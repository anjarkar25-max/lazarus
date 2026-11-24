import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { scanLegacyAst } from "../ast-scanner.js";
import { VmProbeExecutor } from "../vm-executor.js";

const vm = new VmProbeExecutor();

/** Run the extracted expression with the given globals, the way the sandbox does. */
async function evaluate(expression: string, context: Record<string, unknown>): Promise<unknown> {
  return (await vm.run({ code: expression, context })).output;
}

describe("AST specimen extractor", () => {
  it("extracts every parameter of a multi-parameter CommonJS module", async () => {
    const scan = scanLegacyAst("module.exports = function mix(a, b, c) {\n  var s = a * 3 + b - c;\n  return (s / 2) | 0;\n};");
    const fn = scan.functions[0];
    expect(scan.parsed).toBe(true);
    expect(scan.functions).toHaveLength(1);
    expect(fn?.name).toBe("mix");
    expect(fn?.params).toEqual(["a", "b", "c"]);
    expect(fn?.paramNames).toEqual(["a", "b", "c"]);
    expect(fn?.arity).toBe(3);
    expect(fn?.isExported).toBe(true);
    expect(fn?.exportedAs).toBe("default");
    expect(scan.primaryExpression).toContain('typeof c !== "undefined"');
    expect(await evaluate(scan.primaryExpression, { a: 4, b: 3, c: 1 })).toBe(7);
  });

  it("keeps exports.fn and module.exports.fn modules apart and prefers the first export", () => {
    const scan = scanLegacyAst(
      "exports.checksum = function (s) { return String(s).length | 0; };\nmodule.exports.scale = function (n, k) { return n * k; };"
    );
    expect(scan.functions.map((f) => f.name)).toEqual(["checksum", "scale"]);
    expect(scan.functions.map((f) => f.params)).toEqual([["s"], ["n", "k"]]);
    expect(scan.primary?.name).toBe("checksum");
    expect(scan.detectedIdioms).toContain("CommonJS export");
  });

  it("handles named ES5 function declarations exported by name", async () => {
    const scan = scanLegacyAst("function area(w, h) { var r = w * h; return r; }\nmodule.exports = area;");
    expect(scan.primary?.name).toBe("area");
    expect(scan.primary?.isExported).toBe(true);
    expect(scan.primary?.paramNames).toEqual(["w", "h"]);
    expect(await evaluate(scan.primaryExpression, { w: 6, h: 7 })).toBe(42);
  });

  it("expands module.exports = { ... } members, including shorthand methods and arrows", async () => {
    const scan = scanLegacyAst("module.exports = {\n  add: function (a, b) { return a + b; },\n  sub(a, b) { return a - b; },\n  neg: (a) => -a\n};");
    expect(scan.functions.map((f) => [f.name, f.kind])).toEqual([["add", "expression"], ["sub", "method"], ["neg", "arrow"]]);
    const sub = scanLegacyAst("module.exports = { sub(a, b) { var d = a - b; return d + 0; } };", { functionName: "sub" });
    expect(await evaluate(sub.primaryExpression, { a: 10, b: 4 })).toBe(6);
  });

  it("selects a function by name or export name", () => {
    const source = "exports.first = function (a) { return a; };\nexports.second = function (a, b) { return a + b; };";
    expect(scanLegacyAst(source, { functionName: "second" }).primary?.arity).toBe(2);
    expect(scanLegacyAst(source, { functionName: "nope" }).primary?.name).toBe("first");
  });

  it("keeps the module's helper statements so helper calls still resolve", async () => {
    const scan = scanLegacyAst("var SCALE = 3;\nfunction helper(x) { return x * SCALE; }\nmodule.exports = function (n, m) { return helper(n) + m; };");
    expect(scan.primary?.exportedAs).toBe("default");
    expect(scan.primaryExpression).toContain("var SCALE = 3;");
    expect(await evaluate(scan.primaryExpression, { n: 5, m: 1 })).toBe(16);
  });

  it("passes defaults and rest parameters through (undefined triggers the default)", async () => {
    const scan = scanLegacyAst("module.exports = function (a, b = 10, ...rest) { return a + b + rest.length; };");
    expect(scan.primary?.params).toEqual(["a", "b = 10", "...rest"]);
    expect(scan.primary?.paramNames).toEqual(["a", "b", "rest"]);
    expect(await evaluate(scan.primaryExpression, { a: 1 })).toBe(11);
    expect(await evaluate(scan.primaryExpression, { a: 1, b: 2 })).toBe(3);
  });

  it("still reduces simple bodies to the bare expression", () => {
    expect(scanLegacyAst("module.exports = function (n) { return (n / 2) | 0; };").primaryExpression).toBe("(n / 2) | 0");
    expect(scanLegacyAst("exports.f = function (n) { var r = (n / 2) | 0; return r; };").primaryExpression).toBe("(n / 2) | 0");
    expect(scanLegacyAst("module.exports = function () { return { a: 1 }; };").primaryExpression).toBe("({ a: 1 })");
  });

  it("does not inline a body that uses this or arguments", async () => {
    const scan = scanLegacyAst("module.exports = function () { return arguments.length; };");
    expect(scan.primary?.usesArguments).toBe(true);
    expect(scan.primaryExpression).toContain("(function ()");
  });

  it("falls back to the plain text for non-function specimens", () => {
    expect(scanLegacyAst("(n / 2) | 0").primaryExpression).toBe("(n / 2) | 0");
    expect(scanLegacyAst("var half = (n / 2) | 0; half;").primaryExpression).toBe("var half = (n / 2) | 0; half");
    expect(scanLegacyAst("module.exports = 42;").primaryExpression).toBe("42");
  });

  it("reports parse failures and still returns text-based idioms", () => {
    const scan = scanLegacyAst("function (a, b) { return a | 0 ");
    expect(scan.parsed).toBe(false);
    expect(scan.parseError).toBeTruthy();
    expect(scan.functions).toEqual([]);
    expect(scan.detectedIdioms).toContain("32-bit bitwise truncation (| 0)");
  });
});

