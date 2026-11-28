# Requirements: V19 Gauntlet and Security
Three strictly additive upgrades. Constraints for every requirement: zero new top-level tabs (3 stay), zero edits to the Tab 3
Red-Team CSS, markup and script (the three SHA-256 assertions in `studio-ui.test.ts` stay byte-identical), zero new runtime
dependencies, zero API keys, and every existing test keeps passing. The only existing assertions that change are the ones that
count things this spec adds: the spec count (28 to 29), the tests badge, and the key list of a signed certificate payload
(`proofSeed` joins it, last). Inter-process traffic with the sandbox stays typed JSON-RPC 2.0, validated at runtime.
## R1. 12-Case Adversarial Edge-Case Gauntlet (`src/crew/edge-gauntlet.ts`)
1. `runEdgeGauntlet({ legacyCode, modernCode, naiveCode?, schema, functionName? })` evaluates up to 12 fixed edge inputs
   (`-0`, `NaN`, `Infinity`, `-Infinity`, `2147483647`, `2147483648`, `-2147483648`, `-3`, `""`, `"\u0000"`, `"__proto__"`, and a
   64-character ASCII/Unicode string) through Legacy, Naive AI and Lazarus Proven in the sandbox workers. Numeric edges target
   `number` and `json` parameters, and (as their text) `string` parameters; an `integer` parameter takes only the integral edges
   (`-0` and the int32 edges, since `NaN` and `Infinity` are outside its declared domain); text edges target `string` and `json`
   parameters; every other parameter keeps a neutral default. A case that no parameter of the schema can take is not run, so `total` is at most 12.
2. The result is `{ total, lazarusPassed, naivePassed, rows }` with one row per case:
   `{ label, inputDisplay, legacyOut, naiveOut, lazarusOut, naiveMatch, lazarusMatch }`. Matching is the exact tagged
   `Object.is` comparison used by the fuzzer, so `-0`, `NaN` and `undefined` stay distinguishable. Two rejections count as a match.
3. `POST /api/edge-gauntlet` validates its body with zod (`legacyCode`, `modernCode`, optional `naiveCode`, `schema`, optional
   `functionName`), answers 400 for a bad body, 413 for a large one, 422 for a specimen without input or with a parse error, 429
   while another gauntlet runs, and 200 with the result. It uses its own two warm workers and closes them with the server.
4. When `naiveCode` is absent the deterministic Naive AI rewrite of the legacy code is used.
5. Tab 1's 3-Way Judge Probe card gets a compact **Run 12-Case Edge Gauntlet** button. It renders a 3-column red/green scorecard
   ("Lazarus: 12/12 Exact Parity · Naive AI: 5/12") and highlights every trap where Naive AI diverges while Lazarus holds parity.
## R2. Prototype-Pollution and Loose-Equality Security Exorcist (`src/crew/security-exorcist.ts`)
1. With Acorn, `detectProtoPollution` finds `for (k in src) { dst[k] = src[k]; }` key-copy loops that copy without a guard for
   `__proto__`, `constructor` and `prototype`; `detectLooseEquality` finds every `==` and `!=`.
2. Necromancer rule `proto-pollution-guard` (ladder `guard`, `off`) inserts
   `if (!Object.prototype.hasOwnProperty.call(src, k) || k === "__proto__" || k === "constructor" || k === "prototype") continue;`
   as the first statement of the loop body when the loop's source is a side-effect-free reference. Anything else is kept and flagged.
   Existing headers still decode (a missing rule means its default).
3. Showcase preset `legacyUnsafeMerge` (Tab 1): an ES5 merge helper that is vulnerable to prototype pollution. Lazarus repairs the loop,
   proves exact parity on normal inputs, `tsc --strict` reports 0 errors, and a live sandbox exploit probe feeds
   `JSON.parse('{"__proto__":{"polluted":true}}')` to the resurrected code and checks `({}).polluted === undefined`. The purity proof
   gains `protoPollutionBlocked` and a detail line; the Studio shows **Proto-Pollution Blocked** inside the Purity proof details.
   A `json` input that the legacy code indexes like an object (`TS18046`, `TS2407`) is declared `any` at the reported migration boundary.
4. `src/cli-audit.ts` adds two SARIF 2.1.0 rules, `LAZ009 PrototypePollutionRisk` (High, level error) and `LAZ010 LooseEqualityCoercion`
   (Medium, level warning). They are listed in `tool.driver.rules` only when a finding uses them, so LAZ001 to LAZ008 output stays identical.
   `LAZ009` is always on. `LAZ010` is opt-in (`lazarus audit --security`, `security: true` on `POST /api/audit-sarif`): `==` is everywhere in
   real legacy code, and the built-in example reports are pinned by existing tests.
## R3. Reproducible proof seeds and live Seed Replay
1. `POST /api/resurrect` accepts an optional integer `seed` (32-bit). Without one the server draws a real integer seed. The seed is the
   base seed of the proof: it is passed to `fast-check` through the Exorcist (attempt n fuzzes with seed + n), so the same seed and the same
   specimen give the same inputs, the same counterexample and the same shrink trace.
2. The final result carries `proofSeed` and `numRuns`. `proofSeed` is also in the Ed25519-signed certificate payload (last key, absent
   from payloads signed without one), in `RESURRECTION_REPORT.html` and in the exported Vitest suite as `{ numRuns: N, seed: S }`.
3. Tab 1's Verification Deck shows a **Seed: N** chip and a **Re-Verify New Seed** button that re-runs the verification with a fresh integer seed.
## R4. Tests, E2E and badges
1. New suites `edge-gauntlet.test.ts`, `security-exorcist.test.ts` and `seed-replay.test.ts`; extended `studio-ui`, `kiro-dna`,
   `kiro-power` and `async-callback` tests (Edge Gauntlet UI, Seed Replay control, 29 Kiro Specs, the Tab 3 hashes).
2. `scripts/e2e-smoke.mjs` also checks `Run 12-Case Edge Gauntlet`, `legacyUnsafeMerge` and `Re-Verify New Seed` with 0 browser errors.
3. `npx tsc --noEmit` is 0, `npx vitest run` is green with no leaked process, `npm run test:e2e` passes, no temp file is left,
   `#badgeSpecs` is `29 Kiro Specs`, `#badgeTests` is the exact count, and every task is ticked.
