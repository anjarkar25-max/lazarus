import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BENCHMARK_PRESETS } from "../../benchmark-presets.js";
import { scanLegacyAst } from "../../sandbox/ast-scanner.js";
import { describePaste } from "../smart-paste.js";
import { createWebServer } from "../server.js";
import { VmProbeExecutor } from "../../sandbox/vm-executor.js";

describe("smart paste: parameter inference on custom pasted functions", () => {
  it.each([
    ["bare arrow with string methods", "(str, len) => str.slice(0, len)", { str: "string", len: "integer" }, "anonymous(str: string, len: number)"],
    ["function declaration, math only", "function foo(a, b) { return a * b + 1; }", { a: "integer", b: "integer" }, "foo(a: number, b: number)"],
    ["var function expression", "var fn = function (x) { return x.trim().toUpperCase(); };", { x: "string" }, "fn(x: string)"],
    ["module.exports function", "module.exports = function (s, n) { return s.charCodeAt(n) | 0; };", { s: "string", n: "integer" }, "anonymousSpecimen(s: string, n: number)"],
    ["string concatenation", "function greet(name) { return 'Hi ' + name; }", { name: "string" }, "greet(name: string)"],
    ["string comparison", "function isA(s) { return s === 'a'; }", { s: "string" }, "isA(s: string)"],
    ["replace + length", "const clean = (s) => s.replace(/x/g, '').length;", { s: "string" }, "clean(s: string)"],
    ["concatenated partner", "const pad = (str, len, ch) => { while (str.length < len) str = ch + str; return str; };", { str: "string", len: "integer", ch: "string" }, "pad(str: string, len: number, ch: string)"],
    ["flag in a ternary", "function pick(a, b, useA) { return useA ? a : b; }", { a: "integer", b: "integer", useA: "boolean" }, "pick(a: number, b: number, useA: boolean)"],
    ["flag in an if", "function f(n, verbose) { if (verbose) { return n + 1; } return n; }", { n: "integer", verbose: "boolean" }, "f(n: number, verbose: boolean)"],
    ["negated flag", "function g(n, skip) { if (!skip) return n * 2; return n; }", { n: "integer", skip: "boolean" }, "g(n: number, skip: boolean)"],
    ["compared with true", "function e(x) { return x === true ? 1 : 0; }", { x: "boolean" }, "e(x: boolean)"],
    ["anonymous function expression", "(function (a, b) { return a - b; })", { a: "integer", b: "integer" }, "anonymous(a: number, b: number)"],
  ])("%s", (_label, source, schema, signature) => {
    const r = describePaste(source);
    expect(r).toMatchObject({ parsed: true, kind: "function", schema });
    expect(r.signatures).toEqual([signature]);
  });

  it.each([
    ["a counter used as a condition and in arithmetic stays numeric", "function h(n) { if (n) return n - 1; return 0; }", { n: "integer" }],
    ["&& used as a value is not a condition", "function v(a, b) { return a && b; }", { a: "integer", b: "integer" }],
    ["array-only methods win over shared ones", "function f(arr) { arr.push(1); return arr.slice(1); }", { arr: "json" }],
    ["(a + b) + 'x' does not make a or b strings", "function f(a, b) { return a + b + 'x'; }", { a: "integer", b: "integer" }],
  ])("%s", (_label, source, schema) => {
    expect(scanLegacyAst(source).suggestedSchema).toEqual(schema);
  });

  it("a pasted bare function is run by calling it with its parameters", async () => {
    const scan = scanLegacyAst("(str, len) => str.slice(0, len)");
    const res = await new VmProbeExecutor().run({ code: scan.primaryExpression, context: { str: "lazarus", len: 4 } });
    expect(res.output).toBe("laza");
  });

  it("describes modules per export and scripts by their free inputs", () => {
    const mod = describePaste("exports.clamp = function (n, lo, hi) { return Math.min(hi, Math.max(lo, n)); };\nexports.greet = function (name) { return 'Hi ' + name; };");
    expect(mod).toMatchObject({ kind: "module", schema: { clamp: { n: "integer", lo: "integer", hi: "integer" }, greet: { name: "string" } } });
    expect(mod.signatures).toEqual(["clamp(n: number, lo: number, hi: number)", "greet(name: string)"]);
    const script = describePaste("var half = (n / 2) | 0; half;");
    expect(script).toMatchObject({ kind: "script", schema: { n: "integer" }, signatures: ["script(n: number)"] });
    expect(describePaste("function (")).toMatchObject({ parsed: false, kind: "none" });
  });

  it("leaves the inferred schema of every curated preset unchanged", () => {
    const wrong = BENCHMARK_PRESETS.filter((p) => p.module !== true && p.async !== true && p.name !== "legacyLeftPad").filter((p) => JSON.stringify(scanLegacyAst(p.code).suggestedSchema) !== JSON.stringify(p.schema));
    // Error-first callback presets: smart paste drops the callback from the schema.
    const asyncWrong = BENCHMARK_PRESETS.filter((p) => p.async === true).filter((p) => JSON.stringify(describePaste(p.code).schema) !== JSON.stringify(p.schema));
    expect(asyncWrong.map((p) => p.name)).toEqual([]);
    expect(describePaste(BENCHMARK_PRESETS.find((p) => p.async === true)?.code ?? "").signatures).toEqual(["legacyReadConfigCb(text: string) \u2192 Promise (error-first cb)"]);
    expect(wrong.map((p) => p.name)).toEqual([]);
  });
});

describe("POST /api/scan", () => {
  const server = createWebServer();
  let baseUrl = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
  const post = (body: unknown): Promise<Response> => fetch(`${baseUrl}/api/scan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("returns the signature and schema of a pasted function", async () => {
    const res = await post({ legacyCode: "(str, len) => str.slice(0, len)" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ parsed: true, kind: "function", schema: { str: "string", len: "integer" }, signatures: ["anonymous(str: string, len: number)"] });
  });

  it("only parses: hostile code is never executed", async () => {
    const started = Date.now();
    const res = await post({ legacyCode: "while (true) {} process.exit(1); require('child_process').execSync('echo pwned');" });
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);
    // The server is still alive and answering.
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  it.each([[{}], [{ legacyCode: 5 }], [{ legacyCode: "x", extra: 1 }], [{ legacyCode: "x".repeat(64_001) }]])("rejects %j with 400", async (body) => {
    expect((await post(body)).status).toBe(400);
  });
});
