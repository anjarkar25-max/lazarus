# Design: Module Graph Necromancer

## Sandbox loader
- `virtual-fs.ts` holds the host-side rules (`normalizeVirtualPath`, `resolveRelative`, `validateVirtualFiles`,
  `withVirtualFiles`) and `VIRTUAL_REQUIRE_SOURCE`, the loader source that the vm bootstrap evaluates in the sandbox realm.
- `VmProbeExecutor` passes `files` as a JSON string (`__lzFiles`) plus `__lzEntry`; the bootstrap installs `require` and
  deletes both. Module bodies are compiled with the context's own `Function` (string code generation is already enabled
  for probes), so modules share the probe's realm, timeout and heap limits.
- Validation runs in `isProbeParams`, so the pooled worker rejects bad maps before executing anything.

## Analyzer
- `parseProgram` + `analyze` (scope) find unshadowed `require` calls. `resolveRelative` mirrors the in-sandbox resolver.
- Tarjan SCC for cycles; post-order DFS over sorted roots, entry visited last; `depth` = longest dependency chain (layout).

## Per-file pipeline
- Executors: two warm `PooledProbeRunner`s per graph run (or injected), wrapped with `withVirtualFiles(map)`.
- Probe call: `require("./<file>")["<export>"](params...)`, or `require("./<file>")(params...)` for a default export.
- Candidate file = `modernize(source, { levels })` (still CommonJS). Healing replays the exact tagged counterexample.
- ESM: `toEsmModule(source, { levels, resolveRequire })`. `resolveRequire` maps a specifier to the dependency's ESM path
  (relative `.js` specifier) and export names, so the import shape is chosen from what the dependency really exports.

## Whole-graph check
- `linkEsmForSandbox`: `import x from s` -> `const x = require(s).default`; `import * as x` -> `const x = require(s)`;
  `import { a as b }` -> `const b = require(s).a`; export declarations stay in place and `exports.name = local`
  assignments are appended; `export default expr` -> `const __lz_default = expr` + `exports.default`; a `"use strict"`
  directive keeps ESM strictness. Requires of an acyclic graph complete before the importer's body, matching ESM order
  for dependencies.
- The exported project's own Vitest suite runs the real ES modules under Node, independently of this linker.

## Bundle / web / CLI
- `src/exporter/graph-bundle.ts` builds the file map and zip. The server caches the last 16 bundles under a UUID.
- UI panel below the three-column table: preset select, tabs + textarea, SVG (layered by `depth`, importer -> dependency
  arrows, state classes), log, verdict, zip button. Colors: #090d16, #111827, #10b981, #ef4444, #8b5cf6.
- CLI: `statSync(...).isDirectory()` switches to `runDirectory`, which writes only after parity is proven.

## Trade-offs
- Cyclic graphs are refused: ESM hoisting changes the evaluation order of circular CommonJS graphs, and the loader's
  partial-exports behavior has no exact ESM equivalent. The loader itself supports cycles for probing.
- Output modules are ES2022 `.js` (untyped). Emitting `.ts` would need inferred types for every export; the TypeScript
  part of the project is the parity suite.
