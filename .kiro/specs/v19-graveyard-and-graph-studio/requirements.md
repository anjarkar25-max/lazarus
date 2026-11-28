# Requirements: V19 Graveyard and Graph Studio
The 30th spec. Two strictly additive upgrades. Constraints for every requirement: zero new top-level tabs (3 stay), zero edits to the Tab 3
Red-Team CSS, markup and script (the three SHA-256 assertions in `studio-ui.test.ts` stay byte-identical), zero new runtime
dependencies, zero API keys, and every existing test keeps passing. The only existing assertions that change are the ones that count
things this spec adds: the spec count (29 to 30) and the tests badge.
## R1. Famous npm Classics (`src/crew/graveyard-classics.ts`)
1. A deterministic registry of five iconic legacy npm utilities: `left-pad@1.3.0`, `is-number@3.0.0`, `ms@0.7.1`, `decamelize@1.2.0` and
   `pad-left@2.1.0`. Each entry has the ES5 CommonJS snapshot of the package's entry file, the fuzz schema, the license, author, homepage
   and repository, a one-line summary, and the legacy traps it carries (string coercion, bitwise and numeric edges, regex and padding
   boundaries). A one-line dependency the sandbox cannot load (`kind-of` in is-number, `repeat-string` in pad-left) is inlined and listed under
   `modifications`; every other snapshot is the file the package ships.
2. `GET /api/graveyard-classics` returns `{ count, classics }` with each classic's metadata, byte length and SHA-256 (not its source).
3. `POST /api/import/npm` takes an optional `source`: `live` (the default: exactly the behavior of every earlier version), `snapshot` (a curated
   classic from the snapshot, no network at all; any other package is refused with NOT_FOUND) and `auto` (live CDN first; for a curated classic,
   a CDN timeout, rate limit, outage, redirect refusal, size or dependency problem falls back cleanly to the snapshot and the result carries
   `fallback: { code, message }`). A classic's result also carries `origin` (`curated-snapshot` or `live-cdn`), `license` and `classic`.
4. The signed certificate's provenance names the license of a classic (`npm \`left-pad@1.3.0\` via lazarus-curated (1137 bytes, WTFPL)`).
5. Tab 1's npm Graveyard panel gets a **Famous npm Classics** chip strip (`left-pad`, `is-number`, `ms`, `decamelize`, `pad-left`). A click imports
   the snapshot with its provenance badge and runs the full resurrection and 5-pillar proof: `100% Exact Parity`, `tsc --strict: 0 errors`,
   purity, the Ed25519 signature. IMPORT NPM and the older chips send `auto`, so a typed classic never flakes on a slow CDN.
6. To keep the five classics at `tsc --strict: 0 errors`, a parameter of the wrapped specimen that TypeScript types from a possibly-undefined call
   argument (TS18048, TS18049, TS2339 on `{}`, TS2362, TS2363, TS2367) is declared `any` at the reported migration boundary.
## R2. Public API Contract Guard (`src/crew/api-contract.ts`, `src/crew/graph-resurrector.ts`)
1. A successful graph resurrection gains an additive `apiContract`: `{ breakingChanges, totalExports, preservedExports, modules }` with one
   entry per module `{ file, legacyExports, modernExports, preserved, breaking }`. Each export is `{ name, form, kind, arity }`: its name, `named` or
   `default`, `function`, `class` or `value`, and parameter count.
2. Both sides are described the same way, by loading the original CommonJS module and the stitched ES module in the sandbox (virtual require, one
   vm context per probe). A legacy export is preserved when the modern module exports the same name and form with the same kind (a prototype
   constructor that became a class is the same kind) and the same arity. Removing or renaming an export, changing its kind or its arity is a
   breaking change; extra modern exports are not. When a module cannot be described, `apiContract` is absent: nothing is guessed.
3. `POST /api/resurrect-graph` streams `apiContract` in its result.
## R3. Tab 2 Module Inspector and contract badge
1. Every file node of the live SVG graph is `role="button"`, `tabindex="0"` and reachable by Enter and Space. A selected node gets a highlight ring.
2. Selecting a node opens the **Module Inspector** right below the graph: the module's cycle role (`Cycle Member`, `Entry`, `Leaf`, else
   `Intermediate`), its public API exports with their preserved or broken state, a `tsc --strict: N errors` badge for that file, and an aligned
   side-by-side Legacy CJS and Resurrected TypeScript diff of that exact file. It updates when another node is selected and clears when the project changes.
3. The results header shows `Public API Contract: 0 Breaking Changes (N/N Exports Preserved)` next to `Cycle Resolved (ESM Live Bindings)`.
## R4. Tests, E2E and the 30-spec milestone
1. New suites `graveyard-classics.test.ts` and `api-contract.test.ts`; extended `studio-ui`, `kiro-dna`, `kiro-power` and `async-callback` tests (the
   chip strip, the inspector, the contract badge, 30 Kiro Specs, the Tab 3 hashes).
2. `scripts/e2e-smoke.mjs` also clicks a Famous npm Classic chip (`left-pad@1.3.0`), resurrects `legacy-circular-ledger` on Tab 2, clicks the
   `tax.cjs` node to check the inspector diff, and asserts the `Public API Contract: 0 Breaking Changes` badge, with 0 browser errors.
3. `npx tsc --noEmit` is 0, `npx vitest run` is green with no leaked process, `npm run test:e2e` passes, no temp file is left, `#badgeSpecs` is
   `30 Kiro Specs`, `#badgeTests` is the exact count, and every task is ticked.
