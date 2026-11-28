import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PooledProbeRunner } from "../../sandbox/pool.js";
import { createWebServer } from "../../web/server.js";
import { buildApiContract, buildIntrospectionProbe, compareExports, describeExports, guardApiContract, type ApiContract, type ExportDescriptor } from "../api-contract.js";
import { linkEsmForSandbox, resurrectGraph, type GraphResurrectionResult } from "../graph-resurrector.js";
import { closeSharedTsVerifier } from "../ts-verifier.js";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../../..");
const readExample = (name: string): Record<string, string> => {
  const dir = nodePath.join(root, "examples", name);
  return Object.fromEntries(fs.readdirSync(dir).filter((f) => /\.c?js$/.test(f)).map((f) => [f, fs.readFileSync(nodePath.join(dir, f), "utf8")]));
};
const fn = (name: string, arity: number, form: ExportDescriptor["form"] = "named", extra: Partial<ExportDescriptor> = {}): ExportDescriptor => ({ name, form, kind: "function", arity, ...extra });
const value = (name: string): ExportDescriptor => ({ name, form: "named", kind: "value", arity: null });

afterAll(async () => {
  await closeSharedTsVerifier();
});

describe("compareExports and buildApiContract (pure)", () => {
  it("preserves identical exports and does not count additive ones", () => {
    expect(compareExports([fn("a", 1), value("RATE")], [fn("a", 1), value("RATE"), fn("extra", 3)])).toEqual([]);
    const contract = buildApiContract([{ file: "m.cjs", legacy: [fn("a", 1), fn("b", 2)], modern: [fn("a", 1), fn("b", 2), fn("c", 0)] }]);
    expect(contract).toMatchObject({ breakingChanges: 0, totalExports: 2, preservedExports: 2 });
    expect(contract.modules[0]).toMatchObject({ file: "m.cjs", preserved: true, breaking: [] });
    expect(contract.modules[0]?.modernExports).toHaveLength(3);
  });

  it("detects a renamed or removed export", () => {
    expect(compareExports([fn("taxFor", 1)], [fn("taxForCents", 1)])).toEqual([{ export: "taxFor(1)", reason: 'the export "taxFor" was removed or renamed' }]);
    expect(compareExports([fn("taxFor", 1), fn("withTax", 1)], [fn("taxFor", 1)])).toEqual([{ export: "withTax(1)", reason: 'the export "withTax" was removed or renamed' }]);
    expect(compareExports([fn("default", 2, "default")], [fn("slug", 2)])).toEqual([{ export: "default(2)", reason: "the default export was removed or renamed" }]);
  });

  it("tells a default export from a named export of the same name", () => {
    expect(compareExports([fn("default", 1, "default")], [fn("default", 1, "named")])).toHaveLength(1);
    expect(compareExports([fn("default", 1, "named")], [fn("default", 1, "default")])).toHaveLength(1);
    expect(compareExports([fn("default", 1, "default")], [fn("default", 1, "default")])).toEqual([]);
  });

  it("detects a changed parameter count and a changed kind", () => {
    expect(compareExports([fn("a", 2)], [fn("a", 1)])).toEqual([{ export: "a(2)", reason: "its parameter count changed from 2 to 1" }]);
    expect(compareExports([fn("a", 2)], [fn("a", 3)])[0]?.reason).toBe("its parameter count changed from 2 to 3");
    expect(compareExports([fn("a", 2)], [value("a")])[0]?.reason).toBe("its kind changed from function to value");
    expect(compareExports([value("RATE")], [fn("RATE", 0)])[0]?.reason).toBe("its kind changed from value to function");
    expect(compareExports([{ name: "K", form: "named", kind: "class", arity: 1 }], [fn("K", 1)])[0]?.reason).toBe("its kind changed from class to function");
  });

  it("accepts a prototype constructor that became a class, but not a plain function that did", () => {
    const cls: ExportDescriptor = { name: "Counter", form: "named", kind: "class", arity: 1 };
    expect(compareExports([fn("Counter", 1, "named", { constructorLike: true })], [cls])).toEqual([]);
    expect(compareExports([fn("Counter", 1)], [cls])).toHaveLength(1);
    expect(compareExports([fn("Counter", 1, "named", { constructorLike: true })], [{ ...cls, arity: 2 }])[0]?.reason).toContain("parameter count");
  });

  it("counts every break across modules", () => {
    const contract = buildApiContract([
      { file: "a.cjs", legacy: [fn("x", 1), fn("y", 1)], modern: [fn("x", 1)] },
      { file: "b.cjs", legacy: [fn("z", 2)], modern: [fn("z", 1)] },
      { file: "c.cjs", legacy: [fn("w", 0)], modern: [fn("w", 0)] },
    ]);
    expect(contract).toMatchObject({ breakingChanges: 2, totalExports: 4, preservedExports: 2 });
    expect(contract.modules.map((m) => m.preserved)).toEqual([false, false, true]);
  });
});

