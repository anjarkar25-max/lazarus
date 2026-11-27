import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, runVerifyCli } from "../../cli.js";
import { createWebServer } from "../../web/server.js";
import { canonicalPayload, CERTIFICATE_JSON_FILE, embedSignatureInSvg, getSigningKey, signCertificate, verifyBundleZip, verifyCertificate } from "../cert-crypto.js";
import { createZip, readZip } from "../zip.js";

const LEGACY = "function half(n) { return (n / 2) | 0; }";
const MODERN = "Math.trunc(n / 2) || 0";
const FIXED = "2026-01-01T00:00:00.000Z";

const sign = () => signCertificate({ legacySource: LEGACY, resurrectedSource: MODERN, paritySummary: "exact Object.is parity, 100 fuzz runs, 1 attempt", tscStrictErrors: 0, issuedAt: FIXED });

function flipChar(text: string, index = 3): string {
  const ch = text[index] ?? "x";
  return `${text.slice(0, index)}${ch === "a" ? "b" : "a"}${text.slice(index + 1)}`;
}

describe("cert-crypto: Ed25519 sign and verify", () => {
  it("signs a canonical payload with the required fields and verifies it", () => {
    const block = sign();
    expect(Object.keys(JSON.parse(block.canonical) as object)).toEqual(["legacySha256", "resurrectedSha256", "paritySummary", "mutantsKilled", "tscStrictErrors", "issuedAt"]);
    expect(block.canonical).toBe(canonicalPayload(block.payload));
    expect(block.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(block.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(block.payload.mutantsKilled).toBeNull();
    const result = verifyCertificate({ payload: block.payload, signatureB64: block.signatureB64, publicKeyPem: block.publicKeyPem, resurrectedCode: MODERN });
    expect(result.valid).toBe(true);
    expect(result.expectedDigest).toBe(result.actualDigest);
    expect(result.keyId).toBe(block.keyId);
    expect(result.trustedKey).toBe(true);
  });

  it("is deterministic for the same input and fixed timestamp", () => {
    expect(sign().signatureB64).toBe(sign().signatureB64);
    expect(getSigningKey().keyId).toBe(sign().keyId);
  });

  it("rejects a 1-byte change in the resurrected code", () => {
    const block = sign();
    const result = verifyCertificate({ payload: block.payload, signatureB64: block.signatureB64, publicKeyPem: block.publicKeyPem, resurrectedCode: flipChar(MODERN) });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Digest mismatch/);
    expect(result.expectedDigest).not.toBe(result.actualDigest);
  });

  it("rejects an altered signature", () => {
    const block = sign();
    const result = verifyCertificate({ payload: block.payload, signatureB64: flipChar(block.signatureB64, 5), publicKeyPem: block.publicKeyPem, resurrectedCode: MODERN });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Signature mismatch/);
  });

  it("rejects a forged payload whose digest was rewritten to match tampered code", () => {
    const block = sign();
    const tampered = flipChar(MODERN);
    const forged = signCertificate({ legacySource: LEGACY, resurrectedSource: tampered, paritySummary: block.payload.paritySummary, tscStrictErrors: 0, issuedAt: FIXED }).payload;
    const result = verifyCertificate({ payload: forged, signatureB64: block.signatureB64, publicKeyPem: block.publicKeyPem, resurrectedCode: tampered });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Signature mismatch/);
  });

  it("rejects malformed payloads and keys without throwing", () => {
    const block = sign();
    expect(verifyCertificate({ payload: { nope: 1 }, signatureB64: block.signatureB64, publicKeyPem: block.publicKeyPem, resurrectedCode: MODERN }).valid).toBe(false);
    expect(verifyCertificate({ payload: block.payload, signatureB64: block.signatureB64, publicKeyPem: "not a key", resurrectedCode: MODERN }).valid).toBe(false);
  });

  it("embeds the signature in the SVG as metadata without breaking the document", () => {
    const svg = embedSignatureInSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>', sign());
    expect(svg).toContain('<metadata id="lazarus-ed25519">');
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });
});

