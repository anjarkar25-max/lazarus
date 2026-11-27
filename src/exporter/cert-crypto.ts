// Ed25519 signatures for Resurrection Certificates, using only node:crypto (no npm dependency, no API key).
//
// The signed message is a canonical JSON payload (fixed key order, no whitespace). Verification recomputes the SHA-256
// of the submitted resurrected code, compares it with the signed digest, then checks the signature.
//
// Key handling: LAZARUS_ED25519_PRIVATE_KEY_PEM (PKCS8 PEM) when set. Otherwise a deterministic demo key derived from a
// fixed public seed, so signatures are reproducible across processes. That demo key is NOT a secret: it proves the bundle
// was not altered after signing, not who signed it. Set LAZARUS_ED25519_EPHEMERAL=1 for a fresh random key per process.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { readZip } from "./zip.js";
import { sha256Hex } from "./certificate.js";

export const CERTIFICATE_JSON_FILE = "certificate.json";
export const SIGNED_SUBJECT_FILE = "resurrected.ts";
const DEMO_KEY_LABEL = "lazarus-v13-demo-ed25519-key (public, deterministic, not a secret)";
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const CertificatePayloadSchema = z
  .object({
    legacySha256: Sha256Hex,
    resurrectedSha256: Sha256Hex,
    paritySummary: z.string().min(1).max(300),
    mutantsKilled: z.number().int().min(0).nullable(),
    tscStrictErrors: z.number().int().min(0).nullable(),
    issuedAt: z.string().min(1).max(40),
  })
  .strict();
export type CertificatePayload = z.infer<typeof CertificatePayloadSchema>;

export interface SignatureBlock {
  readonly payload: CertificatePayload;
  /** Canonical JSON of `payload`: the exact bytes that were signed. */
  readonly canonical: string;
  readonly signatureB64: string;
  readonly publicKeyPem: string;
  readonly keyId: string;
}

export interface VerifyResult {
  readonly valid: boolean;
  readonly reason: string;
  /** The digest the signature vouches for (payload.resurrectedSha256). */
  readonly expectedDigest: string;
  /** SHA-256 of the code that was submitted for verification. */
  readonly actualDigest: string;
  readonly keyId: string;
  /** The signing key is the one this server would sign with (false for a foreign or demo-mismatched key). */
  readonly trustedKey: boolean;
}

/** Fixed key order, no whitespace. */
export function canonicalPayload(p: CertificatePayload): string {
  return JSON.stringify({
    legacySha256: p.legacySha256,
    resurrectedSha256: p.resurrectedSha256,
    paritySummary: p.paritySummary,
    mutantsKilled: p.mutantsKilled,
    tscStrictErrors: p.tscStrictErrors,
    issuedAt: p.issuedAt,
  });
}

