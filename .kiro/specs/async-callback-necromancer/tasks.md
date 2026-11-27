# Tasks: Async Callback Necromancer
- [x] 1. Sandbox: `settle` probes (afterEvaluate microtasks, in-context virtual timers, budgeted poll/tick loop), validation, `supportsSettle`.
- [x] 2. Fuzzer: `FuzzOptions.settle`, `asyncOutcomes` counts.
- [x] 3. `async-callback.ts`: detection, deterministic lift, legacy/modern harnesses, promise-wrapper fallback.
- [x] 4. Orchestrator `resurrectErrorFirst` (self-healing ladder, Type Alchemist return type) and `/api/resurrect` routing.
- [x] 5. Async export bundle (`tsc --strict`, async Vitest parity suite) wired into `/api/export-bundle` and `/api/export-zip`; async mutation audit.
- [x] 6. Tab 1: `legacyReadConfigCb` preset and async result handling; `lazarus audit` error-first findings.
- [x] 7. Tests: `async-callback.test.ts` (parity both paths, counterexamples, timers, TIMEOUT, preset end to end, no leaks) and existing-suite updates.
- [x] 8. Verify: browser check, `tsc`, full `vitest run`, leak check, badges (`22 Kiro Specs`, final test count).
