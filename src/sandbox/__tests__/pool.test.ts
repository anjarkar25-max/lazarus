// sandbox-pooling spec: PooledProbeRunner, VmProbeExecutor, worker.ts, and fuzzer/orchestrator wiring.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";
import { SandboxError } from "../errors.js";
import { PooledProbeRunner, type PoolWorker } from "../pool.js";
import { VmProbeExecutor } from "../vm-executor.js";
import type { ProbeParams, ProbeResult, SandboxErrorCode } from "../types.js";
import { DifferentialFuzzer } from "../../fuzzer/differential.js";
import type { InputSchema } from "../../fuzzer/types.js";
import { ResurrectionOrchestrator } from "../../crew/orchestrator.js";
import type { CodeSynthesizer } from "../../crew/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isRunning(pid);
}

function codeOf(e: unknown): SandboxErrorCode | "NOT_SANDBOX_ERROR" {
  return e instanceof SandboxError ? e.code : "NOT_SANDBOX_ERROR";
}

async function rejectionCode(p: Promise<unknown>): Promise<SandboxErrorCode | "NOT_SANDBOX_ERROR" | "RESOLVED"> {
  try {
    await p;
    return "RESOLVED";
  } catch (e: unknown) {
    return codeOf(e);
  }
}

const OK_RESULT: ProbeResult = { output: 1, durationMs: 0, memoryUsedBytes: 0 };

type FakeBehaviour = (worker: FakeWorker, params: ProbeParams) => Promise<ProbeResult>;

/** In-memory PoolWorker used to drive the pool's state machine deterministically. */
class FakeWorker implements PoolWorker {
  static nextPid = 1;
  alive = false;
  stderrTail = "";
  readonly pid = FakeWorker.nextPid++;
  constructor(private readonly behaviour: () => FakeBehaviour) {}
  async spawn(): Promise<void> {
    this.alive = true;
  }
  probe(params: ProbeParams): Promise<ProbeResult> {
    return this.behaviour()(this, params);
  }
  async shutdown(): Promise<void> {
    this.alive = false;
  }
  async kill(): Promise<void> {
    this.alive = false;
  }
  get isAlive(): boolean {
    return this.alive;
  }
}

// ---------------------------------------------------------------------------
// 1. VmProbeExecutor — per-probe isolation (in-process, fast)
// ---------------------------------------------------------------------------

describe("VmProbeExecutor isolation", () => {
  const exec = new VmProbeExecutor();

  it("does not leak globals or built-in prototype mutations between probes", async () => {
    await exec.run({
      code: "globalThis.leaked = 1; Object.prototype.polluted = 1; Array.prototype.evil = 1; Math.secret = 1; 0",
    });
    const second = await exec.run({
      code: "[typeof leaked, typeof ({}).polluted, typeof [].evil, typeof Math.secret].join(',')",
    });
    expect(second.output).toBe("undefined,undefined,undefined,undefined");
  });

  it("does not leak context values into later probes", async () => {
    await exec.run({ code: "x", context: { x: 5 } });
    const res = await exec.run({ code: "typeof x" });
    expect(res.output).toBe("undefined");
  });

  it("property: a mutation made in probe N is never observable in probe N+1", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-z]{1,12}$/).map((s) => `lz_${s}`),
        fc.integer(),
        async (key, value) => {
          const k = JSON.stringify(key);
          await exec.run({
            code: `globalThis[${k}] = ${value}; Object.prototype[${k}] = ${value}; Array.prototype[${k}] = ${value}; 0`,
          });
          const res = await exec.run({ code: `[${k} in globalThis, ${k} in {}, ${k} in []].join(',')` });
          expect(res.output).toBe("false,false,false");
        }
      ),
      { numRuns: 100 }
    );
  });

  it("does not expose the host realm through constructor chains", async () => {
    const res = await exec.run({
      code: [
        "var p1 = this.constructor.constructor('return process')();",
        "var p2 = console.log.constructor('return process')();",
        "[typeof p1.exit, typeof p2.exit, typeof p1.mainModule, typeof require].join(',')",
      ].join(" "),
    });
    expect(res.output).toBe("undefined,undefined,undefined,undefined");
  });

  it("gives each probe values copied from context, not host references", async () => {
    const context = { obj: { n: 1 } };
    await exec.run({ code: "obj.n = 99; obj.added = true; 0", context });
    expect(context.obj).toEqual({ n: 1 });
  });

  it("captures console output into stdout/stderr", async () => {
    const res = await exec.run({ code: "console.log('a', 1); console.error('b'); console.log({ x: 2 }); 'done'" });
    expect(res.output).toBe("done");
    expect(res.stdout).toBe("a 1\n{\"x\":2}");
    expect(res.stderr).toBe("b");
  });

  it("classifies thrown values and syntax errors as EXECUTION_ERROR with a message", async () => {
    await expect(exec.run({ code: "throw new Error('boom')" })).rejects.toMatchObject({
      code: "EXECUTION_ERROR",
      detail: "boom",
    });
    expect(await rejectionCode(exec.run({ code: "throw 42" }))).toBe("EXECUTION_ERROR");
    expect(await rejectionCode(exec.run({ code: "function (" }))).toBe("EXECUTION_ERROR");
    expect(await rejectionCode(exec.run({ code: "process.exit(1)" }))).toBe("EXECUTION_ERROR");
  });

  it("does not run a hostile toJSON getter outside the time budget", async () => {
    expect(
      await rejectionCode(exec.run({ code: "({ toJSON: function () { while (true) {} } })" }))
    ).toBe("TIMEOUT");
  }, 10_000);
});

