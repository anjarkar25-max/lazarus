# Requirements: Judge Playground

Goal: let a judge (or developer) throw arbitrary legacy modules and adversarial inputs at Lazarus and
see, with `Object.is` precision, whether the resurrected code behaves identically. Covers a real AST
specimen extractor, a live probe endpoint and UI, a self-healing matrix, and a local CLI.

## Specimen extraction

- **REQ-JP-01 AST extractor.** `scanLegacyAst` parses with `acorn` instead of regexes. It finds top-level
  function declarations, `module.exports = function/arrow`, `exports.x = ...`, `module.exports.x = ...`,
  `module.exports = { ... }` members and `var f = function` helpers, and returns every parameter (source
  text and bare name), kind, export name, line and `this`/`arguments` use.
- **REQ-JP-02 Idioms from the AST.** Detected idioms come from syntax, not text, so strings and comments
  never match. Existing idiom labels stay; new ones: `.apply()` calls, loose equality, prototype assignment.
- **REQ-JP-03 No lost parameters.** The runnable expression calls the chosen function with all of its
  parameters (each guarded with `typeof p !== "undefined"`). Helper statements in the module are kept so
  helper calls resolve. Single `return expr` / `var x = e; return x` bodies still reduce to the bare
  expression, as before.
- **REQ-JP-04 Compatibility.** The result keeps `functions`, `primaryExpression` and `detectedIdioms` with
  the same meaning, and all existing `bundle-exporter` tests pass unchanged. Unparsable input degrades
  to the old text behaviour and reports `parsed: false`.
- **REQ-JP-05 Input schema inference.** A suggested fuzz schema is inferred from how each parameter is used
  (string methods, array methods, otherwise integer).

## Probe endpoint and card

- **REQ-JP-06 `POST /api/probe`.** Body `{ legacyCode, modernCode, context }`, validated with `zod` (bounded
  sizes, string-keyed context, unknown keys rejected). Both sides run in the pooled sandbox (256 MB, 3000 ms)
  and the response is `{ legacy, modern, exactParity }`. Invalid payloads get HTTP 400 with the offending
  paths. `legacyCode` goes through the same specimen extractor as `/api/resurrect`.
- **REQ-JP-07 Exact value fidelity.** Parity uses `Object.is` semantics: `-0` differs from `+0`, `NaN`
  equals `NaN`. Because JSON cannot carry `-0`, `NaN`, `Infinity` or `undefined`, probes use a tagged
  encoding (`{"$lazarus":"-0"}` etc.) in both directions between the browser, the RPC layer and the vm. The
  default JSON behaviour of every existing caller is unchanged.
- **REQ-JP-08 Probe card.** Below the resurrection output: one editable field per schema key, quick chips
  (`-1`, `-0`, `0`, `2147483648`, `NaN`, `""`), a PROBE button, side-by-side Legacy / Resurrected values with
  timings, and a parity badge that names the reason on a mismatch.

## Self-healing matrix

- **REQ-JP-09 Matrix.** When a run needed more than one attempt, or an AST rule was rolled back, the results
  panel shows the rejected Attempt 1 draft beside the final verified code, the shrunk counterexample
  (input, legacy output, draft output), the blamed rule and the rules that stayed active.
- **REQ-JP-10 Existing exporter intact.** The PR bundle tabs (including ESM), Copy File and Download
  buttons keep working. Layout stays three columns on desktop and laptop widths and stacks below 1024 px.

## Exactness of the default rewrite

- **REQ-JP-11 Sign of zero.** Because the probe card makes `-0` observable, the default `| 0` rewrite must
  not introduce `-0` or `NaN` differences: it becomes `Math.trunc(x) || 0`. The remaining caveat
  (infinities and values beyond int32) stays flagged speculative and refinable.

## CLI

- **REQ-JP-12 `npm run resurrect`.** `npm run resurrect -- ./file.cjs --out ./dir` resurrects a local
  `.js`/`.cjs`/`.mjs` file through the sandbox and writes `resurrected.ts`, `resurrected.test.ts`,
  `SPEC.md` and `resurrection.patch` (plus ESM files when the conversion is exact). Options: `--schema`,
  `--runs`, `--seed`, `--name`, `--function`. Exit 0 only when parity is proven; on divergence nothing is
  written and the counterexample is printed.
- **REQ-JP-13 Multi-parameter bundles.** The generated TypeScript, parity test and diff handle every schema
  parameter, not only the first.

## Non-functional

- **REQ-JP-14** Strict TypeScript, no `any`, no `@ts-ignore`. Legacy code is never executed outside the
  sandbox. 223 existing tests keep passing.