describe("describeExports (sandbox introspection of a module)", () => {
  const describeIn = async (files: Record<string, string>, path = "m.js"): Promise<ExportDescriptor[] | undefined> => {
    await using pool = new PooledProbeRunner();
    return await describeExports(pool, files, path);
  };

  it("describes a default function, named functions, values, classes and constructors by what they are at run time", async () => {
    expect(await describeIn({ "m.js": "module.exports = function (a, b) { return a + b; };" })).toEqual([{ name: "default", form: "default", kind: "function", arity: 2 }]);
    expect(await describeIn({ "m.js": "exports.b = function (x) {}; exports.a = function (x, y, z) {}; exports.RATE = 0.2;" })).toEqual([
      { name: "RATE", form: "named", kind: "value", arity: null },
      { name: "a", form: "named", kind: "function", arity: 3 },
      { name: "b", form: "named", kind: "function", arity: 1 },
    ]);
    expect(await describeIn({ "m.js": "exports.K = class { constructor(a, b) {} };" })).toEqual([{ name: "K", form: "named", kind: "class", arity: 2 }]);
    const ctor = await describeIn({ "m.js": "function C(n) { this.n = n; }\nC.prototype.get = function () { return this.n; };\nmodule.exports = C;" });
    expect(ctor).toEqual([{ name: "default", form: "default", kind: "function", arity: 1, constructorLike: true }]);
    expect(await describeIn({ "m.js": "module.exports = 42;" })).toEqual([{ name: "default", form: "default", kind: "value", arity: null }]);
  });

  it("lists the properties of a default function as named exports, and reads an ES module namespace's default", async () => {
    expect(await describeIn({ "m.js": "function f(a) {}\nf.helper = function (x, y) {};\nmodule.exports = f;" })).toEqual([
      { name: "default", form: "default", kind: "function", arity: 1 },
      { name: "helper", form: "named", kind: "function", arity: 2 },
    ]);
    expect(await describeIn({ "m.js": "exports.default = function (a) {}; exports.named = function () {};" })).toEqual([
      { name: "default", form: "default", kind: "function", arity: 1 },
      { name: "named", form: "named", kind: "function", arity: 0 },
    ]);
  });

  it("follows a relative require, and says nothing about a module that cannot be loaded", async () => {
    expect(await describeIn({ "m.js": "module.exports = require('./dep.js');", "dep.js": "module.exports = function (a) {};" })).toEqual([{ name: "default", form: "default", kind: "function", arity: 1 }]);
    expect(await describeIn({ "m.js": "throw new Error('boom');" })).toBeUndefined();
    expect(await describeIn({ "m.js": "module.exports = require('fs');" })).toBeUndefined();
    expect(await describeIn({ "m.js": "exports.a = 1;" }, "missing.js")).toBeUndefined();
  });

  it("probes only through the virtual require and returns plain JSON", () => {
    const probe = buildIntrospectionProbe("lib/a.js");
    expect(probe).toContain('require("./lib/a.js")');
    expect(probe).toContain("Function.prototype.toString.call");
  });
});

