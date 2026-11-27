# Tasks: V12 Grandmaster Autopsy and Audit
- [x] 1. `mutation-audit.ts`: `originalLine` / `mutatedLine` on mutants; `autopsy` per result (status, killer input with source and shrink replay, formatted outputs, divergence).
- [x] 2. Tab 1: clickable, keyboard-accessible mutation score toggling the collapsed Mutant Autopsy Inspector.
- [x] 3. `naive-refactor.ts` (deterministic rewrites) and `POST /api/compare-naive` (strict body, dedicated pools, busy guard).
- [x] 4. Tab 1: Compare vs. Naive AI button and the side-by-side Trap Card.
- [x] 5. `cli-audit.ts`, `audit` subcommand in `cli.ts`, `npm run audit`, Kiro Power skill mention.
- [x] 6. `GET /api/health` and the Render cold-start guard.
- [x] 7. Tests: `naive-refactor.test.ts`, `cli-audit.test.ts`, and extensions to `mutation-audit.test.ts`, `studio-ui.test.ts`, `kiro-dna.test.ts`.
- [x] 8. Verify: browser check, acorn parse, `tsc`, full `vitest run`, leak check, badges (`21 Kiro Specs`, final test count).
