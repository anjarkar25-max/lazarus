import { parse } from "acorn";
import { afterAll, describe, expect, it } from "vitest";
import type { InputSchema } from "../../fuzzer/types.js";
import { scanLegacyAst } from "../../sandbox/ast-scanner.js";
import { PooledProbeRunner } from "../../sandbox/pool.js";
import { allOff, modernize } from "../ast-modernizer.js";
import { MAX_MUTANTS, generateMutants, runMutationAudit } from "../mutation-audit.js";

const legacyPool = new PooledProbeRunner();
const modernPool = new PooledProbeRunner();
const executors = { legacy: legacyPool, modern: modernPool };
afterAll(async () => {
  await Promise.all([legacyPool.close(), modernPool.close()]);
});

interface Preset {
  readonly name: string;
  readonly source: string;
  readonly schema: InputSchema;
  /** Rule levels the Exorcist settles on for this preset (stringHash32 needs `| 0`). */
  readonly keepTruncation: boolean;
}

const PRESETS: readonly Preset[] = [
  { name: "legacy-int-halve", source: "var half = (n / 2) | 0; half;", schema: { n: "integer" }, keepTruncation: true },
  { name: "stringHash32", source: "var h = 0; for (var i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; } h;", schema: { text: "string" }, keepTruncation: false },
  { name: "es5-ascii-checksum", source: "var sum = 0; for (var i = 0; i < text.length; i++) { sum += text.charCodeAt(i); } sum;", schema: { text: "string" }, keepTruncation: true },
  {
    name: "quantizeClamp",
    source: "module.exports = function quantizeClamp(n) {\n  var clamped = n < -100 ? -100 : (n > 100 ? 100 : n);\n  return (clamped / 3) | 0;\n};",
    schema: { n: "integer" },
    keepTruncation: true,
  },
];

const prepare = (p: Preset): { legacy: string; modern: string } => {
  const legacy = scanLegacyAst(p.source).primaryExpression;
  const modern = modernize(legacy, p.keepTruncation ? {} : { levels: { ...allOff(), "var-scoping": 0 } }).code;
  return { legacy, modern };
};

describe("generateMutants", () => {
  it.each(PRESETS.map((p) => [p.name, p] as const))("%s: produces valid, distinct, real mutants", (_name, preset) => {
    const { modern } = prepare(preset);
    const mutants = generateMutants(modern);
    expect(mutants.length).toBeGreaterThanOrEqual(3);
    expect(mutants.length).toBeLessThanOrEqual(MAX_MUTANTS);
    const normalized = (s: string): string => s.replace(/\s+/g, " ").trim();
    const codes = mutants.map((m) => normalized(m.code));
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).not.toContain(normalized(modern));
    for (const m of mutants) {
      expect(() => parse(m.code, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true })).not.toThrow();
      expect(m.diffSnippet).toMatch(/^- .+\n\+ .+$/);
      expect(m.id).toMatch(/^M\d$/);
    }
  });

  it("interleaves operator families so a small budget covers different bug classes", () => {
    const { modern } = prepare(PRESETS[1] as Preset);
    expect(generateMutants(modern).map((m) => m.label)).toEqual(["strip | 0", "< → <=", "+ → -", "constant 0 → 1", "* → +"]);
    const halve = generateMutants(prepare(PRESETS[0] as Preset).modern).map((m) => m.label);
    expect(halve).toEqual(["Math.trunc → Math.floor", "/ → *", "constant 2 → 3", "constant 0 → 1"]);
  });

  it("covers every operator family", () => {
    const code = "let t = 0;\nfor (let i = 0; i < n; i++) { if (i === 3) t += i; }\nMath.trunc(t * 2) | 0;";
    const ops = new Set(generateMutants(code, 50).map((m) => m.operator));
    expect([...ops].sort()).toEqual(["arithmetic-flip", "boundary-flip", "equality-flip", "guard-sabotage", "truncation-sabotage"]);
  });

  it("never mutates string concatenation as arithmetic, nor the scanner's argument guard", () => {
    expect(generateMutants('"a" + s;').filter((m) => m.operator === "arithmetic-flip")).toEqual([]);
    const { modern } = prepare(PRESETS[3] as Preset);
    expect(generateMutants(modern, 50).some((m) => m.diffSnippet.includes("typeof n"))).toBe(false);
  });

  it("returns nothing for code without mutation sites or that does not parse", () => {
    expect(generateMutants("x;")).toEqual([]);
    expect(generateMutants("function (")).toEqual([]);
  });
});

