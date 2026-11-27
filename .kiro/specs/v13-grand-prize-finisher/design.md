# Design: V13 Grand Prize Finisher

## cert-crypto (`src/exporter/cert-crypto.ts`)
- `canonicalPayload(p)`: JSON with fixed key order, no whitespace. This is the exact signed byte string.
- `getSigningKey()`: env PEM, else `createPrivateKey` from PKCS8 DER (`302e020100300506032b657004220420` + 32-byte seed = sha256 of a fixed label). `keyId` = first 16 hex of SHA-256 of the SPKI DER.
  `generateKeyPairSync('ed25519')` is used when `LAZARUS_ED25519_EPHEMERAL=1`.
- `signCertificate({ legacySource, resurrectedSource, paritySummary, mutantsKilled, tscStrictErrors, issuedAt? })` → `{ payload, signatureB64, publicKeyPem, keyId }`.
- `verifyCertificate({ payload, signatureB64, publicKeyPem, resurrectedCode })` → `{ valid, reason, expectedDigest, actualDigest, keyId }`. Order of checks: payload shape, digest, signature.
- `signatureSvgMetadata`, `signatureMarkdown`: pure string helpers.
- `buildCertificateJson` / `verifyBundleZip` (reads the zip via `readZip`) used by the CLI.

Digests use `sha256Hex` (CRLF-normalized) from `certificate.ts`, the same function as the legacy SHA-256.

## Server wiring (`src/web/server.ts`)
- `/api/resurrect`: the existing `certificateFor` adds `signature` (hash of `modernCode`, tsc errors from the strict check, `mutantsKilled: null`).
- `buildExportBundle` signs the final `resurrected.ts` and returns `certificateJson`; `/api/export-zip` appends `certificate.json`; the SVG gets the metadata. The bundle `files` map is unchanged.
- `/api/verify-certificate`: zod strict body, 413/400 handling like its siblings, pure CPU (no sandbox).
- `/api/probe`: optional `compareNaive`. After legacy and modern run, `naiveRefactor(legacyRunnable)` output runs on the modern pool. The legacy and naive values are compared with `areOutputsEquivalent`.

## CLI (`src/cli.ts`)
`lazarus verify <zip>` is dispatched next to `audit`. `package.json` gets `"verify": "tsx src/cli.ts verify"`.

## UI (`public/index.html`, Tab 1 only)
- Tour dock: `#tourHud.docked` renders a fixed bottom-left pill (`.tour-pill`) with `Resume Tour` and `×`. Triggers: `lazarus:result` completion, and clicks on `#compareNaiveBtn`, the mutant autopsy button and the certificate controls (capture-phase listener). The docked state hides the full banner contents.
- Causal strip: `#causalStrip` in the Verification Deck above the diff, rendered by `LazarusCausal.render(result)` with `textContent` only.
- Certificate viewer: badge + `Simulate 1-Byte Tamper` + `Restore Verified`, using `certificate.signature` and the current resurrected code copy.
- Probe card: when the current preset is synchronous, requests `compareNaive:true` and renders a third `.probe-side` (Naive AI).
- No Tab 3 line (`#pane-redteam`, `.redteam`, Red-Team script) is touched; a test diffs the file against `HEAD~` markers.
