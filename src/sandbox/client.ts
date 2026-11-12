/// <reference types="node" />
// Task 9: SandboxClient — orchestrator-side handle for the sandbox host process.

import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import * as nodePath from "node:path";
import * as fs from "node:fs";
import { SandboxError } from "./errors.js";
import type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  PingResult,
  ProbeParams,
  ProbeResult,
  ShutdownResult,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = nodePath.dirname(__filename);

/** Resolve the host path, preferring .ts if available (test environment). */
function resolveHostPath(provided: string | undefined): string {
  if (provided !== undefined) return provided;
  const jsPath = nodePath.join(__dirname, "host.js");
  const tsPath = nodePath.join(__dirname, "host.ts");
  if (!fs.existsSync(jsPath) && fs.existsSync(tsPath)) return tsPath;
  return jsPath;
}

/** Find the tsx binary in node_modules/.bin, preferring .cmd on Windows */
function findTsx(): string | undefined {
  const binDir = nodePath.join(__dirname, "..", "..", "..", "node_modules", ".bin");
  // On Windows, prefer .cmd wrapper; on POSIX, prefer the shell script
  const candidates =
    process.platform === "win32"
      ? [
          nodePath.join(binDir, "tsx.cmd"),
          nodePath.join(binDir, "tsx"),
        ]
      : [
          nodePath.join(binDir, "tsx"),
          nodePath.join(binDir, "tsx.cmd"),
        ];
  return candidates.find((c) => fs.existsSync(c));
}

type InFlight = {
  resolve: (value: unknown) => void;
  reject: (err: SandboxError) => void;
};

export class SandboxClient {
  private child: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private inflight = new Map<number, InFlight>();
  private readonly hostPath: string;

  constructor(hostPath?: string) {
    this.hostPath = resolveHostPath(hostPath);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async spawn(): Promise<void> {
    if (this.child !== null) {
      throw new SandboxError("INTERNAL_ERROR", "SandboxClient already spawned");
    }

    const isTs = this.hostPath.endsWith(".ts");
    let spawnCmd: string;
    let spawnArgs: string[];

    if (isTs) {
      const tsx = findTsx();
      if (tsx !== undefined) {
        spawnCmd = tsx;
        spawnArgs = [this.hostPath];
      } else {
        // Fall back to node with --import tsx/esm (Node 22+ supports this)
        spawnCmd = process.execPath;
        spawnArgs = ["--import", "tsx/esm", this.hostPath];
      }
    } else {
      spawnCmd = process.execPath;
      spawnArgs = [this.hostPath];
    }

    this.child = spawn(spawnCmd, spawnArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Pipe stderr to our stderr for debugging
    this.child.stderr?.pipe(process.stderr, { end: false });

    this.rl = readline.createInterface({
      input: this.child.stdout!,
      crlfDelay: Infinity,
      terminal: false,
    });

    this.rl.on("line", (line) => {
      this.handleResponse(line);
    });

    this.child.on("exit", (code) => {
      this.rejectAll(
        new SandboxError("INTERNAL_ERROR", `Sandbox host exited unexpectedly (code ${code ?? "null"})`)
      );
    });

    this.child.on("error", (err) => {
      this.rejectAll(SandboxError.from(err, "INTERNAL_ERROR"));
    });

    // Verify the host is alive
    await this.ping();
  }

  async probe(params: ProbeParams): Promise<ProbeResult> {
    const result = await this.send<ProbeResult>("sandbox.probe", params);
    return result;
  }

  async shutdown(): Promise<void> {
    try {
      await this.send<ShutdownResult>("sandbox.shutdown", {});
    } finally {
      this.cleanup();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    try {
      await this.shutdown();
    } catch {
      this.cleanup();
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async ping(): Promise<void> {
    await this.send<PingResult>("sandbox.ping", {});
  }

  private send<R>(method: string, params: unknown): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      if (this.child === null || this.child.killed) {
        reject(new SandboxError("INTERNAL_ERROR", "Sandbox host is not running"));
        return;
      }

      const id = this.nextId++;
      const request: JsonRpcRequest<string, unknown> = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      this.inflight.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });

      this.child.stdin?.write(JSON.stringify(request) + "\n", "utf8");
    });
  }

  private handleResponse(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Malformed response — reject all in-flight
      this.rejectAll(new SandboxError("INTERNAL_ERROR", "Malformed response from sandbox host"));
      return;
    }

    const response = parsed as JsonRpcResponse<unknown>;
    const id = response.id;

    if (typeof id !== "number") {
      // Can't route this response
      return;
    }

    const pending = this.inflight.get(id);
    if (pending === undefined) return;

    this.inflight.delete(id);

    if ("result" in response) {
      pending.resolve(response.result);
    } else {
      const errData = response.error;
      const sandboxCode =
        (errData.data?.sandboxCode) ?? "INTERNAL_ERROR";
      pending.reject(new SandboxError(sandboxCode, errData.message));
    }
  }

  private rejectAll(err: SandboxError): void {
    for (const pending of this.inflight.values()) {
      pending.reject(err);
    }
    this.inflight.clear();
  }

  private cleanup(): void {
    this.rl?.close();
    if (this.child && !this.child.killed) {
      try { this.child.kill(); } catch { /* ignore */ }
    }
    this.child = null;
  }

  /** Expose for testing */
  get _child(): ChildProcess | null {
    return this.child;
  }

  /** Expose id for testing */
  get _inflightCount(): number {
    return this.inflight.size;
  }
}
