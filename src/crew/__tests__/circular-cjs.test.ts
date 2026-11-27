import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import * as fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../cli.js";
import { AUDIT_WORKFLOW_PATH, renderAuditWorkflow } from "../../exporter/bundle.js";
import { buildGraphBundle, graphBundleZip } from "../../exporter/graph-bundle.js";
import { readZip } from "../../exporter/zip.js";
import { PooledProbeRunner } from "../../sandbox/pool.js";
import { decodeTagged } from "../../sandbox/tagged.js";
import { withVirtualFiles } from "../../sandbox/virtual-fs.js";
import { createWebServer } from "../../web/server.js";
import { analyzeGraph, linkEsmForSandbox, resurrectGraph, type GraphResurrectionResult } from "../graph-resurrector.js";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../../..");
const readProject = (dir: string): Record<string, string> => {
  const files: Record<string, string> = {};
  for (const f of fs.readdirSync(nodePath.join(root, "examples", dir)).sort()) files[f] = fs.readFileSync(nodePath.join(root, "examples", dir, f), "utf8");
  return files;
};
const LEDGER = readProject("legacy-circular-ledger");
const legacyPool = new PooledProbeRunner();
const modernPool = new PooledProbeRunner();
const executors = { legacy: legacyPool, modern: modernPool };
afterAll(async () => {
  await Promise.all([legacyPool.close(), modernPool.close()]);
});

describe("analyzeGraph: import cycles are resolved, not refused", () => {
  it("finds the SCC and its edges for a.cjs <-> b.cjs, with no blocking problem", () => {
    const g = analyzeGraph({
      "a.cjs": "var b = require('./b.cjs'); exports.a = function (n) { return n <= 0 ? 0 : 1 + b.b(n - 1); };",
      "b.cjs": "var a = require('./a.cjs'); exports.b = function (n) { return n <= 0 ? 0 : 1 + a.a(n - 1); };",
      "index.cjs": "var a = require('./a.cjs'); exports.run = function (n) { return a.a(n); };",
    });
    expect(g.problems).toEqual([]);
    expect(g.cycles).toEqual([["a.cjs", "b.cjs"]]);
    expect(g.cycleEdges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(["a.cjs->b.cjs", "b.cjs->a.cjs"]);
    expect(g.entry).toBe("index.cjs");
    expect(g.order.at(-1)).toBe("index.cjs");
    expect(new Set(g.order)).toEqual(new Set(g.files));
  });
  it("describes examples/legacy-circular-ledger: tax <-> discount orchestrated by index", () => {
    const g = analyzeGraph(LEDGER);
    expect(Object.keys(LEDGER).sort()).toEqual(["discount.cjs", "index.cjs", "tax.cjs"]);
    expect(g.problems).toEqual([]);
    expect(g.entry).toBe("index.cjs");
    expect(g.cycles).toEqual([["discount.cjs", "tax.cjs"]]);
    expect(g.cycleEdges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(["discount.cjs->tax.cjs", "tax.cjs->discount.cjs"]);
    expect(g.edges.filter((e) => !g.cycleEdges.includes(e)).map((e) => `${e.from}->${e.to}`).sort()).toEqual(["index.cjs->discount.cjs", "index.cjs->tax.cjs"]);
  });
  it("leaves acyclic graphs untouched: no cycle edges, same order", () => {
    for (const dir of ["legacy-invoice-engine", "legacy-text-pipeline"]) {
      const g = analyzeGraph(readProject(dir));
      expect(g.cycles).toEqual([]);
      expect(g.cycleEdges).toEqual([]);
      expect(g.problems).toEqual([]);
    }
  });
  it("a module that requires itself is still a blocking problem", () => {
    const g = analyzeGraph({ "self.cjs": "var me = require('./self.cjs'); exports.s = function (n) { return n; };" });
    expect(g.problems.map((p) => p.kind)).toContain("cycle");
    expect(g.problems.find((p) => p.kind === "cycle")?.message).toBe("circular require chain: self.cjs -> self.cjs");
  });
  it("cycleEdges are exactly the edges whose ends reach each other (property, vs. brute-force reachability)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 6 }), fc.array(fc.tuple(fc.nat(5), fc.nat(5)), { maxLength: 14 }), (n, pairs) => {
        const deps = new Map<number, Set<number>>();
        for (let i = 0; i < n; i++) deps.set(i, new Set());
        for (const [a, b] of pairs) if (a % n !== b % n) deps.get(a % n)?.add(b % n);
        const files: Record<string, string> = {};
        for (let i = 0; i < n; i++) files[`m${i}.cjs`] = `${[...(deps.get(i) ?? [])].map((d) => `var d${d} = require('./m${d}.cjs');`).join("\n")}\nexports.v = function (x) { return x; };`;
        const g = analyzeGraph(files);
        const reaches = (from: number, to: number, seen = new Set<number>()): boolean => {
          if (from === to) return true;
          if (seen.has(from)) return false;
          seen.add(from);
          return [...(deps.get(from) ?? [])].some((next) => reaches(next, to, seen));
        };
        const expected = new Set<string>();
        for (let a = 0; a < n; a++) for (const b of deps.get(a) ?? []) if (reaches(b, a)) expected.add(`m${a}.cjs->m${b}.cjs`);
        expect(new Set(g.cycleEdges.map((e) => `${e.from}->${e.to}`))).toEqual(expected);
        expect(g.problems.filter((p) => p.kind === "cycle")).toEqual([]);
      }),
      { numRuns: 80 }
    );
  });
});

