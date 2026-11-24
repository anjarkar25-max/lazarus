# Design: npm Graveyard Importer and Resurrection Certificate

## Importer (`src/importer/npm.ts`)
- `parsePackageSpec(spec): ParsedSpec` uses `PackageSpecSchema` (zod): `^(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`,
  max length 214 + 32, plus an explicit rejection of `..`. Splits at the last `@`.
- `CDNS = [{ host: "unpkg.com", url: (p) => https://unpkg.com/<name>@<version> }, { host: "cdn.jsdelivr.net", url: https://cdn.jsdelivr.net/npm/<name>@<version> }]`.
  The bare package URL resolves to the package's `main` file on both CDNs (unpkg by redirect, jsDelivr directly).
- `fetchFromCdn(fetchImpl, url)`: loop up to 3 redirects with `redirect: "manual"`; each `Location` is resolved against the
  current URL and validated by `assertAllowedUrl` (https, allowlisted host, no credentials/port, no `..`). Per-request
  `AbortController` timeout (5 s, injectable for tests). Body read through `response.body.getReader()` with a running byte count.
- Errors: `NpmImportError(code, message, details?)` with `NpmErrorCode`. `statusFor(code)` maps to HTTP.
- `findExternalDependencies(source)`: parse with acorn through `parseProgram`, walk for `CallExpression` of an unresolved
  `require` identifier (literal specifier or `<dynamic>`) and any `ImportDeclaration`/`ImportExpression`.
- `importNpmPackage(spec, { fetch?, timeoutMs? })` composes: parse → CDN loop → dependency check → `scanLegacyAst`.
  Returns `NpmImportResult` (provenance + scan fields). The function never executes the fetched code.
- The route is thin: zod strict body, call importer, map `NpmImportError` to status. `createWebServer({ npmFetch })` injects fetch in tests.

## Certificate (`src/exporter/certificate.ts`)
- `generateCertificate(input)` is pure and deterministic. Input: provenance, `legacySource`, `modernCode`, `schema`, fuzz facts
  (`totalRuns`, `exact`, `boundaryRuns?`), `attempts`, `esmComplete?`.
- Digest: `createHash("sha256")` over the UTF-8 legacy source (CRLF normalized to LF so Windows and Linux agree). `shortDigest` = first 12 hex.
- Debt score: `modernize(legacySource)` at default levels yields applied rewrites per rule. Weights (per site, capped per rule):
  var-scoping 1 (cap 10), bitor0-trunc 3 (cap 5), prototype-class 8 (cap 3), arguments-rest 4, apply-spread 3, function-arrow 1 (cap 5),
  loose-equality (flagged sites) 2 (cap 5), CommonJS export 5, parse failure 0. Score = min(100, sum). Grade bands: 0 clean, 1-19 low, 20-49 moderate, 50+ severe.
- Modernized idioms: rules with applied sites whose level in the candidate's `// ast-rules:` header is not `off` (no header means default levels).
  Rolled back = applied sites available but header says `off`. CommonJS → ESM listed when the legacy source has exports and `esmComplete`.
- Markdown is a fixed template without timestamps. `Certificate` also exposes the structured fields for UI rendering.

## Integration
- `/api/resurrect`: optional `provenance` (`kind`, `label`, optional `version`, `cdnHost`, `url`, `byteLength`), sanitized (string lengths, kind enum).
  On success, `result.certificate` is attached (module mode: aggregate runs, max attempts).
- `/api/export-bundle`: same optional `provenance` plus `attempts`; the certificate is recomputed server-side and passed to
  `generateResurrectionBundle({ certificateMarkdown })`, which embeds it under the SPEC.md title. Absent means SPEC.md is unchanged.
- CLI: provenance `file`; certificate embedded likewise.

## UI (`public/index.html`)
- Graveyard bar below the GitHub importer: text input, IMPORT button, four chips, provenance pill, error banner.
- `window.lazarusProvenance` is set by preset change, GitHub import, npm import; typing in the specimen box resets it to `paste`.
- Certificate card in the middle column under the modern code. Built with DOM APIs and `textContent` only. Copy button uses
  `navigator.clipboard` with a textarea fallback.
- Colors: #090d16 / #111827 / #10b981 / #ef4444 / #8b5cf6. No frameworks. Results arrive over the existing SSE stream.

## Risks
- `is-number@3.0.0` depends on `kind-of`. It is a requested chip, and it will show the honest `HAS_DEPENDENCIES` banner.
- CDN main-file resolution may serve a bundled/minified file for some packages; size cap and parse checks apply as usual.
