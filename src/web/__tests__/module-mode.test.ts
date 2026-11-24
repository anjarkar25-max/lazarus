import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { AddressInfo } from "node:net";
import { stripTypeScriptTypes } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebServer } from "../server.js";

const MATH_UTILS =
  "exports.clamp = function (n, lo, hi) {\n  return Math.min(hi, Math.max(lo, n));\n};\nexports.halve = function (n) {\n  return (n / 2) | 0;\n};\nexports.average = function (a, b) {\n  return (a + b) / 2;\n};";
const COUNTER =
  "function Counter(start) {\n  this.n = start;\n}\nCounter.prototype.inc = function (step) {\n  this.n = this.n + step;\n  return this;\n};\nCounter.prototype.value = function () {\n  return this.n;\n};\nCounter.create = function (start) {\n  return new Counter(start);\n};\nvar counter = Counter.create(start);\ncounter.inc(step).inc(step);\ncounter.value();";

interface ModuleResult {
  success: boolean;
  attempts: number;
  modernCode: string;
  fuzzReport: { totalRuns: number };
  module?: {
    functions: Array<{ name: string; exportedAs: string; schema: Record<string, string>; success: boolean; modernCode: string }>;
    skipped: unknown[];
    esm: { complete: boolean; exports: string[] };
  };
}

describe("web: multi-export modules and the two new presets", () => {
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

  async function resurrect(body: Record<string, unknown>): Promise<ModuleResult> {
    const res = await fetch(`${baseUrl}/api/resurrect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const frames = text.split("\n\n").filter((f) => f.startsWith("data: "));
    const last = frames.map((f) => JSON.parse(f.slice(6)) as { kind: string; result?: ModuleResult; message?: string }).filter((f) => f.kind === "result" || f.kind === "error").at(-1);
    if (last?.kind !== "result" || last.result === undefined) throw new Error(`no result: ${last?.message ?? text.slice(0, 200)}`);
    return last.result;
  }

  it("cjsMathUtils: nested per-function schema resurrects all three exports", async () => {
    const result = await resurrect({
      name: "cjsMathUtils",
      legacyCode: MATH_UTILS,
      schema: { clamp: { n: "integer", lo: "integer", hi: "integer" }, halve: { n: "integer" }, average: { a: "integer", b: "integer" } },
      seed: 1337,
    });
    expect(result.success).toBe(true);
    expect(result.module?.functions.map((f) => f.exportedAs)).toEqual(["clamp", "halve", "average"]);
    expect(result.module?.functions.every((f) => f.success)).toBe(true);
    expect(result.module?.esm).toMatchObject({ complete: true, exports: ["clamp", "halve", "average"] });
    expect(result.fuzzReport.totalRuns).toBe(300);
  });

  it("a flat schema is accepted too (filtered per function)", async () => {
    const result = await resurrect({ name: "m", legacyCode: MATH_UTILS, schema: { n: "integer", a: "integer", b: "integer", lo: "integer", hi: "integer" }, fuzzRuns: 20 });
    expect(result.success).toBe(true);
    expect(result.module?.functions).toHaveLength(3);
  });

  it("legacyCounterClass: resurrects as a class with exact parity", async () => {
    const result = await resurrect({ name: "legacyCounterClass", legacyCode: COUNTER, schema: { start: "integer", step: "integer" }, seed: 1337 });
    expect(result.success).toBe(true);
    expect(result.module).toBeUndefined();
    expect(result.modernCode).toContain("class Counter");
    expect(result.fuzzReport.totalRuns).toBe(100);
  });

  it("probe with functionName runs that export", async () => {
    const res = await fetch(`${baseUrl}/api/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ legacyCode: MATH_UTILS, functionName: "average", modernCode: "(a + b) / 2", context: { a: 3, b: 4 } }),
    });
    const json = (await res.json()) as { exactParity: boolean; legacy: { display: string } };
    expect(res.status).toBe(200);
    expect(json.legacy.display).toBe("3.5");
    expect(json.exactParity).toBe(true);
  });

  it("export-bundle with functions yields typed named exports and a valid ESM module", async () => {
    const result = await resurrect({ name: "cjsMathUtils", legacyCode: MATH_UTILS, schema: { clamp: { n: "integer", lo: "integer", hi: "integer" }, halve: { n: "integer" }, average: { a: "integer", b: "integer" } }, fuzzRuns: 20 });
    const res = await fetch(`${baseUrl}/api/export-bundle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specimenName: "cjsMathUtils",
        legacyCode: MATH_UTILS,
        modernCode: result.modernCode,
        specMarkdown: "# spec",
        fuzzRuns: 20,
        functions: result.module?.functions.map((f) => ({ name: f.exportedAs, schema: f.schema, modernCode: f.modernCode })),
      }),
    });
    const bundle = (await res.json()) as { files: Record<string, string> };
    expect(res.status).toBe(200);
    for (const name of ["clamp", "halve", "average"]) {
      expect(bundle.files["resurrected.ts"]).toContain(`export function ${name}(`);
      expect(bundle.files["resurrected.mjs"]).toContain(`export function ${name}(`);
    }
    expect(() => stripTypeScriptTypes(bundle.files["resurrected.ts"] ?? "")).not.toThrow();
  });

  it("index.html ships both new presets", () => {
    const html = fs.readFileSync(nodePath.resolve(import.meta.dirname, "../../../public/index.html"), "utf8");
    expect(html).toContain('value: "legacyCounterClass"');
    expect(html).toContain('value: "cjsMathUtils"');
    expect(html).toContain('id = "probeFn"');
  });
});
