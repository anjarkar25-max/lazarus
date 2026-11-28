import * as fs from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SARIF_RULES, auditSources, renderSarif } from "../../cli-audit.js";
import { DifferentialFuzzer } from "../../fuzzer/differential.js";
import { PooledProbeRunner } from "../../sandbox/pool.js";
import { scanLegacyAst } from "../../sandbox/ast-scanner.js";
import { closeSharedTsVerifier } from "../ts-verifier.js";
import { buildExportBundle } from "../../web/server.js";
import { BENCHMARK_PRESETS } from "../../benchmark-presets.js";
import { RULE_ORDER, decodeLevels, defaultLevels, encodeLevels, modernize, readHeaderLevels, stepDown } from "../ast-modernizer.js";
import { naiveRefactor } from "../naive-refactor.js";
import { ResurrectionOrchestrator } from "../orchestrator.js";
import { auditPurity, buildPurityProbe, detectGlobalLeaks } from "../purity-audit.js";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../../..");
const pool = new PooledProbeRunner();
afterAll(async () => {
  await pool.close();
  await closeSharedTsVerifier();
});

const LEAKY = [
  "// ES5 reducer: leaks its accumulator onto the global object and mutates the array it was given",
  "function legacyLeakyMutator(list, factor) {",
  "  total = 0;",
  "  if (!Array.isArray(list)) return total;",
  "  for (var i = 0; i < list.length; i++) {",
  "    list[i] = list[i] * factor;",
  "    total = total + list[i];",
  "  }",
  "  return total;",
  "}",
  "",
  "module.exports = legacyLeakyMutator;",
].join("\n");
const SCHEMA = { list: "json", factor: "integer" } as const;
const names = (code: string, inputs: string[] = []): string[] => detectGlobalLeaks(code, { inputs }).leaks.map((l) => l.name);

describe("detectGlobalLeaks (Acorn scope analysis, nothing executed)", () => {
  it("reports an undeclared assignment inside a function, with its line and function name", () => {
    const scan = detectGlobalLeaks(LEAKY);
    expect(scan.parsed).toBe(true);
    expect(scan.leaks).toHaveLength(1);
    expect(scan.leaks[0]).toMatchObject({ name: "total", line: 3, functionName: "legacyLeakyMutator", writes: 2 });
    expect(scan.leaks[0]?.fix).toBeDefined();
  });
  it("finds `acc = acc + x`, `n++` and `s += 1`, but not declared names, parameters or top-level assignments", () => {
    expect(names("function f(x) { acc = acc + x; return acc; }")).toEqual(["acc"]);
    expect(names("function f() { n++; }")).toEqual(["n"]);
    expect(names("function f() { s += 1; }")).toEqual(["s"]);
    expect(names("function f(x) { var t = 0; t = x; let u = 1; u = 2; x = 3; }")).toEqual([]);
    expect(names("counter = 0; function f() { return 1; }")).toEqual([]);
    expect(names("function f() { counter = 1; }\ncounter = 0;")).toEqual([]);
  });
  it("does not report schema inputs, host names, or programs that use the global object, eval or with", () => {
    expect(names("function f() { n = 1; return n; }", ["n"])).toEqual([]);
    expect(names("function f() { module = 1; exports = 2; window = 3; }")).toEqual([]);
    expect(names("function f() { leaked = 1; return globalThis.leaked; }\nglobalThis;")).toEqual([]);
    expect(names("function f() { leaked = 1; eval('1'); }")).toEqual([]);
    expect(names("function f(o) { with (o) { leaked = 1; } }")).toEqual([]);
  });
  it("reports a parse failure instead of throwing", () => {
    expect(detectGlobalLeaks("function (")).toEqual({ parsed: false, leaks: [] });
  });
  it("marks a leak as repairable only when its name is private to one function and starts with `name = value;`", () => {
    const kept = (code: string): string | undefined => detectGlobalLeaks(code).leaks[0]?.keptBecause;
    expect(detectGlobalLeaks("function f() { t = 0; return t; }").leaks[0]?.fix).toBeDefined();
    expect(kept("function f() { return t; }\nfunction g() { t = 1; }")).toMatch(/outside the function/);
    expect(kept("function f() { if (x) { t = 0; } return t; }")).toMatch(/not a plain/);
    expect(kept("function f() { t = t + 1; return t; }")).toMatch(/not a plain|reads the name/);
    expect(kept("function f() { var a = t; t = 1; return a; }")).toMatch(/not a plain/);
    expect(kept("function f() { t = [t]; return t; }")).toMatch(/not a plain|reads the name/);
  });
});

