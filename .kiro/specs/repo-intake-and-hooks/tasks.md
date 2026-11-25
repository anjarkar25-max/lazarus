# Tasks: Repo Intake and Hooks
- [x] 1. `src/importer/github-dir.ts`: URL validation, allowlisted fetch with a single deadline, listing filter, caps, rate-limit and upstream errors, entry via `analyzeGraph`.
- [x] 2. `POST /api/import/github-dir` with injectable `githubFetch`.
- [x] 3. `src/importer/__tests__/github-dir.test.ts` (injected fetch only): valid import, URL/SSRF rejection, caps, rate limits, upstream errors, route.
- [x] 4. Hooks: `sandbox-security-guard.json`, `strict-typecheck-on-crew.json`, `kiro-dna-sync-check.json` (Kiro v1 format).
- [x] 5. `readKiroDna()` reads `.kiro/hooks` (v1 + legacy, zod); tests for all four hooks and the spec badge.
- [x] 6. Page: `lz-intake` helpers, Tab 2 intake bar (dropzone, picker, folder import, entry choice), Copy Lab Link + hash loader, DNA drawer Hooks section.
- [x] 6b. Follow-up: `branch` in the import result, allowlist-validated redirects (max 3), the "requires others" entry rule in `analyzeGraph` and `lzPickEntry`, and the Guided Tour banner dismissed on Tabs 2/3; tests for each.
- [x] 7. `studio-ui.test.ts`: helpers in `node:vm`, intake markup, link button, acorn parse of every inline script.
- [x] 8. Verify: browser check (upload, folder import with stubbed endpoint, link round trip, drawer, overflow), `tsc`, full `vitest run`, leak check, badges.
