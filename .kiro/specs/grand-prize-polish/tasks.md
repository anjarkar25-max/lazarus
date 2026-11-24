# Tasks: Grand Prize Polish
- [x] 1. `src/exporter/zip.ts`: `createZip`, `readZip`, CRC-32, name validation.
- [x] 2. Bundle: generated `.github/workflows/lazarus-parity.yml`, `bundleToZipEntries`; CLI writes nested paths.
- [x] 3. `POST /api/export-zip` (shares the export-bundle handler).
- [x] 4. `src/sandbox/redteam.ts` + `POST /api/redteam` (zod, dedicated pool, canary, single-flight).
- [x] 5. UI: workflow tab, "Download .zip PR Archive", scroll-into-view, Red-Team card.
- [x] 6. Tests: `zip.test.ts`, `redteam.test.ts` (plus bundle/CLI expectations).
- [x] 7. Verify: `tsc`, full `vitest run`, leak check.
