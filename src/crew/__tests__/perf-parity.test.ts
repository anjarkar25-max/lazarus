import type { AddressInfo } from "node:net";
import * as fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PooledProbeRunner } from "../../sandbox/pool.js";
import { createWebServer } from "../../web/server.js";
import {
  BENCH_PROBE,
  FASTER_AT,
  PERF_PROBE_TIMEOUT_MS,
  PerfParityBodySchema,
  PerfParityError,
  RUN_BUDGET_MS,
  RUN_ORDER,
  SLOWER_AT,
  TOTAL_BUDGET_MS,
  VECTOR_COUNT,
  classify,
  median,
  representativeInputs,
  runPerfParity,
  toCallableBody,
  type PerfParityResult,
} from "../perf-parity.js";

const HALVE_LEGACY = "var half = (n / 2) | 0; half;";
const HALVE_MODERN = "const half = Math.trunc(n / 2) || 0;\nhalf;";
const CALLBACK = "function legacyReadConfigCb(text, cb) { if (typeof text !== 'string') return cb(new TypeError('x')); cb(null, { port: parseInt(text, 10) }); }\nmodule.exports = legacyReadConfigCb;";

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isAlive(pid);
};

describe("perf-parity: pure helpers", () => {
  it("keeps the timed work under ~150 ms", () => {
    expect(RUN_ORDER).toEqual(["legacy", "modern", "modern", "legacy"]);
    expect(TOTAL_BUDGET_MS).toBe(RUN_BUDGET_MS * 4);
    expect(TOTAL_BUDGET_MS).toBeLessThanOrEqual(150);
    expect(PERF_PROBE_TIMEOUT_MS).toBeLessThan(3000);
  });
  it("builds deterministic representative inputs of the right kind for every schema", () => {
    const schema = { n: "integer", x: "number", s: "string", b: "boolean", j: "json" } as const;
    const a = representativeInputs(schema);
    expect(a).toHaveLength(VECTOR_COUNT);
    expect(representativeInputs(schema)).toEqual(a);
    for (const v of a) {
      expect(v).toHaveLength(5);
      expect(Number.isInteger(v[0])).toBe(true);
      expect(typeof v[1]).toBe("number");
      expect(typeof v[2]).toBe("string");
      expect(typeof v[3]).toBe("boolean");
    }
    expect(new Set(a.map((v) => JSON.stringify(v))).size).toBeGreaterThan(5);
    expect(() => JSON.stringify(a)).not.toThrow();
  });
  it("inputs never contain NaN, Infinity or -0, so they survive a plain-JSON round trip into the sandbox (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("integer", "number", "string", "boolean", "json"), { minLength: 1, maxLength: 8 }), fc.integer({ min: 1, max: 40 }), (kinds, count) => {
        const schema = Object.fromEntries(kinds.map((k, i) => [`p${i}`, k]));
        const vectors = representativeInputs(schema, count);
        expect(vectors).toHaveLength(count);
        expect(JSON.parse(JSON.stringify(vectors))).toEqual(vectors);
        for (const v of vectors) for (const x of v) if (typeof x === "number") expect(Object.is(x, -0) || !Number.isFinite(x)).toBe(false);
      })
    );
  });
  it("turns the completion value of a script into a return, and refuses code without one", () => {
    expect(new Function("n", toCallableBody(HALVE_LEGACY) ?? "")(7)).toBe(3);
    expect(new Function("n", toCallableBody(HALVE_MODERN) ?? "")(-7)).toBe(-3);
    expect(new Function("n", toCallableBody("(function (n) { return n * 2; })(n)") ?? "")(21)).toBe(42);
    expect(toCallableBody("var x = n; if (x) { x = 2; }")).toBeUndefined();
    expect(toCallableBody("function (")).toBeUndefined();
    expect(toCallableBody("")).toBeUndefined();
    expect(toCallableBody("'use strict';")).toBeUndefined();
  });
  it("classifies the ratio with fixed, honest thresholds", () => {
    expect(FASTER_AT).toBe(1.1);
    expect(SLOWER_AT).toBe(0.9);
    expect(classify(1.1)).toBe("faster");
    expect(classify(2)).toBe("faster");
    expect(classify(1.0999)).toBe("parity");
    expect(classify(1)).toBe("parity");
    expect(classify(0.9001)).toBe("parity");
    expect(classify(0.9)).toBe("slower");
    expect(classify(0.1)).toBe("slower");
  });
  it("medians are exact for odd and even sample counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([5])).toBe(5);
    expect(Number.isNaN(median([]))).toBe(true);
  });
  it("validates the request body strictly", () => {
    const ok = { legacyCode: HALVE_LEGACY, modernCode: HALVE_MODERN, schema: { n: "integer" } };
    expect(PerfParityBodySchema.safeParse(ok).success).toBe(true);
    expect(PerfParityBodySchema.safeParse({ legacyCode: HALVE_LEGACY, modernCode: HALVE_MODERN }).success).toBe(true);
    const bad: unknown[] = [
      {},
      { ...ok, extra: 1 },
      { ...ok, legacyCode: "" },
      { ...ok, modernCode: 5 },
      { ...ok, legacyCode: "x".repeat(64_001) },
      { ...ok, schema: { n: "float" } },
      { ...ok, schema: { "n-1": "integer" } },
      { ...ok, schema: { __lzSecret: "integer" } },
      { ...ok, schema: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, "integer"])) },
      { ...ok, functionName: "" },
    ];
    for (const b of bad) expect(PerfParityBodySchema.safeParse(b).success, JSON.stringify(b).slice(0, 80)).toBe(false);
  });
  it("the sandbox probe uses only Date.now (the sandbox has no hrtime) and ships no host access", () => {
    expect(BENCH_PROBE).toContain("Date.now()");
    expect(BENCH_PROBE).not.toMatch(/hrtime|performance|require|process/);
  });
});

