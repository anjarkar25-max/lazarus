import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CertificatePayloadSchema, canonicalPayload, signCertificate, verifyBundleZip, verifyCertificate } from "../../exporter/cert-crypto.js";
import { generateResurrectionBundle } from "../../exporter/bundle.js";
import { renderAsyncParityTest } from "../../exporter/async-bundle.js";
import { readZip } from "../../exporter/zip.js";
import { DifferentialFuzzer } from "../../fuzzer/differential.js";
import { PooledProbeRunner } from "../../sandbox/pool.js";
import { createWebServer, freshSeed, isSeed } from "../../web/server.js";
import { ResurrectionOrchestrator } from "../orchestrator.js";
import { closeSharedTsVerifier } from "../ts-verifier.js";

const LEGACY = "function half(n) { return (n / 2) | 0; }";
const SNIPPET = "var half = (n / 2) | 0; half;";
const FIXED = "2026-01-01T00:00:00.000Z";

afterAll(async () => {
  await closeSharedTsVerifier();
});

describe("the seed the Ed25519 certificate signs", () => {
  const sign = (proofSeed?: number) => signCertificate({ legacySource: LEGACY, resurrectedSource: "export const x = 1;\n", paritySummary: "exact Object.is parity, 100 fuzz runs, 1 attempt", tscStrictErrors: 0, issuedAt: FIXED, ...(proofSeed !== undefined ? { proofSeed } : {}) });

  it("is the last key of the canonical payload, and absent when no seed was given (older certificates keep their bytes)", () => {
    const withSeed = sign(1375503261);
    expect(Object.keys(JSON.parse(withSeed.canonical) as object)).toEqual(["legacySha256", "resurrectedSha256", "paritySummary", "mutantsKilled", "tscStrictErrors", "issuedAt", "proofSeed"]);
    expect(withSeed.payload.proofSeed).toBe(1375503261);
    expect(withSeed.canonical).toBe(canonicalPayload(withSeed.payload));
    const without = sign();
    expect(Object.keys(JSON.parse(without.canonical) as object)).toEqual(["legacySha256", "resurrectedSha256", "paritySummary", "mutantsKilled", "tscStrictErrors", "issuedAt"]);
    expect(without.payload).not.toHaveProperty("proofSeed");
    expect(without.canonical).not.toContain("proofSeed");
  });

  it("verifies, and a changed seed breaks the signature", () => {
    const block = sign(42);
    const verify = (payload: unknown) => verifyCertificate({ payload, signatureB64: block.signatureB64, publicKeyPem: block.publicKeyPem, resurrectedCode: "export const x = 1;\n" });
    expect(verify(block.payload)).toMatchObject({ valid: true, trustedKey: true });
    expect(verify({ ...block.payload, proofSeed: 43 })).toMatchObject({ valid: false, reason: expect.stringContaining("Signature mismatch") as unknown });
    const { proofSeed: _dropped, ...stripped } = block.payload;
    expect(verify(stripped).valid).toBe(false);
    expect(verifyCertificate({ payload: sign().payload, signatureB64: sign().signatureB64, publicKeyPem: block.publicKeyPem, resurrectedCode: "export const x = 1;\n" }).valid).toBe(true);
  });

  it("accepts only a 32-bit integer", () => {
    const ok = sign(1).payload;
    for (const seed of [0, -5, 2147483647, -2147483648]) expect(CertificatePayloadSchema.safeParse({ ...ok, proofSeed: seed }).success, String(seed)).toBe(true);
    for (const seed of [1.5, 2147483648, "7", null, Number.NaN]) expect(CertificatePayloadSchema.safeParse({ ...ok, proofSeed: seed }).success, String(seed)).toBe(false);
  });

  it("isSeed and freshSeed agree on what a seed is", () => {
    for (let i = 0; i < 50; i++) {
      const seed = freshSeed();
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(2 ** 31 - 16);
      expect(isSeed(seed)).toBe(true);
    }
    expect([isSeed(1.5), isSeed("1"), isSeed(2 ** 31), isSeed(undefined), isSeed(-(2 ** 31))]).toEqual([false, false, false, false, true]);
  });
});

