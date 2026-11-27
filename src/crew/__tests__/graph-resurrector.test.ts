import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "acorn";
import * as fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../../cli.js";
import { renderAuditWorkflow } from "../../exporter/bundle.js";
import { buildGraphBundle, graphBundleZip } from "../../exporter/graph-bundle.js";
import { readZip } from "../../exporter/zip.js";
import { PooledProbeRunner } from "../../sandbox/pool.js";
import { toEsmModule } from "../esm-export.js";
import { analyzeGraph, linkEsmForSandbox, relativeSpecifier, resurrectGraph, type GraphProgress } from "../graph-resurrector.js";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../../..");
const readProject = (dir: string): Record<string, string> => {
  const files: Record<string, string> = {};
  for (const f of fs.readdirSync(nodePath.join(root, "examples", dir)).sort()) files[f] = fs.readFileSync(nodePath.join(root, "examples", dir, f), "utf8");
  return files;
};
const INVOICE = readProject("legacy-invoice-engine");
const TEXT = readProject("legacy-text-pipeline");

const legacyPool = new PooledProbeRunner();
const modernPool = new PooledProbeRunner();
const executors = { legacy: legacyPool, modern: modernPool };
afterAll(async () => {
  await Promise.all([legacyPool.close(), modernPool.close()]);
});

describe("analyzeGraph", () => {
  it("extracts relative require edges and a topological order with leaves first and the entry last", () => {
    const g = analyzeGraph(INVOICE);
    expect(g.problems).toEqual([]);
    expect(g.entry).toBe("invoice.cjs");
    expect(g.order).toEqual(["money.cjs", "tax.cjs", "invoice.cjs"]);
    expect(g.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(["invoice.cjs->money.cjs", "invoice.cjs->tax.cjs", "tax.cjs->money.cjs"]);
    expect(g.depth).toEqual({ "money.cjs": 0, "tax.cjs": 1, "invoice.cjs": 2 });
    expect(g.esmPaths["money.cjs"]).toBe("money.js");
    expect(analyzeGraph(TEXT).order).toEqual(["trim.cjs", "pad.cjs", "slug.cjs"]);
  });

  it("resolves nested folders, ../ hops and extensionless specifiers", () => {
    const g = analyzeGraph({
      "src/index.js": "var a = require('./lib/a'); var c = require('../shared/c.cjs'); module.exports = function () { return a() + c(); };",
      "src/lib/a.js": "var b = require('./b.js'); module.exports = function () { return b(); };",
      "src/lib/b.js": "module.exports = function () { return 1; };",
      "shared/c.cjs": "module.exports = function () { return 2; };",
    });
    expect(g.problems).toEqual([]);
    expect(g.entry).toBe("src/index.js");
    expect(g.order.at(-1)).toBe("src/index.js");
    expect(g.order.indexOf("src/lib/b.js")).toBeLessThan(g.order.indexOf("src/lib/a.js"));
  });

  it("orders any DAG so that every dependency precedes its dependents, deterministically (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 7 }), fc.array(fc.tuple(fc.nat(6), fc.nat(6)), { maxLength: 14 }), (n, pairs) => {
        const files: Record<string, string> = {};
        for (let i = 0; i < n; i++) {
          // Only edges from a higher index to a lower one, so the graph is acyclic.
          const deps = [...new Set(pairs.filter(([a, b]) => a % n === i && b % n < i).map(([, b]) => b % n))];
          files[`m${i}.cjs`] = `${deps.map((d) => `var d${d} = require('./m${d}.cjs');`).join("\n")}\nexports.v = function (x) { return x; };`;
        }
        const g = analyzeGraph(files);
        expect(g.cycles).toEqual([]);
        expect(new Set(g.order).size).toBe(n);
        for (const e of g.edges) expect(g.order.indexOf(e.to)).toBeLessThan(g.order.indexOf(e.from));
        expect(g.order.at(-1)).toBe(g.entry);
        expect(analyzeGraph(files).order).toEqual(g.order);
      }),
      { numRuns: 60 }
    );
  });

  it("detects cycles (including self-requires); only a self-require still refuses to resurrect (V14 resolves module cycles)", async () => {
    const g = analyzeGraph({
      "a.cjs": "var b = require('./b.cjs'); exports.a = function () { return 1; };",
      "b.cjs": "var c = require('./c.cjs'); exports.b = function () { return 2; };",
      "c.cjs": "var a = require('./a.cjs'); exports.c = function () { return 3; };",
      "self.cjs": "var me = require('./self.cjs'); exports.s = function () { return 4; };",
    });
    expect(g.cycles).toEqual([["a.cjs", "b.cjs", "c.cjs"], ["self.cjs"]]);
    expect(g.problems.filter((p) => p.kind === "cycle").map((p) => p.message)).toEqual(["circular require chain: self.cjs -> self.cjs"]);
    expect(g.cycleEdges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(["a.cjs->b.cjs", "b.cjs->c.cjs", "c.cjs->a.cjs", "self.cjs->self.cjs"]);
    const result = await resurrectGraph({ "self.cjs": "var me = require('./self.cjs'); exports.s = function (n) { return n; };" }, { name: "cyclic", executors });
    expect(result.success).toBe(false);
    expect(result.error).toContain("circular require chain");
  });

  it.each([
    ["host module", { "a.cjs": "var fs = require('fs'); exports.a = function () { return 1; };" }, "external-require"],
    ["package", { "a.cjs": "var _ = require('lodash'); exports.a = function () { return 1; };" }, "external-require"],
    ["dynamic specifier", { "a.cjs": "var n = './b'; var b = require(n); exports.a = function () { return 1; };" }, "dynamic-require"],
    ["missing module", { "a.cjs": "var b = require('./nope.cjs'); exports.a = function () { return 1; };" }, "missing-module"],
    ["traversal", { "a.cjs": "var b = require('../../etc/passwd'); exports.a = function () { return 1; };" }, "missing-module"],
    ["output collision", { "a.cjs": "exports.a = function () { return 1; };", "a.js": "exports.b = function () { return 2; };" }, "path-collision"],
  ] as const)("reports %s as a problem", (_label, files, kind) => {
    expect(analyzeGraph(files).problems.map((p) => p.kind)).toContain(kind);
  });

  it("ignores a locally declared require", () => {
    expect(analyzeGraph({ "a.cjs": "function require(x) { return x; } exports.a = function () { return require('fs'); };" }).problems).toEqual([]);
  });
});

