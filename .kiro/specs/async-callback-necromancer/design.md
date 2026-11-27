# Design: Async Callback Necromancer
## Sandbox (`vm-executor.ts`)
- `settle !== true`: the existing path, unchanged.
- `settle === true`:
  - The context is created with `microtaskMode: "afterEvaluate"`.
  - A second bootstrap installs `__lzt`, a closure-private timer queue ordered by `(due, seq)` with a virtual clock.
    It also defines the timer globals and `process.nextTick`.
  - `__lz.watch(p)` attaches context-side `then` handlers that store the settled value or error.
  - `__lz.poll()` returns `"pending"`, `"resolved"` or `"rejected"`. `__lz.tick()` runs the next timer and returns
    whether there was one.
  - The executor runs the probe, then `watch`, then loops `poll`/`tick`. Each step is a `runInContext` with the
    remaining budget, and microtasks drain after each evaluation inside that budget.
  - A resolved probe returns its value through the existing (tagged) stringify. A rejected probe throws
    `EXECUTION_ERROR` with the described error, the same as a synchronous throw.
- `validate.ts` accepts `settle` (a boolean). `PooledProbeRunner` and `VmProbeExecutor` declare `supportsSettle`.
## Harness envelopes (`async-callback.ts`)
- `buildLegacyHarness(source, entryRef, params)` builds an IIFE with a CommonJS shim (`module`, `exports`).
  - It evaluates the source, then calls the entry function with the parameter globals and a context-side callback.
  - The callback settles once: `{ settled: "resolve", value }` when `err == null`, otherwise
    `{ settled: "reject", error: { name, message } }`.
  - A synchronous throw rejects too.
- `buildModernHarness(modernJs, entryName, params)` does the same for `entryName(...params)`, using
  `Promise.resolve(call).then(...)`.
- Error description: `name` comes from `e.name` (string) or the value's type, and `message` from `e.message` (string)
  or `String(e)`. Both are read in the context only.
## Lift
- Detection walks the top-level statements. A reference walk with scope tracking is avoided: a nested function or
  variable that redeclares the callback name makes the function not liftable.
- `transformBlock(stmts, ctx)` handles the statements in order. Patterns are allowed only in tail position
  (`index === stmts.length - 1`), except `return cb(...)` and `cb(...)` statements, which end execution in the lifted
  code (first-settlement semantics).
  - `if`, `switch`, loops and labelled blocks are entered recursively.
  - `try` and nested functions that mention the callback are refused.
- After the rewrite, a full walk checks that no reference to any removed callback name is left. If one is, the
  function is not liftable.
- The entry function is normalized to a declaration, so the TypeScript module can `export` it.
  `module.exports = name` lines are dropped from the TypeScript output.
## Self-healing ladder (`resurrectErrorFirstWith`)
- Each candidate is fuzzed against the legacy harness with
  `{ exact: true, boundary: true, settle: true, numRuns, seed }`.
- On a counterexample, a `counterexample_found` event is emitted and the next candidate is tried. The ladder is:
  1. lift plus `modernize`;
  2. plain lift;
  3. `new Promise` wrapper.
- On success, the Type Alchemist infers the return type from the resolved legacy values (observations whose envelope
  resolved).
## Export
- `src/exporter/async-bundle.ts`:
  - `renderAsyncTypescript(lifted, signature)`, with types on the entry function only;
  - `generateAsyncVerifiedBundle(input)`: `verifyStrictTypeScript` plus `applyBoundaryFixes`, widening the return type
    to `unknown` if the observed type fails. It returns the same `VerifiedBundle` shape, so the zip and the
    certificate reuse the existing code.
- The test file loads `legacy.cjs` through `createRequire`, promisifies it, and compares the envelopes with a
  recursive `Object.is` equality over `fast-check` inputs.
## UI
- The preset is added to `presets`. The schema excludes `cb`.
- A small new script (before `lz-stale`) handles async results: on `lazarus:result` with `r.asyncCallback` it hides
  `#probeCard` and the naive button, and shows `#asyncNote`. On `lazarus:run-start` it restores them.
- The V12 naive script ignores async results (one condition).