describe("rule global-leak-fix", () => {
  it("turns the leaked statement into a `let` of the function and says so in the applied list", () => {
    const result = modernize(LEAKY);
    expect(result.code).toContain("let total = 0;");
    expect(result.code).not.toMatch(/^\s*total = 0;/m);
    const applied = result.applied.find((a) => a.rule === "global-leak-fix");
    expect(applied).toMatchObject({ variant: "declare", line: 3, before: "total = 0", after: "let total = 0", speculative: false });
    expect(applied?.note).toContain("legacyLeakyMutator");
    expect(result.flagged.some((f) => f.kind === "global-leak")).toBe(false);
  });
  it("keeps and flags a leak it cannot prove private, and leaves the code unchanged", () => {
    const shared = "function a() { total = 0; }\nfunction b() { return total; }\nb();";
    const result = modernize(shared);
    expect(result.applied.some((a) => a.rule === "global-leak-fix")).toBe(false);
    expect(result.flagged).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "global-leak", text: "total" })]));
    expect(result.code).toContain("total = 0;");
    expect(result.code).not.toContain("let total");
  });
  it("is a Necromancer rule with a two-step ladder that can be rolled back, and the schema inputs are never declared", () => {
    expect(RULE_ORDER).toContain("global-leak-fix");
    const off = modernize(LEAKY, { levels: stepDown(defaultLevels(), "global-leak-fix") });
    expect(off.code).not.toContain("let total");
    expect(off.flagged.some((f) => f.kind === "global-leak")).toBe(true);
    const input = modernize("function f() { n = 1; return n; }\nf();", { inputs: ["n"] });
    expect(input.code).not.toContain("let n");
  });
  it("round-trips in the `// ast-rules:` header and still reads headers written before it existed", () => {
    const levels = stepDown(defaultLevels(), "global-leak-fix");
    expect(decodeLevels(encodeLevels(levels))).toEqual(levels);
    expect(encodeLevels(defaultLevels())).toMatch(/global-leak-fix=declare$/);
    const old = "// ast-rules: var-scoping=let-const prototype-class=class arguments-rest=rest apply-spread=spread function-arrow=arrow bitor0-trunc=trunc-or0 loose-equality=strict-proven";
    expect(readHeaderLevels(old)).toEqual(defaultLevels());
  });
  it("does not change a constructor that the prototype-class rule refuses for a strict-mode hazard", () => {
    const code = "function C(){ leaked = 1; }\nC.prototype.f = function () { return 1; };\nnew C().f();";
    const result = modernize(code);
    expect(result.applied.some((a) => a.rule === "prototype-class")).toBe(false);
    expect(result.flagged.some((f) => f.kind === "prototype-kept")).toBe(true);
  });
});

describe("naive strict-mode refactor", () => {
  it("adds only \"use strict\" to code that leaks, so it throws a ReferenceError that Lazarus avoids", async () => {
    const expression = scanLegacyAst(LEAKY).primaryExpression;
    const naive = naiveRefactor(expression);
    expect(naive.rewrites.map((r) => r.rule)).toContain("strict-mode");
    expect(naive.naiveCode.startsWith('"use strict";')).toBe(true);
    await expect(pool.run({ code: naive.naiveCode, context: { list: [1, 2], factor: 2 } })).rejects.toThrow(/total is not defined/);
    const lazarus = modernize(expression, { inputs: ["list", "factor"] }).code;
    expect((await pool.run({ code: `"use strict";\n${lazarus}`, context: { list: [1, 2], factor: 2 } })).output).toBe(6);
    expect(naiveRefactor("var half = (n / 2) | 0; half;").rewrites.map((r) => r.rule)).not.toContain("strict-mode");
  });
});

