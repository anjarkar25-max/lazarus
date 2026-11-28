import * as fs from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { closeSharedTsVerifier } from "../../crew/ts-verifier.js";
import { resurrectGraph } from "../../crew/graph-resurrector.js";
import { PooledProbeRunner } from "../../sandbox/pool.js";
import { buildExportBundle } from "../../web/server.js";
import { bundleToZipEntries } from "../bundle.js";
import { CERTIFICATE_JSON_FILE, verifyBundleZip } from "../cert-crypto.js";
import { parseReportExtras } from "../export-report.js";
import { buildGraphBundle, graphBundleZip } from "../graph-bundle.js";
import { REPORT_FILE, esc, renderResurrectionReport, sideBySide, type ReportInput } from "../html-report.js";
import { createZip, readZip } from "../zip.js";
import { diffLines } from "../../web/line-diff.js";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../../..");
const legacyPool = new PooledProbeRunner();
const modernPool = new PooledProbeRunner();
afterAll(async () => {
  await Promise.all([legacyPool.close(), modernPool.close()]);
  await closeSharedTsVerifier();
});

const LEGACY = "function half(n) { return (n / 2) | 0; }\nmodule.exports = half;";
const MODERN = "export function half(n: number): number {\n  return Math.trunc(n / 2) || 0;\n}\n";
const base = (over: Partial<ReportInput> = {}): ReportInput => ({
  name: "half",
  legacyCode: LEGACY,
  modernCode: MODERN,
  fuzz: { runs: 100, attempts: 2, healed: true, exact: true },
  typecheck: { passed: true, errorCount: 0, filesChecked: 1, tsVersion: "7.0.2" },
  ...over,
});
/** What a browser would fetch: any src/href attribute, a CSS url(), an @import or a script/link/img/iframe element. */
const LOADS = /<script|<link|<img|<iframe|<object|<embed|<video|<audio|\ssrc\s*=|\shref\s*=|url\(|@import/i;

describe("renderResurrectionReport (offline, self-contained)", () => {
  const full = renderResurrectionReport(
    base({
      purity: { globalLeaksDetected: ["total"], globalLeaksEliminated: true, prototypeSafe: true, inputMutationParity: true, legacyMutatesInput: true, legacyLeakedGlobals: ["total"], samples: 6, proven: true, details: [] },
      mutation: { killed: 4, total: 5, mutants: [{ operator: "Math.trunc -> Math.floor", status: "killed", originalLine: "return Math.trunc(n / 2) || 0;", mutatedLine: "return Math.floor(n / 2) || 0;", killerInput: "n = -3", legacyOutput: "-1", mutantOutput: "-2", divergence: "Object.is mismatch" }, { operator: "boundary-flip", status: "survived" }] },
      signature: { keyId: "0e3366a1c87de918", legacySha256: "a".repeat(64), resurrectedSha256: "b".repeat(64), signatureB64: "c2ln", issuedAt: "2026-01-01T00:00:00.000Z" },
      perf: { ratio: 1.12, legacyMedianUs: 3.8, resurrectedMedianUs: 3.4, verdict: "faster" },
      causal: { rules: [{ rule: "bitor0-trunc", status: "rolled-back", reason: "32-bit overflow" }, { rule: "var-scoping", status: "applied", reason: "var became let" }], counterexample: { input: "n = 2147483648", legacyOutput: "-1073741824", modernOutput: "1073741824" }, shrink: { steps: 3, from: "n = 99999999999", to: "n = 2147483648" } },
      files: ["resurrected.ts", REPORT_FILE],
    })
  );
  it("is one HTML document with inline CSS and nothing a browser would load", () => {
    expect(REPORT_FILE).toBe("RESURRECTION_REPORT.html");
    expect(full.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(full).toContain("<style>");
    expect(full).toContain("Content-Security-Policy");
    expect(full).toContain("default-src 'none'");
    expect(full).not.toMatch(LOADS);
    expect(full).not.toMatch(/https?:\/\//i);
    expect(full).not.toMatch(/@font-face|fonts\.googleapis|cdn\./i);
  });
  it("shows the 5 pillars, the compiler proof, the side-by-side diff, the rollback trace and the mutant autopsy", () => {
    for (const s of ["5-Pillar Proof Scorecard", "1 \u00b7 Object.is parity", "2 \u00b7 Purity / no global leaks", "3 \u00b7 Mutant kill rate", "4 \u00b7 Ed25519 signature &amp; digest", "5 \u00b7 Performance parity", "tsc --strict", "0 errors", "4/5 killed", "leaks fixed: total", "1.12x faster", "key 0e3366a1c87de918", "Legacy (ES5 / CommonJS)", "Resurrected (ES2022 / TypeScript)", "Causal rollback &amp; shrink trace", "bitor0-trunc", "rolled back", "Shrink trace", "Mutant Autopsy", "SURVIVED", "KILLED"]) expect(full, s).toContain(s);
  });
  it("says \"not measured\" for a pillar the run did not produce, never a made-up pass", () => {
    const bare = renderResurrectionReport(base());
    expect(bare.match(/not measured/g)?.length).toBeGreaterThanOrEqual(3);
    expect(bare).toContain("not signed");
    expect(bare).not.toContain("PROVEN</div><p>leaks");
    const skipped = renderResurrectionReport(base({ perf: { skipped: "async specimen" } }));
    expect(skipped).toContain("async specimen");
  });
  it("marks a purity proof that failed, a survivor and a compiler error", () => {
    const html = renderResurrectionReport(
      base({
        purity: { globalLeaksDetected: [], globalLeaksEliminated: true, prototypeSafe: false, inputMutationParity: false, legacyMutatesInput: false, legacyLeakedGlobals: [], samples: 3, proven: false, details: [] },
        typecheck: { passed: false, errorCount: 1, filesChecked: 1, diagnostics: [{ file: "resurrected.ts", line: 3, code: 2304, message: "Cannot find name 'total'." }] },
      })
    );
    expect(html).toContain("NOT PROVEN");
    expect(html).toContain("CHANGED");
    expect(html).toContain("1 error");
    expect(html).toContain("TS2304");
  });
  it("escapes every piece of user text (code, names, messages), so nothing can inject markup", () => {
    const evil = "</pre><script>alert(1)</script><img src=x onerror=alert(2)>\"'&";
    const html = renderResurrectionReport(
      base({
        name: evil,
        legacyCode: `var a = "${evil}";`,
        modernCode: `const a = "${evil}";`,
        mutation: { killed: 0, total: 1, mutants: [{ operator: evil, status: "survived", originalLine: evil, divergence: evil }] },
        causal: { rules: [{ rule: evil, status: "applied", reason: evil }] },
        typecheck: { passed: false, errorCount: 1, filesChecked: 1, diagnostics: [{ file: evil, line: 1, code: 1, message: evil }] },
        files: [evil],
      })
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(esc(evil)).toBe("&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;&quot;&#39;&amp;");
    // A real script element appears nowhere, whatever the input; the one <title> is escaped too.
    expect((html.match(/<title>/g) ?? []).length).toBe(1);
  });
  it("is deterministic for the same input", () => {
    expect(renderResurrectionReport(base())).toBe(renderResurrectionReport(base()));
  });
  it("pairs a deleted run with the added run after it, row by row", () => {
    const rows = sideBySide(diffLines("a\nb\nc", "a\nB\nB2\nc"));
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([["a", "a"], ["b", "B"], [null, "B2"], ["c", "c"]]);
  });
});

describe("parseReportExtras (what the Studio session may add)", () => {
  it("accepts well-formed summaries and ignores malformed ones", () => {
    const ok = parseReportExtras({ perfParity: { ratio: 1.1, legacyMedianUs: 2, resurrectedMedianUs: 1.8, verdict: "faster" }, mutants: [{ operator: "x", status: "killed" }], causal: { shrink: { steps: 2, from: "a", to: "b" } } });
    expect(ok.perf).toMatchObject({ verdict: "faster" });
    expect(ok.mutants).toHaveLength(1);
    expect(ok.causal?.shrink?.steps).toBe(2);
    const bad = parseReportExtras({ perfParity: { ratio: "fast" }, mutants: [{ status: "dead" }], causal: { shrink: { steps: -1 } } });
    expect(bad).toEqual({});
    expect(parseReportExtras({ mutants: new Array(11).fill({ operator: "x", status: "killed" }) })).toEqual({});
  });
});

describe("RESURRECTION_REPORT.html inside the exported .zip bundles", () => {
  it("joins every single-file .zip next to the existing entries, with the Ed25519 certificate still valid", async () => {
    const bundle = await buildExportBundle(
      { specimenName: "half", legacyCode: LEGACY, modernCode: "Math.trunc(n / 2) || 0", schema: { n: "integer" }, fuzzRuns: 60, attempts: 2, healed: true, mutationAudit: { killed: 4, total: 5 }, perfParity: { ratio: 1.1, legacyMedianUs: 2, resurrectedMedianUs: 1.8, verdict: "faster" }, mutants: [{ operator: "boundary-flip", status: "killed", killerInput: "n = 1" }] },
      { report: true }
    );
    expect(bundle.reportHtml).toBeDefined();
    const entries = bundleToZipEntries(bundle.bundle);
    const names = entries.map((e) => e.name);
    for (const kept of ["resurrected.ts", "resurrected.test.ts", "SPEC.md", "resurrection.patch", ".github/workflows/lazarus-parity.yml", ".github/workflows/lazarus-audit.yml"]) expect(names, kept).toContain(kept);
    expect(names).toContain(REPORT_FILE);
    expect(new Set(names).size).toBe(names.length);
    const zip = createZip([...entries, { name: CERTIFICATE_JSON_FILE, data: bundle.certificateJson }]);
    const back = readZip(zip);
    const report = back.find((e) => e.name === REPORT_FILE)?.data.toString("utf8") ?? "";
    expect(report).toBe(bundle.reportHtml);
    expect(report).not.toMatch(LOADS);
    expect(report).not.toMatch(/https?:\/\//i);
    for (const s of ["4/5 killed", "tsc --strict", "key " + bundle.signature.keyId, "1.10x faster", "boundary-flip", "Purity"]) expect(report, s).toContain(s);
    expect(report).toContain(bundle.signature.payload.resurrectedSha256.slice(0, 16));
    // The signature still covers resurrected.ts and the archive still verifies; the report is not part of the signed subject.
    expect(verifyBundleZip(zip)).toMatchObject({ valid: true, subjectFile: "resurrected.ts" });
    expect(bundle.bundle.files).not.toHaveProperty(REPORT_FILE);
  }, 90_000);
  it("is built only when asked: the default bundle (CLI, MCP, resurrect route) is unchanged", async () => {
    const plain = await buildExportBundle({ specimenName: "half", legacyCode: LEGACY, modernCode: "Math.trunc(n / 2) || 0", schema: { n: "integer" }, fuzzRuns: 30 });
    expect(plain.reportHtml).toBeUndefined();
    expect(bundleToZipEntries(plain.bundle).map((e) => e.name)).not.toContain(REPORT_FILE);
  }, 60_000);
  it("covers an async (Promise chain) export as well, with the async skip note for Performance Parity", async () => {
    const chain = "function legacyPromiseChain(text) {\n  return Promise.resolve(text).then(function (v) { return v.length; }).catch(function () { return 0; });\n}\nmodule.exports = legacyPromiseChain;";
    const { resurrectAny } = await import("../../resurrect-any.js");
    const r = await resurrectAny({ name: "legacyPromiseChain", source: chain, schema: { text: "string" } as never, fuzzRuns: 30, seed: 4 });
    expect(r.success).toBe(true);
    const bundle = await buildExportBundle({ specimenName: "legacyPromiseChain", legacyCode: chain, modernCode: r.modernCode, schema: { text: "string" }, fuzzRuns: 30 }, { report: true });
    const names = bundleToZipEntries(bundle.bundle).map((e) => e.name);
    expect(names).toContain(REPORT_FILE);
    expect(bundle.reportHtml).toContain("async/await conversion");
    expect(bundle.reportHtml).toContain("Async specimens settle");
  }, 90_000);
  it("joins the whole-project .zip when asked, and is absent otherwise", async () => {
    const dir = nodePath.join(root, "examples", "legacy-invoice-engine");
    const files: Record<string, string> = {};
    for (const f of fs.readdirSync(dir).sort()) files[f] = fs.readFileSync(nodePath.join(dir, f), "utf8");
    const result = await resurrectGraph(files, { name: "legacy-invoice-engine", executors: { legacy: legacyPool, modern: modernPool }, fileRuns: 20, graphRuns: 20, seed: 3 });
    const without = readZip(graphBundleZip(buildGraphBundle(result, { runs: 20 }))).map((e) => e.name);
    expect(without).not.toContain(REPORT_FILE);
    const bundle = buildGraphBundle(result, { runs: 20, report: true });
    const entries = readZip(graphBundleZip(bundle));
    const names = entries.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining([...without, REPORT_FILE]));
    expect(names).toHaveLength(without.length + 1);
    const html = entries.find((e) => e.name === REPORT_FILE)?.data.toString("utf8") ?? "";
    expect(html).toContain("whole-project stitch");
    for (const f of ["money.cjs", "tax.cjs", "invoice.cjs"]) expect(html).toContain(f);
    expect(html).not.toMatch(LOADS);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(bundle.files).not.toHaveProperty(REPORT_FILE);
  }, 90_000);
});
