# Design: Exact Exorcist and ES5 Prototypes

## 1. Exact Exorcist

```
fuzz inputs (real values, may hold -0 / NaN / Infinity / undefined)
   -> encodeTagged -> executor.run({ code, context, encoding: "tagged" })
   -> output (tagged wire form) -> decodeTagged -> areOutputsEquivalent (deep Object.is)
```

- `ProbeExecutor.supportsTaggedEncoding?: boolean`; set on `PooledProbeRunner` and `VmProbeExecutor`.
- Reports hold the wire form (`encodeTagged(value)`): plain values are unchanged, specials become
  `{"$lazarus": ...}` markers that survive JSON and that the UI already renders. Mismatch reasons are built
  from decoded values with `describeValue` and name the difference (`sign of zero differs`, `NaN vs null`).
- Boundary corpus (`buildBoundaryCorpus`): run i takes `list[(i + j) % len]` for parameter j, so every constant
  of every parameter appears once in the first `max(len)` runs. It runs before `fc.check`, counts towards
  `numRuns`, and is skipped below 50 runs or when not exact. A corpus failure is reported immediately (corpus
  values are already minimal). Random runs use `fc.oneof(3 x base, 1 x boundary constants)` per parameter.
- The vm bootstrap decodes tagged input recursively (own function, no `JSON.parse` reviver) so a tagged
  `undefined` stays a defined global.
- `refineCandidate` replays the counterexample with tagged inputs and compares decoded outputs.
- Seam: `ResurrectionRequest.exact?: boolean` (default JSON-level, to keep the orchestrator's existing
  contract). Web, probe, CLI and `resurrectModule` pass `true`.

## 2. Rule `prototype-class`

Runs second (after `var-scoping`, which needs original positions; the rule also reads positions). Top-level
statements only.

```
function C(a) { this.n = a; }              class C {
C.prototype.inc = function (s) {...};   =>   constructor(a) { this.n = a; }
C.create = function (a) {...};               inc(s) {...}
C.LIMIT = 10;  (data stays)                  static create(a) {...}
                                           }
                                           C.LIMIT = 10;
```

Skipped for: calls without `new`, `.call/.apply/.bind`, any `.prototype` use outside member assignments,
references before the class or inside the member span, `this instanceof C`, prototype literals without
`constructor: C`, duplicate / arrow / getter / computed members, and strict-mode hazards (see requirements).
Member comments move onto the generated `MethodDefinition` nodes (which copy the statement's position) so they
are reprinted in place. Ladder `class` > `off`, speculative, named in `ast-rules` headers and in `RISK_ORDER`.

## 3. Multi-export modules

- **Scanner:** a candidate defined by a named statement (declaration or `var f = function`) is called by name
  with its whole statement list as the preamble when any other statement refers to it (needed for
  `C.prototype.x = ...`); otherwise it is inlined as before. Constructor-like specimens (a prototype member
  exists) are instantiated with `new`. `schema inference` handles script free variables.
- **`resurrectModule`** (`crew/module-resurrection.ts`): one `ResurrectionOrchestrator.resurrect` per
  exported function (`exact: true`), events tagged with the function name, combined rule levels = per-rule
  maximum of each result's `ast-rules` header, `toEsmModule(source, { levels })`.
- **`esm-export`:** `exports.add = add` with a declared function/class becomes `export function add` /
  `export class` (or `export { local as name }` when renamed) instead of failing the top-level binding check.
- **Bundle:** `functions?: [{ name, exportedAs, schema, legacyCode, modernCode }]` renders one typed
  `export function` and one parity `describe` per function; without it the single-function output is unchanged.
- **Web:** `schema` may be flat (single specimen) or nested per function name. A multi-export result keeps the
  aggregate fields the UI already reads and adds `module.functions[]`; the UI shows a function picker for the
  probe card and sends `functions` on export.

## Limits

- Inheritance patterns, accessor properties and prototype literals without `constructor` are left as written.
- Class specimens need a driver expression (script form) to be exercised beyond `new C(...)`.
- The module combine rule is conservative: one rolled-back rule is rolled back for every function.
