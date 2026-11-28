import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BENCHMARK_PRESETS } from "../../benchmark-presets.js";
import { SARIF_EXTENSION_RULES, SARIF_RULES, auditSources, renderSarif } from "../../cli-audit.js";
import { sha256Hex } from "../../exporter/certificate.js";
import { createWebServer } from "../../web/server.js";
import {
  CATEGORY_CAP,
  DEBT_CATEGORIES,
  DEBT_RULE_NAMES,
  LEVEL_PENALTY,
  SECURITY_RULES,
  badgeParts,
  computeDebtScore,
  escapeCommand,
  escapeXml,
  gradeFor,
  renderVerifiedBadgeSvg,
  simulateCiGate,
  type AfterVerified,
  type DebtFinding,
} from "../debt-score.js";
import { closeSharedTsVerifier } from "../ts-verifier.js";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../../..");
const f = (ruleId: string, level: DebtFinding["level"], extra: Partial<DebtFinding> = {}): DebtFinding => ({ ruleId, level, ...extra });
const sarifFindings = (files: Record<string, string>): DebtFinding[] => {
  const log = renderSarif(auditSources(new Map(Object.entries(files)), [], "."));
  const run = log.runs[0];
  return (run?.results ?? []).map((r) => ({ ruleId: r.ruleId, level: r.level, file: r.locations[0]?.physicalLocation.artifactLocation.uri ?? "", line: r.locations[0]?.physicalLocation.region.startLine ?? 1, message: r.message.text.split(". Fix: ")[0] ?? "", ruleName: run?.tool.driver.rules[r.ruleIndex]?.name ?? r.ruleId }));
};
const preset = (name: string): string => BENCHMARK_PRESETS.find((p) => p.name === name)?.code ?? "";
const VERIFIED: AfterVerified = { verified: true, parity: true, tscErrors: 0, signed: true, keyId: "0e3366a1c87de918", runs: 100, seed: 42 };

afterAll(async () => {
  await closeSharedTsVerifier();
});

describe("categories and rules", () => {
  it("cover LAZ001 to LAZ010 exactly once, in the four categories of the spec", () => {
    expect(DEBT_CATEGORIES.map((c) => c.label)).toEqual(["Bitwise/Numeric", "Async/Callbacks", "Security/Scope", "Module Cycles"]);
    const all = DEBT_CATEGORIES.flatMap((c) => [...c.rules]).sort();
    expect(all).toEqual(["LAZ001", "LAZ002", "LAZ003", "LAZ004", "LAZ005", "LAZ006", "LAZ007", "LAZ008", "LAZ009", "LAZ010"]);
    expect(new Set(all).size).toBe(10);
    expect(SECURITY_RULES).toEqual(["LAZ008", "LAZ009"]);
  });
  it("name every rule as the SARIF rule table does", () => {
    for (const rule of [...SARIF_RULES, ...SARIF_EXTENSION_RULES]) expect(DEBT_RULE_NAMES[rule.id], rule.id).toBe(rule.name);
    expect(Object.keys(DEBT_RULE_NAMES)).toHaveLength(SARIF_RULES.length + SARIF_EXTENSION_RULES.length);
  });
});