describe("Public API Contract on the example graphs", () => {
  const cases: Array<[string, number, string[]]> = [
    ["legacy-circular-ledger", 6, ["tax.cjs", "discount.cjs", "index.cjs"]],
    ["legacy-invoice-engine", 6, ["money.cjs", "tax.cjs", "invoice.cjs"]],
    ["legacy-text-pipeline", 3, ["trim.cjs", "pad.cjs", "slug.cjs"]],
  ];
  const results = new Map<string, GraphResurrectionResult>();
  beforeAll(async () => {
    for (const [name] of cases) results.set(name, await resurrectGraph(readExample(name), { name, fileRuns: 30, graphRuns: 40, seed: 7 }));
  }, 120_000);

  it.each(cases)("%s: every exported name, kind and arity is preserved (0 breaking changes, %i exports)", (name, total, modules) => {
    const result = results.get(name);
    expect(result?.success, result?.error).toBe(true);
    const contract = result?.apiContract;
    expect(contract).toBeDefined();
    if (contract === undefined) return;
    expect(contract).toMatchObject({ breakingChanges: 0, totalExports: total, preservedExports: total });
    expect(contract.modules.map((m) => m.file).sort()).toEqual([...modules].sort());
    for (const m of contract.modules) {
      expect(m.preserved, m.file).toBe(true);
      expect(m.breaking, m.file).toEqual([]);
      expect(m.legacyExports.length, m.file).toBeGreaterThan(0);
      expect(m.modernExports, m.file).toEqual(m.legacyExports);
    }
  });

  it("reports the real names and arities", () => {
    const ledger = results.get("legacy-circular-ledger")?.apiContract;
    const byFile = (c: ApiContract | undefined, file: string): string[] => (c?.modules.find((m) => m.file === file)?.legacyExports ?? []).map((d) => `${d.form}:${d.name}/${d.arity}`);
    expect(byFile(ledger, "tax.cjs")).toEqual(["named:settle/2", "named:taxOf/1"]);
    expect(byFile(ledger, "discount.cjs")).toEqual(["named:discountOf/1", "named:settle/2"]);
    expect(byFile(ledger, "index.cjs")).toEqual(["named:ledgerNet/2", "named:ledgerTotal/2"]);
    expect(byFile(results.get("legacy-invoice-engine")?.apiContract, "money.cjs")).toEqual(["named:addCents/2", "named:formatCents/1", "named:toCents/1"]);
    // `module.exports = slugify` is a default export in both worlds.
    expect(byFile(results.get("legacy-text-pipeline")?.apiContract, "slug.cjs")).toEqual(["default:default/2"]);
  });

  it("agrees with the typed TypeScript the project ships (every legacy export is exported there, tsc --strict: 0 errors)", () => {
    for (const [name] of cases) {
      const result = results.get(name);
      expect(result?.typecheck?.errorCount, name).toBe(0);
      for (const file of result?.files ?? []) {
        const mod = result?.apiContract?.modules.find((m) => m.file === file.path);
        for (const d of mod?.legacyExports ?? []) {
          const pattern = d.form === "default" ? /export default /.test(file.tsCode) : new RegExp(`export (async )?function ${d.name}\\(|export (const|let|var) ${d.name}\\b`).test(file.tsCode);
          expect(pattern, `${file.path} ${d.name}`).toBe(true);
        }
      }
    }
  });

  describe("accurately detects a breaking change in the stitched ES modules", () => {
    const link = (result: GraphResurrectionResult, edit: (path: string, code: string) => string): Record<string, string> => {
      const cyclic = new Set(result.graph.cycles.filter((c) => c.length > 1).flat());
      return Object.fromEntries(result.files.map((f) => [f.esmPath, linkEsmForSandbox(edit(f.path, f.esmCode), { live: cyclic.has(f.path) })]));
    };
    const guard = async (name: string, edit: (path: string, code: string) => string): Promise<ApiContract | undefined> => {
      const result = results.get(name);
      if (result === undefined) throw new Error(`no result for ${name}`);
      await using legacy = new PooledProbeRunner();
      await using modern = new PooledProbeRunner();
      return await guardApiContract({ legacyFiles: readExample(name), modernGraph: link(result, edit), modules: result.files.map((f) => ({ path: f.path, esmPath: f.esmPath })), executors: { legacy, modern } });
    };

    it("is clean for the unedited modules", async () => {
      expect(await guard("legacy-invoice-engine", (_p, code) => code)).toMatchObject({ breakingChanges: 0, totalExports: 6, preservedExports: 6 });
    }, 30_000);

    it("flags a renamed export", async () => {
      const contract = await guard("legacy-invoice-engine", (path, code) => (path === "tax.cjs" ? `${code.replace("export function taxFor(", "function taxFor(")}\nexport { taxFor as taxForCents };` : code));
      expect(contract).toMatchObject({ breakingChanges: 1, totalExports: 6, preservedExports: 5 });
      const tax = contract?.modules.find((m) => m.file === "tax.cjs");
      expect(tax?.preserved).toBe(false);
      expect(tax?.breaking).toEqual([{ export: "taxFor(1)", reason: 'the export "taxFor" was removed or renamed' }]);
      expect(tax?.modernExports.map((d) => d.name)).toEqual(["taxForCents", "withTax"]);
      expect(contract?.modules.filter((m) => m.preserved).map((m) => m.file)).toEqual(["money.cjs", "invoice.cjs"]);
    }, 30_000);

    it("flags a removed export", async () => {
      const contract = await guard("legacy-invoice-engine", (path, code) => (path === "money.cjs" ? code.replace("export function formatCents(", "function formatCents(") : code));
      expect(contract).toMatchObject({ breakingChanges: 1, preservedExports: 5 });
      expect(contract?.modules.find((m) => m.file === "money.cjs")?.breaking[0]?.export).toBe("formatCents(1)");
    }, 30_000);

    it("flags a changed parameter count and a changed kind, and ignores an added export", async () => {
      const arity = await guard("legacy-invoice-engine", (path, code) => (path === "tax.cjs" ? code.replace("export function taxFor(cents)", "export function taxFor(cents, rate)") : code));
      expect(arity?.breakingChanges).toBe(1);
      expect(arity?.modules.find((m) => m.file === "tax.cjs")?.breaking[0]).toEqual({ export: "taxFor(1)", reason: "its parameter count changed from 1 to 2" });
      const kind = await guard("legacy-invoice-engine", (path, code) => (path === "tax.cjs" ? `${code.replace("export function withTax(", "function withTaxOld(")}\nexport const withTax = 1;` : code));
      expect(kind?.modules.find((m) => m.file === "tax.cjs")?.breaking[0]?.reason).toBe("its kind changed from function to value");
      const added = await guard("legacy-invoice-engine", (path, code) => (path === "tax.cjs" ? `${code}\nexport const EXTRA = 1;` : code));
      expect(added).toMatchObject({ breakingChanges: 0, totalExports: 6 });
      expect(added?.modules.find((m) => m.file === "tax.cjs")?.modernExports.map((d) => d.name)).toEqual(["EXTRA", "taxFor", "withTax"]);
    }, 60_000);

    it("flags a lost default export in the text pipeline", async () => {
      const contract = await guard("legacy-text-pipeline", (path, code) => (path === "slug.cjs" ? code.replace("export default slugify;", "export { slugify };") : code));
      expect(contract?.breakingChanges).toBe(1);
      expect(contract?.modules.find((m) => m.file === "slug.cjs")?.breaking[0]).toEqual({ export: "default(2)", reason: "the default export was removed or renamed" });
    }, 30_000);

    it("says nothing when a module cannot be described instead of guessing", async () => {
      const contract = await guard("legacy-invoice-engine", (path, code) => (path === "money.cjs" ? "throw new Error('broken at load');" : code));
      expect(contract).toBeUndefined();
    }, 30_000);
  });
});