describe("cert-crypto: exported bundle and CLI verify", () => {
  const server = createWebServer();
  let baseUrl = "";
  let zip = Buffer.alloc(0);
  let tmp = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${baseUrl}/api/export-zip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specimenName: "half", legacyCode: LEGACY, modernCode: MODERN, schema: { n: "integer" }, fuzzRuns: 100 }),
    });
    expect(res.status).toBe(200);
    zip = Buffer.from(await res.arrayBuffer());
    tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-verify-"));
  }, 60_000);
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    if (tmp !== "") fs.rmSync(tmp, { recursive: true, force: true });
  });

  const run = (file: string): { code: number; out: string; err: string } => {
    let out = "";
    let err = "";
    const code = runVerifyCli([file], { stdout: (t) => void (out += t), stderr: (t) => void (err += t), cwd: tmp });
    return { code, out, err };
  };

  it("adds certificate.json to the zip and verifies it", () => {
    expect(readZip(zip).some((e) => e.name === CERTIFICATE_JSON_FILE)).toBe(true);
    expect(verifyBundleZip(zip).valid).toBe(true);
  });

  it("CLI verify exits 0 on an untouched .zip", () => {
    fs.writeFileSync(nodePath.join(tmp, "ok.zip"), zip);
    const r = run("ok.zip");
    expect(r.code).toBe(0);
    expect(r.out).toContain("VERIFIED");
  });

  it("CLI verify exits 1 when one byte of resurrected.ts changed", () => {
    const entries = readZip(zip).map((e) => {
      if (e.name !== "resurrected.ts") return { name: e.name, data: e.data };
      const text = e.data.toString("utf8");
      return { name: e.name, data: flipChar(text, text.indexOf("trunc")) };
    });
    fs.writeFileSync(nodePath.join(tmp, "bad.zip"), createZip(entries));
    const r = run("bad.zip");
    expect(r.code).toBe(1);
    expect(r.out).toContain("INVALID");
  });

  it("CLI verify routes through main() and reports usage errors with exit 2", async () => {
    const io = { stdout: () => undefined, stderr: () => undefined, cwd: tmp };
    expect(await main(["verify"], io)).toBe(2);
    expect(await main(["verify", "missing.zip"], io)).toBe(2);
    fs.writeFileSync(nodePath.join(tmp, "ok2.zip"), zip);
    expect(await main(["verify", "ok2.zip"], io)).toBe(0);
  });

  it("POST /api/verify-certificate validates, detects tampering and rejects bad bodies", async () => {
    const block = sign();
    const post = (body: unknown) => fetch(`${baseUrl}/api/verify-certificate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const good = (await (await post({ payload: block.payload, signatureB64: block.signatureB64, publicKeyPem: block.publicKeyPem, resurrectedCode: MODERN })).json()) as { valid: boolean; keyId: string };
    expect(good.valid).toBe(true);
    expect(good.keyId).toBe(block.keyId);
    const bad = (await (await post({ payload: block.payload, signatureB64: block.signatureB64, publicKeyPem: block.publicKeyPem, resurrectedCode: flipChar(MODERN) })).json()) as { valid: boolean; reason: string; expectedDigest: string; actualDigest: string };
    expect(bad.valid).toBe(false);
    expect(bad.expectedDigest).not.toBe(bad.actualDigest);
    const wrongLegacy = (await (await post({ payload: block.payload, signatureB64: block.signatureB64, publicKeyPem: block.publicKeyPem, resurrectedCode: MODERN, legacyCode: "other" })).json()) as { valid: boolean };
    expect(wrongLegacy.valid).toBe(false);
    expect((await post({ resurrectedCode: "x" })).status).toBe(400);
    expect((await post({ ...block, extra: 1 })).status).toBe(400);
  });
});
