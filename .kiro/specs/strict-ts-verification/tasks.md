# Tasks: Strict TS Verification
- [x] 1. Inspect `node_modules/typescript` (7.0.2, native, `unstable/async` API); move `typescript` to `dependencies` (package.json + lockfile).
- [x] 2. `src/crew/ts-verifier.ts`: in-memory API engine (virtual root, warm process, idle close), CLI temp-dir fallback, result shape.
- [x] 3. `src/crew/ts-emit.ts`: `annotateModule`, diagnostic-driven `applyBoundaryFixes`.
- [x] 4. `src/exporter/verified-bundle.ts`: verify, boundary fixes, widen once, final SPEC/certificate; PR diff follows the fixed file.
- [x] 5. Certificate `typecheck` row; SPEC.md status lines.
- [x] 6. Graph: per-file observations, cross-module call replay, typed `.ts` modules, project check; bundle `src/*.ts` + `tsconfig.json`.
- [x] 7. Server: shared `buildExportBundle`, `typecheck` on resurrect/export/graph results, verifier closed with the server; UI rows; CLI line.
- [x] 8. Tests: `ts-verifier.test.ts`, graph/bundle/route updates.
- [x] 9. Verify: `tsc`, full `vitest run`, leak check (processes and temp entries).
