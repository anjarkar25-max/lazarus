# Design: V15 Compiler Depth

## es5-idioms.ts
Pure acorn/astring helpers. It imports only types from `ast-modernizer.ts` (no runtime cycle); `ast-modernizer.ts` imports it.
- `scopeGuardOf(decl)`: finds the leading guard and whether it forwards exactly the constructor's parameters.
- `inheritanceOf(statement)`: `X.prototype = Object.create(P.prototype)` -> `P`.
- `superCallOf(decl, parent)`: the first statement `P.call(this, ...)` / `P.apply(this, arguments)` -> the `super(...)` arguments, or a reason.
- `liftApplyToCall(analysis, applied)`: `f.apply(t, array)` -> `f.call(t, ...array)` for provable arrays and simple receivers.
- Promise chain: `detectPromiseChain`, `liftPromiseChain`, `buildPromiseHarness`, `resurrectPromiseChainWith` (same shape as the
  error-first pass: candidates `lift+modernize`, `lift`, `promise-wrapper`, fuzzed with `settle`).
`planPrototypeClass` accepts the Object.create statement and returns `superClass`. `rulePrototypeClass` skips the planned guard in
its reference check, and `convertToClass` emits `extends`, `super(...)`, and drops the guard. Existing programs without those idioms
take exactly the old code path.

## Fuzzer shrink trace
`evaluate` appends every failing evaluation to `failureLog`. fast-check adopts each failing shrink candidate, so the log after the
first failure is the real shrink path. `buildShrinkTrace` picks at most 6 evenly spaced entries (first and last included) and formats
them with the exact-value formatters. It is attached as `counterexample.shrinkTrace`.

## Rule blame
`modernize()` records for each applied rewrite the node it rewrote (WeakMap) and, while printing, the output line of every node
(wrapped astring generator), exposed as additive `resultLines`. `computeRuleBlame(legacy, modernCode, counterexamples)` in
`rule-blame.ts` reads the final `// ast-rules:` header, re-runs `modernize` at those levels (applied rules: legacy line and
resurrected line) and at the default levels (rolled-back rules: legacy lines; resurrected lines by locating the unchanged text),
and ties each rollback to the counterexample named in the `// ast-refine:` note. The orchestrator attaches the result as
`ruleBlame`; the two async passes attach `callback-async` / `promise-async` entries.

## UI
`lzCausalNodes` adds `shrink` to the counterexample node; `renderCausalStrip` builds the toggle and a waterfall element below the strip.
`lz-xray` is a pure region (`lzXrayMarks`) plus DOM glue: chips are `<button>`s, the Legacy diff opens on demand, rows get
`xray-applied` / `xray-rolled` classes, one callout line shows the reason.

## Audit
`FindingKind` gains `inheritance-chain` (LAZ003), `apply-forwarding` (LAZ004), `promise-chain` (new LAZ007). `SARIF_RULES` appends LAZ007.
