# Design: V16 Zero-Trust and SARIF

## Offline verification (`public/index.html`, region `lz-webcrypto`)
Pure functions with the crypto object injected, so the page and the tests run the same code:
- `lzSha256Hex(subtle, text)`: `text.replace(/\r\n/g, "\n")` -> UTF-8 -> `subtle.digest("SHA-256")` -> hex (the server's `sha256Hex`).
- `lzCanonicalPayload(p)`: `JSON.stringify` with the fixed key order of `canonicalPayload` in `cert-crypto.ts`.
- `lzPemToDer(pem)`: base64 decoder written out (no `atob`), so it also works where only `crypto` is provided.
- `lzOfflineVerify(subtle, { payload, signatureB64, publicKeyPem }, code)` -> `{ supported: false }` when `subtle` is missing or
  `importKey("spki", ..., { name: "Ed25519" })` throws `NotSupportedError`/`SyntaxError`; otherwise
  `{ supported: true, valid, reason, expectedDigest, actualDigest, keyId }` with the same reasons as the server ("Signature mismatch...",
  "Digest mismatch..."). Order: payload shape, signature, digest.
`signatureRow` calls it first; `supported: false` falls through to the unchanged `POST /api/verify-certificate`.

## Verify Bundle drawer
`#verifyBtn` in the header, `#verifyDrawer` + `#verifyScrim` (the `dna-drawer` classes), a drop zone and a file input (multiple).
`lzClassifyBundleFiles(files)` picks a `.zip`, or `certificate.json` + a code file (`subjectFile` from the JSON, else the single
`.ts`/`.js`/`.mjs`). A zip is POSTed as `application/zip`; JSON + code goes through `lzOfflineVerify`, with the same fallback to
`/api/verify-certificate`. Results render with `textContent` only.

## `POST /api/verify-bundle` (`src/web/server.ts`)
`readBody(req, 4 MB)` collects the raw buffer; `verifyBundleZip(buffer, { maxEntryBytes: 2 MB, maxTotalBytes: 8 MB, maxEntries: 64 })`.
`readZip` gained optional `ReadZipLimits` (checked before inflating; `maxOutputLength` = declared size).

## SARIF Risk Explorer
`src/cli-audit.ts`: `auditDirectory` = `readAuditSources` + `auditSources` (pure refactor). `src/web/audit-sarif.ts`: `runAuditSarif` builds
the sources (pasted code as `specimen.js`, or an `examples/<dir>` read through `readAuditSources`), calls `auditSources` and `renderSarif`,
and derives `summary` and `findings` from the SARIF results (fix guidance = the rule's help text; snippets from the in-memory sources).
UI: `#sarifBtn`, `#sarifDrawer`, region `lz-sarif` (`lzGroupFindings`, `lzSarifFilename`), `Download .sarif` via a Blob.

## One async router
`src/crew/async-specimen.ts`: `classifySpecimen(source, name?)` -> `"error-first" | "promise-chain" | "sync"` (+ entry);
`resurrectAsyncSpecimen(orchestrator, kind, request)`; `resurrectAnySpecimen(...)` for the MCP tool (sync goes through
`orchestrator.resurrect` on the scanned expression, then `buildExportBundle` for `tsc --strict`).
- CLI: after parsing, an async kind goes to `runAsync` (bundle from `buildExportBundle`, files written like the sync path).
- MCP: `resurrect_legacy` tool + exported `executeResurrect` (testable without a transport; tests also use the SDK's in-memory transport).
- Benchmark: `runPreset` uses the router instead of its own `promiseChain` branch.
