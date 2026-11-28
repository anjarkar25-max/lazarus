import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BENCHMARK_PRESETS } from "../../benchmark-presets.js";
import { SARIF_EXTENSION_RULES, SARIF_RULES, auditSources, renderSarif, runAuditCli, type SarifLog } from "../../cli-audit.js";
import { PooledProbeRunner } from "../../sandbox/pool.js";
import { scanLegacyAst } from "../../sandbox/ast-scanner.js";
import { buildExportBundle, createWebServer } from "../../web/server.js";
import { RULE_ORDER, decodeLevels, defaultLevels, encodeLevels, modernize, readHeaderLevels, stepDown } from "../ast-modernizer.js";
import { ResurrectionOrchestrator } from "../orchestrator.js";
import { auditPurity } from "../purity-audit.js";
import { EXPLOIT_PAYLOAD, POLLUTING_KEYS, buildExploitProbe, probeProtoPollution, scanSecurity } from "../security-exorcist.js";
import { closeSharedTsVerifier } from "../ts-verifier.js";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../../..");
const PRESET = BENCHMARK_PRESETS.find((p) => p.name === "legacyUnsafeMerge");
if (PRESET === undefined) throw new Error("legacyUnsafeMerge preset missing");
const SCHEMA = { target: "json", source: "json" } as const;
const COPY = "function copy(dst, src) {\n  for (var k in src) {\n    dst[k] = src[k];\n  }\n  return dst;\n}\ncopy(dst, src);";

afterAll(async () => {
  await closeSharedTsVerifier();
});

describe("static analysis (Acorn AST, nothing executed)", () => {
  it("finds the unguarded key-copy loop with its line, key and source", () => {
    const scan = scanSecurity(COPY);
    expect(scan.parsed).toBe(true);
    expect(scan.pollution).toHaveLength(1);
    expect(scan.pollution[0]).toMatchObject({ line: 2, key: "k", sourceText: "src", fixable: true });
    expect(scan.looseEquality).toEqual([]);
  });
  it("finds the loop in the showcase preset, with or without braces and with an assignment-style loop head", () => {
    expect(scanSecurity(PRESET.code).pollution).toMatchObject([{ key: "key", sourceText: "source", fixable: true }]);
    expect(scanSecurity("function f(d, s) { for (var k in s) d[k] = s[k]; return d; }").pollution).toHaveLength(1);
    expect(scanSecurity("function f(d, s) { var k; for (k in s) { d[k] = s[k]; } return d; }").pollution).toHaveLength(1);
    expect(scanSecurity("function f(d, o) { for (var k in o.inner.deep) { d[k] = o.inner.deep[k]; } }").pollution[0]).toMatchObject({ sourceText: "o.inner.deep", fixable: true });
  });
  it("ignores loops that do not copy by key and loops that already reject __proto__", () => {
    expect(scanSecurity("function f(s) { var n = 0; for (var k in s) { n = n + 1; } return n; }").pollution).toEqual([]);
    expect(scanSecurity("function f(d, s) { for (var k in s) { d.last = s[k]; } return d; }").pollution).toEqual([]);
    expect(scanSecurity('function f(d, s) { for (var k in s) { if (k === "__proto__") continue; d[k] = s[k]; } return d; }').pollution).toEqual([]);
    expect(scanSecurity("function f(d, s) { for (var i = 0; i < s.length; i++) { d[i] = s[i]; } }").pollution).toEqual([]);
  });
  it("reports a loop over a call as not fixable, with the reason", () => {
    const site = scanSecurity("function f(d) { for (var k in make()) { d[k] = make()[k]; } }").pollution[0];
    expect(site).toMatchObject({ fixable: false });
    expect(site?.keptBecause).toContain("not a plain reference");
  });
  it("finds every loose == and != (and nothing else)", () => {
    const scan = scanSecurity("var a = x == 1;\nvar b = y != null;\nvar c = z === 2;\nvar d = w !== 3;");
    expect(scan.looseEquality.map((s) => [s.line, s.operator, s.text])).toEqual([
      [1, "==", "x == 1"],
      [2, "!=", "y != null"],
    ]);
  });
  it("reports a parse failure instead of throwing", () => {
    expect(scanSecurity("function (")).toEqual({ parsed: false, pollution: [], looseEquality: [] });
  });
  it("lists the three polluting keys and the exact exploit payload", () => {
    expect(POLLUTING_KEYS).toEqual(["__proto__", "constructor", "prototype"]);
    expect(EXPLOIT_PAYLOAD).toBe('{"__proto__":{"polluted":true}}');
    expect(Object.keys(JSON.parse(EXPLOIT_PAYLOAD) as object)).toEqual(["__proto__"]);
  });
});