describe("the exported Vitest suite replays the seed", () => {
  const base = { specimenName: "half", legacyCode: SNIPPET, modernCode: "Math.trunc(n / 2) || 0;", specMarkdown: "# spec", fuzzRuns: 60, schema: { n: "integer" } } as const;
  it("prints { numRuns, seed } in every fc.assert, and stays byte-identical without a seed", () => {
    const seeded = generateResurrectionBundle({ ...base, seed: 1375503261 }).files["resurrected.test.ts"];
    expect(seeded).toContain("{ numRuns: 60, seed: 1375503261 }");
    const plain = generateResurrectionBundle(base).files["resurrected.test.ts"];
    expect(plain).toContain("{ numRuns: 60 }");
    expect(plain).not.toContain("seed");
    expect(seeded.replace(", seed: 1375503261", "")).toBe(plain);
  });
  it("covers the ESM and the multi-export suites too", () => {
    const esm = generateResurrectionBundle({ ...base, legacyCode: "function half(n) { return (n / 2) | 0; }\nmodule.exports = half;", esmModule: { code: "export default function half(n) { return Math.trunc(n / 2) || 0; }", exports: ["default"] }, seed: 9 });
    expect(esm.files["resurrected.esm.test.ts"]).toContain("{ numRuns: 60, seed: 9 }");
    const multi = generateResurrectionBundle({ ...base, seed: 9, functions: [{ name: "half", schema: { n: "integer" }, legacyCode: SNIPPET, modernCode: "Math.trunc(n / 2) || 0;" }, { name: "twice", schema: { n: "integer" }, legacyCode: "n * 2;", modernCode: "n * 2;" }] });
    expect(multi.files["resurrected.test.ts"].match(/\{ numRuns: 60, seed: 9 \}/g)).toHaveLength(2);
  });
  it("covers the async suite", () => {
    const entry = { name: "readConfig", params: ["text"], callback: "cb" } as unknown as Parameters<typeof renderAsyncParityTest>[1];
    expect(renderAsyncParityTest("readConfig", entry, { text: "string" }, 40, 5)).toContain("{ numRuns: 40, seed: 5 }");
    expect(renderAsyncParityTest("readConfig", entry, { text: "string" }, 40)).toContain("{ numRuns: 40 }");
  });
});

describe("the same seed gives the same fuzz and shrink run", () => {
  it("replays the same inputs, the same counterexample and the same shrink trace", async () => {
    await using legacy = new PooledProbeRunner();
    await using modern = new PooledProbeRunner();
    const fuzzer = new DifferentialFuzzer({ legacy, modern });
    // Wrong above 500000: a quarter of the integer domain, found by the random runs (no boundary corpus), then shrunk.
    const run = (seed: number) => fuzzer.fuzz("n > 500000 ? n : 0;", "0;", { n: "integer" }, { numRuns: 100, seed, exact: true, boundary: false });
    const a = await run(99);
    const b = await run(99);
    expect(a.passed).toBe(false);
    expect(a.seed).toBe(99);
    expect(b.seed).toBe(99);
    expect(b.counterexample?.inputs).toEqual(a.counterexample?.inputs);
    expect(b.counterexample?.shrinkTrace?.steps.map((s) => s.input)).toEqual(a.counterexample?.shrinkTrace?.steps.map((s) => s.input));
    expect(b.counterexample?.shrinkTrace?.totalShrinks).toBe(a.counterexample?.shrinkTrace?.totalShrinks);
    expect(b.traces.map((t) => t.inputs)).toEqual(a.traces.map((t) => t.inputs));
    expect(a.counterexample?.shrinkTrace?.finalMinimal.input).toBe("n = 500001");
    // A different seed walks a different path (the minimal counterexample is the same, the journey is not).
    const c = await run(100);
    expect(c.seed).toBe(100);
    expect(c.counterexample?.shrinkTrace?.finalMinimal.input).toBe("n = 500001");
    expect(c.traces.map((t) => t.inputs)).not.toEqual(a.traces.map((t) => t.inputs));
  }, 60_000);

  it("the orchestrator passes its seed into fast-check: identical seeds replay identical runs, new seeds explore new inputs", async () => {
    const orchestrator = new ResurrectionOrchestrator();
    // `traces` keeps the first 15 inputs, which are the deterministic boundary corpus; `observations` is every input of the passing run.
    const run = (seed: number) => orchestrator.resurrect({ name: "half", legacyCode: SNIPPET, schema: { n: "integer" }, fuzzRuns: 60, seed, exact: true, maxHealingAttempts: 3, collectObservations: true });
    const a = await run(2024);
    const b = await run(2024);
    const c = await run(2025);
    for (const r of [a, b, c]) expect(r.success).toBe(true);
    expect(b.fuzzReport.seed).toBe(a.fuzzReport.seed);
    expect(a.observations?.length).toBeGreaterThanOrEqual(60);
    expect(b.observations?.map((o) => o.inputs)).toEqual(a.observations?.map((o) => o.inputs));
    expect(b.modernCode).toBe(a.modernCode);
    expect(c.fuzzReport.seed).not.toBe(a.fuzzReport.seed);
    expect(c.observations?.map((o) => o.inputs)).not.toEqual(a.observations?.map((o) => o.inputs));
  }, 60_000);
});