describe("linkEsmForSandbox: live bindings for import cycles", () => {
  const ESM = 'import * as other from "./b.js";\nexport function ping(n) { return n <= 0 ? 0 : 1 + other.pong(n - 1); }\nexport const LIMIT = 3;\n';
  it("installs export getters before the imports run, and keeps the snapshot linking for acyclic modules", () => {
    const live = linkEsmForSandbox(ESM, { live: true });
    expect(live.indexOf('Object.defineProperty(exports, "ping"')).toBeGreaterThan(-1);
    expect(live.indexOf('Object.defineProperty(exports, "ping"')).toBeLessThan(live.indexOf('require("./b.js")'));
    expect(live).toContain('Object.defineProperty(exports, "LIMIT"');
    expect(live).toMatch(/Object\.defineProperty\(ns, k, \{\s*enumerable: true,\s*get/);
    const plain = linkEsmForSandbox(ESM);
    expect(plain).toContain("exports.ping = ping;");
    expect(plain).not.toContain("Object.defineProperty(exports");
    expect(plain.indexOf("exports.ping = ping;")).toBeGreaterThan(plain.indexOf('require("./b.js")'));
  });
  it("runs a two-module ES cycle with real ESM semantics (hoisted functions, live getters, TDZ only for const)", async () => {
    const a = linkEsmForSandbox('import * as b from "./b.js";\nexport function ping(n) { return n <= 0 ? 0 : 1 + b.pong(n - 1); }\nexport const LIMIT = 3;\n', { live: true });
    const bCode = linkEsmForSandbox('import * as a from "./a.js";\nexport function pong(n) { return n <= 0 ? 0 : 1 + a.ping(n - 1) + a.LIMIT * 0; }\n', { live: true });
    const exec = withVirtualFiles(legacyPool, { "a.js": a, "b.js": bCode, "entry.js": linkEsmForSandbox('import { ping } from "./a.js";\nexport const run = (n) => ping(n);\n') });
    const out = await exec.run({ code: 'require("./entry.js").run(6)', encoding: "tagged" });
    expect(decodeTagged(out.output)).toBe(6);
  });
});

describe("legacy-circular-ledger: end-to-end resurrection", () => {
  let result: GraphResurrectionResult;
  const events: string[] = [];
  beforeAll(async () => {
    result = await resurrectGraph(LEDGER, { name: "legacy-circular-ledger", executors, fileRuns: 60, graphRuns: 80, seed: 5, onProgress: (e) => events.push(e.kind === "graph" ? "graph" : e.kind === "node" ? `${e.file}:${e.state}` : e.message) });
  }, 120_000);

  it("resurrects all three files and proves whole-graph exact Object.is parity", () => {
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.files.map((f) => f.path).sort()).toEqual(["discount.cjs", "index.cjs", "tax.cjs"]);
    expect(result.files.every((f) => f.success)).toBe(true);
    expect(result.parity).toMatchObject({ passed: true, exact: true });
    expect(result.parity?.functions.map((f) => f.exportedAs).sort()).toEqual(["ledgerNet", "ledgerTotal"]);
    expect(result.parity?.totalRuns).toBeGreaterThanOrEqual(120);
    expect(events).toContain("graph");
    expect(events.some((e) => e.startsWith("Whole-graph parity proven"))).toBe(true);
  });
  it("self-heals the 32-bit truncation inside the cycle (both partners roll back | 0 -> Math.trunc)", () => {
    for (const f of result.files.filter((x) => x.path === "tax.cjs" || x.path === "discount.cjs")) {
      expect(f.rolledBack, f.path).toContain("bitor0-trunc");
      expect(f.healed, f.path).toBe(true);
    }
  });
  it("emits ES2022 import/export bindings for both partners (live bindings, no require)", () => {
    const tax = result.files.find((f) => f.path === "tax.cjs");
    const discount = result.files.find((f) => f.path === "discount.cjs");
    expect(tax?.esmCode).toContain('import * as discount from "./discount.js";');
    expect(discount?.esmCode).toContain('import * as tax from "./tax.js";');
    expect(tax?.esmCode).toContain("export function settle(");
    expect(discount?.esmCode).toContain("export function settle(");
    for (const f of result.files) expect(f.esmCode).not.toMatch(/\brequire\(|module\.exports/);
  });
  it("passes tsc --strict with 0 errors over the 3 typed modules", () => {
    expect(result.typecheck).toMatchObject({ passed: true, errorCount: 0, filesChecked: 3 });
    expect(result.files.map((f) => f.tsPath).sort()).toEqual(["discount.ts", "index.ts", "tax.ts"]);
    for (const f of result.files) expect(f.tsCode).toContain("export function");
  });
  it("matches the CommonJS graph bit for bit on fresh inputs (property, both run in the sandbox)", async () => {
    const legacy = withVirtualFiles(legacyPool, LEDGER);
    const modernFiles: Record<string, string> = {};
    for (const f of result.files) modernFiles[f.esmPath] = linkEsmForSandbox(f.esmCode.replace(/^\/\/ ast-rules:.*\n/, ""), { live: f.path !== "index.cjs" });
    const modern = withVirtualFiles(modernPool, modernFiles);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: -2_147_483_648, max: 2_147_483_647 }), fc.integer({ min: -3, max: 15 }), fc.constantFrom("ledgerTotal", "ledgerNet"), async (cents, rounds, name) => {
        const run = async (exec: typeof legacy, file: string): Promise<unknown> => decodeTagged((await exec.run({ code: `require("./${file}")[${JSON.stringify(name)}](cents, rounds)`, context: { cents, rounds }, encoding: "tagged" })).output);
        const l = await run(legacy, "index.cjs");
        const m = await run(modern, "index.js");
        expect(Object.is(l, m), `${name}(${cents}, ${rounds}): legacy ${String(l)} vs resurrected ${String(m)}`).toBe(true);
      }),
      { numRuns: 25 }
    );
  }, 60_000);
  it("exports a .zip PR bundle with the cycle's modules and the Code Scanning workflow", () => {
    const bundle = buildGraphBundle(result, { runs: 80 });
    expect(Object.keys(bundle.files)).toEqual(expect.arrayContaining(["src/tax.ts", "src/discount.ts", "src/index.ts", "legacy/tax.cjs", "legacy/discount.cjs", "tsconfig.json", "resurrected.test.ts"]));
    const entries = readZip(graphBundleZip(bundle));
    const names = entries.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["src/tax.ts", "src/discount.ts", AUDIT_WORKFLOW_PATH]));
    expect(entries.find((e) => e.name === AUDIT_WORKFLOW_PATH)?.data.toString("utf8")).toBe(renderAuditWorkflow());
    expect(bundle.files["src/tax.ts"]).toContain('from "./discount.js"');
  });
});

