# Requirements: Exact Exorcist and ES5 Prototypes

Closes two gaps: Exorcist compares JSON-level values (so `-0`, `NaN`, `Infinity`, `undefined` are
invisible), and the modernizer cannot lift ES5 constructor + prototype code into ES2022 classes. It also
makes multi-export CommonJS modules first-class from scanning through the bundle.

## Exact Exorcist

- **REQ-EX-01 Exact comparison.** `DifferentialFuzzer` sends inputs and receives outputs in the tagged
  encoding (`sandbox/tagged.ts`) and compares decoded values with deep `Object.is` semantics: `-0` differs
  from `+0`, `NaN` equals `NaN`, `NaN` differs from `null`, `Infinity`/`-Infinity`/`undefined` are distinct,
  and arrays and plain objects compare structurally. It is the default whenever both executors declare
  `supportsTaggedEncoding`; `FuzzOptions.exact` overrides it. Executors that do not declare support (plain
  `ProbeRunner`, test doubles) keep the JSON-level behaviour.
- **REQ-EX-02 Wire form.** Reports carry inputs and outputs in tagged form, so `-0` and `NaN` survive the
  JSON that reaches the browser. Plain values are unchanged, so existing consumers see the same data.
- **REQ-EX-03 Boundary corpus.** With exact mode and at least 50 runs, a deterministic boundary corpus runs
  first (per kind: `0`, `-0`, `-1`, `1`, `2147483647`, `-2147483648`, `2147483648`, plus `NaN`, `Infinity`,
  `-Infinity` for `number`; edge strings; edge JSON values including `undefined`). The remaining runs use a
  boundary-biased arbitrary mixing those constants with random values. Total runs equal the requested
  `numRuns`. Smaller runs use the unchanged arbitraries.
- **REQ-EX-04 Orchestrator seam.** `ResurrectionRequest.exact` is forwarded to the fuzzer. Its default stays
  JSON-level, because the existing orchestrator test treats plain `Math.trunc(n / 2)` as a valid repair and
  its seed draws `n = -1` (`-0` vs `0`). The web server, probe path, CLI and module resurrection set it on.
- **REQ-EX-05 Undefined inputs.** A tagged `undefined` input defines a global whose value is `undefined`
  (it is not deleted), so `x === undefined` behaves as written.
- **REQ-EX-06 Refinement uses the same wire form.** Counterexample replay sends tagged inputs and compares
  decoded outputs.

## Prototype to class

- **REQ-EX-07 Rule `prototype-class`.** A top-level ES5 constructor (`function C(...)` or
  `var C = function (...)`) with `C.prototype.m = function ...` members, `C.s = function ...` statics and an
  optional `C.prototype = { constructor: C, ... }` literal becomes `class C { constructor ... m ... static s ... }`.
  Non-function members stay as statements after the class. `C.prototype.constructor = C` is dropped.
- **REQ-EX-08 Safety.** The rule is skipped (and reported) when: the constructor is called without `new` or
  through `call/apply/bind`; `C.prototype` is used outside member assignments (inheritance); `C` is referenced
  before the class or between the declaration and its last member; `this instanceof C` guards exist; a
  prototype literal lacks `constructor: C`; members are duplicated, arrow functions, getters, or computed;
  or any method body would break in strict mode (undeclared assignment, `with`, duplicate params,
  `arguments.callee`, legacy octal, block-level function declarations).
- **REQ-EX-09 Speculative and rollback-able.** Class bodies are strict, methods become non-enumerable and the
  class cannot be called without `new`. The rewrite is therefore speculative: it is a named ladder
  (`class` > `off`); when Exorcist finds a counterexample, refinement blames and rolls back just this rule.
- **REQ-EX-10 Script specimens.** A file whose last statement is an expression and which has no CommonJS
  exports is a script specimen: the whole script is the runnable expression and its free variables become the
  inferred schema. This is how a class specimen is exercised (construct, call methods, read a result).

## Multi-export CommonJS

- **REQ-EX-11 Extraction.** `exports.a = ...; exports.b = ...`, `module.exports.x = ...`,
  `module.exports = { a: function, b() {} }` and `exports.a = a` / `module.exports = { a, b }` with declared
  functions each become a specimen with its own parameters, schema and runnable expression. Helper
  statements, and the declaration itself when other statements refer to it, are kept in each runnable.
- **REQ-EX-12 Module resurrection.** `resurrectModule` resurrects every exported function that does not use
  `this`, reports skipped ones with a reason, and combines rollbacks module-wide (the most conservative level
  per rule) so the ESM module honours every rollback.
- **REQ-EX-13 ESM and TypeScript output.** Declared functions that are exported become
  `export function name`; classes become `export class`; renamed exports use `export { a as b }`. The
  TypeScript bundle has one typed `export function` per export, a parity test per export, and the ESM file
  and test as before. The single-function bundle is byte-compatible with today.
- **REQ-EX-14 Presets.** Two curated presets: `legacyCounterClass` (prototype class script) and
  `cjsMathUtils` (multi-export module). Web `/api/resurrect` and `/api/probe` accept per-function schemas
  and a function name; `/api/export-bundle` accepts per-function results.

## Non-functional

- **REQ-EX-15** Strict TypeScript, no `any`, no `@ts-ignore`; legacy code only runs in the sandbox.
- **REQ-EX-16** All 284 existing tests pass unchanged; the full suite stays under 60 s; no leaked processes.
