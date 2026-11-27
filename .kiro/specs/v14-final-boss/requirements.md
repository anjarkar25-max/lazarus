# Requirements: V14 Final Boss

Three strictly additive upgrades. Constraints for every requirement: no new top-level tab, no edit to any Tab 3 Red-Team
line of `public/index.html`, no new npm dependency, no external API key, and no regression in the 995 existing tests.
Where an existing assertion encodes the old behavior that a requirement replaces, the assertion is updated and the
change is listed in the final report.

## R1. Circular CommonJS cycle resolver (Tab 2 + CLI)

1. `analyzeGraph` finds strongly connected components with Tarjan's algorithm, reports them in `cycles`, and lists the
   edges inside them in the new `cycleEdges`. A mutually recursive cycle between two or more modules is no longer a
   blocking problem. A module that requires itself still is (`circular require chain: x -> x`).
2. `order` stays deterministic: every dependency precedes its dependents, except inside a cycle, where the order is the
   depth-first post-order. The entry module is last.
3. `resurrectGraph` resurrects cyclic graphs. Each module is fuzzed with the legacy graph and the candidate side by side
   in the virtual file system (CommonJS partial-exports semantics are the oracle). Its ES module is generated with the
   export names of cycle partners that are not converted yet, and a changed export set later is an error, not a guess.
4. The emitted ES2022 modules use ordinary `import` / `export` declarations, so function bindings stay live and hoisted.
   Whole-graph parity links the ES graph in the sandbox with live exports: export getters are installed before the
   module's imports run and namespace objects read through them, so a cycle partner sees the real binding.
5. The typed project passes `tsc --strict` with 0 errors and the whole-graph `Object.is` fuzz passes.
6. `examples/legacy-circular-ledger/` (`index.cjs`, `tax.cjs` <-> `discount.cjs`) is a built-in Tab 2 preset.
7. Tab 2's SVG graph draws cycle edges in amber and shows a pill: `Cycle detected (resolves as ESM live bindings)` before
   a run and `Cycle Resolved (ESM Live Bindings)` after a successful one. Acyclic presets are unchanged.
8. The server's graph frames carry `cycleEdges`; the CLI and the `.zip` export work unchanged on cyclic projects.

## R2. SARIF 2.1.0 export and Code Scanning workflow

1. `lazarus audit <dir> --sarif` prints a SARIF 2.1.0 document (`$schema`, `version`, `runs[0].tool.driver` with rules,
   `runs[0].results`). `--out <file>` writes the report (SARIF, JSON or Markdown) to that file instead of stdout.
2. Rule ids: `LAZ001` bitwise truncation, `LAZ002` error-first callback, `LAZ003` prototype chain, `LAZ004` var / arguments
   hoisting, `LAZ005` circular or unresolvable CommonJS require, `LAZ006` file that does not parse.
3. Each result has `ruleId`, `ruleIndex`, `level` (high = error, medium = warning, info = note), a fix-oriented message,
   and one location with a relative `uri` (`uriBaseId` `%SRCROOT%`) and `startLine >= 1`. Output is deterministic.
4. The `.zip` PR bundles (single file and graph) contain `.github/workflows/lazarus-audit.yml`, which runs the audit
   and uploads the SARIF with `github/codeql-action/upload-sarif`.
5. `power-lazarus/skills/resurrect-legacy-js/SKILL.md` documents `npm run audit -- <dir> --sarif`.

## R3. Runtime performance parity proof

1. `src/crew/perf-parity.ts` benchmarks Legacy against Resurrected in the pooled sandbox: deterministic representative
   inputs built from the schema, warm-up, then batched timing medians, alternating sides. The timed work is capped well
   under 150 ms in total.
2. `POST /api/perf-parity` (zod strict body, single flight, dedicated pool) returns `{ iterations, legacyMedianUs,
   resurrectedMedianUs, legacyOpsPerSec, resurrectedOpsPerSec, ratio, verdict }`. `ratio` is legacy time divided by
   resurrected time; `verdict` is `faster` (ratio >= 1.10), `slower` (ratio <= 0.90) or `parity`. Numbers are measured,
   never invented. An error-first callback specimen returns `{ skipped: true, reason }`.
3. Tab 1 calls it asynchronously after a synchronous resurrection proves parity, and shows one `Perf Parity` chip next to
   the proof badges, for example `Perf: 1.12x · 3.4µs vs 3.8µs`. Async presets show a skip note. A newer run discards
   an older answer.

## R4. Verification

1. New tests: `src/crew/__tests__/circular-cjs.test.ts`, `src/crew/__tests__/perf-parity.test.ts`; extended
   `src/__tests__/cli-audit.test.ts`; spec-count assertions read 24; Tab 3 stays byte-identical.
2. `npx tsc --noEmit` exits 0; full `npx vitest run` is green with no leaked Node processes.
3. `#badgeSpecs` is `24 Kiro Specs`, `#badgeTests` is the exact final count, every task is ticked.