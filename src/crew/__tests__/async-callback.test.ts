import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditDirectory } from "../../cli-audit.js";
import { DifferentialFuzzer } from "../../fuzzer/differential.js";
import { PooledProbeRunner } from "../../sandbox/pool.js";
import { SandboxError } from "../../sandbox/errors.js";
import { isProbeParams } from "../../sandbox/validate.js";
import { FakeDocument, runInlineScript } from "../../web/__tests__/fake-dom.js";
import { buildExportBundle, createWebServer } from "../../web/server.js";
import {
  buildLegacyHarness,
  buildModernHarness,
  detectErrorFirst,
  liftErrorFirst,
  literalExamples,
  promiseWrapper,
  readEnvelope,
  resurrectErrorFirstWith,
  stripAsyncTypes,
  type ErrorFirstFunction,
} from "../async-callback.js";
import { ResurrectionOrchestrator } from "../orchestrator.js";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../../..");
const pageHtml = fs.readFileSync(nodePath.join(root, "public", "index.html"), "utf8");
/** The shipped Tab 1 preset (the page is the single source of truth). */
const PRESET: string = (() => {
  const m = /value: "legacyReadConfigCb",[\s\S]*?code: ("(?:[^"\\]|\\.)*"),/.exec(pageHtml);
  if (m?.[1] === undefined) throw new Error("legacyReadConfigCb preset not found in public/index.html");
  return JSON.parse(m[1]) as string;
})();

const legacyPool = new PooledProbeRunner();
const modernPool = new PooledProbeRunner();
const fuzzer = new DifferentialFuzzer({ legacy: legacyPool, modern: modernPool });
afterAll(async () => {
  await Promise.all([legacyPool.close(), modernPool.close()]);
});
const entryOf = (source: string): ErrorFirstFunction => {
  const e = detectErrorFirst(source).entry;
  if (e === undefined) throw new Error("no entry");
  return e;
};
/** Fuzzes a legacy callback module against a hand-written async module (both settled in the sandbox). */
async function compare(legacy: string, modern: string, schema: Record<string, "integer" | "string" | "number" | "boolean">, numRuns = 60) {
  const entry = entryOf(legacy);
  return fuzzer.fuzz(buildLegacyHarness(legacy, entry), buildModernHarness(modern, entry.name, entry.params), schema, { numRuns, exact: true, boundary: true, settle: true, seed: 7, examples: literalExamples(legacy, schema) });
}

describe("detectErrorFirst (AST only)", () => {
  it("finds the preset's entry and its error-first helper", () => {
    const d = detectErrorFirst(PRESET);
    expect(d.functions.map((f) => [f.name, f.params, f.callback, f.exported])).toEqual([
      ["parsePort", ["raw"], "cb", false],
      ["legacyReadConfigCb", ["text"], "cb", true],
    ]);
    expect(d.entry?.name).toBe("legacyReadConfigCb");
  });

  it.each([
    ["module.exports = function (a, b, done) { if (b === 0) return done(new Error('x')); done(null, a / b); };", "resurrected", "module.exports", ["a", "b"]],
    ["exports.read = function (key, next) { next(null, key); };", "read", "module.exports.read", ["key"]],
    ["var load = function (p, callback) { callback(err); }; module.exports = load;", "load", "load", ["p"]],
  ])("%s", (source, name, ref, params) => {
    expect(entryOf(source)).toMatchObject({ name, ref, params });
  });

  it("ignores functions that are not error-first, and code that does not parse", () => {
    expect(detectErrorFirst("function map(arr, fn) { return arr.map(function (x) { return fn(x); }); }").functions).toEqual([]);
    expect(detectErrorFirst("function f(a, b) { return a + b; }").functions).toEqual([]);
    expect(detectErrorFirst("var half = (n / 2) | 0; half;").functions).toEqual([]);
    expect(detectErrorFirst("function (").parsed).toBe(false);
  });
});