describe("legacyLeakyMutator end to end (parity, purity, tsc --strict)", () => {
  it("is a built-in Tab 1 preset and a benchmark preset with the leaky ES5 source", () => {
    const html = fs.readFileSync(nodePath.join(root, "public", "index.html"), "utf8");
    expect(html).toContain('value: "legacyLeakyMutator"');
    expect(html).toContain("function legacyLeakyMutator(list, factor)");
    expect(html).toContain('schema: \'{"list": "json", "factor": "integer"}\'');
    expect(BENCHMARK_PRESETS.find((p) => p.name === "legacyLeakyMutator")?.schema).toEqual({ list: "json", factor: "integer" });
  });
  it("proves Object.is parity and the purity pillar, and exports a strict TypeScript bundle with 0 errors", async () => {
    const scan = scanLegacyAst(LEAKY);
    const orchestrator = new ResurrectionOrchestrator();
    const r = await orchestrator.resurrect({ name: "legacyLeakyMutator", legacyCode: scan.primaryExpression, schema: SCHEMA as never, fuzzRuns: 80, seed: 11, exact: true, purityAudit: true });
    expect(r.success).toBe(true);
    expect(r.modernCode).toContain("let total = 0;");
    expect(r.ruleBlame?.find((b) => b.rule === "global-leak-fix")).toMatchObject({ status: "applied" });
    expect(r.purityProof).toMatchObject({ globalLeaksDetected: ["total"], globalLeaksEliminated: true, prototypeSafe: true, inputMutationParity: true, legacyMutatesInput: true, legacyLeakedGlobals: ["total"], proven: true });
    expect(r.purityProof?.samples).toBeGreaterThan(0);
    const bundle = await buildExportBundle({ specimenName: "legacyLeakyMutator", legacyCode: LEAKY, modernCode: r.modernCode, fuzzRuns: r.fuzzReport.totalRuns, attempts: r.attempts, schema: SCHEMA as never });
    expect(bundle.typecheck.errorCount).toBe(0);
    expect(bundle.typecheck.passed).toBe(true);
    expect(bundle.bundle.files["resurrected.ts"]).toContain("let total = 0;");
  }, 90_000);
  it("does not run the purity audit unless asked (existing callers and probe counts are unchanged)", async () => {
    const r = await new ResurrectionOrchestrator().resurrect({ name: "half", legacyCode: "var half = (n / 2) | 0; half;", schema: { n: "integer" }, fuzzRuns: 20, seed: 3, exact: true });
    expect(r.success).toBe(true);
    expect(r.purityProof).toBeUndefined();
    const withAudit = await new ResurrectionOrchestrator().resurrect({ name: "half", legacyCode: "var half = (n / 2) | 0; half;", schema: { n: "integer" }, fuzzRuns: 20, seed: 3, exact: true, purityAudit: true });
    expect(withAudit.purityProof).toMatchObject({ globalLeaksDetected: [], globalLeaksEliminated: true, prototypeSafe: true, inputMutationParity: true, legacyMutatesInput: false, proven: true });
  }, 60_000);
});