describe("runMutationAudit", () => {
  it("kills the legacy-int-halve mutants with concrete counterexamples, in well under 2 s", async () => {
    const preset = PRESETS[0] as Preset;
    const { legacy, modern } = prepare(preset);
    await runMutationAudit({ legacyCode: legacy, modernCode: modern, schema: preset.schema, executors, seed: 1 }); // warm the workers
    const started = Date.now();
    const result = await runMutationAudit({ legacyCode: legacy, modernCode: modern, schema: preset.schema, executors, seed: 1 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.baselineVerified).toBe(true);
    expect(result).toMatchObject({ totalMutants: 4, killed: 4, survived: 0, killRatePercent: 100, runsPerMutant: 30 });
    const floor = result.mutants.find((m) => m.label === "Math.trunc → Math.floor");
    expect(floor?.status).toBe("KILLED");
    // Math.floor(-0.5) is -1, Math.trunc(-0.5) || 0 is 0: the boundary corpus hits n = -1 first.
    expect(floor?.killingCounterexample?.display).toBe("n = -1");
    expect(floor?.killingCounterexample?.reason).toContain("legacy=0 vs modern=-1");
  });

  it("kills all five stringHash32 mutants", async () => {
    const preset = PRESETS[1] as Preset;
    const { legacy, modern } = prepare(preset);
    const result = await runMutationAudit({ legacyCode: legacy, modernCode: modern, schema: preset.schema, executors, seed: 2 });
    expect(result).toMatchObject({ totalMutants: 5, killed: 5, killRatePercent: 100 });
    for (const m of result.mutants) expect(m.killingCounterexample?.inputs).toHaveProperty("text");
  });

  it("reports SURVIVED honestly for genuinely equivalent mutants (quantizeClamp clamp boundaries)", async () => {
    const preset = PRESETS[3] as Preset;
    const { legacy, modern } = prepare(preset);
    const result = await runMutationAudit({ legacyCode: legacy, modernCode: modern, schema: preset.schema, executors, seed: 3 });
    // `n < -100 ? -100 : ...` and `n <= -100 ? -100 : ...` agree for every n (both give -100 at n = -100).
    const survivors = result.mutants.filter((m) => m.status === "SURVIVED").map((m) => m.label).sort();
    expect(survivors).toEqual(["< → <=", "> → >="]);
    expect(result.killRatePercent).toBe(60);
    expect(result.killRatePercent).toBeLessThan(100);
    for (const m of result.mutants.filter((x) => x.status === "SURVIVED")) expect(m.killingCounterexample).toBeNull();
  });

  it("does not fake a kill for mutants in dead code", async () => {
    const result = await runMutationAudit({
      legacyCode: "n * 2",
      modernCode: "const dead = n > 100 ? 1 : 0;\nn + n;",
      schema: { n: "integer" },
      executors,
      seed: 4,
    });
    expect(result.baselineVerified).toBe(true);
    const byLabel = Object.fromEntries(result.mutants.map((m) => [m.label, m.status]));
    expect(byLabel["+ → -"]).toBe("KILLED");
    expect(byLabel["> → >="]).toBe("SURVIVED");
    expect(byLabel["cond ? a : b → !cond ? a : b"]).toBe("SURVIVED");
    expect(result.killed).toBe(1);
    expect(result.survived).toBe(result.totalMutants - 1);
  });

  it("refuses to judge mutants when the baseline itself diverges", async () => {
    const result = await runMutationAudit({ legacyCode: "(n / 2) | 0", modernCode: "Math.floor(n / 2)", schema: { n: "integer" }, executors, seed: 5 });
    expect(result.baselineVerified).toBe(false);
    expect(result.totalMutants).toBe(0);
    expect(result.killRatePercent).toBe(0);
    expect(result.note).toContain("diverges");
  });
});
