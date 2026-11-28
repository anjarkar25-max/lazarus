import * as fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { PooledProbeRunner } from "../../sandbox/pool.js";
import { DifferentialFuzzer, MAX_SHRINK_STEPS, buildShrinkTrace } from "../differential.js";
import type { ProbeOutcome, ShrinkTrace } from "../types.js";

const legacy = new PooledProbeRunner();
const modern = new PooledProbeRunner();
const fuzzer = new DifferentialFuzzer({ legacy, modern });
afterAll(async () => {
  await Promise.all([legacy.close(), modern.close()]);
});

const HASH = "var h = 0; for (var i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; } h;";
/** The naive rewrite: drops the 32-bit wrap, so long strings overflow int32 in legacy only. */
const NAIVE_HASH = "var h = 0; for (var i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)); } h;";

const ok = (output: unknown): ProbeOutcome => ({ ok: true, output, durationMs: 0 });
const record = (n: number): { inputs: Record<string, unknown>; legacy: ProbeOutcome; modern: ProbeOutcome } => ({ inputs: { n }, legacy: ok(n), modern: ok(n + 1) });

describe("shrinkTrace: real fast-check shrinking, captured", () => {
  it("records the journey from the first failing input down to the minimal one", async () => {
    // Random mode (no boundary corpus) so the failure is found by fast-check and then really shrunk.
    const report = await fuzzer.fuzz(HASH, NAIVE_HASH, { text: "string" }, { numRuns: 40, seed: 7, exact: true, boundary: false });
    expect(report.passed).toBe(false);
    const cx = report.counterexample;
    const trace = cx?.shrinkTrace;
    expect(trace).toBeDefined();
    if (cx === undefined || trace === undefined) return;
    expect(trace.steps.length).toBeGreaterThanOrEqual(1);
    expect(trace.steps.length).toBeLessThanOrEqual(MAX_SHRINK_STEPS);
    expect(trace.initialFailure.step).toBe(0);
    expect(trace.steps[0]).toEqual(trace.initialFailure);
    expect(trace.steps.at(-1)).toEqual(trace.finalMinimal);
    expect(trace.finalMinimal.step).toBe(trace.totalShrinks);
    // The last step is the counterexample the report names, formatted like the rest of the payload.
    expect(trace.finalMinimal.input).toBe(`text = ${JSON.stringify(cx.inputs["text"])}`);
    expect(trace.finalMinimal.legacyOutput).not.toBe(trace.finalMinimal.modernOutput);
    // Steps are strictly increasing, and shrinking really happened (a random 12+ char string reduces).
    const steps = trace.steps.map((s) => s.step);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(new Set(steps).size).toBe(steps.length);
    expect(trace.totalShrinks).toBeGreaterThan(0);
    expect(trace.finalMinimal.input.length).toBeLessThanOrEqual(trace.initialFailure.input.length);
    // Every step is a genuine failure: its two outputs differ.
    for (const s of trace.steps) expect(s.legacyOutput, s.input).not.toBe(s.modernOutput);
  }, 60_000);

  it("is deterministic for a seed, and the existing report fields are untouched", async () => {
    const a = await fuzzer.fuzz(HASH, NAIVE_HASH, { text: "string" }, { numRuns: 40, seed: 11, exact: true, boundary: false });
    const b = await fuzzer.fuzz(HASH, NAIVE_HASH, { text: "string" }, { numRuns: 40, seed: 11, exact: true, boundary: false });
    expect(a.counterexample?.shrinkTrace).toEqual(b.counterexample?.shrinkTrace);
    expect(a.counterexample?.inputs).toEqual(b.counterexample?.inputs);
    for (const key of ["passed", "totalRuns", "durationMs", "seed", "traces", "counterexample", "exact", "boundaryRuns"]) expect(a, key).toHaveProperty(key);
    const { shrinkTrace: _t, ...rest } = a.counterexample ?? ({} as Record<string, unknown>);
    expect(Object.keys(rest).sort()).toEqual(["exact", "inputs", "legacy", "modern", "reason"]);
  }, 60_000);

  it("a boundary-corpus failure has a single step and 0 shrinks (it is already minimal)", async () => {
    const report = await fuzzer.fuzz("(n / 2) | 0", "Math.floor(n / 2)", { n: "integer" }, { numRuns: 60, seed: 1, exact: true });
    expect(report.passed).toBe(false);
    const trace = report.counterexample?.shrinkTrace;
    expect(trace).toMatchObject({ totalShrinks: 0 });
    expect(trace?.steps).toHaveLength(1);
    expect(trace?.initialFailure).toEqual(trace?.finalMinimal);
  }, 60_000);

  it("keeps -0, NaN and +0 distinguishable in the trace text", async () => {
    const report = await fuzzer.fuzz("n | 0", "Math.trunc(n)", { n: "number" }, { numRuns: 60, seed: 3, exact: true });
    expect(report.passed).toBe(false);
    const step = report.counterexample?.shrinkTrace?.finalMinimal;
    expect(step).toBeDefined();
    // Whatever the first boundary killer is, no output is blank, and zeros carry their sign.
    expect(step?.legacyOutput).toMatch(/^(\+0|-0|NaN|-?\d|Infinity|-Infinity)/);
    expect(step?.modernOutput).toMatch(/^(\+0|-0|NaN|-?\d|Infinity|-Infinity)/);
    expect(step?.legacyOutput).not.toBe(step?.modernOutput);
  }, 60_000);

  it("a passing run carries no trace, and a run that throws on one side shows `throws` text", async () => {
    const pass = await fuzzer.fuzz("n + 1", "1 + n", { n: "integer" }, { numRuns: 20, seed: 5, exact: true });
    expect(pass.passed).toBe(true);
    expect(pass.counterexample).toBeUndefined();
    const threw = await fuzzer.fuzz("n", "(function () { throw new RangeError('boom'); })()", { n: "integer" }, { numRuns: 20, seed: 5, exact: true });
    expect(threw.counterexample?.shrinkTrace?.finalMinimal.modernOutput).toContain("throws");
  }, 60_000);

  it("shrink:false stops at the first failure, so the trace has exactly one step", async () => {
    const report = await fuzzer.fuzz(HASH, NAIVE_HASH, { text: "string" }, { numRuns: 40, seed: 7, exact: true, boundary: false, shrink: false });
    const trace = report.counterexample?.shrinkTrace;
    expect(trace?.steps).toHaveLength(1);
    expect(trace?.totalShrinks).toBe(0);
  }, 60_000);
});