describe("Necromancer rule proto-pollution-guard", () => {
  it("guards the loop with hasOwnProperty and the three key checks, as its first statement", () => {
    const result = modernize(COPY);
    const applied = result.applied.find((a) => a.rule === "proto-pollution-guard");
    expect(applied).toMatchObject({ variant: "guard", line: 2, speculative: false });
    expect(applied?.note).toContain("__proto__");
    expect(result.code).toContain('if (!Object.prototype.hasOwnProperty.call(src, k) || k === "__proto__" || k === "constructor" || k === "prototype") continue;');
    expect(result.code.indexOf("hasOwnProperty")).toBeLessThan(result.code.indexOf("dst[k] = src[k]"));
    expect(scanSecurity(result.code).pollution).toEqual([]);
    expect(result.flagged.some((f) => f.kind === "proto-pollution")).toBe(false);
  });
  it("wraps a brace-less loop body in a block and keeps the copy", () => {
    const code = modernize("function f(d, s) { for (var k in s) d[k] = s[k]; return d; }\nf(d, s);").code;
    expect(code).toMatch(/for \((?:var|const|let) k in s\) \{\s+if \(!Object\.prototype\.hasOwnProperty\.call\(s, k\)/);
    expect(code).toContain("d[k] = s[k];");
  });
  it("keeps and flags a loop it cannot guard without evaluating its source twice", () => {
    const code = "function f(d) { for (var k in make()) { d[k] = make()[k]; } }\nf(d);";
    const result = modernize(code);
    expect(result.applied.some((a) => a.rule === "proto-pollution-guard")).toBe(false);
    expect(result.flagged).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "proto-pollution", reason: expect.stringContaining("not a plain reference") as unknown })]));
    expect(result.code).not.toContain("hasOwnProperty");
  });
  it("is a two-step ladder that rolls back to the legacy loop, flagged", () => {
    expect(RULE_ORDER).toContain("proto-pollution-guard");
    expect(RULE_ORDER.indexOf("proto-pollution-guard")).toBeLessThan(RULE_ORDER.indexOf("global-leak-fix"));
    const off = modernize(COPY, { levels: stepDown(defaultLevels(), "proto-pollution-guard") });
    expect(off.applied.some((a) => a.rule === "proto-pollution-guard")).toBe(false);
    expect(off.code).not.toContain("hasOwnProperty");
    expect(off.flagged).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "proto-pollution", line: 2 })]));
  });
  it("round-trips in the `// ast-rules:` header and still reads headers written before it existed", () => {
    const levels = stepDown(defaultLevels(), "proto-pollution-guard");
    expect(decodeLevels(encodeLevels(levels))).toEqual(levels);
    expect(encodeLevels(defaultLevels())).toMatch(/proto-pollution-guard=guard global-leak-fix=declare$/);
    const old = "// ast-rules: var-scoping=let-const prototype-class=class arguments-rest=rest apply-spread=spread function-arrow=arrow bitor0-trunc=trunc-or0 loose-equality=strict-proven global-leak-fix=declare";
    expect(readHeaderLevels(old)).toEqual(defaultLevels());
  });
  it("leaves a specimen without a key-copy loop byte-identical to what the other rules produce", () => {
    const code = "var half = (n / 2) | 0; half;";
    const withRule = modernize(code).code;
    const without = modernize(code, { levels: stepDown(defaultLevels(), "proto-pollution-guard") }).code;
    expect(withRule).toBe(without);
  });
});