describe("POST /api/resurrect and the export, with a seed", () => {
  const server = createWebServer();
  let baseUrl = "";
  interface Resurrected {
    success: boolean;
    modernCode: string;
    proofSeed: number;
    numRuns: number;
    fuzzReport: { seed: number; totalRuns: number; traces: Array<{ inputs: unknown }> };
    certificate?: { signature: { payload: Record<string, unknown>; signatureB64: string; publicKeyPem: string } };
  }
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
  async function resurrect(extra: Record<string, unknown>): Promise<Resurrected> {
    const res = await fetch(`${baseUrl}/api/resurrect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "half", legacyCode: LEGACY, schema: { n: "integer" }, fuzzRuns: 60, ...extra }) });
    expect(res.status).toBe(200);
    const text = await res.text();
    const found = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)) as { kind: string; result?: Resurrected })
      .find((m) => m.kind === "result")?.result;
    if (found === undefined) throw new Error("no result");
    return found;
  }

  it("echoes the seed it was given as proofSeed, with numRuns, and signs it", async () => {
    const r = await resurrect({ seed: 7 });
    expect(r).toMatchObject({ success: true, proofSeed: 7 });
    expect(r.numRuns).toBe(r.fuzzReport.totalRuns);
    expect(r.numRuns).toBeGreaterThanOrEqual(60);
    expect(r.certificate?.signature.payload["proofSeed"]).toBe(7);
    const sig = r.certificate?.signature;
    if (sig === undefined) throw new Error("no certificate");
    expect(verifyCertificate({ payload: sig.payload, signatureB64: sig.signatureB64, publicKeyPem: sig.publicKeyPem, resurrectedCode: r.modernCode }).valid).toBe(true);
  }, 60_000);

  it("draws a real integer seed when none is given, and replaying it reproduces the run", async () => {
    const first = await resurrect({});
    expect(Number.isInteger(first.proofSeed)).toBe(true);
    expect(isSeed(first.proofSeed)).toBe(true);
    expect(first.certificate?.signature.payload["proofSeed"]).toBe(first.proofSeed);
    const replay = await resurrect({ seed: first.proofSeed });
    expect(replay.proofSeed).toBe(first.proofSeed);
    expect(replay.fuzzReport.seed).toBe(first.fuzzReport.seed);
    expect(replay.fuzzReport.traces.map((t) => t.inputs)).toEqual(first.fuzzReport.traces.map((t) => t.inputs));
    const fresh = await resurrect({});
    expect(fresh.proofSeed).not.toBe(first.proofSeed);
    expect(fresh.fuzzReport.seed).not.toBe(first.fuzzReport.seed);
    expect(fresh.success).toBe(true);
  }, 90_000);

  it("refuses a seed that is not a 32-bit integer before streaming anything", async () => {
    for (const seed of [1.5, "7", 2 ** 31, null, [1]]) {
      const res = await fetch(`${baseUrl}/api/resurrect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ legacyCode: LEGACY, schema: { n: "integer" }, seed }) });
      expect(res.status, String(seed)).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(((await res.json()) as { error: string }).error).toContain("seed");
    }
  });

  it("puts the seed in the zip: the Vitest suite, the signed certificate.json and RESURRECTION_REPORT.html", async () => {
    const r = await resurrect({ seed: 4242 });
    const res = await fetch(`${baseUrl}/api/export-zip`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ specimenName: "half", legacyCode: LEGACY, modernCode: r.modernCode, schema: { n: "integer" }, fuzzRuns: r.numRuns, seed: r.proofSeed }) });
    expect(res.status).toBe(200);
    const zip = Buffer.from(await res.arrayBuffer());
    const files = new Map(readZip(zip).map((e) => [e.name, e.data.toString("utf8")] as const));
    expect(files.get("resurrected.test.ts")).toContain(`{ numRuns: ${r.numRuns}, seed: 4242 }`);
    expect(files.get("RESURRECTION_REPORT.html")).toContain("Proof seed 4242");
    const cert = JSON.parse(files.get("certificate.json") ?? "{}") as { payload: { proofSeed?: number } };
    expect(cert.payload.proofSeed).toBe(4242);
    expect(verifyBundleZip(zip)).toMatchObject({ valid: true, trustedKey: true });
    // Flipping the seed inside certificate.json makes the signature fail.
    const tampered = (files.get("certificate.json") ?? "").replace('"proofSeed": 4242', '"proofSeed": 4243');
    expect(tampered).not.toBe(files.get("certificate.json"));
    const verdict = verifyCertificate({ payload: { ...cert.payload, proofSeed: 4243 }, signatureB64: (JSON.parse(files.get("certificate.json") ?? "{}") as { signatureB64: string }).signatureB64, publicKeyPem: (JSON.parse(files.get("certificate.json") ?? "{}") as { publicKeyPem: string }).publicKeyPem, resurrectedCode: files.get("resurrected.ts") ?? "" });
    expect(verdict.valid).toBe(false);
  }, 90_000);

  it("ignores a seed that is not an integer in an export request, and prints no seed without one", async () => {
    const body = { specimenName: "half", legacyCode: LEGACY, modernCode: "Math.trunc(n / 2) || 0;", schema: { n: "integer" }, fuzzRuns: 50 };
    for (const seed of ["x", 1.5, null]) {
      const res = await fetch(`${baseUrl}/api/export-zip`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, seed }) });
      const files = new Map(readZip(Buffer.from(await res.arrayBuffer())).map((e) => [e.name, e.data.toString("utf8")] as const));
      expect(files.get("resurrected.test.ts"), String(seed)).toContain("{ numRuns: 50 }");
      expect(JSON.parse(files.get("certificate.json") ?? "{}")).not.toHaveProperty("payload.proofSeed");
    }
  }, 60_000);
});