describe("auditPurity catches what a naive rewrite breaks", () => {
  const legacy = scanLegacyAst(LEAKY).primaryExpression;
  const run = (modernCode: string) => auditPurity({ legacyCode: legacy, modernCode, schema: SCHEMA as never, executor: pool, seed: 5 });
  it("flags a rewrite that still leaks (fails under \"use strict\")", async () => {
    const proof = await run(legacy);
    expect(proof?.globalLeaksDetected).toEqual(["total"]);
    expect(proof?.globalLeaksEliminated).toBe(false);
    expect(proof?.proven).toBe(false);
  });
  it("flags a rewrite that stops mutating its input (different post-call state)", async () => {
    const fixed = modernize(legacy, { inputs: ["list", "factor"] }).code.replace("list[i] = list[i] * factor;", "");
    const proof = await run(fixed);
    expect(proof?.globalLeaksEliminated).toBe(true);
    expect(proof?.inputMutationParity).toBe(false);
    expect(proof?.legacyMutatesInput).toBe(true);
    expect(proof?.proven).toBe(false);
  });
  it("flags a rewrite that pollutes a built-in prototype", async () => {
    const fixed = modernize(legacy, { inputs: ["list", "factor"] }).code;
    const proof = await run(`Array.prototype.lazarusPolluted = 1;\n${fixed}`);
    expect(proof?.prototypeSafe).toBe(false);
    expect(proof?.proven).toBe(false);
  });
  it("snapshots inputs exactly: -0, NaN and undefined are distinguishable", async () => {
    const probe = buildPurityProbe("list.push(-0);", ["list"], false);
    const out = (await pool.run({ code: probe, context: { list: [0] }, encoding: "tagged" })).output as { before: string[]; after: string[] };
    expect(out.before).toEqual(["[n:0]"]);
    expect(out.after).toEqual(["[n:0,n:-0]"]);
  });
  it("accepts a rewrite identical in behavior, and the differential fuzzer agrees", async () => {
    const fixed = modernize(legacy, { inputs: ["list", "factor"] }).code;
    expect((await run(fixed))?.proven).toBe(true);
    const fuzz = await new DifferentialFuzzer({ legacy: pool, modern: pool }).fuzz(legacy, fixed, SCHEMA as never, { numRuns: 40, seed: 2, exact: true });
    expect(fuzz.passed).toBe(true);
  });
});

describe("LAZ008 UndeclaredGlobalLeak (additive SARIF rule)", () => {
  const sarifOf = (files: Record<string, string>) => renderSarif(auditSources(new Map(Object.entries(files)), [], "."));
  it("reports a leak as a LAZ008 warning on the line of the first assignment and lists the rule only then", () => {
    const log = sarifOf({ "leak.js": LEAKY });
    const rules = log.runs[0]?.tool.driver.rules ?? [];
    expect(rules.map((r) => r.id)).toEqual([...SARIF_RULES.map((r) => r.id), "LAZ008"]);
    expect(rules[7]).toMatchObject({ id: "LAZ008", name: "UndeclaredGlobalLeak", defaultConfiguration: { level: "warning" } });
    const hit = (log.runs[0]?.results ?? []).find((r) => r.ruleId === "LAZ008");
    expect(hit).toMatchObject({ ruleIndex: 7, level: "warning", locations: [{ physicalLocation: { artifactLocation: { uri: "leak.js" }, region: { startLine: 3 } } }] });
    expect(hit?.message.text).toContain("`total`");
    expect(hit?.message.text).toContain("ReferenceError");
  });
  it("leaves every LAZ001-LAZ007 log byte-identical when nothing leaks", () => {
    const clean = sarifOf({ "clean.js": "var half = (n / 2) | 0; half;" });
    expect(clean.runs[0]?.tool.driver.rules.map((r) => r.id)).toEqual(SARIF_RULES.map((r) => r.id));
    expect(clean.runs[0]?.tool.driver.rules).toHaveLength(7);
    expect((clean.runs[0]?.results ?? []).every((r) => r.ruleId !== "LAZ008")).toBe(true);
    const examples = nodePath.join(root, "examples");
    for (const dir of fs.readdirSync(examples).filter((d) => fs.statSync(nodePath.join(examples, d)).isDirectory())) {
      const sources = new Map(fs.readdirSync(nodePath.join(examples, dir)).filter((f) => /\.(c?js)$/.test(f)).map((f) => [f, fs.readFileSync(nodePath.join(examples, dir, f), "utf8")] as const));
      expect(renderSarif(auditSources(sources, [], dir)).runs[0]?.tool.driver.rules, dir).toHaveLength(7);
    }
  });
});
