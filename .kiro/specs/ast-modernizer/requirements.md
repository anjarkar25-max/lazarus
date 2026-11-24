# Requirements: AST Modernizer (Necromancer upgrade)

Goal: replace the regex-based `DeterministicModernizer` with a real AST-to-AST ES5/CommonJS to
ES2022 modernizer that needs no LLM or API key, keeps the existing self-healing loop intact, and
learns from Exorcist counterexamples.

Parsing and printing use `acorn` and `astring` (runtime dependencies). Types come from `@types/estree`.

## Transformations

- **REQ-AM-01 var scoping.** `var` becomes `const` (never reassigned, has an initializer) or `let`.
  A declaration is converted only when every reference to the binding lies inside the block or `for`
  statement that holds the declaration and after it, so hoisting, redeclaration and function-scope
  semantics cannot change. It is left alone when: a closure captures a variable declared in or
  looping with a loop; a loop-body `var` has no initializer; the name is also a parameter, function
  declaration or catch parameter; the declaration sits in a `switch` case or a bare statement
  position; the program uses `eval`/`with`; or a program-level `var` could be read through the global
  object (`this`, `globalThis`, `window`, `self`, `global`).
- **REQ-AM-02 Truncation.** `x | 0` becomes `Math.trunc(x)`. `Math.trunc` differs from `| 0` for
  NaN, Infinity, values outside int32 and `-0`, so this rewrite is classed **speculative**: it is
  applied by default, reported as speculative with its domain caveat, and always subject to Exorcist
  verification. Operands that are already int32 (`a | b`, `a & b`, `a ^ b`, `~a`, `a << b`, `a >> b`) and
  integer literals are classed safe. A constructor option turns speculative truncation off.
- **REQ-AM-03 Arrow functions.** Function expressions become arrows only when the body never
  references `this`, `arguments`, `super` or `new.target`, the function is anonymous, non-generator,
  non-async, has plain unique identifier parameters and no `"use strict"` directive, and its use cannot
  be as a constructor (call argument, IIFE callee, or a variable that is never `new`-ed and whose
  `.prototype` is never touched).
- **REQ-AM-04 Rest parameters.** A function whose only `arguments` uses are reads of `.length`,
  `[i]`, `Array.prototype.<safe method>.call(arguments, ...)` and `.apply(x, arguments)` becomes
  `(...args)`, with a collision-free name. Functions with named parameters are converted only for the
  `slice.call(arguments, k)` idiom where `k` equals the parameter count. Writes to `arguments`, `.callee`,
  escapes such as `g(arguments)`, `eval` and shadowing all block the rewrite.
- **REQ-AM-05 Spread.** `f.apply(thisArg, arr)` becomes `f(...arr)` only when `arr` is provably an
  array and either `f` ignores `this` (`Math.*`, `String.fromCharCode`, local `this`-free function with
  a null/undefined `thisArg`) or `thisArg` is textually the receiver (`o.m.apply(o, arr)`).
- **REQ-AM-06 Equality.** Loose `==`/`!=` is always reported in metadata. It is tightened to
  `===`/`!==` only when both operand types are inferred and identical. `x == null` is never tightened.
- **REQ-AM-07 Modules.** `toEsmModule()` converts CommonJS `exports.f = ...`, `module.exports.f = ...`,
  `module.exports = function`, `module.exports = { ... }` and simple `require` calls into ESM
  `export`/`import`. Anything it cannot convert exactly is left as CommonJS and reported
  (`complete: false`). The PR bundle uses it when a conversion is complete.

## Self-healing

- **REQ-AM-08 Rule ladders.** Each rule has an ordered ladder ending in `off` (verbatim). Applied rule
  levels are stored in the candidate header (`// ast-rules: ...`) so refinement is stateless.
- **REQ-AM-09 Counterexample-guided refinement.** With `ctx.counterexample`, Necromancer re-runs the
  counterexample inputs through the sandbox, finds the rule whose step down the ladder makes the
  candidate match the legacy outcome, applies only that step, and records the culprit in an
  `// ast-refine:` header line. If no single rule fixes it, it steps down the riskiest applied rule and
  repeats; the end state is verbatim legacy code. Exorcist re-verifies the result.
- **REQ-AM-10 Compatibility.** `DeterministicModernizer` keeps its name and `CodeSynthesizer`
  interface. The existing orchestrator and web self-healing tests pass unchanged.

## Non-functional

- **REQ-AM-11 Safety.** Legacy code is only parsed, never executed, by the modernizer. Refinement runs
  candidates through `PooledProbeRunner`. Parse errors return the legacy source unchanged with a
  `parse-failed` marker. Comments are preserved where `astring` can attach them.
- **REQ-AM-12 Live depth.** The web server and UI default to 100 fuzz runs (cap 150) and a full
  resurrection stays under 3 seconds.
- **REQ-AM-13 Typing.** Strict TypeScript, no `any`, no `@ts-ignore`.
