# Tasks: Module Graph Necromancer
- [x] 1. `src/sandbox/virtual-fs.ts`; `files`/`entry` in `ProbeParams`, validation in `isProbeParams`, loader in the vm bootstrap.
- [x] 2. `esm-export.ts`: `resolveRequire` option (default / namespace / named / destructuring imports, positions kept).
- [x] 3. `src/crew/graph-resurrector.ts`: analyzer, per-file Exorcist + healing, stitching, linker, whole-graph parity, progress events.
- [x] 4. `src/exporter/graph-bundle.ts`: project files, unified patch, Vitest suite, CI, zip.
- [x] 5. Web: `POST /api/resurrect-graph` (SSE), `POST /api/export-graph-zip`, bundle cache.
- [x] 6. UI: Multi-File Project panel, presets, tab editor, SVG graph, zip button.
- [x] 7. CLI directory mode; `examples/legacy-invoice-engine/`, `examples/legacy-text-pipeline/`.
- [x] 8. Tests: `virtual-fs.test.ts`, `graph-resurrector.test.ts`, `graph-route.test.ts`.
- [x] 9. Verify: `tsc`, full `vitest run`, leak check.