describe("liftErrorFirst (deterministic acorn + astring rewrite)", () => {
  it("lifts the preset: throws, returns, awaits the helper and unwraps the deferred tail", () => {
    const l = liftErrorFirst(PRESET);
    if (!l.ok) throw new Error(l.reason);
    expect(l.lifted).toEqual(["parsePort", "legacyReadConfigCb"]);
    for (const s of [
      "async function parsePort(raw) {",
      'if (isNaN(port)) throw new TypeError("Port must be a number: " + JSON.stringify(raw));',
      "return port;",
      "async function legacyReadConfigCb(text) {",
      "const port = await parsePort(text);",
      "return config;",
      "module.exports = legacyReadConfigCb;",
    ]) {
      expect(l.code, s).toContain(s);
    }
    expect(l.code).not.toMatch(/\bcb\b|setTimeout/);
    expect(liftErrorFirst(PRESET)).toEqual(l);
    expect(() => parse(l.code, { ecmaVersion: "latest", sourceType: "script" })).not.toThrow();
  });

  it("guards a run-time error value and keeps evaluation order for complex arguments", () => {
    const simple = liftErrorFirst("function f(x, cb) { var err = x > 0 ? null : new Error('neg'); cb(err, x); }");
    expect(simple.ok && simple.code).toContain("if (err != null) throw err;\n  return x;");
    const complex = liftErrorFirst("function g(x, cb) { if (x === 0) return cb(null, 0); var e = null; cb(e || check(x), x * 2); }");
    expect(complex.ok && complex.code).toContain("const __lzErr0 = e || check(x), __lzVal0 = x * 2;");
  });

  it("normalizes module.exports = function to an exported declaration", () => {
    const l = liftErrorFirst("module.exports = function (a, b, done) { if (b === 0) return done(new RangeError('div by zero')); setImmediate(function () { done(null, a / b); }); };");
    expect(l.ok && l.code).toBe("async function resurrected(a, b) {\n  if (b === 0) throw new RangeError('div by zero');\n  return a / b;\n}\nmodule.exports = resurrected;");
  });

  it.each([
    ["function f(x, cb) { try { cb(null, x); } catch (e) { cb(e); } }", "try/catch"],
    ["function f(x, cb) { var y = cb; cb(null, x); }", "unsupported position"],
    ["function f(x, cb) { setTimeout(function () { cb(null, x); }, 0); x++; }", "not in tail position"],
    ["function h(x, cb) { cb(null, x); }\nfunction f(x, cb) { h(x, function (err, v) { cb(null, v); }); }", "does not start with"],
    ["function h(x, cb) { cb(null, x); }\nfunction f(x, cb) { h(x, function (err, v) { if (err) return cb(err); cb(null, err || v); }); }", "used outside its guard"],
    ["function f(x, cb) { [1].forEach(function () { cb(null, x); }); }", "unsupported position"],
    ["function f(x, cb) { (function (cb) { cb(null, 1); })(); cb(null, x); }", "redeclares"],
  ])("refuses %s (%s)", (source, reason) => {
    const l = liftErrorFirst(source);
    expect(l.ok).toBe(false);
    if (!l.ok) expect(l.reason).toContain(reason);
  });

  it("does not lift a helper that non-lifted code still calls with a callback", () => {
    const l = liftErrorFirst("function h(x, cb) { cb(null, x); }\nfunction run(x) { h(x, function () {}); }");
    expect(l.ok).toBe(false);
  });

  it("strips the entry's types back to runnable JavaScript", () => {
    const entry = entryOf(PRESET);
    const js = stripAsyncTypes("// header\nasync function parsePort(raw) { return 1; }\nexport async function legacyReadConfigCb(text: string): Promise<{ port: number; secure: boolean }> {\n  return parsePort(text);\n}\n", entry);
    expect(js).toContain("async function legacyReadConfigCb(text) {");
    expect(js).not.toContain("export");
    expect(stripAsyncTypes("function legacyReadConfigCb(text) {}", entry)).toBeUndefined();
  });
});

