# Requirements: npm Graveyard Importer and Resurrection Certificate

## Introduction
Judges should be able to pull real legacy code from the npm registry mirrors in one click, resurrect it, and take away a
compact proof of what happened. This spec adds a secure npm importer (`POST /api/import/npm`), an "npm Graveyard" quick-pick
bar in the Operating Table, and a Resurrection Certificate shown in the UI and embedded in the exported `SPEC.md`.

Constraints: strict TypeScript (no `any`, no `@ts-ignore`), no new runtime dependencies, all 328 existing tests keep passing,
`tsc --noEmit` clean. Fetched code is only parsed on the host (acorn). It runs exclusively in the sandbox, as before.

## Requirements

### R1. Package spec validation
1. `packageSpec` is `name@version` or `@scope/name@version`, validated with zod and one tight regex pair.
2. `name` matches npm's lower-case naming rules (max 214 chars, no leading dot or underscore). `version` is an exact semver
   (`1.2.3`, optional `-prerelease`). Ranges, tags (`latest`), URLs, paths, query strings, `..`, whitespace and shell
   characters are rejected with `INVALID_SPEC` before any network access.
3. The request body is strict: unknown keys are rejected.

### R2. Secure fetching
1. Only `https://unpkg.com/` is tried first, then `https://cdn.jsdelivr.net/npm/`. The URL is built from validated parts only.
2. Each request has a 5 s `AbortController` timeout.
3. Redirects are followed manually (max 3). Every hop must be `https:`, have no credentials or custom port, and a host in
   the allowlist (`unpkg.com`, `cdn.jsdelivr.net`). Anything else fails with `REDIRECT_REJECTED` and is not followed.
4. The body is read as a stream and aborted once it passes 32 KB (`TOO_LARGE`), even without a `Content-Length` header.
5. Fallback to the second CDN happens on 404, other non-2xx statuses, network errors, timeouts and rejected redirects.
   `TOO_LARGE` is final (the same file is on both CDNs). If every CDN fails, the error reports the most specific cause
   (`NOT_FOUND` only when the CDNs agree the package is missing).

### R3. Extraction and honesty
1. The fetched file goes through `scanLegacyAst`. The response includes the source, runnable expression, suggested schema,
   detected idioms, the function list and provenance (package, version, CDN host, URL, byte size, SHA-256).
2. A source that calls `require()` (any specifier, or a non-literal one) or uses `import` cannot run in the isolated sandbox.
   It fails with `HAS_DEPENDENCIES` and lists the specifiers. Nothing is faked, stubbed or silently inlined.
3. Empty files are `EMPTY`; sources acorn cannot parse are `PARSE_ERROR`.
4. HTTP mapping: 400 `INVALID_SPEC`, 404 `NOT_FOUND`, 413 `TOO_LARGE`, 422 `HAS_DEPENDENCIES`/`PARSE_ERROR`/`EMPTY`,
   502 `UPSTREAM_ERROR`/`REDIRECT_REJECTED`, 504 `TIMEOUT`. Body: `{ error, code, details? }`.

### R4. npm Graveyard bar (UI)
1. An "Import from npm Graveyard" input and button beside the GitHub importer.
2. Four chips: `left-pad@1.3.0`, `is-number@3.0.0`, `decamelize@1.2.0`, `escape-string-regexp@1.0.5`. One click imports and
   fills the specimen, name and schema, so Resurrect can be clicked immediately.
3. A provenance pill shows package, exact version, CDN host, byte size and detected idioms. Errors render as a crimson banner
   with the error code and message.
4. Visuals follow `ui-aesthetics.md` (obsidian/panel/emerald/crimson/violet; no UI framework).

### R5. Resurrection Certificate
1. `src/exporter/certificate.ts` builds a certificate from a verified resurrection: provenance (preset / GitHub URL /
   npm `pkg@version` / pasted / file) plus the SHA-256 and a 12-hex short digest of the legacy input.
2. Legacy Debt Score (0-100, deterministic, derived from the AST rewrites available on the legacy source) and the idioms
   that were actually modernized (`var → const/let`, `| 0 → Math.trunc`, CommonJS → ESM, `prototype → class`, ...), plus
   rules the Exorcist rolled back.
3. Parity proof: exact `Object.is` mode, the real fuzz run count, attempts, and whether the Necromancer self-healed.
4. The certificate Markdown contains no timestamps, so the same input always yields byte-identical output.
5. `/api/resurrect` results carry `certificate` on success. The UI renders it in the results column with a
   "Copy Certificate (Markdown)" button. `SPEC.md` of the exported bundle embeds the same block (also from the CLI).

### R6. Tests
1. `src/importer/__tests__/npm.test.ts` and `src/exporter/__tests__/certificate.test.ts` use an injected `fetch`. No live
   network in Vitest.
2. Cover: valid parsing (scoped too), SSRF / traversal / hostile redirect rejection, 32 KB cap (with and without
   `Content-Length`), unpkg → jsDelivr fallback, timeout, `require()` detection, certificate digest and score determinism,
   and `POST /api/import/npm` validation and status mapping.
3. `npx tsc --noEmit`, full `npx vitest run` and a Node process leak check all pass.