describe("other cycle shapes", () => {
  it("resurrects a three-module cycle (a -> b -> c -> a) behind an acyclic entry", async () => {
    const files = {
      "a.cjs": "var b = require('./b.cjs');\nexports.a = function (n) { return n <= 0 ? 0 : 1 + b.b(n - 1); };\n",
      "b.cjs": "var c = require('./c.cjs');\nexports.b = function (n) { return n <= 0 ? 0 : 2 + c.c(n - 1); };\n",
      "c.cjs": "var a = require('./a.cjs');\nexports.c = function (n) { return n <= 0 ? 0 : 3 + a.a(n - 1); };\n",
      "index.cjs": "var a = require('./a.cjs');\nexports.run = function (n) { return a.a(n % 9); };\n",
    };
    const g = analyzeGraph(files);
    expect(g.cycles).toEqual([["a.cjs", "b.cjs", "c.cjs"]]);
    const r = await resurrectGraph(files, { name: "three-cycle", executors, fileRuns: 30, graphRuns: 40, seed: 2 });
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(r.typecheck?.errorCount).toBe(0);
    expect(r.parity?.passed).toBe(true);
  }, 90_000);
  it("resurrects hoisted function declarations exported through module.exports with the require at the bottom", async () => {
    const files = {
      "even.cjs": "function isEven(n) { return n === 0 ? true : odd.isOdd(n - 1); }\nmodule.exports = { isEven: isEven };\nvar odd = require(\x27./odd.cjs\x27);\n",
      "odd.cjs": "function isOdd(n) { return n === 0 ? false : even.isEven(n - 1); }\nmodule.exports = { isOdd: isOdd };\nvar even = require(\x27./even.cjs\x27);\n",
      "index.cjs": "var even = require(\x27./even.cjs\x27);\nexports.parity = function (n) { return even.isEven(n % 40 < 0 ? 0 : n % 40); };\n",
    };
    const g = analyzeGraph(files);
    expect(g.cycles).toEqual([["even.cjs", "odd.cjs"]]);
    const r = await resurrectGraph(files, { name: "even-odd", executors, fileRuns: 30, graphRuns: 40, seed: 4 });
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(r.parity?.passed).toBe(true);
    expect(r.typecheck?.errorCount).toBe(0);
  }, 90_000);
  it("a cycle that cannot be linked exactly is reported, never guessed (default exports read at import time)", async () => {
    const files = {
      "a.cjs": "var b = require('./b.cjs');\nmodule.exports = function (n) { return b(n); };\n",
      "b.cjs": "var a = require('./a.cjs');\nmodule.exports = function (n) { return n; };\n",
      "index.cjs": "var a = require('./a.cjs');\nexports.run = function (n) { return a(n); };\n",
    };
    const r = await resurrectGraph(files, { name: "default-cycle", executors, fileRuns: 20, graphRuns: 20, seed: 1 });
    // Whatever the outcome, it is reported exactly: either parity is proven, or the error names the file.
    if (!r.success) expect(r.error ?? "").toMatch(/parity failed|\.cjs/);
    else expect(r.parity?.passed).toBe(true);
  }, 90_000);
});

