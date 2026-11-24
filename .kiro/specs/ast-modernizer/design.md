# Design: AST Modernizer

## Files

| File | Role |
|------|------|
| `src/crew/ast-scope.ts` | Generic walker, scope analysis (bindings, references, read/write), expression type inference. |
| `src/crew/ast-modernizer.ts` | `modernize(source, config)`, rule implementations, `analyzeLegacy`, `refineCandidate`, config header codec. |
| `src/crew/esm-export.ts` | `toEsmModule(source)` CommonJS to ESM. |
| `src/crew/synthesizer.ts` | `DeterministicModernizer implements CodeSynthesizer`: attempt 1 uses defaults, later attempts refine from the counterexample. |
| `src/exporter/bundle.ts` | Optional `esmModule` input; statement-aware body formatting via the AST (falls back to the old text logic). |
| `src/web/server.ts`, `public/index.html` | Default 100 fuzz runs, cap 150. |

## Pipeline

```
source --acorn--> AST --rule 1--> AST --rule 2--> ... --astring--> code
                       (scope analysis is recomputed before each rule)
```

Order: `var-scoping`, `arguments-rest`, `apply-spread`, `function-arrow`, `bitor0-trunc`,
`loose-equality`. `var-scoping` runs first because it compares source positions, which only the parsed
nodes have; the later rules create nodes without positions. `arguments-rest` precedes `function-arrow`
(arrows cannot carry `arguments`), and `apply-spread` relies on the rest array that `arguments-rest`
introduces.

## Rule ladders

| Rule | Ladder | Risk |
|------|--------|------|
| `var-scoping` | `let-const` > `off` | safe by analysis |
| `bitor0-trunc` | `trunc-or0` (`Math.trunc(x) \|\| 0`: exact for `-0`, `NaN` and int32) > `off` | speculative |
| `function-arrow` | `arrow` > `off` | safe by analysis |
| `arguments-rest` | `rest` > `off` | safe by analysis |
| `apply-spread` | `spread` (also when the argument is only assumed to be an array, speculative) > `spread-proven` > `off` | speculative / proven |
| `loose-equality` | `strict-proven` > `off` | safe by inference |

## Scope analysis

- Scopes: program, function, block, catch. `var` and function declarations bind to the nearest
  function or program scope; `let`/`const`/`class` bind to the nearest block.
- References are every `Identifier` outside property keys, member properties, labels and declaration
  positions. Each is tagged read, write, or both (`+=`, `++`), and records its enclosing function.
- A `var` binding with several declaration sites (two `for (var i ...)` loops) is handled per site: each
  reference is assigned to the one site whose range contains it, and the ranges must be disjoint.

## Type inference (for `==` only)

Literals, `typeof`, comparison and `!`, `void`, `+x` (number), `>>>` (number), `String()`/`Number()`/
`Boolean()` on the unshadowed global, template literals, and arithmetic or bitwise operators with at
least one number-typed operand (mixing BigInt with number throws, so a result is a number). Everything
else is unknown, so the comparison stays loose and is reported.

## Counterexample-guided refinement

```
cfg = header config of ctx.previousCandidate, else defaults
repeat (bounded):
  candidate = modernize(legacy, cfg)
  if candidate matches legacy on counterexample inputs (sandbox probe): done
  if stepping exactly one rule down fixes it: take that step; culprit = that rule; done
  else step down the riskiest rule that changed the output; continue
fallback: all rules off (verbatim legacy)
```

"Matches" uses the same equivalence as the fuzzer (`areOutputsEquivalent`; both sides rejecting counts as a
match). The result header records the culprit and the ladder step, for example
`// ast-refine: rolled back bitor0-trunc (trunc -> off) ...`. A previous candidate that did not come from
these rules (the web demo's deliberate `Math.floor` draft) has no header, so refinement starts from the
defaults, which already match the counterexample.

## Export bundle

`toEsmModule` returns `{ code, exports, complete, notes }`. When complete, `resurrected.ts` is that module
(plus header), `legacy.cjs` is added to the bundle, and the generated test compares every export with the
legacy module through `createRequire`.

## Known limits

- The legacy specimen extractor (`scanLegacyAst`) is still regex-based and exposes one parameter; the
  modernizer itself handles arbitrary programs.
- `| 0` truncation is verified only over the fuzz domain (integers within 1e6). Values outside int32 are
  reported as a caveat, not proved.
- The default `Math.trunc(x) || 0` equals `x | 0` for `NaN`, `-0` and every int32 value. `+/-Infinity` and results beyond int32 still differ, which is why the rewrite stays speculative and rollback-able (the judge-playground probe card makes such inputs easy to try). Exorcist's own fuzz comparison remains JSON-level.
