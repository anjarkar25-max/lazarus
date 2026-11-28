# Requirements: V20 Time-Travel and Adoption
The 31st spec. Three strictly additive upgrades. Constraints for every requirement: zero new top-level tabs (3 stay), zero edits to the Tab 3
Red-Team CSS, markup and script (the three SHA-256 assertions in `studio-ui.test.ts` stay byte-identical), zero new runtime dependencies,
zero API keys, and every existing test keeps passing. The only existing assertions that change are the ones that count things this spec adds:
the spec count (30 to 31) and the tests badge.
## R1. Time-Travel Stepper (`src/crew/pipeline-stages.ts`, Tab 1 diff card)
1. `POST /api/resurrect` (a single-function snippet) gains an additive `pipelineStages` array built from what the run really did, never from a template:
   stage 0 `legacy` (the source as written); stage 1 `candidate`, or `security-guards` when `global-leak-fix` or `proto-pollution-guard` fired (the first
   AST-modernized candidate with the rules it applied); stage 2 `rollback`, present only when the Exorcist caught a counterexample (the shrunken
   counterexample that broke `Object.is` parity, the legacy and candidate outputs, the rolled-back rules, and the healed code); stage 3 `typed` (the strict
   TypeScript with its `tsc --strict` result); stage 4 `verified` (the artifact the Ed25519 signature vouches for, with the parity runs, purity, key id and seed).
   A stage carries `stage`, `id`, `label`, `language`, `code`, `compareTo` and a one-line `summary`.
2. Tab 1's diff card gets a Time-Travel Stepper bar: `Prev`, `Play / Pause`, `Next`, one clickable pill per stage and a one-line note. Playing animates
   the stages in order and stops on the last. The bar appears with the result; the diff shows the final verified diff until a stage is chosen, so the
   default view is unchanged. Choosing the last stage shows the default diff; another stage shows its code against the stage named by `compareTo`.
   Another control that takes over the diff (the Rule Blame X-Ray, the diff toggle) puts the stepper back on the last stage.
## R2. Stateless Judge Proof Permalink (`#proof=...`)
1. **Copy Proof Link** sits beside **PR Preview**. It encodes `{ presetId } or { code, name }`, the schema and the `proofSeed` as base64url JSON in the hash of
   the page URL, at most 8192 characters. A preset that is still unchanged is shared by id; anything else by its code. Over the budget it says so (the
   button reads `Link too large`) instead of truncating. Success updates the address bar, copies the full URL and reads `Proof Link Copied`.
2. On load, a `#proof=` hash is decoded and validated (known fields only, base64url, a 32-bit integer seed, a valid schema, a preset that exists here
   or code and a plain module name). A bad link is ignored and says why. A good one loads the preset or the snippet, sets the seed, runs the resurrection
   with it and shows `Replayed from Proof Permalink (Seed N)` once the run proves parity under that same seed.
## R3. Legacy Migration Debt Score, CI Gate Simulator and the Verified shield (`src/crew/debt-score.ts`)
1. `computeDebtScore(findings)` reads SARIF findings (LAZ001 to LAZ010) and returns `score` (0 to 100, higher is healthier), `debtScore` (100 minus it),
   a `grade` (A 90+, B 75+, C 60+, D 40+, F) and a breakdown of four categories: Bitwise/Numeric, Async/Callbacks, Security/Scope and Module Cycles.
   A finding costs 12 (error), 5 (warning) or 1 (note) points, at most 40 per category. Pure and deterministic.
2. `simulateCiGate(before, afterVerified)` returns the GitHub Actions gate twice. Before: `FAIL · exit 1` while a High finding (an error, or LAZ008 or LAZ009) exists,
   with workflow annotations (`::error file=...,line=...,title=...::message`). After: `PASS · exit 0 · 0 High Findings · Ed25519 Verified` when the resurrection is
   verified, `FAIL` when it is not, `PENDING` when there is no verified resurrection. A graph, which carries no signature, reads `Whole-Graph Parity Verified`.
3. `renderVerifiedBadgeSvg({ label, parity, tscErrors, seed })` returns a self-contained shield (`Lazarus Verified | 100% Parity · tsc 0`): every text is escaped,
   the numbers are validated, and there is no script, link or external resource.
4. `POST /api/audit-sarif` gains additive `debtScore` and `ciGate`. The body may carry `verification` (the Ed25519 certificate and the resurrected code); the server verifies
   the signature, ties it to the audited code and builds the after side from what it proves, never from a client claim. A Tab 2 graph result carries the same fields.
5. The SARIF Audit drawer shows the **Legacy Debt Scorecard** (score, grade, four bars) and a **Simulate GitHub CI Gate** toggle that reveals both logs. Tab 1's action bar
   gets **Copy Badge SVG**, which previews and copies the shield; its client twin is checked against the server renderer.
## R4. Tests, E2E and the 31-spec sync
1. New suites `debt-score.test.ts` and `pipeline-stages.test.ts`; extended `studio-ui`, `kiro-dna`, `kiro-power` and `async-callback` tests (the stepper, permalink
   encode, decode and replay guardrails, the scorecard and CI gate, the badge, 31 Kiro Specs, the Tab 3 hashes).
2. `scripts/e2e-smoke.mjs` also steps through the stages of `stringHash32`, generates and reloads a `#proof=` link, opens SARIF Audit for the Debt Score and the CI
   gate, and clicks `Copy Badge SVG`, with 0 browser errors.
3. `npx tsc --noEmit` is 0, `npx vitest run` is green with no leaked process, `npm run test:e2e` passes, no temp file is left, `#badgeSpecs` is `31 Kiro Specs`,
   `#badgeTests` is the exact count, and every task is ticked.