describe("computeDebtScore", () => {
  it("is 100, grade A and spotless in every category without findings", () => {
    const d = computeDebtScore([]);
    expect(d).toMatchObject({ score: 100, debtScore: 0, grade: "A", total: 0, high: 0 });
    expect(d.breakdown.map((c) => [c.label, c.score, c.penalty, c.findings])).toEqual([["Bitwise/Numeric", 100, 0, 0], ["Async/Callbacks", 100, 0, 0], ["Security/Scope", 100, 0, 0], ["Module Cycles", 100, 0, 0]]);
    expect(d.summary).toBe("No migration debt found: 100/100, grade A.");
  });

  it("charges 12 per error, 5 per warning and 1 per note, in the category of the rule", () => {
    expect(LEVEL_PENALTY).toEqual({ error: 12, warning: 5, note: 1 });
    const d = computeDebtScore([f("LAZ001", "error"), f("LAZ010", "warning"), f("LAZ002", "warning"), f("LAZ008", "warning"), f("LAZ009", "error"), f("LAZ005", "note")]);
    const by = Object.fromEntries(d.breakdown.map((c) => [c.id, c]));
    expect(by["bitwise-numeric"]).toMatchObject({ findings: 2, high: 1, medium: 1, info: 0, penalty: 17, score: 58 });
    expect(by["async-callbacks"]).toMatchObject({ findings: 1, medium: 1, penalty: 5, score: 88 });
    expect(by["security-scope"]).toMatchObject({ findings: 2, high: 1, medium: 1, penalty: 17, score: 58 });
    expect(by["module-cycles"]).toMatchObject({ findings: 1, info: 1, penalty: 1, score: 98 });
    expect(d.score).toBe(100 - 17 - 5 - 17 - 1);
    expect(d).toMatchObject({ score: 60, debtScore: 40, grade: "C", total: 6, high: 2 });
  });

  it("caps one category at 40 points, so a noisy category cannot hide the others", () => {
    const many = Array.from({ length: 20 }, () => f("LAZ001", "error"));
    const d = computeDebtScore(many);
    expect(CATEGORY_CAP).toBe(40);
    expect(d.breakdown[0]).toMatchObject({ findings: 20, penalty: 40, score: 0 });
    expect(d.score).toBe(60);
    expect(d.breakdown.slice(1).every((c) => c.score === 100)).toBe(true);
  });

  it("never goes below 0 or above 100, and ignores a rule that no category lists", () => {
    const everything = DEBT_CATEGORIES.flatMap((c) => c.rules.flatMap((r) => Array.from({ length: 10 }, () => f(r, "error"))));
    expect(computeDebtScore(everything)).toMatchObject({ score: 0, debtScore: 100, grade: "F" });
    expect(computeDebtScore([f("LAZ999", "error"), f("custom", "warning")])).toMatchObject({ score: 100, grade: "A", total: 0 });
  });

  it("is deterministic and independent of the order of the findings", () => {
    const list = [f("LAZ001", "error", { line: 3 }), f("LAZ008", "warning"), f("LAZ002", "note"), f("LAZ005", "warning"), f("LAZ009", "error")];
    const a = computeDebtScore(list);
    expect(computeDebtScore([...list].reverse())).toEqual(a);
    expect(computeDebtScore(list)).toEqual(a);
    expect(JSON.stringify(computeDebtScore(list))).toBe(JSON.stringify(a));
  });

  it("grades A from 90, B from 75, C from 60, D from 40, F below", () => {
    expect([100, 90, 89, 75, 74, 60, 59, 40, 39, 0].map(gradeFor)).toEqual(["A", "A", "B", "B", "C", "C", "D", "D", "F", "F"]);
    expect(computeDebtScore([f("LAZ001", "warning"), f("LAZ002", "warning")]).grade).toBe("A");
    expect(computeDebtScore([f("LAZ001", "error")]).grade).toBe("B");
    expect(computeDebtScore([f("LAZ001", "error"), f("LAZ002", "error"), f("LAZ008", "error")])).toMatchObject({ score: 64, grade: "C" });
    expect(computeDebtScore([f("LAZ001", "error"), f("LAZ002", "error"), f("LAZ008", "error"), f("LAZ005", "error")])).toMatchObject({ score: 52, grade: "D" });
    const heavy = [...Array.from({ length: 4 }, () => f("LAZ001", "error")), ...Array.from({ length: 4 }, () => f("LAZ002", "error"))];
    expect(computeDebtScore(heavy)).toMatchObject({ score: 20, grade: "F" });
  });

  it("names the worst category in the summary", () => {
    const d = computeDebtScore([f("LAZ008", "error"), f("LAZ008", "error"), f("LAZ002", "note")]);
    expect(d.summary).toBe("75/100, grade B: 3 findings (2 high); the most debt is in Security/Scope.");
    expect(computeDebtScore([f("LAZ001", "note")]).summary).toContain("1 finding (0 high)");
  });

  it("scores the real audit of the built-in specimens", () => {
    const leaky = computeDebtScore(sarifFindings({ "specimen.js": preset("legacyLeakyMutator") }));
    expect(leaky.breakdown.find((c) => c.id === "security-scope")?.findings).toBeGreaterThanOrEqual(1);
    expect(leaky.score).toBeLessThan(100);
    const merge = computeDebtScore(sarifFindings({ "specimen.js": preset("legacyUnsafeMerge") }));
    expect(merge.breakdown.find((c) => c.id === "security-scope")?.high).toBe(1);
    const clean = computeDebtScore(sarifFindings({ "specimen.js": "export const x = 1;" }));
    expect(clean).toMatchObject({ score: 100, grade: "A" });
    for (const dir of ["legacy-circular-ledger", "legacy-invoice-engine", "legacy-text-pipeline"]) {
      const folder = nodePath.join(root, "examples", dir);
      const files = Object.fromEntries(fs.readdirSync(folder).map((n) => [n, fs.readFileSync(nodePath.join(folder, n), "utf8")]));
      const d = computeDebtScore(sarifFindings(files));
      expect(d.score, dir).toBeGreaterThanOrEqual(0);
      expect(d.score, dir).toBeLessThanOrEqual(100);
      expect(d.score + d.debtScore, dir).toBe(100);
      expect(computeDebtScore(sarifFindings(files)), dir).toEqual(d);
    }
    expect(computeDebtScore(sarifFindings({ "a.js": "var s = 0; for (var i = 0; i < n; i++) { s = (s * 31 + i) | 0; } s;" })).breakdown[0]?.high).toBeGreaterThan(0);
  });
});