describe("pooled sandbox: settling (async) probes", () => {
  const run = (code: string, context: Record<string, unknown> = {}) => legacyPool.run({ code, context, encoding: "tagged", settle: true });
  const failure = async (code: string): Promise<SandboxError> => {
    try {
      await run(code);
    } catch (err: unknown) {
      if (err instanceof SandboxError) return err;
      throw err;
    }
    throw new Error("expected the probe to fail");
  };

  it("settles promises and runs virtual timers in due order (deterministic, no host timers)", async () => {
    expect((await run("Promise.resolve(n * 2)", { n: 21 })).output).toBe(42);
    expect((await run("new Promise(function (r) { setTimeout(function () { r('late'); }, 50); setTimeout(function () { r('early'); }, 10); })")).output).toBe("early");
    expect((await run("new Promise(function (r) { var log = []; setTimeout(function () { log.push('t'); r(log); }, 0); setImmediate(function () { log.push('i'); }); queueMicrotask(function () { log.push('m'); }); process.nextTick(function () { log.push('n'); }); })")).output).toEqual(["m", "n", "i", "t"]);
    expect((await run("new Promise(function (r) { process.nextTick(r, -0); })")).output).toEqual({ $lazarus: "-0" });
    expect((await run("7")).output).toBe(7);
  });

  it("turns a rejection into EXECUTION_ERROR and a callback that is never called into TIMEOUT", async () => {
    expect(await failure("Promise.reject(new RangeError('bad port'))")).toMatchObject({ code: "EXECUTION_ERROR", message: "bad port" });
    expect((await failure("new Promise(function () {})")).code).toBe("TIMEOUT");
    expect((await failure("new Promise(function () {})")).message).toContain("never settled");
    const started = Date.now();
    expect((await failure("new Promise(function () { (function loop() { Promise.resolve().then(loop); })(); })")).code).toBe("TIMEOUT");
    expect(Date.now() - started).toBeLessThan(3500);
  });

  it("keeps the sandbox boundary: timers are context functions, the sync path has no timers", async () => {
    expect((await run("new Promise(function (r) { setTimeout(function () { r(setTimeout.constructor('return typeof require')()); }, 0); })")).output).toBe("undefined");
    expect((await legacyPool.run({ code: "typeof setTimeout" })).output).toBe("undefined");
    expect(() => isProbeParams({ code: "1", settle: "yes" })).toThrow("params.settle must be a boolean");
    expect(isProbeParams({ code: "1", settle: true })).toBe(true);
  });

  it("refuses async fuzzing with executors that cannot settle", async () => {
    const plain = { run: legacyPool.run.bind(legacyPool) };
    await expect(new DifferentialFuzzer({ legacy: plain, modern: plain }).fuzz("1", "1", { n: "integer" }, { settle: true })).rejects.toThrow("Async (settle) fuzzing");
  });
});

describe("async differential parity (both settlements)", () => {
  const LEGACY = "function half(n, cb) { if (n % 2 !== 0) return cb(new RangeError('odd: ' + n)); setTimeout(function () { cb(null, n / 2); }, 5); }";

  it("proves success-path Object.is parity and error-path name + message parity", async () => {
    const report = await compare(LEGACY, "async function half(n) { if (n % 2 !== 0) throw new RangeError('odd: ' + n); return n / 2; }", { n: "integer" });
    expect(report.passed).toBe(true);
    expect(report.exact).toBe(true);
  });

  it("catches a rewrite that returns a wrong value (including -0)", async () => {
    const report = await compare(LEGACY, "async function half(n) { if (n % 2 !== 0) throw new RangeError('odd: ' + n); return Math.trunc(n / 2) + 0; }", { n: "integer" });
    expect(report.passed).toBe(false);
    // The boundary corpus reaches n = -0 first: -0 / 2 is -0, but Math.trunc(-0 / 2) + 0 is +0.
    expect(report.counterexample?.inputs).toEqual({ n: { $lazarus: "-0" } });
    expect(readEnvelope(report.counterexample?.legacy.output)).toEqual({ settled: "resolve", value: -0 });
  });

  it("catches a rewrite that swallows the error", async () => {
    const report = await compare(LEGACY, "async function half(n) { try { if (n % 2 !== 0) throw new RangeError('odd: ' + n); return n / 2; } catch (e) { return null; } }", { n: "integer" });
    expect(report.passed).toBe(false);
    expect(readEnvelope(report.counterexample?.legacy.output)).toMatchObject({ settled: "reject", error: { name: "RangeError" } });
    expect(readEnvelope(report.counterexample?.modern.output)).toEqual({ settled: "resolve", value: null });
  });

  it("catches a wrong error type or message even when both reject", async () => {
    const wrongType = await compare(LEGACY, "async function half(n) { if (n % 2 !== 0) throw new Error('odd: ' + n); return n / 2; }", { n: "integer" });
    expect(wrongType.passed).toBe(false);
    expect(wrongType.counterexample?.reason).toContain("RangeError");
    const wrongMessage = await compare(LEGACY, "async function half(n) { if (n % 2 !== 0) throw new RangeError('odd'); return n / 2; }", { n: "integer" });
    expect(wrongMessage.passed).toBe(false);
  });

  it("treats a legacy callback that is never called as a failure the rewrite must reproduce", async () => {
    const legacy = "function f(n, cb) { if (n > 0) cb(null, n); }";
    expect((await compare(legacy, "async function f(n) { if (n > 0) return n; }", { n: "integer" })).passed).toBe(false);
  });

  it("counts a synchronous legacy throw as a rejection", async () => {
    const legacy = "function f(s, cb) { if (s.length > 3) throw new TypeError('too long'); cb(null, s.length); }";
    expect((await compare(legacy, "async function f(s) { if (s.length > 3) throw new TypeError('too long'); return s.length; }", { s: "string" })).passed).toBe(true);
  });

  it("the promise wrapper candidate has parity by construction", async () => {
    const legacy = "function f(x, cb) { try { cb(null, x * 2); } catch (e) { cb(e); } }";
    expect((await compare(legacy, promiseWrapper(legacy, entryOf(legacy)), { x: "number" })).passed).toBe(true);
  });
});

