# Design: V18 Product Flagship
## Purity (`src/crew/purity-audit.ts`)
- `leakSites(analysis, inputs)` is the one place that decides what a leak is: unresolved write references whose nearest function
  scope is a function, minus inputs and host names. It also decides whether a site is fixable (first reference is a top-level
  `name = expr;` of the function body, right side does not read the name, all references inside that function). The modernizer
  rule, the static `detectGlobalLeaks` and the SARIF finding all use it.
- `auditPurity(...)` runs wrapper probes through the same `ProbeExecutor` the fuzzer uses. Each probe indirect-evals the code in a
  fresh vm context and returns only strings and booleans: tagged deep serialization of every input before and after, the new own
  names on `globalThis`, the thrown message, and prototype key signatures. Legacy runs sloppy, the resurrected code runs sloppy
  (global diff) and strict (ReferenceError check). Declared top-level names are subtracted from the global diff.
- Opt-in on the orchestrator (`purityAudit: true`, set by the Studio), so existing orchestrator tests and probe counts are
  unchanged. No new event is emitted.
## Rule `global-leak-fix`
Runs in `modernize()` right after `prototype-class` (which keeps refusing a constructor that leaks) and before the rest; it touches one statement and keeps every other node's position. `ModernizeOptions.inputs` carries the
schema names. `RULE_ORDER` gets it last, `RISK_ORDER` just before `var-scoping`. `readHeaderLevels` treats a header without it as default.
## Naive rewrite
`NaiveRule` gains `strict-mode`: for code with function-level leaks the naive rewrite adds a `"use strict"` directive and nothing
else, so it throws a ReferenceError that the Exorcist reports.
## SARIF
`SARIF_EXTENSION_RULES = [LAZ008]`; `renderSarif` appends an extension rule to `driver.rules` only when it has a result.
## Report (`src/exporter/html-report.ts`)
`renderResurrectionReport(input)` is pure and escapes with one `esc()`. The diff is a two-column table (no script). Single-file
bundles: `buildExportBundle` adds the file to `bundle.files` after verification and signing; the Ed25519 subject stays
`resurrected.ts`. Whole project: `buildGraphBundle` adds a project report (files, rules rolled back, cycles). The export route
accepts optional `perfParity`, `mutants` and `causal` summaries (validated, clamped); purity is recomputed on the server.
`/api/export-bundle` also returns `reportHtml`.
## UI
- `PR Preview` button (`#prPreviewBtn`) and drawer (`#prDrawer`, `#prScrim`, `#prClose`) registered with `LazarusDrawers`.
- `#proofStrip` (5 `button.proof-pill`) between the Verification Deck heading and the diff; `lz-proof` region holds the pure state
  function `lzProofPills(result, extras)`.
- `#dnaMap` inline SVG built from `/api/kiro-dna` counts in the existing drawer script.