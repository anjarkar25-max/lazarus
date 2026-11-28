---
name: resurrect-legacy-js
description: Modernize legacy ES5 / CommonJS JavaScript (one file or a multi-file require() graph) into ES2022 and strict TypeScript with Lazarus, proving behavioural parity by exact Object.is differential fuzzing in an isolated sandbox. Use when asked to resurrect, modernize, migrate or port old JavaScript, var/prototype/require code, or to prove a refactor did not change behaviour.
---
# Resurrect legacy JavaScript with Lazarus

Lazarus never trusts a rewrite. It parses the legacy code (never executes it on the host), rewrites it with AST rules,
and accepts the result only when a differential fuzzer finds no input where the two disagree under exact `Object.is`
comparison. Follow these steps in order and report the real outputs; never claim parity that a run did not prove.

## Where Lazarus runs
- A Lazarus checkout (`git clone https://github.com/anjarkar25-max/lazarus && npm install`). The CLI and the web
  studio run from there. The Power's `lazarus-sandbox` MCP server needs it too: set `LAZARUS_HOME` to the checkout.
- The hosted studio: https://lazarus-yf0a.onrender.com (same HTTP routes as below).

## 1. Scan the specimen
- For a whole folder, start with `npm run audit -- <dir>` (`lazarus audit <dir>`, add `--json` for machine-readable
  output). It parses every `.js`/`.cjs` file without running it, flags `| 0` truncation traps, prototype chains, `var`
  / `arguments` usage and the `require()` graph, and prints a readiness score and the exact resurrect command.
  For GitHub Code Scanning use `npm run audit -- <dir> --sarif` (SARIF 2.1.0 on stdout) or
  `npm run audit -- <dir> --sarif --out report.sarif`. Rule ids: `LAZ001` bitwise truncation, `LAZ002` error-first
  callback, `LAZ003` prototype chain, `LAZ004` `var` / `arguments` hoisting, `LAZ005` circular or unresolvable
  `require`, `LAZ006` file that does not parse. The exported `.zip` PR bundles include
  `.github/workflows/lazarus-audit.yml`, which uploads the SARIF with `github/codeql-action/upload-sarif`.
  Mutually requiring modules (`a.cjs` <-> `b.cjs`) are resolved as ES module live bindings when you resurrect the folder.
  The audit also names the ES5 idioms Lazarus lifts: `Object.create(Parent.prototype)` inheritance (reported under `LAZ003`),
  `fn.apply(this, args)` forwarding (`LAZ004`) and `.then().catch()` Promise chains (`LAZ007`). A resurrection shows which AST
  rule did what in `ruleBlame` (applied or rolled back, with the legacy and resurrected lines and the counterexample).
- Read the code first. Note `var` scoping, `x | 0` truncation, `arguments`, `fn.apply`, loose `==`, constructor +
  `prototype` pairs, and `require()` / `module.exports` usage.
- Lazarus extracts the specimen with acorn and infers a fuzz schema from how parameters are used (`number` for
  arithmetic or bitwise use, `string` for string methods, `boolean` for logical flags). To see what it inferred
  without running anything: `POST /api/scan` with `{ "legacyCode": "<source>" }`.
- Only relative `require('./x')` calls inside the project can run. A `require('fs')` or any package is reported as an
  external dependency and the file cannot be resurrected as is; say so instead of stubbing it.
- To try one input in the sandbox (256 MB, 3000 ms, no network), call the MCP tool `run_legacy_probe` with
  `{ "code": "<expression or IIFE>" }`. It returns `returnValue`, `stdout`, `stderr` and metrics.

## 2. Resurrect and fuzz
- Single file: `npm run resurrect -- ./legacy.cjs --out ./resurrected-out` (add `--function <name>` when the file
  exports several, `--schema '{"n":"integer"}'` to override the inferred schema, `--runs <n>` and `--seed <n>` for a
  reproducible run).
- Multi-file project: `npm run resurrect -- ./legacy-dir --out ./resurrected-out` resurrects every `.js`/`.cjs`
  file as one dependency graph, leaves first, then fuzzes the stitched ES module graph end to end. `--entry <file>`
  picks the entry module; otherwise it is the root file that requires the others.
- In the studio: Tab 1 (`POST /api/resurrect`, streamed) or Tab 2, Multi-File Stitch Graph
  (`POST /api/resurrect-graph`), which also accepts dropped files and GitHub folder URLs.
- Parity is exact: `-0` vs `0`, `NaN`, `±Infinity` and `undefined` all count, and a throw on one side only is a
  divergence. Speculative rules
  (for example `x | 0` to `Math.trunc(x) || 0`, prototype to class) are kept only if the fuzzer agrees; a
  counterexample blames the rule, rolls it back, and the candidate is rebuilt and fuzzed again. Read
  [references/parity-invariants.md](references/parity-invariants.md) before you explain a rollback or hand-edit output.
- Exit codes: `0` parity proven, `1` not resurrected, `2` bad usage. On `1`, report the counterexample (inputs,
  legacy outcome, candidate outcome) exactly as printed.

## 3. Gate on the strict compiler
- The fuzz observations become parameter and return types in the exported `.ts`, which is checked in memory with the
  installed TypeScript compiler under `--strict`. The result is in `SPEC.md` and the certificate as
  `tsc --strict: N errors`.
- Accept only `tsc --strict: 0 errors`. Anything else is a failed resurrection, even with fuzz parity.

## 4. Export the PR bundle
- The CLI writes `resurrected.ts`, `resurrected.test.ts` (a fast-check parity suite), `SPEC.md` and
  `resurrection.patch` (plus `resurrected.mjs`, `legacy.cjs` and `resurrected.esm.test.ts` when the CommonJS to ESM
  conversion is exact). Directory mode writes `src/`, `legacy/`, the test, `SPEC.md`, a CI workflow and the patch, or
  nothing when parity fails.
- In the studio: EXPORT PR BUNDLE (`POST /api/export-bundle`) or Download .zip (`POST /api/export-zip`). Exports
  are disabled while the editor no longer matches the proven source; resurrect again first.
- Then run the `prove-the-proof` skill to show the fuzzer would have caught a broken rewrite.

## Report
State the specimen, the number of fuzz runs and attempts, which rules were kept or rolled back and why, the
`tsc --strict` result, and the files written. If parity was not proven, say so and show the counterexample.