describe("live exploit probe (sandbox)", () => {
  const LEGACY = scanLegacyAst(PRESET.code).primaryExpression;

  it("wraps the code in one self-cleaning probe: the last json input gets the payload, the others a fresh {}", () => {
    const probe = buildExploitProbe("x;", ["target", "source"]);
    expect(probe).toContain(JSON.stringify(EXPLOIT_PAYLOAD));
    expect(probe).toContain('["target","source"]');
    expect(probe).toContain("delete Object.prototype.polluted");
  });

  it("shows the unguarded legacy code is exploitable and the guarded resurrection is not", async () => {
    const guarded = modernize(LEGACY, { inputs: ["target", "source"] }).code;
    await using pool = new PooledProbeRunner();
    const proof = await probeProtoPollution({ legacyCode: LEGACY, modernCode: guarded, schema: SCHEMA, executor: pool });
    expect(proof).toMatchObject({ attempted: true, blocked: true, legacyExploitable: true });
    expect(proof?.detail).toContain("Proto-Pollution Blocked");
    // The legacy code run as its own "resurrection" is not blocked: the probe can tell the difference.
    const unguarded = await probeProtoPollution({ legacyCode: LEGACY, modernCode: LEGACY, schema: SCHEMA, executor: pool });
    expect(unguarded).toMatchObject({ attempted: true, blocked: false, legacyExploitable: true });
    expect(unguarded?.detail).toContain("NOT blocked");
    // Each probe runs in a fresh context: the next probe sees a clean Object.prototype.
    expect((await pool.run({ code: "typeof ({}).polluted" })).output).toBe("undefined");
  }, 30_000);

  it("is not attempted without a json input, and says why", async () => {
    await using pool = new PooledProbeRunner();
    const proof = await probeProtoPollution({ legacyCode: "n;", modernCode: "n;", schema: { n: "integer" }, executor: pool });
    expect(proof).toMatchObject({ attempted: false, blocked: false });
    expect(proof?.detail).toContain("no json input");
  });

  it("adds protoPollutionBlocked to the purity proof only for a specimen with a key-copy loop", async () => {
    await using pool = new PooledProbeRunner();
    const guarded = modernize(LEGACY, { inputs: ["target", "source"] }).code;
    const proof = await auditPurity({ legacyCode: LEGACY, modernCode: guarded, schema: SCHEMA, executor: pool, seed: 11 });
    expect(proof).toMatchObject({ protoPollutionBlocked: true, proven: true, prototypeSafe: true });
    expect(proof?.details.some((d) => d.startsWith("Proto-Pollution Blocked"))).toBe(true);
    const unguarded = await auditPurity({ legacyCode: LEGACY, modernCode: LEGACY, schema: SCHEMA, executor: pool, seed: 11 });
    expect(unguarded).toMatchObject({ protoPollutionBlocked: false, proven: false });
    const plain = await auditPurity({ legacyCode: "var half = (n / 2) | 0; half;", modernCode: "Math.trunc(n / 2) || 0;", schema: { n: "integer" }, executor: pool, seed: 11 });
    expect(plain).toBeDefined();
    expect(plain).not.toHaveProperty("protoPollutionBlocked");
  }, 60_000);
});

