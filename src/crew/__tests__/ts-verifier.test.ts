import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../cli.js";
import { buildGraphBundle, graphBundleZip } from "../../exporter/graph-bundle.js";
import { generateVerifiedBundle } from "../../exporter/verified-bundle.js";
import { readZip } from "../../exporter/zip.js";
import type { InputSchema } from "../../fuzzer/types.js";
import { scanLegacyAst } from "../../sandbox/ast-scanner.js";
import { PooledProbeRunner } from "../../sandbox/pool.js";
import { buildExportBundle, createWebServer } from "../../web/server.js";
import { resurrectGraph } from "../graph-resurrector.js";
import { resurrectModule } from "../module-resurrection.js";
import { ResurrectionOrchestrator } from "../orchestrator.js";
import { applyBoundaryFixes } from "../ts-emit.js";
import { STRICT_COMPILER_OPTIONS, StrictTsVerifier, closeSharedTsVerifier, installedTypeScriptVersion, strictTsconfig, verifyStrictTypeScript } from "../ts-verifier.js";
import { inferSignature } from "../type-alchemist.js";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../../..");
const tscBin = nodePath.join(nodePath.dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
const tempEntries = (): string[] => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("lazarus-tsc-"));
const tempBefore = tempEntries();

/** Independent check: the real tsc CLI, run in a directory with the project's own tsconfig.json. */
function realTsc(dir: string): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, [tscBin, "--noEmit", "-p", "tsconfig.json", "--pretty", "false"], { cwd: dir, encoding: "utf8" });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

const BUG = {
  "ok.ts": "export function half(n: number): number {\n  return Math.trunc(n / 2) || 0;\n}\n",
  "bad.ts": 'import { half } from "./ok.js";\nexport const y = half(2);\nconst x: number = "boom";\nexport { x };\n',
};

afterAll(async () => {
  await closeSharedTsVerifier();
});

