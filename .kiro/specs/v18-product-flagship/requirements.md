# Requirements: V18 Product Flagship
Three strictly additive upgrades. Constraints for every requirement: zero new top-level tabs (3 stay), zero edits to the Tab 3
Red-Team CSS, markup and script (the three SHA-256 assertions in `studio-ui.test.ts` stay byte-identical), zero new runtime
dependencies, zero API keys, and every existing test keeps passing. The only existing assertions that change are the ones that
count things this spec adds: the spec count (27 to 28), the tests badge, the exact file list of a whole-project `.zip`
(`RESURRECTION_REPORT.html` joins it) and the tool list or counts that must grow with the new report.
## R1. Purity: the fifth proof pillar (`src/crew/purity-audit.ts`)
1. Leak detection: with Acorn scope analysis, an assignment (`=`, `op=`, `++`) inside a function to an identifier that no
   enclosing scope declares is an undeclared global leak. Schema input names, host names (`module`, `exports`, `window`...)
   and programs that use the global object or `eval` / `with` are not reported as leaks.
2. Necromancer rule `global-leak-fix` (ladder `declare`, `off`): when the first reference to a leaked name in a function is a
   plain `name = expr;` statement at the top level of that function's body, the right side does not read the name, and every
   reference lies inside that function, the statement becomes `let name = expr;`. Anything else is kept and flagged, never
   guessed. Existing encoded headers still decode (a missing rule means its default).
3. Exorcist `purityProof` (additive, on a proven sync resurrection): `globalLeaksDetected` (names in the legacy AST),
   `globalLeaksEliminated` (the resurrected code runs under `"use strict"` without a ReferenceError for a leaked name and adds no
   global to `globalThis`, and its own AST has no leak), `prototypeSafe` (`Object.prototype` / `Array.prototype` keys unchanged
   after both runs), `inputMutationParity` (a deep `Object.is` snapshot of every input after the legacy call equals the one after
   the resurrected call). The proof runs in the sandbox on fuzzed inputs and states how many.
4. Showcase preset `legacyLeakyMutator` in Tab 1: leaks an accumulator, mutates its array argument. A naive strict-mode
   rewrite throws `ReferenceError` (Compare vs. Naive AI shows it); Lazarus repairs the scope, proves `Object.is` and purity
   parity, and `tsc --strict` reports 0 errors.
5. `LAZ008` `UndeclaredGlobalLeak` in `src/cli-audit.ts` and the SARIF log. It is listed in `tool.driver.rules` only when a
   finding uses it, so every existing LAZ001 to LAZ007 output stays identical.
## R2. Offline report and PR Preview
1. `src/exporter/html-report.ts` renders `RESURRECTION_REPORT.html`: one file, dark theme, inline CSS, no script, no font, no
   link, no `http://` or `https://` URL that a browser would load. It shows the specimen, a 5-pillar scorecard (Object.is parity,
   Purity, Mutant kill rate, Ed25519 signature and digest, Performance parity), a side-by-side legacy and resurrected diff, the
   causal rollback and shrink trace summary, the Mutant Autopsy table, and the `tsc --strict` proof. A pillar the run did not
   produce says "not measured". All user text is HTML-escaped.
2. Every `.zip` PR bundle (single file, async, whole project) contains `RESURRECTION_REPORT.html` next to the existing entries.
   The Ed25519 certificate still signs `resurrected.ts` and is unchanged.
3. Tab 1 gets a **PR Preview** button beside **Download .zip PR Archive**. It opens a drawer under the V17 single-active-drawer
   manager (Escape, focus return, focus trap): PR title and summary checklist, the bundle file tree, the unified diff, a
   copyable `git apply` one-liner and **Download Offline Report (.html)**.
## R3. 5-Pill Proof Strip and the Kiro Ecosystem Map
1. Above the code diff, a 5-pill strip: Object.is Parity, Purity / Zero Leaks, Mutants Killed, Ed25519 Offline, Perf Parity.
   Each pill reflects what the run produced and is keyboard-operable: parity scrolls to the Causal Strip and Shrink Trace,
   purity reveals the `purityProof` details, mutants opens the Mutant Autopsy, Ed25519 focuses the certificate and Simulate
   1-Byte Tamper, Perf Parity shows the ratio or the async skip note.
2. The Kiro DNA drawer shows an inline-SVG map: Specs, Crew Agents, Hooks, Steering Docs, `lazarus-sandbox` MCP,
   `power-lazarus` Kiro Power, `lazarus-kiro-crew` App, with the counts read from disk by `/api/kiro-dna`.
## R4. Tests, E2E and badges
1. New suites `purity-audit.test.ts` and `html-report.test.ts`; extended `studio-ui`, `kiro-dna`, `kiro-power`,
   `async-callback` tests (28 Kiro Specs, the strip, the PR Preview drawer, the map, Tab 3 hashes).
2. `scripts/e2e-smoke.mjs` also checks `legacyLeakyMutator`, the strip and the PR Preview drawer with 0 browser errors.
3. `npx tsc --noEmit` is 0, `npx vitest run` is green with no leaked process, `npm run test:e2e` passes, no temp file is left,
   `#badgeSpecs` is `28 Kiro Specs`, `#badgeTests` is the exact count, and every task is ticked.