describe("idioms come from syntax, not text", () => {
  it("detects the full ES5 idiom set", () => {
    const scan = scanLegacyAst(
      "var self = this;\nfunction f(a, b) {\n  var n = arguments.length;\n  if (a == b) { return Math.max.apply(null, [a, b]); }\n  return (Math.floor(a / 2) + n + String(a).charCodeAt(0)) | 0;\n}\nF.prototype.x = 1;\nmodule.exports = f;"
    );
    expect(scan.detectedIdioms).toEqual([
      "ES5 var declaration",
      "32-bit bitwise truncation (| 0)",
      "Math.floor division",
      "CommonJS export",
      "ASCII charCodeAt loop",
      "ES5 arguments object",
      "Function.prototype.apply call",
      "Loose equality (== / !=)",
      "Prototype assignment",
    ]);
  });

  it("ignores idioms that only appear in strings, comments or property names", () => {
    const scan = scanLegacyAst('// var arguments == apply | 0\nconst text = "var x = a == b | 0; arguments; module.exports";\nconst o = { arguments: 1 };\no.arguments;');
    expect(scan.detectedIdioms).toEqual([]);
  });
});

describe("schema inference", () => {
  it("maps parameter usage to fuzz kinds", () => {
    const scan = scanLegacyAst(
      "module.exports = function (text, list, n, flag, tag) {\n  if (typeof flag == 'boolean') { n = n + 1; }\n  if (typeof tag === 'string') { n = n + 1; }\n  list.forEach(function (x) { n += x; });\n  return text.toUpperCase() + n;\n};"
    );
    expect(scan.suggestedSchema).toEqual({ text: "string", list: "json", n: "integer", flag: "boolean", tag: "string" });
  });

  it("treats a parameter that is only measured or indexed as a string", () => {
    expect(scanLegacyAst("exports.f = function (s) { var c = 0; for (var i = 0; i < s.length; i++) { c += s[i] === 'a'; } return c; };").suggestedSchema).toEqual({ s: "string" });
  });
});

describe("property: no parameter is ever lost", () => {
  it("a k-parameter module returns the sum of all k inputs", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 1, maxLength: 6 }), fc.boolean(), async (values, useExportsStyle) => {
        const names = values.map((_, i) => `p${i}`);
        const body = `var total = 0;\n${names.map((n) => `total += ${n};`).join("\n")}\nreturn total;`;
        const source = useExportsStyle
          ? `exports.sum = function (${names.join(", ")}) { ${body} };`
          : `module.exports = function (${names.join(", ")}) { ${body} };`;
        const scan = scanLegacyAst(source);
        expect(scan.primary?.paramNames).toEqual(names);
        expect(Object.keys(scan.suggestedSchema)).toEqual(names);
        const context = Object.fromEntries(names.map((n, i) => [n, values[i]]));
        expect(await evaluate(scan.primaryExpression, context)).toBe(values.reduce((a, b) => a + b, 0));
      }),
      { numRuns: 60 }
    );
  });
});