describe("simulateCiGate", () => {
  const leak = f("LAZ008", "warning", { file: "specimen.js", line: 3, message: "`total` is assigned in f() without var, let or const", ruleName: "UndeclaredGlobalLeak" });
  const pollution = f("LAZ009", "error", { file: "specimen.js", line: 7, message: "copies keys without a guard" });

  it("fails the pre-resurrection gate with exit 1 for a security finding, even one at warning level", () => {
    const gate = simulateCiGate([leak], VERIFIED);
    expect(gate.before).toMatchObject({ phase: "pre-resurrection", status: "FAIL", exitCode: 1, highFindings: 1, headline: "FAIL \u00b7 exit 1 \u00b7 1 High Finding" });
    expect(gate.before.text).toContain("##[group]Run npm run audit -- . --sarif --out lazarus.sarif");
    expect(gate.before.text).toContain("::warning file=specimen.js,line=3,title=LAZ008 UndeclaredGlobalLeak::`total` is assigned in f() without var, let or const");
    expect(gate.before.text).toContain("##[error]Lazarus gate: 1 High finding (LAZ008). Resurrect the code to clear them.");
    expect(gate.before.text.trimEnd().endsWith("##[error]Process completed with exit code 1.")).toBe(true);
  });

  it("annotates an error finding as ::error and lists every blocking rule once", () => {
    const gate = simulateCiGate([pollution, leak, f("LAZ001", "error", { file: "a.js", line: 1 })], VERIFIED);
    expect(gate.before.headline).toBe("FAIL \u00b7 exit 1 \u00b7 3 High Findings");
    expect(gate.before.text).toContain("::error file=specimen.js,line=7,title=LAZ009 PrototypePollutionRisk::copies keys without a guard");
    expect(gate.before.text).toContain("::error file=a.js,line=1,title=LAZ001 BitwiseTruncation::BitwiseTruncation");
    expect(gate.before.text).toContain("(LAZ001, LAZ008, LAZ009)");
  });

  it("passes the post-resurrection gate with exit 0, 0 High Findings and Ed25519 Verified", () => {
    const gate = simulateCiGate([leak, pollution], VERIFIED);
    expect(gate.after).toMatchObject({ phase: "post-resurrection", status: "PASS", exitCode: 0, highFindings: 0, headline: "PASS \u00b7 exit 0 \u00b7 0 High Findings \u00b7 Ed25519 Verified" });
    expect(gate.transition).toBe("FAIL \u2192 PASS");
    expect(gate.workflow).toBe(".github/workflows/lazarus-parity.yml");
    expect(gate.after.text).toContain("exact Object.is parity over 100 runs, seed 42");
    expect(gate.after.text).toContain("tsc --strict: 0 errors");
    expect(gate.after.text).toContain("Ed25519 certificate verified (key 0e3366a1c87de918)");
    expect(gate.after.text).toContain("\u2713 Lazarus gate: 0 High findings unproven (2 blocking findings resolved or covered by the exact parity proof). Process completed with exit code 0.");
  });

  it("passes before the resurrection too when nothing blocks (warnings and notes do not)", () => {
    const gate = simulateCiGate([f("LAZ004", "warning"), f("LAZ002", "warning"), f("LAZ010", "note")], VERIFIED);
    expect(gate.before).toMatchObject({ status: "PASS", exitCode: 0, headline: "PASS \u00b7 exit 0 \u00b7 0 High Findings" });
    expect(gate.transition).toBe("PASS \u2192 PASS");
    expect(simulateCiGate([], undefined).before.status).toBe("PASS");
  });

  it("is PENDING after, not faked, without a verified resurrection", () => {
    for (const after of [undefined, null]) {
      const gate = simulateCiGate([leak], after);
      expect(gate.after).toMatchObject({ status: "PENDING", exitCode: null, headline: "PENDING \u00b7 run RESURRECT SPECIMEN" });
      expect(gate.transition).toBe("FAIL \u2192 PENDING");
      expect(gate.after.text).toContain("Run RESURRECT SPECIMEN");
    }
  });

  it("fails after when the resurrection is not verified, and says why", () => {
    const gate = simulateCiGate([leak], { verified: false, parity: true, tscErrors: 2, signed: true, reason: "tsc --strict is not clean" });
    expect(gate.after).toMatchObject({ status: "FAIL", exitCode: 1, headline: "FAIL \u00b7 exit 1 \u00b7 Not Verified \u00b7 tsc --strict is not clean" });
    expect(gate.after.text).toContain("##[error]Lazarus gate: the resurrection is not verified (tsc --strict is not clean).");
    expect(gate.after.text).toContain("tsc --strict: 2 errors");
    expect(gate.transition).toBe("FAIL \u2192 FAIL");
    const forged = simulateCiGate([leak], { verified: false, parity: false, tscErrors: null, signed: false, reason: "signature does not verify" });
    expect(forged.after.text).toContain("Ed25519 certificate NOT verified");
    expect(forged.after.text).toContain("PARITY FAILED");
    expect(forged.after.text).toContain("tsc --strict: not measured");
  });

  it("calls a graph that carries no signature Whole-Graph Parity Verified", () => {
    const gate = simulateCiGate([leak], { verified: true, parity: true, tscErrors: 0, signed: null, runs: 60 });
    expect(gate.after.headline).toBe("PASS \u00b7 exit 0 \u00b7 0 High Findings \u00b7 Whole-Graph Parity Verified");
    expect(gate.after.text).toContain("Whole-graph parity verified (this artifact carries no signature)");
  });

  it("escapes workflow commands so a message cannot start another one, and truncates a long list", () => {
    expect(escapeCommand("a%b\r\nc")).toBe("a%25b%0D%0Ac");
    expect(escapeCommand("a:b,c", true)).toBe("a%3Ab%2Cc");
    const gate = simulateCiGate([f("LAZ009", "error", { file: "we,ird:name.js", line: 1, message: "x\n::error file=evil::pwned" })], VERIFIED);
    const annotation = gate.before.text.split("\n").filter((l) => l.startsWith("::error"));
    expect(annotation).toHaveLength(1);
    // The newline cannot end the command: it is flattened, and the injected text stays inside the one annotation.
    expect(annotation[0]).toBe("::error file=we%2Cird%3Aname.js,line=1,title=LAZ009 PrototypePollutionRisk::x ::error file=evil::pwned");
    expect(simulateCiGate([f("LAZ009", "error", { file: "a.js", line: 2, message: "100% unsafe" })], VERIFIED).before.text).toContain("::100%25 unsafe");
    const many = simulateCiGate(Array.from({ length: 12 }, (_, i) => f("LAZ001", "error", { file: "a.js", line: i + 1 })), VERIFIED);
    expect(many.before.text.split("\n").filter((l) => l.startsWith("::error"))).toHaveLength(8);
    expect(many.before.text).toContain("##[warning]... and 4 more blocking findings");
    expect(many.before.highFindings).toBe(12);
  });

  it("is deterministic and keeps the log lines and the text in step", () => {
    const a = simulateCiGate([leak, pollution], VERIFIED);
    expect(simulateCiGate([pollution, leak], VERIFIED)).toEqual(a);
    expect(a.before.text.split("\n")).toHaveLength(a.before.lines.length);
    expect(a.after.text.split("\n")).toHaveLength(a.after.lines.length);
    expect(a.before.lines[0]).toEqual({ level: "group", text: "Run actions/checkout@v4" });
  });
});

