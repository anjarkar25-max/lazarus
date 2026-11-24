# Tasks: npm Graveyard Importer and Resurrection Certificate
- [x] 1. `src/importer/npm.ts`: spec validation, allowlisted fetch with manual redirects, timeout, 32 KB streaming cap, CDN fallback, dependency detection, scan.
- [x] 2. `POST /api/import/npm` in `src/web/server.ts` (`npmFetch` injection, status mapping).
- [x] 3. `src/exporter/certificate.ts` (digest, debt score, idioms, parity, Markdown) and `SPEC.md` embedding in the bundle.
- [x] 4. Wire certificate into `/api/resurrect`, `/api/export-bundle` and the CLI.
- [x] 5. UI: npm Graveyard bar, chips, provenance pill, error banner, Certificate card with Copy button, provenance tracking.
- [x] 6. Tests: `npm.test.ts`, `certificate.test.ts`, route tests (mocked fetch).
- [x] 7. Verify: `tsc`, full `vitest run`, leak check, live smoke of the four chips.
