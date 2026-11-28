# Design: V20 Time-Travel and Adoption

## Pipeline stages
The Orchestrator keeps an `AttemptRecord` per candidate (its code and the counterexample that ended it). With `recordPipeline` it returns stages 0 to 2
(`buildDraftStages`): the rules of the first candidate are re-derived from the candidate's own `// ast-rules:` header, the rollback stage comes from the first
recorded counterexample and the rolled-back entries of the Rule Blame. The server adds stages 3 and 4 (`completePipeline`) from the bundle's `resurrected.ts`,
its `tsc --strict` report, the signed code and the certificate. The verified stage is `modernCode` because that is what `/api/resurrect` signs.

## Stepper
`lzMakeStepper(env)` (region `lz-timetravel`) holds stages, the selected index, the timer. Loading stages never redraws the diff; the last index is the default
view and calls `refreshLegacyDiff`. Other stages call `renderDiff(base, code)` with the base named by `compareTo`. Timers and DOM pieces are injected, so the tests
drive it with fake timers.

## Proof permalink
`lzEncodeProof` and `lzDecodeProof` (region `lz-proof-link`) are pure. The decoder whitelists the keys, checks the alphabet, the size, the seed, the schema, the preset
id against the page's own options and the module name; it never evaluates anything, and its values only reach `.value` and `textContent`. Replay sets
`window.lazarusSeedOverride`, which `startRun` already forwards as the request `seed`.

## Debt score, gate, shield
`src/crew/debt-score.ts` is pure. `audit-sarif.ts` maps the SARIF findings to `DebtFinding`s and verifies a supplied certificate with `verifyCertificate`, tying
`legacySha256` to the audited code. The shield has a browser twin (`lzBadgeSvg`, region `lz-badge`) that a test compares byte for byte with the server renderer.

## UI
No new tab and no edit inside the Red-Team regions. The stepper bar sits in the legacy diff card, the two buttons right after PR Preview, the scorecard in the
SARIF drawer. One new script block (`lz-v20`) goes before the stale-proof script, which stays last. CSS goes under its own comment before the V20 Graveyard block.