export function keyIdOf(publicKey: KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

interface KeyPair {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly keyId: string;
}

let cachedKey: { readonly signature: string; readonly pair: KeyPair } | undefined;

export function getSigningKey(env: NodeJS.ProcessEnv = process.env): KeyPair {
  const pem = env.LAZARUS_ED25519_PRIVATE_KEY_PEM;
  const ephemeral = env.LAZARUS_ED25519_EPHEMERAL === "1";
  const signature = pem !== undefined && pem !== "" ? `pem:${pem}` : ephemeral ? "ephemeral" : "demo";
  if (cachedKey?.signature === signature) return cachedKey.pair;
  let privateKey: KeyObject;
  if (signature === "ephemeral") {
    privateKey = generateKeyPairSync("ed25519").privateKey;
  } else if (signature.startsWith("pem:")) {
    privateKey = createPrivateKey(pem ?? "");
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("LAZARUS_ED25519_PRIVATE_KEY_PEM must be an Ed25519 key");
  } else {
    const seed = createHash("sha256").update(DEMO_KEY_LABEL).digest();
    privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  }
  const publicKey = createPublicKey(privateKey);
  const pair: KeyPair = { privateKey, publicKey, keyId: keyIdOf(publicKey) };
  cachedKey = { signature, pair };
  return pair;
}

export interface SignInput {
  readonly legacySource: string;
  /** The exact resurrected text the signature vouches for. */
  readonly resurrectedSource: string;
  readonly paritySummary: string;
  readonly mutantsKilled?: number | null;
  readonly tscStrictErrors?: number | null;
  /** ISO timestamp; defaults to now. Tests pass a fixed value. */
  readonly issuedAt?: string;
}

export function signCertificate(input: SignInput): SignatureBlock {
  const key = getSigningKey();
  const payload: CertificatePayload = {
    legacySha256: sha256Hex(input.legacySource),
    resurrectedSha256: sha256Hex(input.resurrectedSource),
    paritySummary: input.paritySummary.slice(0, 300),
    mutantsKilled: input.mutantsKilled ?? null,
    tscStrictErrors: input.tscStrictErrors ?? null,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
  };
  const canonical = canonicalPayload(payload);
  const signatureB64 = sign(null, Buffer.from(canonical, "utf8"), key.privateKey).toString("base64");
  return {
    payload,
    canonical,
    signatureB64,
    publicKeyPem: key.publicKey.export({ format: "pem", type: "spki" }).toString(),
    keyId: key.keyId,
  };
}

export interface VerifyInput {
  readonly payload: unknown;
  readonly signatureB64: string;
  readonly publicKeyPem: string;
  readonly resurrectedCode: string;
}

export function verifyCertificate(input: VerifyInput): VerifyResult {
  const actualDigest = sha256Hex(input.resurrectedCode);
  const parsed = CertificatePayloadSchema.safeParse(input.payload);
  let publicKey: KeyObject | undefined;
  try {
    publicKey = createPublicKey(input.publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") publicKey = undefined;
  } catch {
    publicKey = undefined;
  }
  const keyId = publicKey === undefined ? "invalid" : keyIdOf(publicKey);
  const expectedDigest = parsed.success ? parsed.data.resurrectedSha256 : "invalid";
  const trustedKey = publicKey !== undefined && keyId === getSigningKey().keyId;
  const fail = (reason: string): VerifyResult => ({ valid: false, reason, expectedDigest, actualDigest, keyId, trustedKey });
  if (!parsed.success) return fail("Invalid certificate payload");
  if (publicKey === undefined) return fail("Invalid Ed25519 public key");
  // Signature first on the payload itself, so a forged payload is never reported as merely "digest mismatch".
  const signatureOk = (() => {
    try {
      return verify(null, Buffer.from(canonicalPayload(parsed.data), "utf8"), publicKey, Buffer.from(input.signatureB64, "base64"));
    } catch {
      return false;
    }
  })();
  if (!signatureOk) return fail("Signature mismatch: the Ed25519 signature does not match the certificate payload");
  if (actualDigest !== parsed.data.resurrectedSha256) return fail("Digest mismatch: the code differs from the signed SHA-256");
  return { valid: true, reason: "Ed25519 signature and SHA-256 digest verified", expectedDigest, actualDigest, keyId, trustedKey };
}

/** certificate.json for a bundle: the signature block plus the file that was hashed. */
export function buildCertificateJson(block: SignatureBlock, subjectFile: string = SIGNED_SUBJECT_FILE): string {
  return `${JSON.stringify(
    {
      format: "lazarus-certificate/v1",
      algorithm: "Ed25519",
      subjectFile,
      payload: block.payload,
      signatureB64: block.signatureB64,
      publicKeyPem: block.publicKeyPem,
      keyId: block.keyId,
    },
    null,
    2
  )}\n`;
}

const CertificateJsonSchema = z
  .object({
    format: z.literal("lazarus-certificate/v1"),
    algorithm: z.literal("Ed25519"),
    subjectFile: z.string().min(1).max(200),
    payload: CertificatePayloadSchema,
    signatureB64: z.string().min(1).max(200),
    publicKeyPem: z.string().min(1).max(2000),
    keyId: z.string().min(1).max(64),
  })
  .strict();

export interface BundleVerification extends VerifyResult {
  readonly subjectFile: string;
}

/** Verifies an exported `.zip`: certificate.json against the file it names. */
export function verifyBundleZip(zip: Buffer): BundleVerification {
  const missing = (reason: string): BundleVerification => ({ valid: false, reason, expectedDigest: "unknown", actualDigest: "unknown", keyId: "unknown", trustedKey: false, subjectFile: SIGNED_SUBJECT_FILE });
  let entries;
  try {
    entries = readZip(zip);
  } catch (err: unknown) {
    return missing(`Not a readable zip archive: ${err instanceof Error ? err.message : String(err)}`);
  }
  const certEntry = entries.find((e) => e.name === CERTIFICATE_JSON_FILE);
  if (certEntry === undefined) return missing(`${CERTIFICATE_JSON_FILE} is missing from the archive`);
  let json: unknown;
  try {
    json = JSON.parse(certEntry.data.toString("utf8"));
  } catch {
    return missing(`${CERTIFICATE_JSON_FILE} is not valid JSON`);
  }
  const checked = CertificateJsonSchema.safeParse(json);
  if (!checked.success) return missing(`${CERTIFICATE_JSON_FILE} is malformed`);
  const subject = entries.find((e) => e.name === checked.data.subjectFile);
  if (subject === undefined) return { ...missing(`${checked.data.subjectFile} is missing from the archive`), subjectFile: checked.data.subjectFile };
  const result = verifyCertificate({
    payload: checked.data.payload,
    signatureB64: checked.data.signatureB64,
    publicKeyPem: checked.data.publicKeyPem,
    resurrectedCode: subject.data.toString("utf8"),
  });
  return { ...result, subjectFile: checked.data.subjectFile };
}

/** Markdown footer for a signed certificate. */
export function signatureMarkdown(block: SignatureBlock): string {
  return [
    `**Ed25519 signature** (key \`${block.keyId}\`): \`${block.signatureB64.slice(0, 24)}...\``,
    `Signed digest of the resurrected code: \`${block.payload.resurrectedSha256}\`; issued ${block.payload.issuedAt}.`,
  ].join("\n");
}

/** Adds an embedded <metadata> element and a one-line note to a certificate SVG (before the closing tag). */
export function embedSignatureInSvg(svg: string, block: SignatureBlock): string {
  const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const metadata = `  <metadata id="lazarus-ed25519">${esc(JSON.stringify({ keyId: block.keyId, payload: block.payload, signatureB64: block.signatureB64 }))}</metadata>`;
  const note = `  <text x="48" y="408" class="s">Ed25519 signed \u00b7 key ${esc(block.keyId)} \u00b7 sig ${esc(block.signatureB64.slice(0, 20))}...</text>`;
  const idx = svg.lastIndexOf("</svg>");
  return idx === -1 ? svg : `${svg.slice(0, idx)}${metadata}\n${note}\n${svg.slice(idx)}`;
}
