import { describe, expect, it } from "vitest";
import { DifferentialFuzzer, areOutputsEquivalent } from "../differential.js";

describe("DifferentialFuzzer", () => {
  it("distinguishes -0 from +0 and handles NaN in parity comparisons", () => {
    expect(areOutputsEquivalent(-0, +0)).toBe(false);
    expect(areOutputsEquivalent(-0, -0)).toBe(true);
    expect(areOutputsEquivalent(Number.NaN, Number.NaN)).toBe(true);
    expect(areOutputsEquivalent({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
  });

  it("proves behavioral parity when modern code matches legacy implementation", async () => {
    const fuzzer = new DifferentialFuzzer();
    const legacy = "var sum = 0; for (var i = 0; i < items.length; i++) { sum += items.charCodeAt(i); } sum;";
    const modern = "[...items].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)";

    const report = await fuzzer.fuzz(legacy, modern, { items: "string" }, { numRuns: 15, seed: 42 });

    expect(report.passed).toBe(true);
    expect(report.totalRuns).toBe(15);
    expect(report.counterexample).toBeUndefined();
    expect(report.traces.length).toBeGreaterThan(0);
  }, 60_000);

  it("catches subtle negative-integer edge case and shrinks to minimal counterexample", async () => {
    const fuzzer = new DifferentialFuzzer();
    // Legacy uses bitwise OR truncation (truncates toward zero: -3 | 0 === -3, -3 / 2 | 0 === -1)
    // Naive modernization uses Math.floor (floors toward -Infinity: Math.floor(-3 / 2) === -2)
    const legacy = "(n / 2) | 0";
    const buggyModern = "Math.floor(n / 2)";

    const report = await fuzzer.fuzz(legacy, buggyModern, { n: "integer" }, { numRuns: 25, seed: 1337 });

    expect(report.passed).toBe(false);
    expect(report.counterexample).toBeDefined();
    expect(typeof report.counterexample?.inputs.n).toBe("number");
    expect((report.counterexample?.inputs.n as number) < 0).toBe(true);
    expect(report.counterexample?.reason).toContain("Output mismatch");
  }, 60_000);
});

