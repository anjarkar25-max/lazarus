# Tasks: Mutation Proof and Types
- [x] 1. Fuzzer: `FuzzOptions.shrink` (`endOnFailure`) and `FuzzOptions.observe`.
- [x] 2. `src/crew/mutation-audit.ts`: sites, interleaving, harness-guard exclusion, distinct mutants, audit with baseline check.
- [x] 3. `src/crew/type-alchemist.ts`: inference, merging, rendering (type, JSDoc, pill, `.d.ts`), validation.
- [x] 4. Orchestrator `collectObservations`; bundle `typeSignature` (typed `resurrected.ts`, `types.d.ts`); clean up the dead module branch.
- [x] 5. Certificate `mutation` row.
- [x] 6. Server: `/api/mutation-audit` (zod, dedicated pools, 429 BUSY), signature on `/api/resurrect`, signature + score on export.
- [x] 7. UI: signature pill, mutation card, kill-score badge and table, certificate row and copy.
- [x] 8. Tests: `mutation-audit.test.ts`, `type-alchemist.test.ts`, `mutation-route.test.ts`.
- [x] 9. Verify: `tsc`, full `vitest run`, leak check.