describe("buildShrinkTrace: bounding and selection (property)", () => {
  it("never returns more than 6 steps, always the first and the last, in order", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 80 }), (n) => {
        const log = Array.from({ length: n }, (_, i) => record(i));
        const trace = buildShrinkTrace(log, true, n - 1) as ShrinkTrace;
        expect(trace.steps.length).toBe(Math.min(n, MAX_SHRINK_STEPS));
        expect(trace.steps[0]?.step).toBe(0);
        expect(trace.steps.at(-1)?.step).toBe(n - 1);
        expect(trace.initialFailure.step).toBe(0);
        expect(trace.finalMinimal.step).toBe(n - 1);
        const nums = trace.steps.map((s) => s.step);
        expect(new Set(nums).size).toBe(nums.length);
        expect([...nums].sort((a, b) => a - b)).toEqual(nums);
        expect(trace.totalShrinks).toBe(n - 1);
      })
    );
  });
  it("returns nothing for an empty log, and clips very long inputs and outputs", () => {
    expect(buildShrinkTrace([], true, 0)).toBeUndefined();
    const long = "x".repeat(500);
    const trace = buildShrinkTrace([{ inputs: { s: long }, legacy: ok(long), modern: ok(`${long}!`) }], true, 0) as ShrinkTrace;
    for (const text of [trace.finalMinimal.input, trace.finalMinimal.legacyOutput, trace.finalMinimal.modernOutput]) expect(text.length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(trace).length).toBeLessThan(2000);
  });
  it("formats exact zeros with their sign", () => {
    const trace = buildShrinkTrace([{ inputs: { n: { $lazarus: "-0" } }, legacy: ok(0), modern: ok({ $lazarus: "-0" }) }], true, 0) as ShrinkTrace;
    expect(trace.finalMinimal).toEqual({ step: 0, input: "n = -0", legacyOutput: "+0", modernOutput: "-0" });
  });
});
