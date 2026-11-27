# Requirements: Async Callback Necromancer
## Introduction
Deterministic resurrection of Node.js error-first callback functions (`function fn(a, cb)` with `cb(err)` /
`cb(null, value)`) into `async function fn(a): Promise<T>` that `return value` and `throw err`, proven by differential
fuzzing of both outcomes inside the pooled sandbox.

Constraints:
- strictly additive: no new top-level tabs, no edits to Tab 3 (Red-Team) lines in `public/index.html`, no new runtime
  dependencies;
- every existing synchronous preset and test behaves exactly as before;
- legacy code still never runs on the host. Async probes run in the same pooled worker (256 MB heap, 3000 ms
  watchdog, network and file-system shims) under the same vm time budget.

Decisions where the request leaves room:
- **Deferred tails.** A deferred success or error at the end of a function (`setTimeout(fn, ms)`, `setImmediate(fn)`,
  `process.nextTick(fn)`, `queueMicrotask(fn)`, `Promise.resolve().then(fn)`) is unwrapped: the deferral only changes
  timing, and an `async` function already settles asynchronously. The resurrected code has no timers.
- **Synchronous throws.** A synchronous throw from the legacy function (instead of calling `cb`) counts as a
  rejection, because that is what a caller sees when it awaits the promisified function.
- **Parity scope.** Parity is decided on the first settlement: the first `cb` call, or the promise's settlement.
  Later `cb` calls are ignored by the harness, as `util.promisify` would ignore them.
## Requirements
### R1. Detection and deterministic lift (`src/crew/async-callback.ts`)
1. `detectErrorFirst(source)` parses with acorn and never executes. A function is error-first when all of these hold:
   - it is a top-level declaration, `var f = function`, or `module.exports` / `exports.x` / `module.exports.x =
     function`;
   - its last parameter is an identifier;
   - every use of that identifier is a direct call `cb(...)` with at most two arguments, or a pass-through as the last
     argument of a call to another error-first function of the same module;
   - at least one call signals success (`cb(null, v)`, `cb(undefined, v)`, `cb()`) or an error (`cb(new Error(...))`,
     `cb(err)`).

   It reports the entry function (the exported one, otherwise the last error-first function), its parameters without
   the callback, every error-first helper, and the reason when a function is not liftable.
2. `liftErrorFirst(source)` rewrites with acorn and astring:
   - `return cb(null, v)` and `cb(null, v)` become `return v`;
   - `cb(new E(...))` becomes `throw new E(...)`;
   - `cb(x, v)` with a run-time error value becomes `if (x != null) throw x; return v;`;
   - a tail deferral wrapping a callback call is unwrapped (see Introduction);
   - a tail call `g(args, function (err, res) { if (err) return cb(err); REST })` to an error-first helper becomes
     `const res = await g(args); REST`;
   - `g(args, cb)` becomes `return await g(args)`;
   - every error-first function loses its callback parameter and becomes `async`. Everything else is left untouched.
3. It refuses (with a reason, never a guess):
   - `cb` used as a value;
   - `cb` called inside a `try` block or inside a nested function other than the patterns above;
   - a deferral or nested callback that is not in tail position;
   - an `err` name used outside its guard;
   - code that does not parse.
4. The lifted module and a typed TypeScript module are both produced:
   - the TypeScript module has `export async function fn(a: T, ...): Promise<R>`;
   - parameter types come from the fuzz schema;
   - `R` is observed from the resolved values (Type Alchemist);
   - helpers are left to the existing strict-mode boundary fixes.
### R2. Async differential parity in the pooled sandbox (`src/sandbox/`, `src/fuzzer/`)
1. `ProbeParams.settle: true` makes the vm executor settle a promise the probe returns. Executors that can do this
   declare `supportsSettle` (the vm executor and the pooled runner do).
2. A settling probe uses `microtaskMode: "afterEvaluate"`, so promise jobs run inside the vm time budget. It also
   gets deterministic virtual timers (`setTimeout`, `setImmediate`, `clear*`, `queueMicrotask`,
   `process.nextTick`). These are implemented inside the context, so no host function ever reaches probe code.
   - The executor alternates "drain microtasks" and "run the next timer" until the promise settles.
   - A probe that never settles is a `TIMEOUT` error ("callback never called"). So is a probe that runs out of the
     2800 ms budget or schedules more than 10 000 timers.
   - The pool's 3000 ms watchdog stays the hard limit.
3. The legacy harness calls `fn(...args, cb)` and records the first settlement:
   - `{ settled: "resolve", value }` for `cb(null, v)`;
   - `{ settled: "reject", error: { name, message } }` for `cb(err)` or a synchronous throw.

   The modern harness awaits `fn(...args)` into the same envelope. The existing exact `Object.is` comparison (tagged
   `-0`, `NaN`, `undefined`, deep objects and arrays) then decides parity on both paths. A rejection matches only
   with the same error name and message.
4. `FuzzOptions.settle` passes the flag to every probe. The report counts resolved and rejected legacy outcomes
   (`asyncOutcomes`).
5. `runMutationAudit` accepts `asyncHarness`: mutants of the async code are wrapped in the modern harness and fuzzed
   with `settle`. `/api/mutation-audit` uses it when the legacy code is error-first and the modern code is the lifted
   async module.
### R3. Pipeline integration
1. `ResurrectionOrchestrator.resurrectErrorFirst(request)` runs the Crew on an error-first source:
   - Archaeologist: detection;
   - Architect: spec;
   - Necromancer, in a self-healing ladder:
     - attempt 1 is the lift plus the existing AST modernizer;
     - attempt 2 is the plain lift;
     - attempt 3 is a `new Promise` wrapper around the untouched legacy function;
   - Exorcist: async parity fuzzing.

   It returns a `ResurrectionResult` with an `asyncCallback` summary. The synchronous `resurrect()` is unchanged.
2. `/api/resurrect` routes an error-first source to `resurrectErrorFirst`. The callback parameter is dropped from the
   schema, and missing parameters are taken from the scanner. Every other source takes the existing path unchanged.
   The result carries the strict TypeScript check, the certificate and the typed signature like the sync path.
3. `/api/export-bundle` and `/api/export-zip` produce an async bundle for an error-first source with an async modern
   module:
   - `resurrected.ts` (async, typed, checked with `tsc --strict`);
   - `resurrected.test.ts`: an async Vitest + fast-check parity suite over both outcomes;
   - `legacy.cjs`, `SPEC.md`, the CI workflow and the patch.
4. Tab 1 gets the preset `legacyReadConfigCb`, an error-first config reader with a nested helper and a deferred
   tail. For async results the Probe card and the Naive AI comparison are hidden (both are synchronous tools), and an
   async note shows the resolved and rejected counts.
5. `lazarus audit` reports `error-first-callback` findings (`medium`), naming the callback parameter and whether the
   function is liftable.
### R4. Tests and verification
1. `src/crew/__tests__/async-callback.test.ts` covers:
   - detection and lift cases, and refusals;
   - success-path `Object.is` parity and error-path name/message parity;
   - counterexamples for an async rewrite that swallows an error or returns a wrong value;
   - the virtual timers, and a callback that is never called (TIMEOUT);
   - `legacyReadConfigCb` end to end: `tsc --strict` 0 errors, a zip export, under 3 s;
   - no leaked timers or worker processes.
2. `npx tsc --noEmit` exits 0, the full `npx vitest run` passes, and no Node processes leak. The badges read
   `22 Kiro Specs` and the exact final test count.
