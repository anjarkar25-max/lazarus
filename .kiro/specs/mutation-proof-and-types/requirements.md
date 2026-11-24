# Requirements: Mutation Proof and Types

## Introduction
Two features that make a resurrection's proof inspectable: a "Prove the Proof" mutation auditor that attacks the
verified resurrected code with realistic rewrite bugs and shows whether the Exorcist catches each one, and a Type
Alchemist that turns the inputs and outputs observed while fuzzing into TypeScript types for the exported bundle.

Constraints: strict TypeScript (no `any`, no `@ts-ignore`), zero new runtime dependencies, all 555 existing tests keep
passing, `tsc --noEmit` clean. Mutants and baselines only run inside pooled sandbox workers (`sandbox-security.md`);
the host only parses and prints them. UI follows `ui-aesthetics.md`.

## Requirements

### R1. Mutant generation (`src/crew/mutation-audit.ts`)
1. acorn + astring produce up to 5 mutants of the resurrected code from five operator families:
   - boundary flip: `<` ↔ `<=`, `>` ↔ `>=`;
   - truncation sabotage: `Math.trunc` → `Math.floor`, or stripping `| 0`;
   - arithmetic flip on numeric expressions: `+` → `-` (not on string-literal concatenation), `-` → `+`, `*` → `+`,
     `/` → `*`, and the compound forms `+=`, `-=`, `*=`, `/=`;
   - guard sabotage: `if (c)` → `if (!c)`, `c ? a : b` → `!c ? a : b`, or an off-by-one integer constant (`k` → `k + 1`);
   - equality flip: `===` ↔ `!==`, `==` ↔ `!=`.
2. Families are interleaved so a 5-mutant budget covers different bug classes. A mutant is emitted only if its printed
   AST differs from the original and from every earlier mutant, and it re-parses.
3. The scanner's own argument guard (`typeof x !== "undefined" ? x : undefined`) is harness code and is never mutated.
4. Each mutant carries `id`, `operator`, a label (e.g. `Math.trunc → Math.floor`), a description and a one-line
   `- before` / `+ after` diff snippet.

### R2. Audit
1. The unmutated candidate is first fuzzed against the legacy baseline with the same budget. If it diverges, no mutant is
   judged and the result says why (`baselineVerified: false`).
2. Each mutant is fuzzed with the pooled exact `Object.is` Exorcist: boundary corpus (half the budget) and then
   boundary-biased random runs, 30 per mutant by default (clamped to 10–60), with no shrinking. `KILLED` comes with the
   first input that told it apart. `SURVIVED` is reported as is, including for genuinely equivalent mutants.
3. Result: `{ totalMutants, killed, survived, killRatePercent, elapsedMs, runsPerMutant, baselineVerified, mutants:
   [{ id, operator, label, description, diffSnippet, status, killingCounterexample, runs, elapsedMs }], note? }`.
4. A 5-mutant audit of a typical preset finishes in under 2 seconds on warm workers.

### R3. `POST /api/mutation-audit`
1. Body `{ legacyCode, modernCode, schema, seed? }`, validated with a strict zod schema (sizes as `/api/probe`, flat
   schema of at most 16 identifier keys with known kinds). The legacy side runs the extracted specimen expression, exactly
   as `/api/resurrect` did.
2. Dedicated pool pair, one audit at a time: a concurrent request gets `429` with `code: "BUSY"`. Pools close with the server.

### R4. Type Alchemist (`src/crew/type-alchemist.ts`)
1. `FuzzOptions.observe` reports every evaluated input with both outcomes. With `collectObservations`, the orchestrator
   returns the inputs and legacy outcomes of the passing fuzz run.
2. `inferSignature(observations, schema)` infers parameter types (schema kinds; observed types for `json` parameters),
   the return type (primitives, `null`/`undefined`, unions up to 4 members, `T[]`, object shapes with optional fields,
   depth ≤ 4, otherwise `unknown`), and notes: integer/number range, signed 32-bit fit, `never returns NaN` /
   `may return NaN`, `Infinity`, `-0`, string length range, and how many inputs threw.
3. Types are structured data. Rendering produces the TS type, a JSDoc block (comment-safe), the pill text and a `.d.ts`
   declaration. A client-sent signature is validated (`TypeSignatureSchema`, depth limit) before it is used.
4. `generateResurrectionBundle({ typeSignature })` annotates the single-function `resurrected.ts` (typed parameters and
   return, JSDoc with `@param`/`@returns`/`@remarks`) and adds `types.d.ts`, which the `.zip` picks up. Without a
   signature, or when its parameters do not match the schema, the output is byte-identical to before.

### R5. UI and certificate
1. `/api/resurrect` (single-function mode) returns `typeSignature` and `typeSignatureText`. An "Inferred TypeScript
   Signature" pill sits right above the resurrected code.
2. A "Prove the Proof — Live Mutation Audit" card below the Resurrection Certificate, with the button
   "ATTACK MY OWN PROOF (RUN MUTATION AUDIT)", a kill-score badge (`5/5 MUTANTS KILLED · 100% PROOF STRENGTH`, crimson
   when anything survived) and a table of injected bugs, status pills and killing counterexamples.
3. After an audit, the certificate card shows the proof strength, the copied Markdown includes it, and the exported
   bundle's certificate gets a `Proof strength (mutation audit)` row (validated `{ killed, total }` from the client).

### R6. Tests
`src/crew/__tests__/mutation-audit.test.ts`, `src/crew/__tests__/type-alchemist.test.ts`,
`src/web/__tests__/mutation-route.test.ts`: valid, distinct mutants for `legacy-int-halve`, `stringHash32`,
`es5-ascii-checksum` and `quantizeClamp`; real kills with counterexamples; honest `SURVIVED` on equivalent and dead-code
mutants; primitive, union, array and object signatures; valid `.d.ts`; route validation, `429 BUSY`, under 3 s;
`npx tsc --noEmit`, full `npx vitest run`, no leaked Node processes.
