# Design: V19 Graveyard and Graph Studio

## npm Graveyard Classics
`src/crew/graveyard-classics.ts` holds the registry (`GRAVEYARD_CLASSICS`, `findClassic`, `summarizeClassic`). `importNpmPackage` in
`src/importer/npm.ts` gains `options.source`: `live` is the unchanged code path (now `importLive`), `snapshot` returns `importClassicSnapshot`, and `auto`
wraps `importLive` in a try/catch that falls back to the snapshot for a curated classic only. No new network path: the CDN allowlist, size cap and
redirect rules are untouched, and the snapshot never touches the network. The route validates `source` with zod (the body stays strict).
The chips call `importNpm(spec, "snapshot")` and then `LazarusRun.start()`, so the run goes through the same button path as every other resurrection.

## Public API Contract Guard
`src/crew/api-contract.ts` builds one introspection probe per module (`require("./<path>")`, then name, form, kind from `Function.prototype.toString`,
and `fn.length`) and runs it through `withVirtualFiles` once on the legacy files and once on the linked ES modules (`linkEsmForSandbox` output). The pure
`compareExports` and `buildApiContract` decide what broke, so tests can feed them doctored exports. `resurrectWith` calls `guardApiContract` after the
whole-graph parity and the typecheck, and adds the field only when every module was described.

## Tab 2
The graph script keeps `selected`, `lastResult` and `lastGraph`. `nodeClass(f)` renders the state and the selection ring, `selectNode(f)` updates the nodes and the
inspector, `renderInspector()` reads the role from the graph, the exports from `apiContract`, the tsc count from the typecheck diagnostics of that file, and the
diff from `LazarusDiff.diffLines`, aligned into rows. New CSS goes under `/* ---- V20:` (before the V19 block, after the Red-Team region); no script block is added, so the
stale-proof script stays the last one.