describe("POST /api/resurrect-graph streams the contract", () => {
  const server = createWebServer();
  let baseUrl = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("returns apiContract (0 breaking changes) next to the typecheck, and logs it", async () => {
    const res = await fetch(`${baseUrl}/api/resurrect-graph`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "legacy-circular-ledger", files: readExample("legacy-circular-ledger"), seed: 5, fileRuns: 30, graphRuns: 40 }) });
    expect(res.status).toBe(200);
    const frames = (await res.text()).split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as { kind: string; message?: string; result?: { success: boolean; apiContract?: ApiContract; typecheck?: { errorCount: number }; cycles: string[][]; entry: string } });
    const result = frames.find((f) => f.kind === "result")?.result;
    expect(result?.success).toBe(true);
    expect(result?.typecheck?.errorCount).toBe(0);
    expect(result?.apiContract).toMatchObject({ breakingChanges: 0, totalExports: 6, preservedExports: 6 });
    expect(result?.apiContract?.modules.map((m) => m.file).sort()).toEqual(["discount.cjs", "index.cjs", "tax.cjs"]);
    expect(frames.some((f) => f.kind === "log" && /Public API Contract: 0 breaking changes \(6\/6 exports preserved across 3 modules\)/.test(f.message ?? ""))).toBe(true);
    expect(result?.cycles).toEqual([["discount.cjs", "tax.cjs"]].map((c) => expect.arrayContaining(c) as unknown));
  }, 90_000);
});