describe("require -> import rewriting", () => {
  const resolve = (exports: string[]) => (spec: string) => ({ source: spec.replace(/\.c?js$/, "") + ".js", exports });

  it.each([
    ["default export", "var m = require('./m.cjs');\nexports.f = function (x) { return m(x); };", ["default"], 'import m from "./m.js";'],
    ["namespace for named exports", "var money = require('./money.cjs');\nexports.f = function (x) { return money.add(x, 1); };", ["add"], 'import * as money from "./money.js";'],
    ["member access", "var add = require('./money.cjs').add;\nexports.f = function (x) { return add(x, 1); };", ["add"], 'import {add} from "./money.js";'],
    ["destructuring", "const { add, sub: minus } = require('./money.cjs');\nexports.f = function (x) { return minus(add(x, 1), 1); };", ["add", "sub"], 'import {add, sub as minus} from "./money.js";'],
  ])("%s", (_label, source, exports, expected) => {
    const esm = toEsmModule(source, { resolveRequire: resolve(exports) });
    expect(esm.complete).toBe(true);
    expect(esm.code).toContain(expected);
    expect(esm.code).not.toContain("require(");
    expect(() => parse(esm.code, { ecmaVersion: "latest", sourceType: "module" })).not.toThrow();
  });

  it("falls back to a default import plus destructuring when the target has no such named export", () => {
    const esm = toEsmModule("const { a } = require('./m.cjs');\nexports.f = function () { return a; };", { resolveRequire: resolve(["default"]) });
    expect(esm.code).toMatch(/import __lz_m from "\.\/m\.js";\s*const \{a\} = __lz_m;/);
  });

  it("refuses a require that is not a top-level declaration (no exact ESM equivalent)", () => {
    const esm = toEsmModule("exports.f = function () { return require('./m.cjs').x; };", { resolveRequire: resolve(["x"]) });
    expect(esm.complete).toBe(false);
  });

  it("computes relative import specifiers between folders", () => {
    expect(relativeSpecifier("", "money.js")).toBe("./money.js");
    expect(relativeSpecifier("src", "src/lib/a.js")).toBe("./lib/a.js");
    expect(relativeSpecifier("src/lib", "shared/c.js")).toBe("../../shared/c.js");
  });

  it("links ES modules for the sandbox 1:1 and keeps them strict", () => {
    const linked = linkEsmForSandbox('import * as m from "./m.js";\nimport d from "./d.js";\nimport {a as b} from "./a.js";\nexport function f(x) { return m.g(x) + d + b; }\nconst k = 1;\nexport {k as K};\nexport default f;');
    expect(linked.startsWith('"use strict";')).toBe(true);
    expect(linked).toContain('const m = __lzNamespace(require("./m.js"));');
    expect(linked).toContain('const d = require("./d.js").default;');
    expect(linked).toContain('const b = require("./a.js").a;');
    expect(linked).toMatch(/exports\.f = f;\s*exports\.K = k;\s*exports\.default = __lz_default;$/);
  });
});

