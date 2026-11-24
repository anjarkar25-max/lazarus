# Design: Judge Playground

## Specimen extractor (`src/sandbox/ast-scanner.ts`)

```
source --acorn--> Program
  idioms:   one walk over the AST (var, `| 0`, Math.floor, CJS exports, charCodeAt, arguments, apply, ==, prototype)
  functions: top-level declarations, CJS assignments, object-literal exports, `var f = function`
  primary:  first exported function, else first function
  runnable: simple return/var-return body -> bare expression (only when nothing else is in the module)
            otherwise  (fn)(guarded args)  or  (function(){ <helpers> return (fn)(args); })()
```

A guarded argument is `typeof p !== "undefined" ? p : undefined`, so inputs the caller does not supply
become `undefined` and default parameters still fire. Schema inference walks the function body and maps
parameter usage to a kind: string methods and `typeof p == 'string'` give `string`; array methods give
`json`; everything else gives `integer`.

## Tagged values (`src/sandbox/tagged.ts`)

`{"$lazarus": "NaN" | "Infinity" | "-Infinity" | "-0" | "undefined"}` stands in for values JSON drops.
`ProbeParams.encoding = "tagged"` switches the vm executor to a tagged reviver (inputs) and replacer
(outputs), both created inside the vm context so no host object leaks in. Everything else is untouched:
without `encoding` the executor behaves exactly as before.

## `POST /api/probe`

```
browser --{legacyCode, modernCode, context(tagged)}--> zod --> scanLegacyAst(legacy).primaryExpression
   legacyPool.run({code, context, encoding:"tagged"})  ||  modernPool.run(...)    (two warm workers, server scoped)
   decodeTagged(outputs) --> areOutputsEquivalent (Object.is) --> { legacy, modern, exactParity, reason }
```

Pools are created lazily and closed when the HTTP server closes. Each side reports `ok`, a display string
(`-0`, `NaN`, `undefined`, JSON), the tagged output, an error code and the duration.

## UI

- Middle column, in order: spec, modern code, **Self-Healing Matrix** (only when `attempts > 1` or a rule was
  rolled back), PR bundle, **Probe Custom Edge Case**.
- Matrix data comes from the SSE `events` already sent: first `code_synthesized` (rejected draft),
  `counterexample_found` payload (shrunk input, legacy output, draft output, reason) and the final code's
  `// ast-rules:` / `// ast-refine:` header lines (blamed and rolled-back rules).
- Probe inputs are parsed by a tiny literal parser: `NaN`, `-0`, `Infinity`, `-Infinity`, `undefined`
  become tagged values; everything else is JSON, falling back to a string.
- Grid is `0.9fr / 1.45fr / 1fr`; below 1024 px the columns stack; the matrix and probe card wrap with
  `auto-fit` columns so they stay readable at laptop widths.

## Default truncation

`bitor0-trunc` ladder is now `trunc-or0` > `off`. `Math.trunc(x) || 0` equals `x | 0` for NaN, `-0` and every
int32 value; only infinities and results beyond int32 differ, and those stay flagged speculative.

## CLI (`src/cli.ts`)

`main(argv, io)` is a pure function over arguments and an io object (testable), `npm run resurrect` runs it
with the process streams. Flow: read file (256 KB cap) -> `scanLegacyAst` -> schema (flag or inferred) ->
`ResurrectionOrchestrator` (sandboxed, pooled) -> on success `generateResurrectionBundle` ->
write files. `bundle.ts` gains `legacySource` (original text for diff and `legacy.cjs`) alongside the
runnable `legacyCode`, and builds signatures and tests from all schema entries.

## Known limits

- The runnable expression keeps helper statements but cannot satisfy `require()` inside the sandbox; such
  modules fail on both sides and are reported, not guessed.
- Tagged markers collide with real data shaped exactly like `{"$lazarus": "NaN"}`.
- Exorcist's fuzz comparison remains JSON-level; the probe card is the Object.is-exact view.
