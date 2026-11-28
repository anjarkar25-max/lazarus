import { generateKeyPairSync, sign } from "node:crypto";
import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBenchmark } from "../../benchmark.js";
import { BENCHMARK_PRESETS } from "../../benchmark-presets.js";
import { SARIF_RULES, auditDirectory, renderSarif, runAuditCli, type SarifLog } from "../../cli-audit.js";
import { main } from "../../cli.js";
import { classifySpecimen } from "../../crew/async-specimen.js";
import { closeSharedTsVerifier } from "../../crew/ts-verifier.js";
import { canonicalPayload, signCertificate } from "../../exporter/cert-crypto.js";
import { createZip, readZip } from "../../exporter/zip.js";
import { createLazarusMcpServer, executeResurrect } from "../../mcp/server.js";
import { resurrectAny } from "../../resurrect-any.js";
import type { AuditSarifResult } from "../audit-sarif.js";
import { VERIFY_BUNDLE_MAX_BYTES, createWebServer } from "../server.js";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../../..");
const preset = (name: string): { code: string; schema: Record<string, string> } => {
  const p = BENCHMARK_PRESETS.find((x) => x.name === name);
  if (p === undefined) throw new Error(`no preset ${name}`);
  return { code: p.code, schema: p.schema as Record<string, string> };
};

const LEGACY = "function half(n) { return (n / 2) | 0; }";
const MODERN = "Math.trunc(n / 2) || 0";
const flip = (text: string, at = text.search(/[A-Za-z]/)): string => `${text.slice(0, at)}${text[at] === "a" ? "b" : "a"}${text.slice(at + 1)}`;

const server = createWebServer();
let baseUrl = "";
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await closeSharedTsVerifier();
});

const postJson = async <T = Record<string, unknown>>(path: string, body: unknown): Promise<{ status: number; json: T }> => {
  const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as T };
};
const postZip = async (body: Buffer | Uint8Array): Promise<{ status: number; json: Record<string, unknown> & { valid?: boolean; reason?: string; expectedDigest?: string; actualDigest?: string; trustedKey?: boolean; subjectFile?: string; entries?: string[]; error?: string } }> => {
  const res = await fetch(`${baseUrl}/api/verify-bundle`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: Buffer.from(body) });
  return { status: res.status, json: (await res.json()) as never };
};