describe("perf-parity: micro-benchmark in the pooled sandbox", () => {
  const legacy = new PooledProbeRunner({ probeTimeoutMs: PERF_PROBE_TIMEOUT_MS });
  const modern = new PooledProbeRunner({ probeTimeoutMs: PERF_PROBE_TIMEOUT_MS });
  afterAll(async () => {
    await Promise.all([legacy.close(), modern.close()]);
  });
  const run = async (input: Partial<Parameters<typeof runPerfParity>[0]> = {}): Promise<PerfParityResult> => {
    const r = await runPerfParity({ legacy, modern, legacyCode: HALVE_LEGACY, modernCode: HALVE_MODERN, schema: { n: "integer" }, ...input });
    if ("skipped" in r) throw new Error(`unexpectedly skipped: ${r.reason}`);
    return r;
  };

  it("returns a coherent payload: medians, ops/s, ratio and verdict agree with each other", async () => {
    await run(); // warm the workers (spawn cost is not part of the timing, but keeps the next call fast)
    const r = await run();
    expect(Object.keys(r).sort()).toEqual(["budgetMs", "elapsedMs", "inputs", "iterations", "legacyMedianUs", "legacyOpsPerSec", "ratio", "resurrectedMedianUs", "resurrectedOpsPerSec", "verdict"]);
    expect(r.iterations).toBeGreaterThan(100);
    expect(r.inputs).toBe(VECTOR_COUNT);
    expect(r.legacyMedianUs).toBeGreaterThan(0);
    expect(r.resurrectedMedianUs).toBeGreaterThan(0);
    // ops/s is 1e6 / median (within rounding of the 3-decimal microseconds).
    expect(Math.abs(r.legacyOpsPerSec - 1e6 / r.legacyMedianUs) / r.legacyOpsPerSec).toBeLessThan(0.02);
    expect(Math.abs(r.resurrectedOpsPerSec - 1e6 / r.resurrectedMedianUs) / r.resurrectedOpsPerSec).toBeLessThan(0.02);
    expect(Math.abs(r.ratio - r.legacyMedianUs / r.resurrectedMedianUs) / r.ratio).toBeLessThan(0.05);
    expect(r.verdict).toBe(classify(r.ratio));
    expect(["faster", "parity", "slower"]).toContain(r.verdict);
    expect(r.budgetMs).toBe(TOTAL_BUDGET_MS);
  }, 30_000);

  it("is bounded: a warm benchmark finishes well inside a second", async () => {
    await run();
    const started = Date.now();
    const r = await run();
    const wall = Date.now() - started;
    expect(r.elapsedMs).toBeLessThanOrEqual(wall);
    expect(wall).toBeLessThan(1500);
    expect(r.elapsedMs).toBeLessThan(TOTAL_BUDGET_MS + 1000);
  }, 30_000);

  it("measures real differences: a deliberately slower resurrected side is not reported as faster", async () => {
    const slow = "let total = 0;\nfor (let i = 0; i < 3000; i++) total += i % 7;\nconst half = (Math.trunc(n / 2) || 0) + total * 0;\nhalf;";
    const r = await run({ modernCode: slow });
    expect(r.ratio).toBeLessThan(0.9);
    expect(r.verdict).toBe("slower");
    const fast = await run({ legacyCode: "var t = 0; for (var i = 0; i < 3000; i++) t += i % 7; var half = ((n / 2) | 0) + t * 0; half;", modernCode: HALVE_MODERN });
    expect(fast.ratio).toBeGreaterThan(1.1);
    expect(fast.verdict).toBe("faster");
  }, 60_000);

  it("benchmarks multi-parameter and string specimens with the schema's inputs", async () => {
    const r = await run({
      legacyCode: "var h = 0; for (var i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; } h;",
      modernCode: "let h = 0;\nfor (let i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; }\nh;",
      schema: { text: "string" },
    });
    expect(r.legacyMedianUs).toBeGreaterThan(0);
    const two = await run({ legacyCode: "var s = (a + b) | 0; s;", modernCode: "const s = (a + b) | 0;\ns;", schema: { a: "integer", b: "integer" } });
    expect(two.inputs).toBe(VECTOR_COUNT);
  }, 60_000);

  it("falls back to the scanner's schema, and to the function's runnable expression", async () => {
    const r = await run({ legacyCode: "function half(n) { return (n / 2) | 0; }", modernCode: "(function half(n) { return Math.trunc(n / 2) || 0; })(n)", schema: undefined as never });
    expect(r.iterations).toBeGreaterThan(0);
  }, 30_000);

  it("skips error-first callback specimens with a stated reason, without touching the sandbox", async () => {
    const r = await runPerfParity({ legacy, modern, legacyCode: CALLBACK, modernCode: "export async function legacyReadConfigCb() {}" });
    expect(r).toEqual({ skipped: true, reason: expect.stringContaining("Error-first callback") as unknown });
  });
  it("skips code that produces no value, and rejects specimens without inputs or that do not parse", async () => {
    const skipped = await runPerfParity({ legacy, modern, legacyCode: "var x = n; if (x) { x = 2; }", modernCode: "const x = n; if (x) { }", schema: { n: "integer" } });
    expect(skipped).toMatchObject({ skipped: true });
    await expect(runPerfParity({ legacy, modern, legacyCode: "var x = 1; x;", modernCode: "1;" })).rejects.toMatchObject({ status: 422, message: expect.stringContaining("No input") as unknown });
    await expect(runPerfParity({ legacy, modern, legacyCode: "var x = (;", modernCode: "1;", schema: { n: "integer" } })).rejects.toBeInstanceOf(PerfParityError);
  });
  it("runs only inside the sandbox: a host escape in the benchmarked code is contained and nothing leaks", async () => {
    const r = await run({ legacyCode: "var x = (typeof process !== 'undefined' && process.exit ? 1 : 0) + n; x;", modernCode: "const x = (typeof process !== 'undefined' && process.exit ? 1 : 0) + n;\nx;" });
    expect(r.iterations).toBeGreaterThan(0);
    expect(legacy.workerPid).toBeDefined();
  }, 30_000);

  it("leaves no worker behind after close", async () => {
    const a = new PooledProbeRunner({ probeTimeoutMs: PERF_PROBE_TIMEOUT_MS });
    const b = new PooledProbeRunner({ probeTimeoutMs: PERF_PROBE_TIMEOUT_MS });
    await runPerfParity({ legacy: a, modern: b, legacyCode: HALVE_LEGACY, modernCode: HALVE_MODERN, schema: { n: "integer" } });
    const pids = [a.workerPid, b.workerPid].filter((p): p is number => p !== undefined);
    expect(pids).toHaveLength(2);
    await Promise.all([a.close(), b.close()]);
    for (const pid of pids) expect(await gone(pid), `worker ${pid}`).toBe(true);
  }, 30_000);
});