describe("renderVerifiedBadgeSvg", () => {
  it("renders the shield 'Lazarus Verified | 100% Parity · tsc 0'", () => {
    const svg = renderVerifiedBadgeSvg({ parity: 100, tscErrors: 0, seed: 1375503261 });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="')).toBe(true);
    expect(svg).toContain(">Lazarus Verified</text>");
    expect(svg).toContain(">100% Parity \u00b7 tsc 0</text>");
    expect(svg).toContain('role="img" aria-label="Lazarus Verified: 100% Parity \u00b7 tsc 0 \u00b7 seed 1375503261"');
    expect(svg).toContain("<title>Lazarus Verified: 100% Parity \u00b7 tsc 0 \u00b7 seed 1375503261</title>");
    expect(svg).toContain('fill="#059669"');
    expect(svg.endsWith("</svg>\n")).toBe(true);
    const width = Number(/width="(\d+)"/.exec(svg)?.[1]);
    expect(width).toBeGreaterThan(150);
    expect(svg).toContain(`viewBox="0 0 ${width} 20"`);
  });

  it("changes colour with the proof: green, amber for tsc errors, red below full parity", () => {
    expect(badgeParts({ parity: 100, tscErrors: 0 })).toEqual({ label: "Lazarus Verified", message: "100% Parity \u00b7 tsc 0", color: "#059669" });
    expect(badgeParts({ parity: 100, tscErrors: 3 }).color).toBe("#d97706");
    expect(badgeParts({ parity: 99, tscErrors: 0 }).color).toBe("#dc2626");
    expect(renderVerifiedBadgeSvg({ parity: 100, tscErrors: 3 })).toContain("tsc 3");
  });

  it("is XSS-safe: every text is escaped and nothing loads or runs", () => {
    const evil = renderVerifiedBadgeSvg({ label: '<script>alert(1)</script>"&\'', parity: 100, tscErrors: 0, seed: 7 });
    expect(evil).not.toContain("<script");
    expect(evil).not.toMatch(/<(?!\/?(svg|title|rect|g|text)[\s>/])/);
    expect(evil).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&amp;&#39;");
    for (const bad of [/\son\w+=/i, /javascript:/i, /\shref=/i, /xlink/i, /<image/i, /<foreignObject/i, /<style/i, /url\(/i, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/i]) expect(evil, String(bad)).not.toMatch(bad);
    // The only attribute values come from the escaped title and from numbers.
    const attrs = [...evil.matchAll(/(\w[\w-]*)="([^"]*)"/g)];
    for (const [, name, value] of attrs) if (name === "aria-label") expect(value).not.toMatch(/[<>"]/);
    expect(escapeXml("<a href=\"x\" onload='y'>&")).toBe("&lt;a href=&quot;x&quot; onload=&#39;y&#39;&gt;&amp;");
    expect(escapeXml("a\u0000b\u001fc\u007fd\u2028e")).toBe("abcde");
  });

  it("validates its numbers instead of printing them", () => {
    const parts = (parity: number, tscErrors: number): string => badgeParts({ parity, tscErrors }).message;
    expect(parts(Number.NaN, Number.POSITIVE_INFINITY)).toBe("0% Parity \u00b7 tsc 0");
    expect(parts(250, -4)).toBe("100% Parity \u00b7 tsc 0");
    expect(parts(-5, 2.9)).toBe("0% Parity \u00b7 tsc 2");
    expect(parts(99.9, 0)).toBe("99% Parity \u00b7 tsc 0");
    expect(renderVerifiedBadgeSvg({ parity: 100, tscErrors: 0, seed: 1.5 })).not.toContain("seed");
    expect(renderVerifiedBadgeSvg({ parity: 100, tscErrors: 0 })).not.toContain("seed");
  });

  it("falls back to the default label for an empty one, trims and clips a long one, and never reads a control character", () => {
    expect(badgeParts({ label: "", parity: 100, tscErrors: 0 }).label).toBe("Lazarus Verified");
    expect(badgeParts({ label: "  \n\t ", parity: 100, tscErrors: 0 }).label).toBe("Lazarus Verified");
    expect(badgeParts({ label: "x".repeat(80), parity: 100, tscErrors: 0 }).label).toHaveLength(32);
    expect(badgeParts({ label: "My\u0000 App", parity: 100, tscErrors: 0 }).label).toBe("My App");
  });

  it("is deterministic and well formed", () => {
    const input = { label: "Acme", parity: 100, tscErrors: 0, seed: 5 };
    expect(renderVerifiedBadgeSvg(input)).toBe(renderVerifiedBadgeSvg({ ...input }));
    const svg = renderVerifiedBadgeSvg(input);
    const opens = [...svg.matchAll(/<(svg|g|title|text)[\s>]/g)].length;
    const closes = [...svg.matchAll(/<\/(svg|g|title|text)>/g)].length;
    expect(opens).toBe(closes);
  });
});

describe("POST /api/audit-sarif: debtScore and ciGate (additive)", () => {
  const server = createWebServer();
  let baseUrl = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
  interface Audit {
    status: number;
    json: { error?: string; sarif: { version: string; runs: Array<{ results: unknown[] }> }; findings: Array<{ ruleId: string }>; debtScore: ReturnType<typeof computeDebtScore>; ciGate: ReturnType<typeof simulateCiGate> };
  }
  const audit = async (body: unknown): Promise<Audit> => {
    const res = await fetch(`${baseUrl}/api/audit-sarif`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Audit["json"] };
  };
  async function resurrect(code: string, name: string, schema: unknown): Promise<{ modernCode: string; certificate: { signature: { payload: Record<string, unknown>; signatureB64: string; publicKeyPem: string; keyId: string } } }> {
    const res = await fetch(`${baseUrl}/api/resurrect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, legacyCode: code, schema, fuzzRuns: 60, seed: 11 }) });
    const frames = (await res.text()).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as { kind: string; result?: never });
    return frames.find((x) => x.kind === "result")?.result as never;
  }
  const LEAKY = preset("legacyLeakyMutator");

  it("adds the score and the gate, and leaves the SARIF log and the finding views as they were", async () => {
    const { status, json } = await audit({ code: LEAKY });
    expect(status).toBe(200);
    expect(json.sarif.version).toBe("2.1.0");
    expect(json.debtScore.score).toBeLessThan(100);
    expect(json.debtScore.breakdown).toHaveLength(4);
    expect(json.debtScore.breakdown.find((c) => c.id === "security-scope")?.findings).toBeGreaterThanOrEqual(1);
    expect(json.ciGate.before).toMatchObject({ status: "FAIL", exitCode: 1 });
    expect(json.ciGate.before.text).toContain("LAZ008 UndeclaredGlobalLeak");
    expect(json.ciGate.after).toMatchObject({ status: "PENDING", exitCode: null });
    expect(json.findings.some((x) => x.ruleId === "LAZ008")).toBe(true);
  });

  it("scores an example folder and a clean file", async () => {
    const example = await audit({ example: "legacy-text-pipeline" });
    expect(example.status).toBe(200);
    expect(example.json.debtScore.score + example.json.debtScore.debtScore).toBe(100);
    expect(example.json.ciGate.after.status).toBe("PENDING");
    const clean = await audit({ code: "export const x = 1;" });
    expect(clean.json.debtScore).toMatchObject({ score: 100, grade: "A" });
    expect(clean.json.ciGate.before).toMatchObject({ status: "PASS", exitCode: 0 });
  });

  it("builds the post-resurrection gate from a verified Ed25519 certificate: FAIL exit 1 before, PASS exit 0 after", async () => {
    const r = await resurrect(LEAKY, "legacyLeakyMutator", { list: "json", factor: "integer" });
    const sig = r.certificate.signature;
    const { status, json } = await audit({ code: LEAKY, verification: { payload: sig.payload, signatureB64: sig.signatureB64, publicKeyPem: sig.publicKeyPem, resurrectedCode: r.modernCode } });
    expect(status).toBe(200);
    expect(json.ciGate.before.headline).toMatch(/^FAIL \u00b7 exit 1 \u00b7 \d+ High Findings?$/);
    expect(json.ciGate.after).toMatchObject({ status: "PASS", exitCode: 0, headline: "PASS \u00b7 exit 0 \u00b7 0 High Findings \u00b7 Ed25519 Verified" });
    expect(json.ciGate.after.text).toContain(`key ${sig.keyId}`);
    expect(json.ciGate.after.text).toContain("seed 11");
    expect(json.ciGate.transition).toBe("FAIL \u2192 PASS");
  }, 60_000);

  it("never trusts a claim: a certificate for other code, another resurrected text, or a forged signature does not pass", async () => {
    const r = await resurrect(LEAKY, "legacyLeakyMutator", { list: "json", factor: "integer" });
    const sig = r.certificate.signature;
    const verification = { payload: sig.payload, signatureB64: sig.signatureB64, publicKeyPem: sig.publicKeyPem, resurrectedCode: r.modernCode };
    const otherCode = await audit({ code: `${LEAKY}\n// edited`, verification });
    expect(otherCode.json.ciGate.after).toMatchObject({ status: "FAIL", exitCode: 1 });
    expect(otherCode.json.ciGate.after.headline).toContain("the certificate is for different code");
    const swapped = await audit({ code: LEAKY, verification: { ...verification, resurrectedCode: `${r.modernCode}\n// tampered` } });
    expect(swapped.json.ciGate.after.status).toBe("FAIL");
    expect(swapped.json.ciGate.after.headline).toContain("signature does not verify");
    const forged = await audit({ code: LEAKY, verification: { ...verification, payload: { ...sig.payload, tscStrictErrors: 0, paritySummary: "exact Object.is parity, 9999 fuzz runs, 1 attempt" } } });
    expect(forged.json.ciGate.after.status).toBe("FAIL");
    expect(sha256Hex(LEAKY)).toBe(sig.payload["legacySha256"]);
  }, 60_000);

  it("rejects a verification without code, an unknown key and a malformed certificate", async () => {
    expect((await audit({ example: "legacy-text-pipeline", verification: { payload: {}, signatureB64: "x", publicKeyPem: "y", resurrectedCode: "z" } })).status).toBe(400);
    expect((await audit({ code: "var x = 1;", verification: { payload: {}, signatureB64: "x", publicKeyPem: "y", resurrectedCode: "z", extra: 1 } })).status).toBe(400);
    expect((await audit({ code: "var x = 1;", verification: { payload: "nope" } })).status).toBe(400);
    const junk = await audit({ code: "var x = 1;", verification: { payload: { nope: 1 }, signatureB64: "AAAA", publicKeyPem: "not a key", resurrectedCode: "z" } });
    expect(junk.status).toBe(200);
    expect(junk.json.ciGate.after.status).toBe("FAIL");
  });

  it("puts debtScore and ciGate on a Tab 2 graph result (no signature: Whole-Graph Parity Verified)", async () => {
    const dir = nodePath.join(root, "examples", "legacy-text-pipeline");
    const files = Object.fromEntries(fs.readdirSync(dir).map((n) => [n, fs.readFileSync(nodePath.join(dir, n), "utf8")]));
    const res = await fetch(`${baseUrl}/api/resurrect-graph`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "text", files, seed: 3, fileRuns: 30, graphRuns: 40 }) });
    const frames = (await res.text()).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as { kind: string; result?: { success: boolean; debtScore: ReturnType<typeof computeDebtScore>; ciGate: ReturnType<typeof simulateCiGate> } });
    const result = frames.find((x) => x.kind === "result")?.result;
    expect(result?.success).toBe(true);
    expect(result?.debtScore.breakdown).toHaveLength(4);
    expect(result?.debtScore.score).toBeGreaterThanOrEqual(0);
    expect(result?.ciGate.after).toMatchObject({ status: "PASS", exitCode: 0, headline: "PASS \u00b7 exit 0 \u00b7 0 High Findings \u00b7 Whole-Graph Parity Verified" });
  }, 90_000);
});