describe("resurrectGraph", () => {
  it("resurrects the invoice engine leaves first, self-heals money.cjs, stitches imports and proves whole-graph parity", async () => {
    const events: GraphProgress[] = [];
    const result = await resurrectGraph(INVOICE, { name: "legacy-invoice-engine", executors, fileRuns: 60, graphRuns: 60, seed: 11, onProgress: (e) => events.push(e) });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.files.map((f) => f.path)).toEqual(["money.cjs", "tax.cjs", "invoice.cjs"]);

    const money = result.files[0];
    // `Math.round(amount * 100) | 0` wraps at 2^31; the boundary corpus finds it and bitor0-trunc is rolled back.
    expect(money?.healed).toBe(true);
    expect(money?.rolledBack).toContain("bitor0-trunc");
    expect(money?.esmCode).toContain("export function toCents(amount)");
    expect(money?.esmCode).toContain("| 0");

    const tax = result.files[1];
    expect(tax?.esmCode).toContain('import * as money from "./money.js";');
    expect(tax?.esmCode).toContain("Math.trunc(cents * RATE_BPS / 10000) || 0");
    expect(result.files[2]?.esmCode).toContain('import * as tax from "./tax.js";');
    for (const f of result.files) expect(f.esmCode).not.toMatch(/require\(|module\.exports|exports\./);

    expect(result.parity).toMatchObject({ passed: true, exact: true, totalRuns: 60 });
    expect(result.parity?.functions.map((f) => f.exportedAs)).toEqual(["invoiceTotal"]);

    // Live states: every node goes probing -> (healing) -> resurrected, in topological order.
    const nodeEvents = events.filter((e): e is Extract<GraphProgress, { kind: "node" }> => e.kind === "node");
    expect(nodeEvents.filter((e) => e.state === "resurrected").map((e) => e.file)).toEqual(["money.cjs", "tax.cjs", "invoice.cjs"]);
    expect(nodeEvents.some((e) => e.file === "money.cjs" && e.state === "healing")).toBe(true);
    expect(events[0]?.kind).toBe("graph");
  }, 60_000);

  it("resurrects the text pipeline with a default export and a member import, healing at the graph level", async () => {
    const logs: string[] = [];
    // 20 runs per file is below the boundary-corpus threshold, so the per-file checks cannot reach 2^31; the
    // whole-graph corpus (60 runs) then finds `len | 0` wrapping in pad.cjs and pins the rollback on that file.
    const result = await resurrectGraph(TEXT, {
      name: "legacy-text-pipeline",
      executors,
      fileRuns: 20,
      graphRuns: 60,
      seed: 5,
      schemas: { default: { title: "string", width: "integer" } },
      onProgress: (e) => {
        if (e.kind === "log") logs.push(e.message);
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    const pad = result.files.find((f) => f.path === "pad.cjs");
    expect(pad?.rolledBack).toEqual(["bitor0-trunc"]);
    expect(pad?.notes.join(" ")).toContain("whole-graph counterexample");
    expect(pad?.esmCode).toContain("len | 0");
    expect(result.files.find((f) => f.path === "trim.cjs")?.rolledBack).toEqual([]);
    expect(logs.some((m) => m.includes("after 1 graph-level rollback"))).toBe(true);
    const slug = result.files.find((f) => f.path === "slug.cjs");
    expect(slug?.esmExports).toEqual(["default"]);
    expect(slug?.esmCode).toContain('import {padLeft} from "./pad.js";');
    expect(slug?.esmCode).toContain("export default slugify;");
    expect(result.parity?.functions[0]).toMatchObject({ exportedAs: "default", passed: true, schema: { title: "string", width: "integer" } });
  }, 60_000);

  it("fails honestly when the stitched graph diverges from the CommonJS graph", async () => {
    // b.cjs mutates the exports object of a.cjs: CommonJS allows it, the ES module namespace (and strict mode) do not.
    const files = {
      "a.cjs": "exports.base = function (n) { return n; };",
      "b.cjs": "var a = require('./a.cjs');\nexports.patch = function (n) { try { a.extra = 1; return n; } catch (e) { return -1; } };",
    };
    const result = await resurrectGraph(files, { name: "mutating", executors, fileRuns: 20, graphRuns: 30, seed: 2 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("whole-graph parity failed");
    expect(result.parity?.passed).toBe(false);
  }, 60_000);

  it("exports a whole-project zip with folders, the multi-file patch, SPEC.md, CI and the Vitest suite", async () => {
    const result = await resurrectGraph(INVOICE, { name: "legacy-invoice-engine", executors, fileRuns: 30, graphRuns: 30, seed: 3 });
    const bundle = buildGraphBundle(result, { runs: 40 });
    const entries = readZip(graphBundleZip(bundle));
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(
      [
        ".github/workflows/lazarus-audit.yml",
        ".github/workflows/lazarus-parity.yml",
        "SPEC.md",
        "legacy/invoice.cjs",
        "legacy/money.cjs",
        "legacy/package.json",
        "legacy/tax.cjs",
        "package.json",
        "resurrected.test.ts",
        "resurrection.patch",
        "src/invoice.ts",
        "src/money.ts",
        "src/package.json",
        "src/tax.ts",
        "tsconfig.json",
      ].sort()
    );
    for (const e of entries) expect(e.data.toString("utf8")).toBe(e.name === ".github/workflows/lazarus-audit.yml" ? renderAuditWorkflow() : bundle.files[e.name]);
    const patch = bundle.files["resurrection.patch"] ?? "";
    for (const f of ["money", "tax", "invoice"]) expect(patch).toContain(`diff --git a/${f}.cjs b/src/${f}.ts`);
    expect(bundle.files["SPEC.md"]).toContain("`money.cjs` -> `tax.cjs` -> `invoice.cjs`");
    expect(bundle.files["resurrected.test.ts"]).toContain("import * as modern from './src/invoice.js';");
    expect(bundle.files["resurrected.test.ts"]).toContain("createRequire(import.meta.url)('./legacy/invoice.cjs')");
    // Typed modules: valid TypeScript whose type-erased form is the verified ES module.
    for (const f of ["src/money.ts", "src/tax.ts", "src/invoice.ts"]) expect(() => parse(stripTypeScriptTypes(bundle.files[f] ?? ""), { ecmaVersion: "latest", sourceType: "module" })).not.toThrow();
  }, 60_000);
});

describe("CLI directory mode", () => {
  it("resurrects examples/legacy-invoice-engine end to end and writes the project", async () => {
    const out = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-graph-cli-"));
    try {
      let stdout = "";
      let stderr = "";
      const code = await main([nodePath.join(root, "examples", "legacy-invoice-engine"), "--out", out, "--runs", "40", "--seed", "9"], {
        stdout: (t) => void (stdout += t),
        stderr: (t) => void (stderr += t),
        cwd: root,
      });
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toContain("order: money.cjs -> tax.cjs -> invoice.cjs");
      expect(stdout).toContain("Whole-graph parity proven");
      for (const f of ["src/money.ts", "src/tax.ts", "src/invoice.ts", "tsconfig.json", "legacy/invoice.cjs", "resurrected.test.ts", "SPEC.md", "resurrection.patch", ".github/workflows/lazarus-parity.yml"]) {
        expect(fs.existsSync(nodePath.join(out, f))).toBe(true);
      }
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);

  it("exits 1 and writes nothing when the graph cannot be resurrected", async () => {
    const input = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-graph-bad-"));
    const out = nodePath.join(input, "out");
    try {
      fs.writeFileSync(nodePath.join(input, "a.cjs"), "var fs = require('fs');\nexports.a = function (n) { return n; };");
      let stderr = "";
      const code = await main([input, "--out", out], { stdout: () => undefined, stderr: (t) => void (stderr += t), cwd: input });
      expect(code).toBe(1);
      expect(stderr).toContain("NOT resurrected");
      expect(stderr).toContain('requires "fs"');
      expect(fs.existsSync(out)).toBe(false);
    } finally {
      fs.rmSync(input, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects an empty directory with usage exit code 2", async () => {
    const input = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-graph-empty-"));
    try {
      let stderr = "";
      expect(await main([input], { stdout: () => undefined, stderr: (t) => void (stderr += t), cwd: input })).toBe(2);
      expect(stderr).toContain("no .js or .cjs files");
    } finally {
      fs.rmSync(input, { recursive: true, force: true });
    }
  });
});