describe("environment", () => {
  it("uses the installed TypeScript and lists it as a production dependency", () => {
    const pkg = JSON.parse(fs.readFileSync(nodePath.join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(pkg.dependencies?.typescript).toBeDefined();
    expect(pkg.devDependencies?.typescript).toBeUndefined();
    const lock = JSON.parse(fs.readFileSync(nodePath.join(root, "package-lock.json"), "utf8")) as { packages: Record<string, { dev?: boolean; version?: string }> };
    expect(lock.packages["node_modules/typescript"]?.dev).toBeUndefined();
    expect(lock.packages["node_modules/@typescript/typescript-linux-x64"]?.dev).toBeUndefined();
    expect(installedTypeScriptVersion()).toBe(lock.packages["node_modules/typescript"]?.version);
    expect(STRICT_COMPILER_OPTIONS).toMatchObject({ strict: true, noImplicitAny: true, target: "ES2022", module: "NodeNext", noEmit: true });
  });
});

describe("verifyStrictTypeScript", () => {
  it.each(["api", "cli"] as const)("%s engine: reports a deliberate type bug with its real line, column, code and message", async (engine) => {
    const verifier = new StrictTsVerifier({ engine });
    try {
      const r = await verifier.verify(BUG);
      expect(r.engine).toBe(engine === "api" ? "typescript-api" : "tsc-cli");
      expect(r.passed).toBe(false);
      expect(r.errorCount).toBe(1);
      expect(r.diagnostics).toEqual([{ file: "bad.ts", line: 3, column: 7, code: 2322, message: "Type 'string' is not assignable to type 'number'." }]);
      const clean = await verifier.verify({ "ok.ts": BUG["ok.ts"] });
      expect(clean).toMatchObject({ passed: true, errorCount: 0, diagnostics: [], filesChecked: 1 });
    } finally {
      await verifier.close();
    }
  }, 30_000);

  it("enforces noImplicitAny and strict null checks", async () => {
    const r = await verifyStrictTypeScript({
      "a.ts": "export function f(p) { return p; }\nexport function g(s: string | null): number { return s.length; }\n",
    });
    expect(r.passed).toBe(false);
    expect(r.diagnostics.map((d) => d.code).sort()).toEqual([18047, 7006]);
  });

  it("checks files in memory: every check is isolated, and nothing is written to disk", async () => {
    const first = await verifyStrictTypeScript({ "m.ts": "export const v: number = 1;\n" });
    const second = await verifyStrictTypeScript({ "m.ts": 'export const v: number = "no";\n' });
    const third = await verifyStrictTypeScript({ "m.ts": "export const v: number = 2;\n" });
    expect([first.passed, second.passed, third.passed]).toEqual([true, false, true]);
    expect(first.engine).toBe("typescript-api");
    // Warm compiler: repeated checks are fast.
    expect(third.elapsedMs).toBeLessThan(1500);
  });

  it("rejects unsafe file names", async () => {
    for (const name of ["../x.ts", "/abs.ts", "a\\b.ts", "a/../b.ts"]) await expect(verifyStrictTypeScript({ [name]: "export {};" })).rejects.toThrow(/unsafe file name/);
  });
});

describe("diagnostic-driven boundary fixes", () => {
  it("declares only what strict mode cannot type, and leaves real conflicts alone", async () => {
    const code = "export function f(start: number): number {\n  class C {\n    constructor(v) {\n      this.v = v;\n    }\n  }\n  const bad: string = 5;\n  return new C(start).v;\n}\n";
    const first = await verifyStrictTypeScript({ "f.ts": code });
    const fixed = applyBoundaryFixes(code, first.diagnostics, "f.ts");
    expect(fixed.adjustments).toEqual(["parameter v (line 3): untyped in the legacy code", "C.v: class field assigned in legacy code"]);
    const second = await verifyStrictTypeScript({ "f.ts": fixed.code });
    // The genuine bug survives the fixes.
    expect(second.diagnostics.map((d) => d.code)).toEqual([2322]);
  });
});

describe("single-file presets pass tsc --strict with 0 errors", () => {
  const COUNTER = "function Counter(start) {\n  this.n = start;\n}\nCounter.prototype.inc = function (step) {\n  this.n = this.n + step;\n  return this;\n};\nCounter.prototype.value = function () {\n  return this.n;\n};\nCounter.create = function (start) {\n  return new Counter(start);\n};\nvar counter = Counter.create(start);\ncounter.inc(step).inc(step);\ncounter.value();";
  const presets: Array<[string, string, InputSchema]> = [
    ["legacy-int-halve", "var half = (n / 2) | 0; half;", { n: "integer" }],
    ["stringHash32", "var h = 0; for (var i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; } h;", { text: "string" }],
    ["legacyCounterClass", COUNTER, { start: "integer", step: "integer" }],
    ["mixAB", "module.exports = function mix(a, b) {\n  var s = a * 3 + b;\n  return (s / 2) | 0;\n};", { a: "integer", b: "integer" }],
  ];

  it.each(presets)("%s", async (name, source, schema) => {
    const r = await new ResurrectionOrchestrator().resurrect({ name, legacyCode: scanLegacyAst(source).primaryExpression, schema, fuzzRuns: 60, seed: 1337, exact: true, collectObservations: true });
    expect(r.success).toBe(true);
    const sig = inferSignature(r.observations ?? [], schema);
    const { bundle, typecheck } = await buildExportBundle({ specimenName: name.replace(/\W/g, "_"), legacyCode: source, modernCode: r.modernCode, schema, typeSignature: sig, fuzzRuns: 60 });
    expect(typecheck.diagnostics).toEqual([]);
    expect(typecheck).toMatchObject({ passed: true, errorCount: 0, widenedReturn: false });
    expect(bundle.files["resurrected.ts"]).toContain("): number {");
    expect(bundle.files["SPEC.md"]).toContain("- **TypeScript Strict Check:** tsc --strict: 0 errors");
    expect(bundle.files["SPEC.md"]).toContain("| TypeScript strict check | tsc --strict: 0 errors");
    if (name === "legacyCounterClass") {
      // Legacy class internals have no observable type: declared any, and listed.
      expect(typecheck.adjustments).toContain("Counter.n: class field assigned in legacy code");
      expect(bundle.files["SPEC.md"]).toContain("Migration boundary (declared `any`)");
      expect(bundle.files["resurrected.ts"]).toContain("export function legacyCounterClass(start: number, step: number): number {");
    } else {
      expect(typecheck.adjustments).toEqual([]);
    }
  }, 30_000);

  it("cjsMathUtils (multi-export module)", async () => {
    const MATH = "exports.clamp = function (n, lo, hi) {\n  return Math.min(hi, Math.max(lo, n));\n};\nexports.halve = function (n) {\n  return (n / 2) | 0;\n};\nexports.average = function (a, b) {\n  return (a + b) / 2;\n};";
    const m = await resurrectModule(MATH, { name: "cjsMathUtils", fuzzRuns: 60, seed: 1337 });
    expect(m.success).toBe(true);
    const { typecheck } = await buildExportBundle({ specimenName: "cjsMathUtils", legacyCode: MATH, modernCode: m.modernCode, functions: m.functions.map((f) => ({ name: f.exportedAs, schema: f.schema, modernCode: f.modernCode })) });
    expect(typecheck).toMatchObject({ passed: true, errorCount: 0, adjustments: [] });
  }, 30_000);
});

describe("widening and honest failures", () => {
  it("widens an observed return type that tsc rejects, and re-verifies", async () => {
    // Every observed output was a number, but the code can also return a string.
    const sig = inferSignature([{ inputs: { n: 1 }, ok: true, output: 1 }, { inputs: { n: 2 }, ok: true, output: 2 }], { n: "integer" });
    const { bundle, typecheck } = await generateVerifiedBundle({ specimenName: "maybe", legacyCode: 'n > 0 ? n : "neg"', modernCode: 'n > 0 ? n : "neg"', specMarkdown: "s", schema: { n: "integer" }, typeSignature: sig });
    expect(typecheck).toMatchObject({ passed: true, errorCount: 0, widenedReturn: true });
    expect(bundle.files["resurrected.ts"]).toContain("export function maybe(n: number): unknown {");
    expect(bundle.files["types.d.ts"]).toContain("export declare function maybe(n: number): unknown;");
    expect(bundle.files["SPEC.md"]).toContain("widened to `unknown`");
  });

  it("reports a genuine error honestly (no fixes, no widening can hide it)", async () => {
    const { bundle, typecheck } = await generateVerifiedBundle({ specimenName: "upper", legacyCode: "n.toUpperCase()", modernCode: "n.toUpperCase()", specMarkdown: "s", schema: { n: "integer" } });
    expect(typecheck.passed).toBe(false);
    expect(typecheck.errorCount).toBe(1);
    expect(typecheck.diagnostics[0]).toMatchObject({ file: "resurrected.ts", code: 2339, message: "Property 'toUpperCase' does not exist on type 'number'." });
    expect(bundle.files["SPEC.md"]).toContain("tsc --strict: 1 error (1 file");
  });
});

describe("web: the server computes the strict check; client claims are ignored", () => {
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

  it("attaches typecheck to /api/resurrect in under 3 s, with the row on the certificate", async () => {
    const started = Date.now();
    const res = await fetch(`${baseUrl}/api/resurrect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "legacy-int-halve", legacyCode: "var half = (n / 2) | 0; half;", schema: { n: "integer" }, seed: 1337 }),
    });
    const frames = (await res.text()).split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as { kind: string; result?: Record<string, unknown> });
    expect(Date.now() - started).toBeLessThan(3000);
    const result = frames.find((f) => f.kind === "result")?.result as { success: boolean; typecheck: { passed: boolean; errorCount: number; engine: string }; certificate: { markdown: string } };
    expect(result.success).toBe(true);
    expect(result.typecheck).toMatchObject({ passed: true, errorCount: 0, engine: "typescript-api" });
    // resurrected.ts plus the types.d.ts the Type Alchemist emits.
    expect(result.certificate.markdown).toMatch(/\| TypeScript strict check \| tsc --strict: 0 errors \(2 files, TypeScript \d+\.\d+\.\d+\) \|/);
  }, 20_000);

  it("ignores a tampered typecheck claim on /api/export-bundle", async () => {
    const res = await fetch(`${baseUrl}/api/export-bundle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specimenName: "upper",
        legacyCode: "n.toUpperCase()",
        modernCode: "n.toUpperCase()",
        schema: { n: "integer" },
        typecheck: { passed: true, errorCount: 0, diagnostics: [], elapsedMs: 1 },
        certificate: { typecheck: { errorCount: 0, filesChecked: 1, tsVersion: "7.0.2" } },
      }),
    });
    const body = (await res.json()) as { files: Record<string, string>; typecheck: { passed: boolean; errorCount: number } };
    expect(body.typecheck).toMatchObject({ passed: false, errorCount: 1 });
    expect(body.files["SPEC.md"]).toContain("| TypeScript strict check | tsc --strict: 1 error (1 file");
    expect(body.files["SPEC.md"]).not.toContain("tsc --strict: 0 errors");
  });
});