describe("POST /api/verify-bundle", () => {
  let zip = Buffer.alloc(0);
  beforeAll(async () => {
    const res = await fetch(`${baseUrl}/api/export-zip`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ specimenName: "half", legacyCode: LEGACY, modernCode: MODERN, schema: { n: "integer" }, fuzzRuns: 100 }) });
    expect(res.status).toBe(200);
    zip = Buffer.from(await res.arrayBuffer());
  }, 60_000);
  const rewrite = (change: (name: string, data: Buffer) => Buffer): Buffer => createZip(readZip(zip).map((e) => ({ name: e.name, data: change(e.name, e.data) })));

  it("verifies an untouched export: VERIFIED, this Studio's key, the entries it read", async () => {
    const { status, json } = await postZip(zip);
    expect(status).toBe(200);
    expect(json).toMatchObject({ valid: true, subjectFile: "resurrected.ts", trustedKey: true, reason: "Ed25519 signature and SHA-256 digest verified" });
    expect(json.expectedDigest).toBe(json.actualDigest);
    expect(json.expectedDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(json.entries).toEqual(expect.arrayContaining(["certificate.json", "resurrected.ts", "SPEC.md", "resurrected.test.ts"]));
    expect(json["bytes"]).toBe(zip.length);
  });

  it("reports TAMPER DETECTED when one byte of resurrected.ts changed, with both digests", async () => {
    const tampered = rewrite((name, data) => (name === "resurrected.ts" ? Buffer.from(flip(data.toString("utf8"), data.toString("utf8").indexOf("trunc"))) : data));
    const { status, json } = await postZip(tampered);
    expect(status).toBe(200);
    expect(json.valid).toBe(false);
    expect(json.reason).toMatch(/^Digest mismatch/);
    expect(json.expectedDigest).not.toBe(json.actualDigest);
    expect(json.actualDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports TAMPER DETECTED for an altered signature, and for a rewritten payload digest", async () => {
    const edit = (change: (cert: Record<string, unknown>) => void): Buffer =>
      rewrite((name, data) => {
        if (name !== "certificate.json") return data;
        const cert = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        change(cert);
        return Buffer.from(JSON.stringify(cert));
      });
    const badSignature = await postZip(edit((c) => void (c["signatureB64"] = flip(String(c["signatureB64"]), 5))));
    expect(badSignature.json.valid).toBe(false);
    expect(badSignature.json.reason).toMatch(/^Signature mismatch/);
    const forgedDigest = await postZip(edit((c) => void ((c["payload"] as Record<string, unknown>)["resurrectedSha256"] = "0".repeat(64))));
    expect(forgedDigest.json.valid).toBe(false);
    expect(forgedDigest.json.reason).toMatch(/^Signature mismatch/);
  });

  it("accepts a self-contained signature from another key, and says it is not this Studio's key", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const code = "export const x = 1;\n";
    const mine = signCertificate({ legacySource: "legacy", resurrectedSource: code, paritySummary: "exact", issuedAt: "2026-01-01T00:00:00.000Z" });
    const signature = sign(null, Buffer.from(canonicalPayload(mine.payload), "utf8"), privateKey).toString("base64");
    const certificate = JSON.stringify({ format: "lazarus-certificate/v1", algorithm: "Ed25519", subjectFile: "resurrected.ts", payload: mine.payload, signatureB64: signature, publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(), keyId: "x" });
    const { json } = await postZip(createZip([{ name: "certificate.json", data: certificate }, { name: "resurrected.ts", data: code }]));
    expect(json).toMatchObject({ valid: true, trustedKey: false });
    expect(json.keyId).not.toBe(mine.keyId);
  });

  it("reports unreadable and incomplete archives as not verified, never as an error page", async () => {
    expect((await postZip(Buffer.from("this is not a zip archive at all"))).json).toMatchObject({ valid: false, reason: expect.stringContaining("Not a readable zip") as unknown });
    const noCert = await postZip(createZip([{ name: "resurrected.ts", data: "x" }]));
    expect(noCert.json).toMatchObject({ valid: false, reason: "certificate.json is missing from the archive", entries: ["resurrected.ts"] });
    const noSubject = await postZip(rewriteWithout(zip, "resurrected.ts"));
    expect(noSubject.json).toMatchObject({ valid: false, reason: "resurrected.ts is missing from the archive" });
    const malformed = await postZip(createZip([{ name: "certificate.json", data: "{\"format\":1}" }, { name: "resurrected.ts", data: "x" }]));
    expect(malformed.json).toMatchObject({ valid: false, reason: "certificate.json is malformed" });
  });

  it("caps what it reads: empty body 400, over 4 MB 413, and an entry that inflates past 2 MB is refused", async () => {
    const empty = await fetch(`${baseUrl}/api/verify-bundle`, { method: "POST", body: Buffer.alloc(0) });
    expect(empty.status).toBe(400);
    const big = await fetch(`${baseUrl}/api/verify-bundle`, { method: "POST", body: Buffer.alloc(VERIFY_BUNDLE_MAX_BYTES + 1, 1) });
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string }).error).toContain("too large");
    // 3 MB of zeros deflates to a few KB, so only the uncompressed cap can stop it.
    const bomb = createZip([{ name: "certificate.json", data: "{}" }, { name: "resurrected.ts", data: Buffer.alloc(3 * 1024 * 1024) }]);
    expect(bomb.length).toBeLessThan(100_000);
    const refused = await postZip(bomb);
    expect(refused.status).toBe(200);
    expect(refused.json).toMatchObject({ valid: false, reason: expect.stringMatching(/uncompressed; the limit is 2097152/) as unknown });
  });

  it("agrees with `lazarus verify` on the same archive", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-vb-"));
    try {
      fs.writeFileSync(nodePath.join(dir, "ok.zip"), zip);
      const { runVerifyCli } = await import("../../cli.js");
      let out = "";
      expect(runVerifyCli(["ok.zip"], { stdout: (t) => void (out += t), stderr: () => undefined, cwd: dir })).toBe(0);
      expect(out).toContain("VERIFIED");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
function rewriteWithout(zip: Buffer, drop: string): Buffer {
  return createZip(readZip(zip).filter((e) => e.name !== drop).map((e) => ({ name: e.name, data: e.data })));
}

describe("POST /api/audit-sarif", () => {
  const audit = async (body: unknown): Promise<{ status: number; json: AuditSarifResult & { error?: string } }> => postJson<AuditSarifResult & { error?: string }>("/api/audit-sarif", body);

  it("returns SARIF 2.1.0 for each built-in example, identical to `lazarus audit --sarif` (no duplicated rule logic)", async () => {
    for (const example of ["legacy-circular-ledger", "legacy-invoice-engine", "legacy-text-pipeline"]) {
      const { status, json } = await audit({ example });
      expect(status, example).toBe(200);
      expect(json.sarif.$schema).toBe("https://json.schemastore.org/sarif-2.1.0.json");
      expect(json.sarif.version).toBe("2.1.0");
      expect(json.sarif).toEqual(renderSarif(auditDirectory(nodePath.join(root, "examples", example), `examples/${example}`)));
      let out = "";
      expect(runAuditCli([`examples/${example}`, "--sarif"], { stdout: (t) => void (out += t), stderr: () => undefined, cwd: root })).toBe(0);
      expect(JSON.parse(out) as SarifLog).toEqual(json.sarif);
      expect(json.source).toEqual({ kind: "example", name: example });
    }
  });

  it("summarizes by rule id, zero counts included, and the counts add up", async () => {
    const { json } = await audit({ example: "legacy-circular-ledger" });
    expect(json.summary.byRule.map((r) => r.id)).toEqual(SARIF_RULES.map((r) => r.id));
    expect(json.summary.byRule.map((r) => r.id)).toEqual(["LAZ001", "LAZ002", "LAZ003", "LAZ004", "LAZ005", "LAZ006", "LAZ007"]);
    const count = (id: string): number => json.summary.byRule.find((r) => r.id === id)?.count ?? -1;
    expect(count("LAZ001")).toBe(8);
    expect(count("LAZ005")).toBeGreaterThan(0);
    expect(count("LAZ006")).toBe(0);
    expect(json.summary.byRule.reduce((n, r) => n + r.count, 0)).toBe(json.summary.total);
    expect(json.summary.total).toBe(json.findings.length);
    expect(json.summary.total).toBe(json.sarif.runs[0]?.results.length);
    expect(json.summary.totals).toEqual({ high: 10, medium: 3, info: 1 });
    expect(json.summary).toMatchObject({ directory: "examples/legacy-circular-ledger", files: 3, grade: "C", entry: "index.cjs", cycles: [["discount.cjs", "tax.cjs"]] });
  });

  it("every finding has its rule, level, repository-relative uri, line, fix guidance and a source snippet around the line", async () => {
    const { json } = await audit({ example: "legacy-invoice-engine" });
    expect(json.findings.length).toBeGreaterThan(5);
    for (const f of json.findings) {
      expect(["LAZ001", "LAZ002", "LAZ003", "LAZ004", "LAZ005", "LAZ006", "LAZ007"]).toContain(f.ruleId);
      expect(f.uri).toMatch(/^examples\/legacy-invoice-engine\/(money|tax|invoice)\.cjs$/);
      expect(f.severity).toBe({ error: "high", warning: "medium", note: "info" }[f.level]);
      expect(f.fix.length).toBeGreaterThan(20);
      expect(f.message).not.toContain("Fix:");
      expect(f.snippet.lines.length).toBeGreaterThanOrEqual(1);
      expect(f.snippet.lines.length).toBeLessThanOrEqual(3);
      expect(f.line).toBeGreaterThanOrEqual(f.snippet.startLine);
      expect(f.line).toBeLessThanOrEqual(f.snippet.startLine + f.snippet.lines.length - 1);
    }
    const truncation = json.findings.find((f) => f.ruleId === "LAZ001");
    expect(truncation?.snippet.lines[truncation.line - truncation.snippet.startLine]).toContain("| 0");
    const onDisk = fs.readFileSync(nodePath.join(root, truncation?.uri ?? ""), "utf8").split(/\r?\n/);
    expect(onDisk[(truncation?.line ?? 1) - 1]).toBe(truncation?.snippet.lines[(truncation?.line ?? 1) - (truncation?.snippet.startLine ?? 1)]);
  });

  it("audits pasted code as specimen.js: error-first callback, truncation and var, with exact lines", async () => {
    const code = "function readPort(text, cb) {\n  if (typeof text !== 'string') return cb(new TypeError('text'));\n  var n = parseInt(text, 10);\n  cb(null, (n / 2) | 0);\n}\nmodule.exports = readPort;\n";
    const { status, json } = await audit({ code });
    expect(status).toBe(200);
    expect(json.source).toEqual({ kind: "code", name: "specimen.js" });
    const at = (rule: string): number[] => json.findings.filter((f) => f.ruleId === rule).map((f) => f.line);
    expect(at("LAZ002")).toEqual([1]);
    expect(at("LAZ001")).toEqual([4]);
    expect(at("LAZ004")).toEqual([3]);
    expect(json.findings.every((f) => f.uri === "specimen.js")).toBe(true);
    expect(json.findings.find((f) => f.ruleId === "LAZ001")?.snippet).toEqual({ startLine: 3, lines: ["  var n = parseInt(text, 10);", "  cb(null, (n / 2) | 0);", "}"] });
  });

  it("reports a Promise chain (LAZ007) and a parse error (LAZ006) from pasted code", async () => {
    const chain = await audit({ code: "function load(x) {\n  return get(x).then(function (v) { return v; }).catch(function () { return 0; });\n}\nmodule.exports = load;\n" });
    expect(chain.json.findings.some((f) => f.ruleId === "LAZ007" && f.line === 1)).toBe(true);
    const broken = await audit({ code: "function ( {\n" });
    expect(broken.json.findings.map((f) => f.ruleId)).toContain("LAZ006");
    expect(broken.json.summary.byRule.find((r) => r.id === "LAZ006")?.count).toBe(1);
  });

  it("never exposes a server path, and rejects bad requests", async () => {
    const { json } = await audit({ example: "legacy-text-pipeline" });
    const text = JSON.stringify(json);
    expect(text).not.toContain(root);
    expect(text).not.toContain(root.replace(/\\/g, "/"));
    const unknown = await audit({ example: "../src" });
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toContain("legacy-circular-ledger");
    for (const [body, label] of [[{}, "empty"], [{ code: "x", example: "legacy-text-pipeline" }, "both"], [{ code: "" }, "blank code"], [{ code: "x".repeat(64_001) }, "too long"], [{ code: "x", extra: 1 }, "extra key"], [{ example: 5 }, "non-string"]] as const) {
      expect((await audit(body)).status, label).toBe(400);
    }
    const bad = await fetch(`${baseUrl}/api/audit-sarif`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{nope" });
    expect(bad.status).toBe(400);
    const huge = await fetch(`${baseUrl}/api/audit-sarif`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "x".repeat(300_000) }) });
    expect(huge.status).toBe(413);
  });

  it("is a pure parse: auditing code that would write a file or exit leaves the machine alone", async () => {
    const marker = nodePath.join(os.tmpdir(), "lazarus-audit-sarif-marker.txt");
    fs.rmSync(marker, { force: true });
    await audit({ code: `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(7);` });
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("Promise chains reach the CLI, the MCP server and the benchmark through one router", () => {
  it("classifies the specimens the same way for every front end", () => {
    expect(classifySpecimen(preset("legacyPromiseChain").code).kind).toBe("promise-chain");
    expect(classifySpecimen(preset("legacyReadConfigCb").code).kind).toBe("error-first");
    expect(classifySpecimen(preset("legacyCounterClass").code).kind).toBe("sync");
    expect(classifySpecimen(preset("cjsMathUtils").code).kind).toBe("sync");
    expect(classifySpecimen(preset("legacyPromiseChain").code, "legacyPromiseChain").entry).toMatchObject({ name: "legacyPromiseChain", params: ["text"], style: "promise-chain" });
    expect(classifySpecimen("var x = 1;").kind).toBe("sync");
    expect(classifySpecimen("function (").kind).toBe("sync");
  });

  describe("lazarus resurrect <file> (npm run resurrect)", () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-v16-cli-"));
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
    const run = async (file: string, args: string[] = []): Promise<{ code: number; out: string; err: string }> => {
      let out = "";
      let err = "";
      const code = await main([file, "--out", `out-${file}`, "--runs", "40", "--seed", "3", ...args], { stdout: (t) => void (out += t), stderr: (t) => void (err += t), cwd: dir });
      return { code, out, err };
    };

    it("resurrects a .then().catch() file as async/await: both settlements proven, tsc --strict 0 errors, bundle written", async () => {
      fs.writeFileSync(nodePath.join(dir, "chain.cjs"), preset("legacyPromiseChain").code);
      const r = await run("chain.cjs");
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(r.out).toContain("as async/await (Promise chain (.then/.catch))");
      expect(r.out).toMatch(/Async parity proven: 40 fuzz runs, 1 attempt\(s\); \d+ resolved and \d+ rejected inputs matched \(lift/);
      expect(r.out).toContain("tsc --strict: 0 errors");
      const ts = fs.readFileSync(nodePath.join(dir, "out-chain.cjs", "resurrected.ts"), "utf8");
      expect(ts).toContain("export async function legacyPromiseChain(text: string)");
      expect(ts).toMatch(/try \{[\s\S]*await pending[\s\S]*\} catch \(err\)/);
      for (const f of ["resurrected.test.ts", "SPEC.md", "legacy.cjs", "resurrection.patch", ".github/workflows/lazarus-parity.yml"]) expect(fs.existsSync(nodePath.join(dir, "out-chain.cjs", f)), f).toBe(true);
      expect(fs.readFileSync(nodePath.join(dir, "out-chain.cjs", "resurrected.test.ts"), "utf8")).toContain("await legacyModule.__lazarusEntry(...args)");
    }, 90_000);

    it("resurrects an error-first callback file the same way (the web, CLI and benchmark share the pass)", async () => {
      fs.writeFileSync(nodePath.join(dir, "cb.cjs"), preset("legacyReadConfigCb").code);
      const r = await run("cb.cjs");
      expect(r.code).toBe(0);
      expect(r.out).toContain("error-first callback (cb)");
      expect(r.out).toContain("tsc --strict: 0 errors");
      expect(fs.readFileSync(nodePath.join(dir, "out-cb.cjs", "resurrected.ts"), "utf8")).toContain("export async function legacyReadConfigCb(text: string)");
    }, 90_000);

    it("takes --schema and --name, rejects a bad --schema with exit 2, and leaves synchronous files on the old path", async () => {
      const named = await run("chain.cjs", ["--schema", '{"text":"string"}', "--name", "levelChain", "--out", "out-named"]);
      expect(named.code).toBe(0);
      expect(named.out).toContain("(from --schema)");
      expect(named.out).toContain("resurrecting levelChain");
      const bad = await run("chain.cjs", ["--schema", "{nope"]);
      expect(bad.code).toBe(2);
      expect(bad.err).toContain("--schema is not valid JSON");
      fs.writeFileSync(nodePath.join(dir, "sync.cjs"), "module.exports = function half(n) { return (n / 2) | 0; };\n");
      const sync = await run("sync.cjs");
      expect(sync.code).toBe(0);
      expect(sync.out).toContain("Parity proven");
      expect(sync.out).not.toContain("async/await");
    }, 120_000);

    it("writes nothing and exits 1 when the async parity cannot be proven", async () => {
      fs.writeFileSync(nodePath.join(dir, "flaky.cjs"), "function flaky(x) {\n  return Promise.resolve(x).then(function (v) { return Math.random(); }).catch(function (e) { return 0; });\n}\nmodule.exports = flaky;\n");
      const r = await run("flaky.cjs", ["--runs", "20"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("NOT resurrected: async parity could not be proven");
      expect(fs.existsSync(nodePath.join(dir, "out-flaky.cjs"))).toBe(false);
    }, 90_000);
  });

  describe("the lazarus-sandbox MCP server", () => {
    const text = (res: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> => JSON.parse(res.content[0]?.text ?? "{}") as Record<string, unknown>;

    it("resurrect_legacy turns a Promise chain into async/await with both settlements and tsc --strict: 0 errors", async () => {
      const res = await executeResurrect({ code: preset("legacyPromiseChain").code, name: "legacyPromiseChain", fuzzRuns: 40 });
      expect(res.isError).toBe(false);
      const r = text(res);
      expect(r).toMatchObject({ kind: "promise-chain", success: true, parity: "exact Object.is", tscPassed: true, name: "legacyPromiseChain", schema: { text: "string" } });
      expect(String(r["tsc"])).toContain("tsc --strict: 0 errors");
      expect(String(r["modernCode"])).toContain("export async function legacyPromiseChain(text: string)");
      expect((r["async"] as { resolved: number; rejected: number }).resolved).toBeGreaterThan(0);
      expect((r["async"] as { resolved: number; rejected: number }).rejected).toBeGreaterThan(0);
      expect(r["ruleBlame"]).toMatchObject([{ rule: "promise-async", status: "applied" }]);
      expect(r["bundleFiles"]).toEqual(expect.arrayContaining(["resurrected.ts", "resurrected.test.ts", "SPEC.md", "resurrection.patch"]));
    }, 90_000);

    it("resurrects an error-first callback, a synchronous function (with rule blame) and a multi-export module", async () => {
      const cb = text(await executeResurrect({ code: preset("legacyReadConfigCb").code, fuzzRuns: 40 }));
      expect(cb).toMatchObject({ kind: "error-first", success: true, tscPassed: true });
      expect(cb["ruleBlame"]).toMatchObject([{ rule: "callback-async", status: "applied" }]);
      const sync = text(await executeResurrect({ code: "var h = 0; for (var i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; } h;", name: "stringHash32", fuzzRuns: 60 }));
      expect(sync).toMatchObject({ kind: "sync", success: true, tscPassed: true, attempts: 2 });
      expect((sync["ruleBlame"] as Array<{ rule: string; status: string }>).find((b) => b.rule === "bitor0-trunc")?.status).toBe("rolled-back");
      const mod = text(await executeResurrect({ code: preset("cjsMathUtils").code, name: "cjsMathUtils", fuzzRuns: 30 }));
      expect(mod).toMatchObject({ kind: "module", success: true, tscPassed: true });
    }, 120_000);

    it("reports a failure as isError with the counterexample, and rejects bad input without running anything", async () => {
      const flaky = await executeResurrect({ code: "function flaky(x) { return Promise.resolve(x).then(function (v) { return Math.random(); }).catch(function (e) { return 0; }); }\nmodule.exports = flaky;", fuzzRuns: 20 });
      expect(flaky.isError).toBe(true);
      expect(text(flaky)).toMatchObject({ kind: "promise-chain", success: false, parity: "not proven" });
      expect(text(flaky)["counterexample"]).toMatchObject({ reason: expect.stringContaining("mismatch") as unknown });
      const empty = await executeResurrect({ code: "" });
      expect(empty.isError).toBe(true);
      expect(text(empty)).toMatchObject({ error: { code: "INVALID_REQUEST" } });
      const badKey = await executeResurrect({ code: "var x = n; x;", schema: { "n; evil()": "integer" } });
      expect(badKey.isError).toBe(true);
      expect(text(badKey)).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    }, 90_000);

    it("serves both tools over the MCP protocol (in-memory transport): run_legacy_probe is unchanged", async () => {
      const mcp = createLazarusMcpServer();
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "v16-test", version: "1.0.0" });
      await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
      try {
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name).sort()).toEqual(["resurrect_legacy", "run_legacy_probe"]);
        const schema = tools.tools.find((t) => t.name === "resurrect_legacy")?.inputSchema as { properties: Record<string, unknown>; required?: string[] };
        expect(Object.keys(schema.properties).sort()).toEqual(["code", "fuzzRuns", "functionName", "name", "schema", "seed"].sort());
        expect(schema.required).toEqual(["code"]);
        const probe = (await client.callTool({ name: "run_legacy_probe", arguments: { code: "x + y", context: { x: 1, y: 2 } } })) as { content: Array<{ type: string; text: string }> };
        expect((JSON.parse(probe.content[0]?.text ?? "{}") as { output: number }).output).toBe(3);
        const resurrected = (await client.callTool({ name: "resurrect_legacy", arguments: { code: preset("legacyPromiseChain").code, fuzzRuns: 30 } })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
        expect(resurrected.isError).toBeFalsy();
        expect(JSON.parse(resurrected.content[0]?.text ?? "{}")).toMatchObject({ kind: "promise-chain", success: true, tscPassed: true });
        const rejected = (await client.callTool({ name: "resurrect_legacy", arguments: { code: "x", fuzzRuns: 1 } })) as { isError?: boolean };
        expect(rejected.isError).toBe(true);
      } finally {
        await client.close();
        await mcp.close();
      }
    }, 120_000);
  });

  describe("Web Studio, CLI, MCP and benchmark report the same thing", () => {
    it("POST /api/resurrect and resurrectAny agree on the Promise-chain and error-first presets", async () => {
      for (const name of ["legacyPromiseChain", "legacyReadConfigCb"]) {
        const { code, schema } = preset(name);
        const res = await fetch(`${baseUrl}/api/resurrect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, legacyCode: code, schema, fuzzRuns: 40, seed: 5 }) });
        const frames = (await res.text()).split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as { kind: string; result?: { success: boolean; attempts: number; fuzzReport: { totalRuns: number }; typecheck: { passed: boolean; errorCount: number }; asyncCallback: { strategy: string; outcomes: { resolved: number; rejected: number } } } });
        const web = frames.find((f) => f.kind === "result")?.result;
        const any = await resurrectAny({ name, source: code, schema: schema as never, fuzzRuns: 40, seed: 5 });
        expect(web?.success, name).toBe(true);
        expect(any.success, name).toBe(true);
        expect(any.attempts, name).toBe(web?.attempts);
        expect(any.fuzzRuns, name).toBe(web?.fuzzReport.totalRuns);
        expect(any.asyncSummary?.strategy, name).toBe(web?.asyncCallback.strategy);
        expect({ resolved: any.asyncSummary?.resolved, rejected: any.asyncSummary?.rejected }, name).toEqual(web?.asyncCallback.outcomes);
        expect(any.tscPassed, name).toBe(web?.typecheck.passed);
        expect(web?.typecheck.errorCount).toBe(0);
      }
    }, 120_000);

    it("the benchmark runs the Promise-chain, subclass and error-first presets with 100% parity and tsc --strict: 0 errors", async () => {
      const rows = await runBenchmark({ presets: BENCHMARK_PRESETS.filter((p) => ["legacySubclassMeter", "legacyPromiseChain", "legacyReadConfigCb"].includes(p.name)), fuzzRuns: 40 });
      expect(rows.map((r) => r.specimen)).toEqual(["legacyReadConfigCb", "legacySubclassMeter", "legacyPromiseChain"]);
      for (const row of rows) {
        expect(row.success, row.specimen).toBe(true);
        expect(row.tscPassed, row.specimen).toBe(true);
        expect(row.tsc, row.specimen).toMatch(/^tsc --strict: 0 errors \(\d files?, TypeScript 7\./);
        expect(row.fuzzRuns, row.specimen).toBe(40);
      }
    }, 120_000);
  });
});
