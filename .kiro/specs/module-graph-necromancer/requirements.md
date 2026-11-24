# Requirements: Module Graph Necromancer

## Introduction
Upgrade Lazarus from single-file resurrection to multi-file CommonJS dependency graphs: an in-memory virtual
module loader inside the sandbox, a static dependency analyzer with a deterministic topological resurrection order,
per-file modernization + Exorcist, require -> import stitching, an end-to-end whole-graph parity check, a whole-project
`.zip` export, a live SVG dependency graph in the Operating Table, and a CLI directory mode.

Constraints: strict TypeScript (no `any`, no `@ts-ignore`), zero new runtime dependencies, all 479 existing tests keep
passing, `tsc --noEmit` clean. Legacy code only ever runs inside the pooled sandbox worker (`sandbox-security.md`); the
virtual loader never touches the host file system. UI follows `ui-aesthetics.md`.

## Requirements

### R1. Virtual CommonJS loader (`src/sandbox/virtual-fs.ts`, `vm-executor.ts`)
1. `ProbeParams` gains optional `files: Record<string, string>` and `entry: string`. They are validated at the JSON-RPC
   boundary: canonical relative paths only (no `..`, `.`, empty segments, backslashes, absolute paths, NUL), string
   sources, at most 64 files, 64 KB per file, 512 KB in total, `entry` must name a file, `entry` requires `files`.
2. With `files`, every fresh vm context gets a `require(specifier)` that resolves only `./` and `../` specifiers against
   the map, trying `""`, `.js`, `.cjs`, `/index.js`, `/index.cjs`. Each module runs once per probe (cache), with
   `exports`, `require`, `module`, `__filename`, `__dirname`. Circular requires see partial exports (Node semantics).
   A module that throws is not cached.
3. `fs`, `os`, `child_process`, `node:*`, bare packages, absolute paths and any traversal outside the map fail with a
   clear `[lazarus sandbox] blocked require(...)` error (EXECUTION_ERROR). There is no host fallback. Without `files`,
   `require` stays undefined, exactly as before.
4. The loader is built inside the sandbox realm (bootstrap), so it exposes no host objects.

### R2. Graph analyzer (`src/crew/graph-resurrector.ts`)
1. acorn extracts every call of an unshadowed `require` with a literal specifier. Relative ones become edges via the
   same resolution rules as the loader. External specifiers, dynamic specifiers, missing modules, `.cjs`/`.js` output
   path collisions and cycles (Tarjan SCC, including self-loops) are reported as structured problems.
2. The entry is the requested file, otherwise the single root (preferring `index`/`main`, then the root reaching the
   most files). The order is a deterministic post-order DFS: dependencies first, ties by path, entry last.
3. A graph with problems is refused with every problem listed; nothing is faked.

### R3. Resurrection, stitching and whole-graph parity
1. Files are resurrected in topological order. For each file, every exported, `this`-free function is fuzzed (exact
   tagged `Object.is`) with the legacy file versus the modernized candidate, both loaded through the virtual map with the
   legacy versions of their dependencies.
2. On a divergence, the counterexample is replayed against each applied AST rule rolled back on its own; the first one
   that restores parity is blamed and rolled back (otherwise the riskiest applied rule). As a last resort every rule is
   off (verbatim legacy semantics).
3. CommonJS -> ESM: `var x = require('./foo')` becomes `import x from './foo.js'` (default export) or
   `import * as x from './foo.js'` (named exports); `var f = require('./foo').f` and `const { a, b } = require('./foo')`
   become named imports, with a default-import + destructure fallback. Import paths are relative `.js` specifiers.
   Anything else is reported as not convertible.
4. Whole-graph parity: the original CommonJS graph and the stitched ESM graph (through a 1:1 import/export linker that
   keeps ES module strictness) are fuzzed end to end through every export of the entry module, exact `Object.is`.
5. Progress events: `graph`, `node` (`probing`, `healing`, `resurrected`, `failed`) and `log`.

### R4. Whole-project bundle and `.zip`
1. `src/<esm paths>` (ES2022 modules), `legacy/<original paths>` (oracle), `src/package.json` (`type: module`),
   `legacy/package.json` (`type: commonjs`), root `package.json`, `resurrected.test.ts` (Vitest + fast-check whole-graph
   parity against the CommonJS graph), `SPEC.md`, `.github/workflows/lazarus-parity.yml`, `resurrection.patch`
   (unified multi-file diff). Packaged with the existing zero-dependency ZIP writer, folder structure preserved.

### R5. Web (`POST /api/resurrect-graph`, `POST /api/export-graph-zip`, `public/index.html`)
1. `/api/resurrect-graph` validates `{ name?, files, entry?, schemas?, fileRuns?, graphRuns?, seed? }` with zod plus the
   sandbox file-map rules (400 on failure) and streams SSE: `graph`, `node`, `log`, then `result` (or `error`).
2. A successful result gets a `bundleId`; the server keeps the last 16 bundles. `/api/export-graph-zip { bundleId }`
   returns `application/zip` (404 for an unknown id, 400 for a malformed body). The client never uploads code to zip.
3. A "Multi-File Project (Stitch Graph)" panel: two curated projects (`legacy-invoice-engine`: money, tax, invoice;
   `legacy-text-pipeline`: trim, pad, slug), a file-tab editor, "Resurrect Project Graph", an SVG dependency graph whose
   nodes move through DEAD CJS -> PROBING -> SELF-HEALING -> RESURRECTED ESM with directional import arrows, a log, the
   verdict, and "Download Whole-Project .zip". No chart libraries; DOM/SVG APIs and `textContent` only.

### R6. CLI directory mode
1. `lazarus resurrect <dir> --out <dir>` discovers `.js`/`.cjs` files (skipping `node_modules` and dot-directories,
   same limits as R1), resurrects the graph, proves whole-graph parity and writes the bundle; on failure exits `1` and
   writes nothing. `--function` names the entry file; `--schema` is flat or `{ export: { param: kind } }`.
2. `examples/legacy-invoice-engine/` and `examples/legacy-text-pipeline/` ship in the repo.

### R7. Tests
`src/sandbox/__tests__/virtual-fs.test.ts`, `src/crew/__tests__/graph-resurrector.test.ts`,
`src/web/__tests__/graph-route.test.ts`: nested resolution, blocked host modules and traversal, circular requires,
topological order, cycle detection, require -> import rewriting, whole-graph parity (and a failing graph), zip export,
SSE streaming, CLI directory mode end to end. `npx tsc --noEmit`, full `npx vitest run`, no leaked Node processes.
