# Tasks: AST Modernizer

- [x] 1. Dependencies: `acorn`, `astring` (runtime), `@types/estree` (dev). The lockfile also gained the already-declared MCP packages; no existing version changed.
- [x] 2. `ast-scope.ts`: walker, scope and reference analysis, type inference.
- [x] 3. `ast-modernizer.ts`: six rules, `modernize`, `summarizeForSpec`, rule-level header codec.
- [x] 4. `refineCandidate`: sandbox-probed, ladder-based, counterexample-guided refinement.
- [x] 5. `synthesizer.ts`: `DeterministicModernizer` on top of the engine; same class name and interface.
- [x] 6. `esm-export.ts` + bundle integration (`resurrected.mjs`, `legacy.cjs`, ESM parity test, AST-aware body formatting).
- [x] 7. Orchestrator spec section ("Legacy Idioms (AST analysis)"); web server and UI default to 100 runs (cap 150); live run about 0.45 s.
- [x] 8. `__tests__/ast-modernizer.test.ts` (86 tests, unit + fast-check) and two live-depth tests in `web/__tests__/server.test.ts`.
- [x] 9. Verify: `tsc --noEmit`, full `vitest run`, no leaked node processes.
