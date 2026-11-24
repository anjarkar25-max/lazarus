import * as fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { PooledProbeRunner } from "../../sandbox/pool.js";
import { BOUNDARY_MIN_RUNS, boundariesForKind, buildBoundaryCorpus, DifferentialFuzzer } from "../differential.js";
import type { InputSchema, ParamKind } from "../types.js";

const pool = new PooledProbeRunner();
const fuzzer = new DifferentialFuzzer(pool);
afterAll(async () => {
  await pool[Symbol.asyncDispose]();
});

describe("exact tagged Object.is Exorcist", () => {
  it("catches -0 vs +0 deterministically within the default 100 runs", async () => {
    const report = await fuzzer.fuzz("Math.trunc(n / 2)", "Math.trunc(n / 2) || 0", { n: "integer" }, { numRuns: 100 });
    expect(report.passed).toBe(false);
    expect(report.exact).toBe(true);
    expect(report.counterexample?.exact).toBe(true);
    expect(report.counterexample?.reason).toContain("sign of zero differs");
  });

  it("catches NaN vs null", async () => {
    const report = await fuzzer.fuzz("NaN", "null", { n: "integer" }, { numRuns: 50 });
    expect(report.passed).toBe(false);
    expect(report.counterexample?.reason).toContain("NaN vs null");
  });

  it("catches undefined vs null and Infinity vs null", async () => {
    const a = await fuzzer.fuzz("undefined", "null", { n: "integer" }, { numRuns: 50 });
    const b = await fuzzer.fuzz("Infinity", "null", { n: "integer" }, { numRuns: 50 });
    expect(a.passed).toBe(false);
    expect(b.passed).toBe(false);
  });

  it("is deep: -0 inside arrays and objects is detected", async () => {
    const report = await fuzzer.fuzz("({ a: [n * 0] })", "({ a: [0] })", { n: "integer" }, { numRuns: 100 });
    expect(report.passed).toBe(false);
  });

  it("passes identical code and runs exactly the requested number of runs", async () => {
    const report = await fuzzer.fuzz("n * 2", "n * 2", { n: "integer" }, { numRuns: 100 });
    expect(report.passed).toBe(true);
    expect(report.totalRuns).toBe(100);
    expect(report.boundaryRuns).toBe(50);
  });

  it("JSON-level mode (exact: false) keeps the old tolerance", async () => {
    const report = await fuzzer.fuzz("Math.trunc(n / 2)", "Math.trunc(n / 2) || 0", { n: "integer" }, { numRuns: 100, exact: false });
    expect(report.passed).toBe(true);
    expect(report.exact).toBe(false);
  });

  it("does not add boundary runs below the minimum", async () => {
    const report = await fuzzer.fuzz("n", "n", { n: "integer" }, { numRuns: BOUNDARY_MIN_RUNS - 1 });
    expect(report.boundaryRuns).toBe(0);
    expect(report.totalRuns).toBe(BOUNDARY_MIN_RUNS - 1);
  });

  it("boundary corpus covers every boundary of every parameter (property)", () => {
    const kinds: ParamKind[] = ["integer", "number", "string", "boolean", "json"];
    fc.assert(
      fc.property(fc.subarray(kinds, { minLength: 1 }), (chosen) => {
        const schema: InputSchema = Object.fromEntries(chosen.map((k, i) => [`p${i}`, k]));
        const corpus = buildBoundaryCorpus(schema, 50);
        expect(corpus).toHaveLength(50);
        chosen.forEach((kind, i) => {
          const seen = corpus.map((r) => r[`p${i}`]);
          for (const b of boundariesForKind(kind)) {
            expect(seen.some((v) => Object.is(v, b) || (typeof b === "object" && JSON.stringify(v) === JSON.stringify(b)))).toBe(true);
          }
        });
      })
    );
  });

  it("an unknown kind still makes fuzz() throw", async () => {
    await expect(fuzzer.fuzz("1", "1", { x: "not-a-kind" as ParamKind }, { numRuns: 60 })).rejects.toThrow();
  });
});