describe("legacyUnsafeMerge: parity, tsc --strict and the exploit probe, end to end", () => {
  it("is resurrected with the guard, exact parity on normal inputs and a blocked exploit", async () => {
    const r = await new ResurrectionOrchestrator().resurrect({ name: PRESET.name, legacyCode: scanLegacyAst(PRESET.code).primaryExpression, schema: SCHEMA, fuzzRuns: 100, seed: 21, maxHealingAttempts: 3, exact: true, purityAudit: true });
    expect(r.success).toBe(true);
    expect(r.attempts).toBe(1);
    expect(r.fuzzReport).toMatchObject({ passed: true, exact: true });
    expect(r.modernCode).toContain('key === "__proto__" || key === "constructor" || key === "prototype") continue;');
    expect(r.ruleBlame?.find((b) => b.rule === "proto-pollution-guard")).toMatchObject({ status: "applied" });
    expect(r.purityProof).toMatchObject({ protoPollutionBlocked: true, proven: true });
    expect(r.purityProof?.details.join("\n")).toContain("Proto-Pollution Blocked");
    // Normal inputs: the resurrected merge returns what the legacy merge returns.
    await using pool = new PooledProbeRunner();
    const context = { target: { a: 1, nested: { x: 1 } }, source: { b: 2, nested: { y: 2 } } };
    const legacy = await pool.run({ code: scanLegacyAst(PRESET.code).primaryExpression, context });
    const modern = await pool.run({ code: r.modernCode, context });
    expect(modern.output).toEqual({ a: 1, b: 2, nested: { x: 1, y: 2 } });
    expect(modern.output).toEqual(legacy.output);
  }, 60_000);

  it("compiles with tsc --strict: 0 errors, declaring the json inputs `any` at the migration boundary", async () => {
    const r = await new ResurrectionOrchestrator().resurrect({ name: PRESET.name, legacyCode: scanLegacyAst(PRESET.code).primaryExpression, schema: SCHEMA, fuzzRuns: 50, seed: 22, exact: true });
    const bundle = await buildExportBundle({ specimenName: PRESET.name, legacyCode: PRESET.code, modernCode: r.modernCode, schema: SCHEMA, fuzzRuns: 50, seed: 22 }, { report: true });
    expect(bundle.typecheck.errorCount).toBe(0);
    expect(bundle.typecheck.passed).toBe(true);
    expect(bundle.bundle.files["resurrected.ts"]).toContain("legacyUnsafeMerge(target: any, source: any)");
    expect(bundle.typecheck.adjustments.join("\n")).toContain("parameter target");
    expect(bundle.bundle.files["resurrected.ts"]).toContain('key === "__proto__"');
    expect(bundle.reportHtml).toContain("Proto-Pollution Blocked");
  }, 90_000);

  describe("over HTTP", () => {
    const server = createWebServer();
    let baseUrl = "";
    beforeAll(async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    });
    it("POST /api/resurrect streams the proof with Proto-Pollution Blocked and tsc --strict: 0 errors", async () => {
      const res = await fetch(`${baseUrl}/api/resurrect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: PRESET.name, legacyCode: PRESET.code, schema: PRESET.schema, fuzzRuns: 100 }) });
      const text = await res.text();
      const result = text
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice(6)) as { kind: string; result?: { success: boolean; typecheck: { errorCount: number }; purityProof: { protoPollutionBlocked: boolean; proven: boolean; details: string[] } } })
        .find((m) => m.kind === "result")?.result;
      expect(result?.success).toBe(true);
      expect(result?.typecheck.errorCount).toBe(0);
      expect(result?.purityProof).toMatchObject({ protoPollutionBlocked: true, proven: true });
      expect(result?.purityProof.details.some((d) => d.startsWith("Proto-Pollution Blocked"))).toBe(true);
    }, 90_000);
  });
});

describe("SARIF LAZ009 PrototypePollutionRisk and LAZ010 LooseEqualityCoercion (additive)", () => {
  const sarifOf = (files: Record<string, string>, security = false): SarifLog => renderSarif(auditSources(new Map(Object.entries(files)), [], ".", security ? { security: true } : {}));
  const MERGE = "function merge(dst, src) {\n  for (var k in src) {\n    dst[k] = src[k];\n  }\n  return dst;\n}\nmodule.exports = merge;";

  it("keeps LAZ001 to LAZ008 as they were and adds the two rules after them", () => {
    expect(SARIF_RULES.map((r) => r.id)).toEqual(["LAZ001", "LAZ002", "LAZ003", "LAZ004", "LAZ005", "LAZ006", "LAZ007"]);
    expect(SARIF_EXTENSION_RULES.map((r) => r.id)).toEqual(["LAZ008", "LAZ009", "LAZ010"]);
    expect(SARIF_EXTENSION_RULES[1]).toMatchObject({ id: "LAZ009", name: "PrototypePollutionRisk", defaultConfiguration: { level: "error" } });
    expect(SARIF_EXTENSION_RULES[2]).toMatchObject({ id: "LAZ010", name: "LooseEqualityCoercion", defaultConfiguration: { level: "warning" } });
  });

  it("reports an unguarded copy loop as a LAZ009 high-severity error on the line of the for statement", () => {
    const log = sarifOf({ "merge.js": MERGE });
    const rules = log.runs[0]?.tool.driver.rules ?? [];
    expect(rules.map((r) => r.id)).toEqual([...SARIF_RULES.map((r) => r.id), "LAZ009"]);
    const hit = (log.runs[0]?.results ?? []).find((r) => r.ruleId === "LAZ009");
    expect(hit).toMatchObject({ ruleIndex: 7, level: "error", locations: [{ physicalLocation: { artifactLocation: { uri: "merge.js" }, region: { startLine: 2 } } }] });
    expect(hit?.message.text).toContain("__proto__");
    expect(hit?.message.text).toContain("Fix:");
    expect((log.runs[0]?.results ?? []).some((r) => r.ruleId === "LAZ010")).toBe(false);
  });

  it("reports loose equality as one LAZ010 medium warning per file, only when asked for with the security option", () => {
    const source = "function f(a, b) {\n  if (a == 1) return b != null;\n  return a == b;\n}";
    expect((sarifOf({ "loose.js": source }).runs[0]?.results ?? []).some((r) => r.ruleId === "LAZ010")).toBe(false);
    expect(sarifOf({ "loose.js": source }).runs[0]?.tool.driver.rules).toHaveLength(7);
    const log = sarifOf({ "loose.js": source }, true);
    const hits = (log.runs[0]?.results ?? []).filter((r) => r.ruleId === "LAZ010");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ level: "warning", locations: [{ physicalLocation: { region: { startLine: 2 } } }] });
    expect(hits[0]?.message.text).toContain("3 loose");
    expect(log.runs[0]?.tool.driver.rules.map((r) => r.id)).toEqual([...SARIF_RULES.map((r) => r.id), "LAZ010"]);
    expect(hits[0]?.ruleIndex).toBe(7);
  });

  it("lists both new rules at their own indexes when a file triggers both", () => {
    const log = sarifOf({ "both.js": `${MERGE}\nfunction g(x) { return x == 0; }` }, true);
    expect(log.runs[0]?.tool.driver.rules.map((r) => r.id).slice(7)).toEqual(["LAZ009", "LAZ010"]);
    const byRule = Object.fromEntries((log.runs[0]?.results ?? []).map((r) => [r.ruleId, r.ruleIndex]));
    expect(byRule).toMatchObject({ LAZ009: 7, LAZ010: 8 });
  });

  it("leaves every built-in example's SARIF identical by default (no LAZ009 and no LAZ010)", () => {
    const examples = nodePath.join(root, "examples");
    for (const dir of fs.readdirSync(examples).filter((d) => fs.statSync(nodePath.join(examples, d)).isDirectory())) {
      const sources = new Map(fs.readdirSync(nodePath.join(examples, dir)).filter((f) => /\.(c?js)$/.test(f)).map((f) => [f, fs.readFileSync(nodePath.join(examples, dir, f), "utf8")] as const));
      const run = renderSarif(auditSources(sources, [], dir)).runs[0];
      expect(run?.tool.driver.rules, dir).toHaveLength(7);
      expect((run?.results ?? []).some((r) => r.ruleId === "LAZ009" || r.ruleId === "LAZ010"), dir).toBe(false);
    }
  });

  it("the CLI adds LAZ010 with --security and documents it", () => {
    let out = "";
    const io = { stdout: (t: string) => void (out += t), stderr: () => undefined, cwd: root };
    expect(runAuditCli(["examples/legacy-text-pipeline", "--sarif", "--security"], io)).toBe(0);
    const log = JSON.parse(out) as SarifLog;
    expect((log.runs[0]?.results ?? []).filter((r) => r.ruleId === "LAZ010").length).toBeGreaterThan(0);
    out = "";
    expect(runAuditCli(["examples/legacy-text-pipeline", "--sarif"], io)).toBe(0);
    expect((JSON.parse(out) as SarifLog).runs[0]?.results.some((r) => r.ruleId === "LAZ010")).toBe(false);
    out = "";
    expect(runAuditCli(["--help"], io)).toBe(0);
    expect(out).toContain("--security");
    expect(out).toContain("LAZ001-LAZ010");
  });

  it("POST /api/audit-sarif takes the same option", async () => {
    const server = createWebServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const audit = async (body: unknown): Promise<{ sarif: SarifLog }> => (await (await fetch(`${base}/api/audit-sarif`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()) as { sarif: SarifLog };
      const code = `${MERGE}\nfunction g(x) { return x == 0; }`;
      const plain = await audit({ code });
      expect(plain.sarif.runs[0]?.results.map((r) => r.ruleId)).toContain("LAZ009");
      expect(plain.sarif.runs[0]?.results.map((r) => r.ruleId)).not.toContain("LAZ010");
      const secure = await audit({ code, security: true });
      expect(secure.sarif.runs[0]?.results.map((r) => r.ruleId)).toEqual(expect.arrayContaining(["LAZ009", "LAZ010"]));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
