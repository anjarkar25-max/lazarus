# Design: V14 Final Boss

## Cycle resolver
- `ModuleGraph.cycleEdges`: edges whose endpoints are in the same SCC. `GraphProblem.kind "cycle"` is now produced only for a
  module that requires itself. Multi-module SCCs are informational (`cycles`).
- `resurrectWith` precomputes, for every module in a cycle, its export names (`toEsmModule` with a resolver that returns a
  default export, which never fails). `esmFor` falls back to that prediction for dependencies that are not converted yet.
  After a module is converted its real export list must equal the prediction used by earlier modules, else the graph fails
  with an explicit message.
- `linkEsmForSandbox(code, { live: true })` (used for modules in a cycle): export getters
  `Object.defineProperty(exports, "x", { enumerable: true, get() { return x; } })` are emitted at the top, before imports,
  so function declarations (hoisted) and TDZ behave exactly like ESM; `import * as ns` uses a getter-based namespace object.
  Named imports from a cycle partner read the binding when the import runs, which is exact for hoisted functions.
  Acyclic modules keep the existing snapshot linking, so acyclic output is unchanged.
- The typed-project step, bundle and CLI need no change: ES imports of a cycle are legal and tsc handles them.
- Tab 2: `lz-cycle` pure helper computes SCC edges on the client (the server re-analyzes), `edge cycle` paths are amber,
  a pill is added to the graph panel, and the server's `graph` frame supplies `cycleEdges` for the final state.

## SARIF
`renderSarif(report)` in `cli-audit.ts` is a pure function of the `AuditReport` (plus `requireLines`, the line of each
resolved `require` recorded during the audit). Finding kinds map to rules: bitwise-truncation LAZ001, error-first-callback
LAZ002, prototype-chain LAZ003, var-hoisting and arguments-usage LAZ004, require-graph and external-require LAZ005,
parse-error LAZ006. `runAuditCli` gains `--sarif` and `--out <file>`. `lazarus-audit.yml` is a constant in
`src/exporter/audit-workflow.ts`, added to both bundle types and to the `.zip` entries.

## Perf parity
`src/crew/perf-parity.ts`: `representativeInputs(schema)`, `buildBenchProbe(code, params, inputs, budgetMs)` (the code is turned
into a function body with acorn: the last expression statement becomes `return`), `runPerfParity(legacyRunner, modernRunner, body)`,
`classify(ratio)`. The sandbox loop uses `Date.now()` over calibrated batches (no hrtime exists in the sandbox) and returns per-op
microsecond samples. Runs alternate L, M, M, L. Server: dedicated pools, single flight (429), closed on server close.
UI: a `perfBadge` chip in the existing badge row, filled by a small script that listens to `lazarus:result`.