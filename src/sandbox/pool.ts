/// <reference types="node" />
// PooledProbeRunner: keeps ONE warm sandbox worker alive and reuses it across probes.
// - probes run one at a time (serial queue)
// - a hard 3000 ms watchdog kills the worker if a probe overruns
// - unhealthy or dead workers are disposed and transparently replaced
// - close() / asyncDispose always waits for the worker process to exit

import * as fs from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxClient } from "./client.js";
import { SandboxError } from "./errors.js";
import type { ProbeExecutor, ProbeParams, ProbeResult } from "./types.js";

/** Same limits as ProbeRunner (see .kiro/steering/sandbox-security.md). */
export const MAX_PROBE_TIMEOUT_MS = 3000;
export const WORKER_MAX_OLD_SPACE_MB = 256;

const DEFAULT_SPAWN_TIMEOUT_MS = 10_000;
const GRACEFUL_SHUTDOWN_MS = 1000;
const OOM_MARKERS = ["javascript heap out of memory", "allocation failed", "process out of memory"];

/** The slice of SandboxClient that the pool relies on. Injectable for tests. */
export interface PoolWorker {
  spawn(): Promise<void>;
  probe(params: ProbeParams): Promise<ProbeResult>;
  shutdown(): Promise<void>;
  kill(): Promise<void>;
  readonly isAlive: boolean;
  readonly pid: number | undefined;
  readonly stderrTail: string;
}

export interface PooledProbeRunnerOptions {
  /** Creates a new worker. Defaults to a SandboxClient running worker.ts with a 256 MB heap cap. */
  readonly workerFactory?: () => PoolWorker;
  /** Per-probe watchdog. Clamped to MAX_PROBE_TIMEOUT_MS. */
  readonly probeTimeoutMs?: number;
  /** How long a freshly spawned worker may take to answer its first ping. */
  readonly spawnTimeoutMs?: number;
}

export interface PoolStats {
  /** Workers started (first start included). */
  readonly spawns: number;
  /** Workers started after a previous one had to be disposed. */
  readonly respawns: number;
  /** Probes dispatched to a worker. */
  readonly probes: number;
  /** Workers killed/stopped by the pool. */
  readonly disposals: number;
}

function resolveWorkerPath(): string {
  const dir = nodePath.dirname(fileURLToPath(import.meta.url));
  const js = nodePath.join(dir, "worker.js");
  const ts = nodePath.join(dir, "worker.ts");
  return !fs.existsSync(js) && fs.existsSync(ts) ? ts : js;
}

function defaultWorkerFactory(): PoolWorker {
  return new SandboxClient(resolveWorkerPath(), {
    execArgv: [`--max-old-space-size=${WORKER_MAX_OLD_SPACE_MB}`],
    pipeStderr: false,
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

export class PooledProbeRunner implements ProbeExecutor, AsyncDisposable {
  /** The worker's vm executor understands the tagged encoding. */
  readonly supportsTaggedEncoding = true;
  private worker: PoolWorker | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private readonly factory: () => PoolWorker;
  private readonly probeTimeoutMs: number;
  private readonly spawnTimeoutMs: number;
  private spawns = 0;
  private probes = 0;
  private disposals = 0;

  constructor(options: PooledProbeRunnerOptions = {}) {
    this.factory = options.workerFactory ?? defaultWorkerFactory;
    this.probeTimeoutMs = Math.min(options.probeTimeoutMs ?? MAX_PROBE_TIMEOUT_MS, MAX_PROBE_TIMEOUT_MS);
    this.spawnTimeoutMs = options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
  }

  /** PID of the current worker (undefined when none is running). */
  get workerPid(): number | undefined {
    return this.worker?.pid;
  }

  get stats(): PoolStats {
    return {
      spawns: this.spawns,
      respawns: Math.max(0, this.spawns - 1),
      probes: this.probes,
      disposals: this.disposals,
    };
  }

  run(params: ProbeParams): Promise<ProbeResult> {
    if (this.closing !== null) {
      return Promise.reject(new SandboxError("INTERNAL_ERROR", "PooledProbeRunner is closed"));
    }
    const task = this.queue.then(() => this.runExclusive(params));
    this.queue = task.catch(() => undefined);
    return task;
  }

  close(): Promise<void> {
    this.closing ??= this.shutdownWorker();
    return this.closing;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  // -------------------------------------------------------------------------

  private async runExclusive(params: ProbeParams): Promise<ProbeResult> {
    if (this.closing !== null) {
      throw new SandboxError("INTERNAL_ERROR", "PooledProbeRunner is closed");
    }
    const worker = await this.acquire();
    this.probes++;
    try {
      return await withTimeout(
        worker.probe(params),
        this.probeTimeoutMs,
        () => new SandboxError("TIMEOUT", `Probe exceeded ${this.probeTimeoutMs}ms execution limit`)
      );
    } catch (e: unknown) {
      throw await this.recover(worker, SandboxError.from(e, "INTERNAL_ERROR"));
    }
  }

  /** Return a live worker, replacing a dead one and spawning lazily. */
  private async acquire(): Promise<PoolWorker> {
    if (this.worker !== null && !this.worker.isAlive) {
      await this.dispose(this.worker);
    }
    if (this.worker !== null) return this.worker;

    const worker = this.factory();
    this.worker = worker;
    this.spawns++;
    try {
      await withTimeout(
        worker.spawn(),
        this.spawnTimeoutMs,
        () => new SandboxError("INTERNAL_ERROR", `Sandbox worker did not start within ${this.spawnTimeoutMs}ms`)
      );
    } catch (e: unknown) {
      await this.dispose(worker);
      throw SandboxError.from(e, "INTERNAL_ERROR");
    }
    return worker;
  }

  /** Decide whether the worker may be reused; dispose it if not. Returns the error to surface. */
  private async recover(worker: PoolWorker, err: SandboxError): Promise<SandboxError> {
    const died = !worker.isAlive;
    let surfaced = err;
    if (died && err.code === "INTERNAL_ERROR") {
      const tail = worker.stderrTail.toLowerCase();
      surfaced = OOM_MARKERS.some((m) => tail.includes(m))
        ? new SandboxError("MEMORY_EXCEEDED", "Sandbox worker ran out of memory")
        : new SandboxError("EXECUTION_ERROR", "Sandbox worker exited while running the probe");
    }
    const unhealthy =
      died ||
      surfaced.code === "TIMEOUT" ||
      surfaced.code === "MEMORY_EXCEEDED" ||
      surfaced.code === "INTERNAL_ERROR";
    if (unhealthy) {
      await this.dispose(worker);
    }
    return surfaced;
  }

  private async dispose(worker: PoolWorker): Promise<void> {
    if (this.worker === worker) this.worker = null;
    this.disposals++;
    try {
      await worker.kill();
    } catch {
      /* best effort: the process is already gone or being reaped */
    }
  }

  private async shutdownWorker(): Promise<void> {
    await this.queue; // let any in-flight probe finish (bounded by the watchdog)
    const worker = this.worker;
    if (worker === null) return;
    if (worker.isAlive) {
      try {
        await withTimeout(
          worker.shutdown(),
          GRACEFUL_SHUTDOWN_MS,
          () => new SandboxError("TIMEOUT", "Graceful worker shutdown timed out")
        );
      } catch {
        /* fall through to hard kill */
      }
    }
    await this.dispose(worker);
  }
}
