# Parity invariants

Lazarus compares the legacy and resurrected outcome of every fuzz input with `Object.is` on tagged values, so the
cases below are real differences, not formatting. Each section names the rule in `src/crew/ast-modernizer.ts` and
what the fuzzer must hold.

## Exact comparison
- `Object.is(-0, 0)` is `false` and `Object.is(NaN, NaN)` is `true`. `===` gets both wrong, so it is never the oracle.
- Values cross the sandbox boundary tagged (`{"$lazarus":"-0"}`, `NaN`, `Infinity`, `-Infinity`, `undefined`), so
  JSON serialization cannot hide them.
- A throw is an outcome too: if one side throws and the other returns, that input is a divergence. If both throw,
  the input counts as matching; the error type and message are not compared.
- Exact runs always mix in a boundary corpus (`src/fuzzer/differential.ts`):
  - `integer`: `0`, `-0`, `-1`, `1`, `2^31 - 1`, `-2^31`, `2^31`;
  - `number`: the integer values plus `NaN`, `±Infinity`, `±0.5`, `2^32` and `Number.MAX_SAFE_INTEGER`;
  - `string`: `""`, `" "`, `"0"`, `"-0"`, `"NaN"`, `"null"`, a NUL character, a non-ASCII character and a 40-character string.
- `NaN` and `±Infinity` are only probed when the schema says `number`. An `integer` parameter never receives them, so
  a proof over `integer` says nothing about those inputs.

## `-0`
- `x | 0` never yields `-0`: `(-0.5) | 0` is `0`.
- `Math.trunc(-0.5)` is `-0`, so a plain `Math.trunc` rewrite breaks parity on any negative fraction above -1.
- Lazarus rewrites `x | 0` to `Math.trunc(x) || 0`; `-0 || 0` is `0`.
- `-0` also shows up through `Math.round(-0.4)`, `0 * -1` and `-x` when `x` is `0`. An `|| 0` added by hand changes
  results for those inputs too, so let the fuzzer decide.

## `NaN`
- `NaN | 0` is `0` but `Math.trunc(NaN)` is `NaN`; `Math.trunc(x) || 0` maps `NaN` to `0` like the original.
- `undefined | 0` and `"abc" | 0` are `0` as well, through `ToInt32`.
- `NaN` breaks every comparison, so a rewritten guard such as `!(x > 0)` vs `x <= 0` differs exactly at `NaN`.

## 32-bit `| 0` overflow
- `x | 0` is `ToInt32`: it wraps modulo `2^32` into `[-2^31, 2^31 - 1]`. `(2 ** 31) | 0` is `-2147483648`.
- `Math.trunc(x) || 0` does not wrap, so it matches only for `|x| < 2^31` and differs for `±Infinity`
  (`Infinity | 0` is `0`). The rule is therefore speculative. It is kept only when the fuzz domain proves it safe, and
  a counterexample rolls it back to the original `| 0`.
- Hash and checksum loops (`h = (h * 31 + c) | 0`) depend on wrapping on every step. Expect the rule to be rolled
  back there and keep `| 0`.
- Parity is proven over the fuzz domain only. Say "verified over N fuzz runs", never "equivalent for all inputs".

## Prototype to class
- An ES5 constructor with `C.prototype.m = function () {}` members (or `C.prototype = { constructor: C, ... }`) can
  become a `class`. The rule is speculative and the fuzzer verifies it.
- Class methods are non-enumerable, while prototype assignments are enumerable. `for...in` over an instance and
  `Object.keys(C.prototype)` change, and the fuzzer catches it when the output depends on it.
- A class body is strict mode: assigning an undeclared variable throws, and `this` is `undefined` in a detached call.
  The rule refuses bodies that assign undeclared variables, `eval` or `arguments`.
- A class cannot be called without `new`. The rule refuses when the constructor is ever called as `C(...)`.
- The rule also refuses computed or duplicate members, arrow-function members, named function expressions, static
  members named `name`, `length`, `prototype`, `caller` or `arguments`, and a prototype literal that does not restore
  `constructor`. Refused code is kept as is and reported, not forced.