describe("typed multi-file graphs", () => {
  const legacyPool = new PooledProbeRunner();
  const modernPool = new PooledProbeRunner();
  afterAll(async () => {
    await Promise.all([legacyPool.close(), modernPool.close()]);
  });
  const readProject = (dir: string): Record<string, string> => {
    const files: Record<string, string> = {};
    for (const f of fs.readdirSync(nodePath.join(root, "examples", dir)).sort()) files[f] = fs.readFileSync(nodePath.join(root, "examples", dir, f), "utf8");
    return files;
  };

  it.each([
    ["legacy-invoice-engine", undefined],
    ["legacy-text-pipeline", { default: { title: "string" as const, width: "integer" as const } }],
  ])("%s: typed .ts project passes tsc --strict, and the unzipped archive passes the real tsc CLI", async (dir, schemas) => {
    const result = await resurrectGraph(readProject(dir), { name: dir, executors: { legacy: legacyPool, modern: modernPool }, fileRuns: 60, graphRuns: 60, seed: 7, ...(schemas !== undefined ? { schemas } : {}) });
    expect(result.success).toBe(true);
    expect(result.typecheck).toMatchObject({ passed: true, errorCount: 0, adjustments: [], engine: "typescript-api" });
    for (const f of result.files) {
      expect(f.tsPath).toMatch(/\.ts$/);
      expect(Object.keys(f.signatures).length).toBeGreaterThan(0);
    }
    const out = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-graph-zip-"));
    try {
      for (const entry of readZip(graphBundleZip(buildGraphBundle(result, { runs: 40 })))) {
        const target = nodePath.join(out, ...entry.name.split("/"));
        fs.mkdirSync(nodePath.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.data);
      }
      expect(JSON.parse(fs.readFileSync(nodePath.join(out, "tsconfig.json"), "utf8"))).toEqual(JSON.parse(strictTsconfig(["src/**/*.ts"])));
      expect(fs.readdirSync(nodePath.join(out, "src")).filter((n) => n.endsWith(".ts")).length).toBe(3);
      const tsc = realTsc(out);
      expect(tsc.output).toBe("");
      expect(tsc.status).toBe(0);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);

  it("types parameters by the values they actually received from other modules", async () => {
    const result = await resurrectGraph(readProject("legacy-text-pipeline"), {
      name: "text",
      executors: { legacy: legacyPool, modern: modernPool },
      fileRuns: 60,
      graphRuns: 60,
      seed: 7,
      schemas: { default: { title: "string", width: "integer" } },
    });
    const trim = result.files.find((f) => f.path === "trim.cjs");
    // Fuzzed per file with integers, called by pad/slug with strings: the observed union, not a guess.
    expect(trim?.tsCode).toContain("export function trimSpaces(str: number | string): string {");
    expect(trim?.tsCode).toContain("@param str observed as number | string (fuzzed as integer)");
    expect(result.files.find((f) => f.path === "slug.cjs")?.tsCode).toContain("function slugify(title: string, width: number): string {");
  }, 60_000);

  it("CLI directory mode writes typed .ts modules and a tsconfig.json that pass the real tsc CLI", async () => {
    const out = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-graph-cli-ts-"));
    try {
      let stdout = "";
      const code = await main([nodePath.join(root, "examples", "legacy-invoice-engine"), "--out", out, "--runs", "40", "--seed", "9"], { stdout: (t) => void (stdout += t), stderr: () => undefined, cwd: root });
      expect(code).toBe(0);
      expect(stdout).toContain("tsc --strict: 0 errors (3 files, TypeScript");
      for (const f of ["src/money.ts", "src/tax.ts", "src/invoice.ts", "tsconfig.json"]) expect(fs.existsSync(nodePath.join(out, f))).toBe(true);
      expect(fs.existsSync(nodePath.join(out, "src", "money.js"))).toBe(false);
      const tsc = realTsc(out);
      expect(tsc.output).toBe("");
      expect(tsc.status).toBe(0);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("cleanup", () => {
  it("leaves no temp directories behind", () => {
    expect(tempEntries().filter((n) => !tempBefore.includes(n))).toEqual([]);
  });
});