// ---------------------------------------------------------------------------
// 2. PooledProbeRunner against the real worker process
// ---------------------------------------------------------------------------

describe("PooledProbeRunner (real worker)", () => {
  const opened: PooledProbeRunner[] = [];
  const open = (): PooledProbeRunner => {
    const pool = new PooledProbeRunner();
    opened.push(pool);
    return pool;
  };

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((p) => p.close()));
  });

  it("reuses one warm worker and keeps probes isolated from each other", async () => {
    const pool = open();
    const first = await pool.run({ code: "globalThis.leak = 1; Object.prototype.p = 1; x + 1", context: { x: 41 } });
    const pid = pool.workerPid;
    const second = await pool.run({ code: "typeof leak + ',' + typeof ({}).p" });

    expect(first.output).toBe(42);
    expect(second.output).toBe("undefined,undefined");
    expect(pool.workerPid).toBe(pid);
    expect(pool.stats).toMatchObject({ spawns: 1, respawns: 0, probes: 2 });
  }, 15_000);

  it("enforces network and filesystem shims inside the worker", async () => {
    const pool = open();
    // Probe code has no require/import; the blocked modules are only reachable via host bindings,
    // which the null-prototype context does not expose.
    const res = await pool.run({ code: "[typeof require, typeof process.binding, typeof fetch].join(',')" });
    expect(res.output).toBe("undefined,undefined,undefined");
  }, 15_000);

  it("a probe calling process.exit(1) fails cleanly and leaves the worker healthy", async () => {
    const pool = open();
    await pool.run({ code: "1" });
    const pid = pool.workerPid;

    expect(await rejectionCode(pool.run({ code: "process.exit(1)" }))).toBe("EXECUTION_ERROR");
    const after = await pool.run({ code: "2 + 2" });

    expect(after.output).toBe(4);
    expect(pool.workerPid).toBe(pid);
    expect(pool.stats.respawns).toBe(0);
  }, 15_000);

  it("respawns a fresh worker after a TIMEOUT and tears the old one down", async () => {
    const pool = open();
    await pool.run({ code: "1" });
    const oldPid = pool.workerPid;
    expect(oldPid).toBeDefined();

    const started = Date.now();
    expect(await rejectionCode(pool.run({ code: "while (true) {}" }))).toBe("TIMEOUT");
    expect(Date.now() - started).toBeLessThan(3500);
    expect(await waitUntilGone(oldPid!)).toBe(true);

    const res = await pool.run({ code: "6 * 7" });
    expect(res.output).toBe(42);
    expect(pool.workerPid).not.toBe(oldPid);
    expect(pool.stats).toMatchObject({ spawns: 2, respawns: 1 });
  }, 20_000);

  it("respawns after the worker process dies in the middle of a probe", async () => {
    const pool = open();
    await pool.run({ code: "1" });
    const pid = pool.workerPid!;

    const pending = pool.run({ code: "var end = Date.now() + 2000; while (Date.now() < end) {} 1" });
    await new Promise((r) => setTimeout(r, 150));
    process.kill(pid, "SIGKILL");

    expect(await rejectionCode(pending)).toBe("EXECUTION_ERROR");
    const res = await pool.run({ code: "'alive'" });
    expect(res.output).toBe("alive");
    expect(pool.workerPid).not.toBe(pid);
  }, 20_000);

  it("detects a worker that died between probes and replaces it", async () => {
    const pool = open();
    await pool.run({ code: "1" });
    const pid = pool.workerPid!;
    process.kill(pid, "SIGKILL");
    expect(await waitUntilGone(pid)).toBe(true);

    const res = await pool.run({ code: "3" });
    expect(res.output).toBe(3);
    expect(pool.workerPid).not.toBe(pid);
  }, 20_000);

  it("reports MEMORY_EXCEEDED when a probe blows the 256 MB heap, then recovers", async () => {
    const pool = open();
    const code = "var hog = []; while (true) { hog.push(new Array(1e6).fill(1.5)); } 0";
    expect(await rejectionCode(pool.run({ code }))).toBe("MEMORY_EXCEEDED");
    const res = await pool.run({ code: "'recovered'" });
    expect(res.output).toBe("recovered");
  }, 30_000);

  it("terminates the worker process on close() after normal use", async () => {
    const pool = open();
    await pool.run({ code: "1" });
    const pid = pool.workerPid!;
    await pool.close();
    expect(isRunning(pid)).toBe(false);
    expect(pool.workerPid).toBeUndefined();
  }, 15_000);

  it("terminates the worker on the error path via await using", async () => {
    let pid: number | undefined;
    const failing = async (): Promise<void> => {
      await using pool = new PooledProbeRunner();
      await pool.run({ code: "1" });
      pid = pool.workerPid;
      throw new Error("caller failed");
    };
    await expect(failing()).rejects.toThrow("caller failed");
    expect(pid).toBeDefined();
    expect(isRunning(pid!)).toBe(false);
  }, 15_000);

  it("rejects probes after close and is idempotent", async () => {
    const pool = open();
    await pool.close();
    await pool.close();
    expect(await rejectionCode(pool.run({ code: "1" }))).toBe("INTERNAL_ERROR");
    expect(pool.stats.spawns).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. PooledProbeRunner state machine (fake workers, fast)
// ---------------------------------------------------------------------------

describe("PooledProbeRunner recovery logic (fake worker)", () => {
  it("watchdog rejects with TIMEOUT and kills a hung worker", async () => {
    const workers: FakeWorker[] = [];
    let hang = true;
    const pool = new PooledProbeRunner({
      probeTimeoutMs: 50,
      workerFactory: () => {
        const w = new FakeWorker(() => async () =>
          hang ? new Promise<ProbeResult>(() => undefined) : OK_RESULT
        );
        workers.push(w);
        return w;
      },
    });

    expect(await rejectionCode(pool.run({ code: "x" }))).toBe("TIMEOUT");
    expect(workers[0]?.alive).toBe(false);
    hang = false;
    expect((await pool.run({ code: "x" })).output).toBe(1);
    expect(workers).toHaveLength(2);
    await pool.close();
    expect(workers.every((w) => !w.alive)).toBe(true);
  });

  it("reclassifies a worker crash using its stderr", async () => {
    let mode: "oom" | "exit" | "ok" = "oom";
    const pool = new PooledProbeRunner({
      workerFactory: () =>
        new FakeWorker(() => async (w) => {
          if (mode === "ok") return OK_RESULT;
          w.alive = false;
          w.stderrTail = mode === "oom" ? "FATAL ERROR: Reached heap limit - JavaScript heap out of memory" : "";
          throw new SandboxError("INTERNAL_ERROR", "Sandbox host exited unexpectedly (code 1)");
        }),
    });
    expect(await rejectionCode(pool.run({ code: "x" }))).toBe("MEMORY_EXCEEDED");
    mode = "exit";
    expect(await rejectionCode(pool.run({ code: "x" }))).toBe("EXECUTION_ERROR");
    mode = "ok";
    expect((await pool.run({ code: "x" })).output).toBe(1);
    expect(pool.stats).toMatchObject({ spawns: 3, respawns: 2 });
    await pool.close();
  });

  it("surfaces spawn failures as INTERNAL_ERROR and tries again on the next probe", async () => {
    let failSpawn = true;
    const pool = new PooledProbeRunner({
      workerFactory: () => {
        const w = new FakeWorker(() => async () => OK_RESULT);
        const realSpawn = w.spawn.bind(w);
        w.spawn = async () => {
          if (failSpawn) throw new Error("spawn ENOENT");
          await realSpawn();
        };
        return w;
      },
    });
    expect(await rejectionCode(pool.run({ code: "x" }))).toBe("INTERNAL_ERROR");
    failSpawn = false;
    expect((await pool.run({ code: "x" })).output).toBe(1);
    await pool.close();
  });

  it("property: any outcome sequence leaves at most one live worker, and none after close()", async () => {
    type Step = "ok" | "throw" | "timeout" | "crash" | "deadBetween";
    const stepArb = fc.constantFrom<Step>("ok", "throw", "timeout", "crash", "deadBetween");

    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 25 }), async (steps) => {
        const workers: FakeWorker[] = [];
        let current: Step = "ok";
        const pool = new PooledProbeRunner({
          workerFactory: () => {
            const w = new FakeWorker(() => async (self) => {
              switch (current) {
                case "throw":
                  throw new SandboxError("EXECUTION_ERROR", "boom");
                case "timeout":
                  throw new SandboxError("TIMEOUT", "slow");
                case "crash":
                  self.alive = false;
                  throw new SandboxError("INTERNAL_ERROR", "exited");
                default:
                  return OK_RESULT;
              }
            });
            workers.push(w);
            return w;
          },
        });

        for (const step of steps) {
          if (step === "deadBetween") {
            const live = workers.find((w) => w.alive);
            if (live) live.alive = false;
            current = "ok";
          } else {
            current = step;
          }
          const outcome = await rejectionCode(pool.run({ code: "x" }));
          const expected: Record<Step, string> = {
            ok: "RESOLVED",
            deadBetween: "RESOLVED",
            throw: "EXECUTION_ERROR",
            timeout: "TIMEOUT",
            crash: "EXECUTION_ERROR",
          };
          expect(outcome).toBe(expected[step]);
          expect(workers.filter((w) => w.alive).length).toBeLessThanOrEqual(1);
        }

        await pool.close();
        expect(workers.filter((w) => w.alive)).toHaveLength(0);
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Fuzzer / orchestrator wiring always disposes their pools
// ---------------------------------------------------------------------------

describe("pool lifecycle in DifferentialFuzzer and ResurrectionOrchestrator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("DifferentialFuzzer reuses one worker per side and closes both pools", async () => {
    const closeSpy = vi.spyOn(PooledProbeRunner.prototype, "close");
    const runSpy = vi.spyOn(PooledProbeRunner.prototype, "run");
    const report = await new DifferentialFuzzer().fuzz("n + 1", "1 + n", { n: "integer" }, { numRuns: 10, seed: 7 });

    expect(report.passed).toBe(true);
    expect(runSpy).toHaveBeenCalledTimes(20);
    expect(closeSpy).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("DifferentialFuzzer closes its pools when fuzz() throws", async () => {
    const closeSpy = vi.spyOn(PooledProbeRunner.prototype, "close");
    const badSchema = { n: "not-a-kind" } as unknown as InputSchema;
    await expect(new DifferentialFuzzer().fuzz("n", "n", badSchema, { numRuns: 1 })).rejects.toThrow();
    expect(closeSpy).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("ResurrectionOrchestrator closes its session pools when the synthesizer throws", async () => {
    const closeSpy = vi.spyOn(PooledProbeRunner.prototype, "close");
    const broken: CodeSynthesizer = {
      async synthesize() {
        throw new Error("model offline");
      },
    };
    await expect(
      new ResurrectionOrchestrator({ synthesizer: broken }).resurrect({
        name: "broken",
        legacyCode: "n",
        schema: { n: "integer" },
        seed: 1,
      })
    ).rejects.toThrow("model offline");
    expect(closeSpy).toHaveBeenCalledTimes(2);
  }, 30_000);
});
