# Requirements: V16 Zero-Trust and SARIF

Three strictly additive upgrades. For every requirement: no new top-level tab, no edit to any Tab 3 Red-Team line of
`public/index.html` (its three SHA-256 invariants stay unchanged), no new npm dependency, no external API key, and no
regression in the 1,147 existing tests. Where an existing assertion encodes a value this spec changes (the spec count,
the header's button row), the assertion is updated and listed in the final report.

## R1. Zero-trust offline verification in the browser

1. Tab 1's certificate verification first verifies the Ed25519 signature in the browser with `window.crypto.subtle`:
   `Ed25519` SPKI import, `verify` over the canonical payload, and a SHA-256 digest of the resurrected code (CRLF normalized
   to LF, UTF-8, the same digest the server signs). No network request is made when the browser can do it.
2. If `crypto.subtle` is missing, or does not support `Ed25519` (an older browser, a headless or fake DOM), verification falls
   back to `POST /api/verify-certificate` unchanged. A WebCrypto failure that is not "unsupported" is a verification failure,
   never a silent fallback.
3. A `Verified Offline (Browser WebCrypto)` pill sits next to the `Ed25519 Signed · VERIFIED` badge when the offline check
   succeeded. `Simulate 1-Byte Tamper` runs the same offline check on the changed copy: the badge turns red with
   `TAMPER DETECTED (Digest / Signature Mismatch)` and the pill reads `Offline check failed (Browser WebCrypto)`.
   `Restore Verified` restores both.
4. A `Verify Bundle` button in the header (beside Kiro DNA, not a tab) opens a drawer. A judge drops or selects a Lazarus
   `.zip` PR archive, or `certificate.json` together with the resurrected `.ts` file.
   - For `certificate.json` + code files the check runs in the browser (WebCrypto, with the same fallback).
   - For a `.zip` the archive is sent to `POST /api/verify-bundle`.
   The result is exactly `VERIFIED` or `TAMPER DETECTED`, with the expected and actual SHA-256 digests, the key id, the file
   that was checked, and whether the signing key is this Studio's key.
5. `POST /api/verify-bundle` accepts the raw `.zip` body (at most 4 MB; entries capped at 2 MB each and 8 MB in total,
   inflation never exceeds the declared size). It returns `{ valid, reason, expectedDigest, actualDigest, keyId, trustedKey,
   subjectFile, entries }`; an unreadable archive is `valid: false` with the reason. An empty body is 400, an oversized one 413.

## R2. Interactive SARIF 2.1.0 Risk Explorer

1. `POST /api/audit-sarif` takes exactly one of `{ code }` (pasted legacy JavaScript, at most 64,000 characters) or
   `{ example }` (the name of a directory under `examples/`, matched against the real listing). It reuses `src/cli-audit.ts`
   (`auditSources`, `renderSarif`): no rule logic is duplicated. The refactor of `auditDirectory` into `readAuditSources` +
   `auditSources` changes no existing output.
2. The response has the full SARIF 2.1.0 log (`sarif`), a `summary` (files, readiness, grade, totals by severity, and counts for every
   rule `LAZ001` to `LAZ007`, zero included) and `findings`: one per SARIF result with its rule, level, `uri`, `startLine`,
   message, fix guidance, and a source snippet of up to three lines around the finding. Paths of the server never appear.
3. A `SARIF Audit` button in the header opens a drawer (the Kiro DNA pattern): a source selector (the Tab 1 specimen, or one
   of the three built-in example projects), a Run button, counts per rule, and findings grouped by severity and rule id.
   Selecting a finding shows its snippet and fix guidance. `Download .sarif` saves `lazarus-report.sarif` from the browser.

## R3. One Promise-chain path for Studio, CLI, MCP and the benchmark

1. `src/crew/async-specimen.ts` classifies a source (error-first callback, Promise chain, or synchronous) and runs the
   matching pass; the CLI, the MCP server and the benchmark use it.
2. `lazarus resurrect <file>` (`npm run resurrect`) resurrects an error-first or Promise-chain file as `async/await`, proves both
   settlements, checks `tsc --strict`, and writes the async bundle (`resurrected.ts`, `resurrected.test.ts`, `SPEC.md`, `legacy.cjs`,
   CI workflow, `resurrection.patch`) with exit code 0, or nothing and exit 1. Synchronous files take the old path unchanged.
3. The `lazarus-sandbox` MCP server gains a `resurrect_legacy` tool (the existing `run_legacy_probe` is unchanged). It accepts legacy
   code, resurrects it by the same router, and returns the result as JSON: kind, success, attempts, fuzz runs, resurrected code,
   `tsc --strict` result, rule blame and the counterexample on failure.
4. `npm run benchmark` runs every built-in preset, including `legacySubclassMeter`, `legacyPromiseChain` and
   `legacyReadConfigCb`, with 100% parity and `tsc --strict: 0 errors`.

## R4. Verification

1. New suite `src/web/__tests__/verify-bundle-and-sarif.test.ts`; extended `studio-ui.test.ts`, `kiro-dna.test.ts`,
   `kiro-power.test.ts`, `async-callback.test.ts`, `cli-audit.test.ts`, `cli.test.ts`.
2. `npx tsc --noEmit` exits 0; the full `npx vitest run` is green with no leaked Node processes; no temporary files remain.
3. `#badgeSpecs` is `26 Kiro Specs`, `#badgeTests` is the exact final count, every task is ticked.