describe("CLI and server on a cyclic project", () => {
  it("lazarus <dir> resurrects examples/legacy-circular-ledger and writes the project", async () => {
    const out = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-circ-"));
    let stdout = "";
    try {
      const code = await main([nodePath.join(root, "examples", "legacy-circular-ledger"), "--out", out, "--runs", "40", "--seed", "9"], { stdout: (t) => void (stdout += t), stderr: () => undefined, cwd: root });
      expect(code).toBe(0);
      expect(stdout).toContain("Whole-graph parity proven");
      expect(stdout).toContain("0 errors");
      for (const f of ["src/tax.ts", "src/discount.ts", "src/index.ts", "legacy/tax.cjs", "resurrected.test.ts", "tsconfig.json"]) expect(fs.existsSync(nodePath.join(out, f)), f).toBe(true);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);

  describe("POST /api/resurrect-graph", () => {
    const server = createWebServer();
    let baseUrl = "";
    beforeAll(async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    });
    it("streams a graph frame with cycleEdges, then a successful result", async () => {
      const res = await fetch(`${baseUrl}/api/resurrect-graph`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "legacy-circular-ledger", files: LEDGER, seed: 1337, fileRuns: 40, graphRuns: 40 }) });
      expect(res.status).toBe(200);
      const frames = (await res.text()).split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as { kind: string; graph?: { cycles: string[][]; cycleEdges: Array<{ from: string; to: string }>; problems: unknown[] }; result?: { success: boolean; cycles: string[][]; cycleEdges: unknown[]; typecheck?: { errorCount: number } } });
      const graph = frames.find((f) => f.kind === "graph")?.graph;
      expect(graph?.cycles).toEqual([["discount.cjs", "tax.cjs"]]);
      expect(graph?.cycleEdges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(["discount.cjs->tax.cjs", "tax.cjs->discount.cjs"]);
      expect(graph?.problems).toEqual([]);
      const result = frames.find((f) => f.kind === "result")?.result;
      expect(result).toMatchObject({ success: true, cycles: [["discount.cjs", "tax.cjs"]] });
      expect(result?.cycleEdges).toHaveLength(2);
      expect(result?.typecheck?.errorCount).toBe(0);
    }, 90_000);
  });
});