describe("resurrectErrorFirst: legacyReadConfigCb end to end", () => {
  it("lifts, proves both settlements in under 3 s, and infers the Promise type", async () => {
    const started = Date.now();
    const r = await resurrectErrorFirstWith(fuzzer, { name: "legacyReadConfigCb", source: PRESET, schema: { text: "string" }, seed: 1337 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.success).toBe(true);
    expect(r.attempts).toBe(1);
    expect(r.fuzzReport.totalRuns).toBe(100);
    expect(r.asyncCallback).toMatchObject({ entry: "legacyReadConfigCb", callback: "cb", params: ["text"], lifted: ["parsePort", "legacyReadConfigCb"], strategy: "lift+modernize" });
    expect(r.asyncCallback?.outcomes.resolved).toBeGreaterThan(0);
    expect(r.asyncCallback?.outcomes.rejected).toBeGreaterThan(0);
    expect((r.asyncCallback?.outcomes.resolved ?? 0) + (r.asyncCallback?.outcomes.rejected ?? 0)).toBe(100);
    expect(r.modernCode).toContain("export async function legacyReadConfigCb(text: string): Promise<{ port: number; secure: boolean; source: string }> {");
    expect(r.events.map((e) => e.type)).toEqual(expect.arrayContaining(["agent_started", "spec_generated", "code_synthesized", "fuzz_completed", "completed"]));
  });

  it("falls back to the promise wrapper when the lift is refused, and still proves parity", async () => {
    const source = "function readJson(text, cb) { try { cb(null, JSON.parse(text)); } catch (e) { cb(new SyntaxError('bad json')); } }";
    const r = await resurrectErrorFirstWith(fuzzer, { name: "readJson", source, schema: { text: "string" }, seed: 3, fuzzRuns: 40 });
    expect(r).toMatchObject({ success: true, attempts: 1, asyncCallback: { strategy: "promise-wrapper" } });
    expect(r.events.some((e) => e.message.includes("Structural lift refused") && e.message.includes("try/catch"))).toBe(true);
  });

  it("the orchestrator's additive pass tears its own pools down (no leaked worker processes or timers)", async () => {
    const before = process.getActiveResourcesInfo().filter((x) => x === "ProcessWrap").length;
    const r = await new ResurrectionOrchestrator().resurrectErrorFirst({ name: "legacyReadConfigCb", source: PRESET, schema: { text: "string" }, seed: 1, fuzzRuns: 30 });
    expect(r.success).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(process.getActiveResourcesInfo().filter((x) => x === "ProcessWrap").length).toBe(before);
  });

  it("exports a strictly type-checked async bundle with an async parity suite", async () => {
    const r = await resurrectErrorFirstWith(fuzzer, { name: "legacyReadConfigCb", source: PRESET, schema: { text: "string" }, seed: 1337 });
    const exported = await buildExportBundle({ specimenName: "legacyReadConfigCb", legacyCode: PRESET, modernCode: r.modernCode, schema: { text: "string" }, fuzzRuns: 100, attempts: 1 });
    expect(exported.typecheck).toMatchObject({ passed: true, errorCount: 0, widenedReturn: false });
    expect(Object.keys(exported.bundle.files).sort()).toEqual([".github/workflows/lazarus-parity.yml", "SPEC.md", "legacy.cjs", "resurrected.test.ts", "resurrected.ts"]);
    const ts = exported.bundle.files["resurrected.ts"];
    expect(ts).toContain("export async function legacyReadConfigCb(text: string): Promise<{ port: number; secure: boolean; source: string }> {");
    expect(ts).toContain("async function parsePort(raw: any) {");
    const test = exported.bundle.files["resurrected.test.ts"];
    for (const s of ["fc.asyncProperty(fc.string({ minLength: 0, maxLength: 32 })", "await runModern(text)", "await runLegacy(text)", "import { legacyReadConfigCb } from './resurrected.js';"]) expect(test, s).toContain(s);
    expect(exported.bundle.files["legacy.cjs"]).toContain("module.exports.__lazarusEntry = legacyReadConfigCb;");
    expect(exported.bundle.files["SPEC.md"]).toContain("100% Async Behavioral Parity Proven");
    expect(exported.bundle.files["SPEC.md"]).toContain("tsc --strict: 0 errors");
    expect(exported.bundle.prDiff.startsWith("diff --git a/legacy.cjs b/resurrected.ts")).toBe(true);
  });
});

describe("HTTP: /api/resurrect, /api/export-zip and /api/mutation-audit for legacyReadConfigCb", () => {
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
  const post = (path: string, body: unknown): Promise<Response> => fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  async function resurrect(body: unknown): Promise<Record<string, unknown>> {
    const text = await (await post("/api/resurrect", body)).text();
    const frames = text.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as Record<string, unknown>);
    const result = frames.find((f) => f["kind"] === "result");
    expect(result, JSON.stringify(frames.filter((f) => f["kind"] === "error"))).toBeDefined();
    return result?.["result"] as Record<string, unknown>;
  }
  let resurrected: Record<string, unknown> = {};

  it("resurrects in under 3 s with exact parity on both paths and tsc --strict: 0 errors", async () => {
    const started = Date.now();
    // The page sends the preset's schema; a stale `cb` entry is ignored.
    resurrected = await resurrect({ name: "legacyReadConfigCb", legacyCode: PRESET, schema: { text: "string", cb: "json" }, seed: 1337 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(resurrected["success"]).toBe(true);
    expect(resurrected["typecheck"]).toMatchObject({ passed: true, errorCount: 0 });
    expect(resurrected["typeSignatureText"]).toBe("legacyReadConfigCb(text: string): Promise<{ port: number; secure: boolean; source: string }>");
    expect(resurrected["certificate"]).toBeDefined();
    const a = resurrected["asyncCallback"] as { outcomes: { resolved: number; rejected: number } };
    expect(a.outcomes.resolved).toBeGreaterThan(0);
    expect(a.outcomes.rejected).toBeGreaterThan(0);
  });

  it("exports the .zip PR archive", async () => {
    const res = await post("/api/export-zip", { specimenName: "legacyReadConfigCb", legacyCode: PRESET, modernCode: resurrected["modernCode"], schema: { text: "string" }, fuzzRuns: 100, attempts: 1 });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");
    const zip = Buffer.from(await res.arrayBuffer());
    expect(zip.subarray(0, 4).toString("hex")).toBe("504b0304");
    const names = zip.toString("latin1");
    for (const n of ["resurrected.ts", "resurrected.test.ts", "legacy.cjs", "SPEC.md", "resurrection.patch"]) expect(names).toContain(n);
  });

  it("audits the async proof: mutants are settled in the sandbox and all killed", async () => {
    const res = await post("/api/mutation-audit", { legacyCode: PRESET, modernCode: resurrected["modernCode"], schema: { text: "string" }, seed: 1337 });
    expect(res.status).toBe(200);
    const audit = (await res.json()) as { baselineVerified: boolean; totalMutants: number; killed: number; mutants: Array<{ autopsy: { status: string; killerInput: { display: string } | null } }> };
    expect(audit.baselineVerified).toBe(true);
    expect(audit.totalMutants).toBe(5);
    expect(audit.killed).toBe(5);
    for (const m of audit.mutants) expect(m.autopsy.killerInput?.display).toMatch(/^text = "/);
  });

  it("leaves synchronous specimens on the existing path", async () => {
    const r = await resurrect({ name: "legacy-int-halve", legacyCode: "var half = (n / 2) | 0; half;", schema: { n: "integer" }, seed: 1 });
    expect(r["success"]).toBe(true);
    expect(r["asyncCallback"]).toBeUndefined();
  });
});

describe("Studio and CLI integration", () => {
  it("ships the legacyReadConfigCb preset in Tab 1 and the async note, without touching Tab 3", () => {
    expect(pageHtml).toContain('label: "Preset 11: Node.js Error-First Callback (cb(err, config) -> async/await)"');
    expect(pageHtml).toContain('schema: \'{"text": "string"}\'');
    expect(pageHtml).toContain('<div class="async-note" id="asyncNote" role="status" hidden></div>');
    expect(pageHtml).toContain("if (!r || !r.success || r.module || r.asyncCallback) { reset(); return; }");
    expect(pageHtml).toContain('<span class="proof-badge" id="badgeSpecs">24 Kiro Specs</span>');
    const tab3 = pageHtml.slice(pageHtml.indexOf('<div class="studio-pane" id="pane-redteam"'), pageHtml.indexOf('<div class="dna-scrim"'));
    expect(tab3).not.toMatch(/async|legacyReadConfigCb/i);
  });

  it("the async note script reports both settlements and hides the synchronous Probe card", () => {
    const source = [...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "").find((s) => s.includes("Async Callback Necromancer: error-first callback results")) ?? "";
    expect(source).not.toBe("");
    const doc = new FakeDocument();
    const note = doc.element("div", "asyncNote");
    note.hidden = true;
    const probe = doc.element("div", "probeCard");
    runInlineScript(source, { document: doc });
    doc.dispatchEvent({ type: "lazarus:result", detail: { success: true, asyncCallback: { entry: "legacyReadConfigCb", params: ["text"], callback: "cb", strategy: "lift+modernize", outcomes: { resolved: 9, rejected: 91 } } } });
    expect(note.hidden).toBe(false);
    expect(probe.hidden).toBe(true);
    expect(note.textContent).toContain("legacyReadConfigCb(text, cb) became await legacyReadConfigCb(text) via lift+modernize.");
    expect(note.textContent).toContain("9 resolved and 91 rejected inputs matched exactly");
    doc.dispatchEvent({ type: "lazarus:run-start", detail: { source: "x" } });
    expect(note.hidden).toBe(true);
    expect(probe.hidden).toBe(false);
    doc.dispatchEvent({ type: "lazarus:result", detail: { success: true, name: "halve" } });
    expect(note.hidden).toBe(true);
  });

  it("lazarus audit flags error-first callbacks and whether they lift", () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-audit-cb-"));
    try {
      fs.writeFileSync(nodePath.join(dir, "config.cjs"), PRESET);
      fs.writeFileSync(nodePath.join(dir, "json.cjs"), "function readJson(text, cb) { try { cb(null, JSON.parse(text)); } catch (e) { cb(e); } }\nmodule.exports = readJson;");
      const r = auditDirectory(dir);
      const cb = r.files.flatMap((f) => f.findings.filter((x) => x.kind === "error-first-callback").map((x) => ({ file: f.file, ...x })));
      expect(cb.map((x) => [x.file, x.severity, x.line])).toEqual([
        ["config.cjs", "medium", 2],
        ["config.cjs", "medium", 11],
        ["json.cjs", "medium", 1],
      ]);
      expect(cb[1]?.message).toContain("legacyReadConfigCb(text, cb) is a Node.js error-first callback");
      expect(cb[1]?.message).toContain("Lazarus lifts it to async/await");
      expect(cb[2]?.message).toContain("not liftable as is");
      expect(cb[2]?.message).toContain("promise wrapper");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
