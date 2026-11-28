# Requirements: V15 Compiler Depth

Three strictly additive compiler and explainability upgrades. For every requirement: no new top-level tab, no edit to any
Tab 3 Red-Team line of `public/index.html` (its three SHA-256 invariants stay unchanged), no new npm dependency, no
external API key, and no regression in the 1,066 existing tests. Existing presets resurrect exactly as before; every
existing field of every payload is preserved. Where an existing assertion encodes a value this spec changes (the spec
count, the SARIF rule list), the assertion is updated and listed in the final report.

## R1. Hardcore ES5 idiom and Promise-chain lifter (`src/crew/es5-idioms.ts`)

1. **Inheritance.** `Child.prototype = Object.create(Parent.prototype)` (with an optional `Child.prototype.constructor = Child`),
   a first statement `Parent.call(this, ...)` or `Parent.apply(this, arguments)` in the child constructor, and prototype
   members become `class Child extends Parent { constructor(...) { super(...); ... } ... }`. It is part of the existing
   `prototype-class` rule: a rollback of that rule turns it off together with the plain class lift.
2. **Scope-safe constructors.** A leading `if (!(this instanceof Foo)) return new Foo(<the same parameters>)` guard is dropped
   when every use of `Foo` is `new Foo(...)`, a `.prototype` access, a non-call reference, or a `Foo.call/apply(this, ...)`
   in a lifted child constructor. A bare call `Foo(x)`, `Foo.bind`, or a guard that forwards different arguments keeps the
   legacy function (a class would throw).
3. **`arguments` and `.apply()`.** `fn.apply(thisArg, array)` with a provably array argument and a side-effect-free `thisArg`
   becomes `fn.call(thisArg, ...array)`; `Parent.apply(this, arguments)` becomes `super(...arguments)`. This extends the existing
   `apply-spread` rule. `Array.prototype.slice.call(arguments)` and `arguments` loops keep using the existing `arguments-rest` rule.
4. **Promise chains.** A function whose last statement is `return X.then(h)`, `return X.then(h).catch(c)` or
   `return X.catch(c)` (handlers are function expressions or arrows with at most one identifier parameter, without
   `this`, `arguments`, `var` or nested function declarations) becomes an `async` function: `X` is evaluated before the `try`,
   the `then` handler body and `await` run in `try { ... }`, the `catch` handler body in `catch (err) { ... }`. Two-argument
   `then(a, b)`, longer chains and `finally` are left alone. Both settlements are verified by the existing async differential
   fuzzer (resolved values with `Object.is`, rejections by error name and message). When the chain cannot be lifted, the legacy
   body stays behind an `async` wrapper and `promise-async` is reported as rolled back.
5. **Presets (Tab 1 dropdown).** `legacySubclassMeter` (Object.create inheritance, a scope-safe constructor, `arguments` and
   `.apply()`) resurrects with exact parity and `tsc --strict: 0 errors`. `legacyPromiseChain` resurrects with both a resolved and
   a rejected path observed.
6. **Audit.** `lazarus audit` reports the new idioms as additional findings (`LAZ003` for Object.create inheritance, `LAZ004` for
   `apply` forwarding, new `LAZ007` for Promise chains) without changing any existing finding, count, or `LAZ001` to `LAZ006`.

## R2. Shrinking waterfall trace (`src/fuzzer/`, Tab 1 Causal Strip)

1. Every counterexample report gains an additive `shrinkTrace`: `{ initialFailure, steps, finalMinimal, totalShrinks }`.
   `initialFailure` and `finalMinimal` are `{ step, input, legacyOutput, modernOutput }` (text, `-0`/`NaN` preserved);
   `steps` holds at most 6 representative entries of the real failing sequence fast-check explored, including the first and
   last; `totalShrinks` is fast-check's own shrink count. A corpus (boundary) failure has one step and `totalShrinks` 0.
2. The Causal Strip's `Counterexample Caught` node gets a `Shrink Trace (N steps)` toggle. It opens an inline waterfall from the
   initial failing input down to the minimal killer, and is collapsed by default.

## R3. Interactive Rule Blame X-Ray

1. The Necromancer result carries `ruleBlame`: one entry per rule (`var-scoping`, `prototype-class`, `arguments-rest`,
   `apply-spread`, `function-arrow`, `bitor0-trunc`, `loose-equality`, plus `callback-async` and `promise-async` for async
   specimens) with `status` (`applied` or `rolled-back`), `legacyLines`, `resurrectedLines`, a one-sentence `reason`, and for a
   rollback a `counterexample` link (`attempt` and the failing input as text). Deterministic for a given input.
2. In Tab 1 the rule chips are keyboard-accessible buttons. Selecting one highlights its lines in the Legacy vs. Resurrected diff
   (green for applied, amber for rolled back) and shows a one-line X-Ray callout; selecting the active chip again clears both.

## R4. Verification

1. New suites: `src/crew/__tests__/es5-idioms.test.ts`, `src/fuzzer/__tests__/shrink-trace.test.ts`; extended
   `studio-ui.test.ts`, `kiro-dna.test.ts`, `kiro-power.test.ts`, `async-callback.test.ts`, `cli-audit.test.ts`.
2. `npx tsc --noEmit` exits 0; full `npx vitest run` is green; no leaked Node processes; no temporary test output files remain.
3. `#badgeSpecs` is `25 Kiro Specs`, `#badgeTests` is the exact final count, every task is ticked.