describe("POST /api/perf-parity", () => {
  const server = createWebServer();
  let baseUrl = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
  const post = async (body: unknown, raw = false): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${baseUrl}/api/perf-parity`, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw ? String(body) : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it("returns the documented payload for a synchronous specimen", async () => {
    const { status, json } = await post({ legacyCode: HALVE_LEGACY, modernCode: HALVE_MODERN, schema: { n: "integer" } });
    expect(status).toBe(200);
    for (const key of ["iterations", "legacyMedianUs", "resurrectedMedianUs", "legacyOpsPerSec", "resurrectedOpsPerSec", "ratio"]) expect(typeof json[key], key).toBe("number");
    expect(["faster", "parity", "slower"]).toContain(json["verdict"]);
    expect(json["verdict"]).toBe(classify(json["ratio"] as number));
    expect(json["budgetMs"]).toBeLessThanOrEqual(150);
  }, 30_000);
  it("works without a schema (the scanner suggests one) and with functionName", async () => {
    const a = await post({ legacyCode: "function half(n) { return (n / 2) | 0; }", modernCode: "(function half(n) { return Math.trunc(n / 2) || 0; })(n)" });
    expect(a.status).toBe(200);
    const b = await post({ legacyCode: "function half(n) { return (n / 2) | 0; }\nfunction twice(n) { return n * 2; }", modernCode: "(function twice(n) { return n * 2; })(n)", functionName: "twice" });
    expect(b.status).toBe(200);
  }, 30_000);
  it("answers a skip note (200) for an error-first callback specimen", async () => {
    const { status, json } = await post({ legacyCode: CALLBACK, modernCode: "export async function legacyReadConfigCb(text: string) { return { port: 1 }; }" });
    expect(status).toBe(200);
    expect(json).toMatchObject({ skipped: true });
    expect(String(json["reason"])).toContain("Error-first callback");
  });
  it.each([
    ["not JSON", "{nope", true, 400],
    ["an empty body", {}, false, 400],
    ["an unknown key", { legacyCode: HALVE_LEGACY, modernCode: HALVE_MODERN, extra: true }, false, 400],
    ["a bad schema kind", { legacyCode: HALVE_LEGACY, modernCode: HALVE_MODERN, schema: { n: "float" } }, false, 400],
    ["a non-identifier parameter", { legacyCode: HALVE_LEGACY, modernCode: HALVE_MODERN, schema: { "n; evil()": "integer" } }, false, 400],
    ["an oversized snippet", { legacyCode: "x".repeat(64_001), modernCode: "1;" }, false, 400],
    ["an oversized payload", { legacyCode: "x".repeat(300_000), modernCode: "1;" }, false, 413],
    ["a specimen without inputs", { legacyCode: "var x = 1; x;", modernCode: "1;" }, false, 422],
    ["code that does not parse", { legacyCode: "var x = (;", modernCode: "1;", schema: { n: "integer" } }, false, 422],
  ])("rejects %s with %i", async (_label, body, raw, expected) => {
    const { status, json } = await post(body, raw);
    expect(status).toBe(expected);
    expect(typeof json["error"]).toBe("string");
  });
  it("is single-flight: concurrent requests are answered 200 or 429, never lost", async () => {
    const body = { legacyCode: HALVE_LEGACY, modernCode: HALVE_MODERN, schema: { n: "integer" } };
    const answers = await Promise.all([post(body), post(body), post(body)]);
    for (const a of answers) expect([200, 429]).toContain(a.status);
    expect(answers.some((a) => a.status === 200)).toBe(true);
    const after = await post(body);
    expect(after.status).toBe(200);
  }, 60_000);
  it("a benchmark that hangs is stopped by the watchdog and reported without numbers", async () => {
    const { status, json } = await post({ legacyCode: "while (n > -1) { n = n; } n;", modernCode: "n;", schema: { n: "integer" } });
    expect([422, 500]).toContain(status);
    expect(json["verdict"]).toBeUndefined();
    expect(typeof json["error"]).toBe("string");
    const next = await post({ legacyCode: HALVE_LEGACY, modernCode: HALVE_MODERN, schema: { n: "integer" } });
    expect(next.status).toBe(200);
  }, 60_000);
});
