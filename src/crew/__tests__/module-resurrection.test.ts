import { stripTypeScriptTypes } from "node:module";
import { parse } from "acorn";
import { describe, expect, it } from "vitest";
import { generateResurrectionBundle } from "../../exporter/bundle.js";
import { scanLegacyAst } from "../../sandbox/ast-scanner.js";
import { readHeaderLevels } from "../ast-modernizer.js";
import { toEsmModule } from "../esm-export.js";
import { listModuleFunctions, mergeLevels, resurrectModule } from "../module-resurrection.js";

const EXPORTS_STYLE = `
"use strict";
function add(a, b) { return a + b; }
var sub = function (a, b) { return a - b; };
exports.add = add;
exports.minus = sub;
exports.halve = function (n) { return (n / 2) | 0; };
`;

const OBJECT_STYLE = `
module.exports = {
  clamp: function (n, lo, hi) { return Math.min(hi, Math.max(lo, n)); },
  halve: function (n) { return (n / 2) | 0; },
  average: function (a, b) { return (a + b) / 2; }
};
`;

describe("multi-export scanning", () => {
  it("finds every exports.x function, including identifier exports", () => {
    const scan = scanLegacyAst(EXPORTS_STYLE);
    const names = scan.functions.filter((f) => f.isExported).map((f) => f.exportedAs);
    expect(names).toEqual(["add", "minus", "halve"]);
    expect(scan.detectedIdioms).toContain("CommonJS export");
  });

  it("finds every member of a module.exports object literal", () => {
    const { functions } = listModuleFunctions(OBJECT_STYLE);
    expect(functions.map((f) => f.exportedAs)).toEqual(["clamp", "halve", "average"]);
    expect(functions[0]?.paramKinds).toEqual({ n: "integer", lo: "integer", hi: "integer" });
  });

  it("selects a single export by name and runs it with its helpers", () => {
    const scan = scanLegacyAst(OBJECT_STYLE, { functionName: "average" });
    expect(scan.primary?.exportedAs).toBe("average");
    expect(scan.suggestedSchema).toEqual({ a: "integer", b: "integer" });
  });

  it("skips default exports and functions that use this", () => {
    const { functions, skipped } = listModuleFunctions(
      "exports.a = function (n) { return n; };\nexports.b = function (n) { return this.x + n; };\nexports.c = function (n) { return n + 1; };"
    );
    expect(functions.map((f) => f.exportedAs)).toEqual(["a", "c"]);
    expect(skipped.map((s) => s.name)).toEqual(["b"]);
  });
});

describe("multi-export ESM conversion", () => {
  it.each([
    ["exports.x style", EXPORTS_STYLE, ["add", "minus", "halve"]],
    ["module.exports object", OBJECT_STYLE, ["clamp", "halve", "average"]],
  ])("%s becomes named exports", (_label, source, names) => {
    const esm = toEsmModule(source);
    expect(esm.complete).toBe(true);
    expect(esm.exports).toEqual(names);
    expect(() => parse(esm.code, { ecmaVersion: "latest", sourceType: "module" })).not.toThrow();
    for (const name of names) expect(esm.code).toMatch(new RegExp(`export (function ${name}\\b|\\{[^}]*\\b${name}\\b)`));
    expect(esm.code).not.toContain("exports.");
  });

  it("exports a declared function in place instead of colliding with its own binding", () => {
    const esm = toEsmModule(EXPORTS_STYLE);
    expect(esm.code).toContain("export function add(a, b)");
    expect(esm.code).toContain("minus");
  });

  it("applies rollback levels to the ESM output", () => {
    const rolledBack = mergeLevels(["// ast-rules: var-scoping=let-const prototype-class=class arguments-rest=rest apply-spread=spread function-arrow=arrow bitor0-trunc=off loose-equality=strict-proven\nx"]);
    expect(toEsmModule(OBJECT_STYLE, { levels: rolledBack }).code).toContain("| 0");
    expect(toEsmModule(OBJECT_STYLE).code).toContain("Math.trunc");
  });
});

describe("resurrectModule", () => {
  it("resurrects each export with exact parity and one combined ESM module", async () => {
    const result = await resurrectModule(OBJECT_STYLE, { name: "mathUtils", fuzzRuns: 60, seed: 21 });
    expect(result.success).toBe(true);
    expect(result.functions.map((f) => f.exportedAs)).toEqual(["clamp", "halve", "average"]);
    expect(result.functions.every((f) => f.fuzzReport.exact === true && f.fuzzReport.passed)).toBe(true);
    expect(result.fuzzReport.totalRuns).toBe(180);
    expect(result.events.every((e) => typeof e.payload?.functionName === "string")).toBe(true);
    expect(result.esm.complete).toBe(true);
    expect(result.esm.exports).toEqual(["clamp", "halve", "average"]);
    expect(readHeaderLevels(result.functions[0]?.modernCode)).toBeDefined();
  });

  it("generates a valid TypeScript + ESM bundle with one parity test per function", async () => {
    const result = await resurrectModule(OBJECT_STYLE, { name: "mathUtils", fuzzRuns: 30, seed: 22 });
    const bundle = generateResurrectionBundle({
      specimenName: "mathUtils",
      legacyCode: OBJECT_STYLE,
      legacySource: OBJECT_STYLE,
      modernCode: result.modernCode,
      specMarkdown: result.specMarkdown,
      fuzzRuns: 30,
      esmModule: { code: result.esm.code, exports: result.esm.exports },
      functions: result.functions.map((f) => ({ name: f.exportedAs, schema: f.schema, legacyCode: f.legacyCode, modernCode: f.modernCode })),
    });
    const ts = bundle.files["resurrected.ts"];
    for (const name of ["clamp", "halve", "average"]) {
      expect(ts).toContain(`export function ${name}(`);
      expect(bundle.files["resurrected.test.ts"]).toContain(`runLegacy_${name}`);
    }
    expect(() => stripTypeScriptTypes(ts)).not.toThrow();
    expect(() => stripTypeScriptTypes(bundle.files["resurrected.test.ts"])).not.toThrow();
    const mjs = bundle.files["resurrected.mjs"] ?? "";
    expect(() => parse(mjs, { ecmaVersion: "latest", sourceType: "module" })).not.toThrow();
    expect(bundle.files["SPEC.md"]).toContain("clamp(");
  });

  it("without `functions` the bundle keeps the single-function layout", () => {
    const bundle = generateResurrectionBundle({ specimenName: "half", legacyCode: "(n / 2) | 0", modernCode: "Math.trunc(n / 2) || 0", specMarkdown: "spec", schema: { n: "integer" } });
    expect(bundle.files["resurrected.ts"]).toContain("export function half(n: number): unknown {");
    expect(bundle.files["resurrected.test.ts"]).toContain("function runLegacy(n: number)");
  });
});
