# Requirements: Strict TS Verification

## Introduction
Generated TypeScript gets real compiler verification, and multi-file graph exports become typed `.ts` modules. Two
claims that were previously only asserted become checked facts: "the exported TypeScript compiles under `--strict`",
and "the multi-file project is TypeScript".

Constraints: strict TypeScript in Lazarus itself (no `any`, no `@ts-ignore`), all 595 existing tests keep passing,
`tsc --noEmit` clean. Type-checking never executes the checked code; legacy code still runs only in the sandbox.

## Requirements

### R1. Dependency
1. The installed `typescript` package is inspected (7.0.2: the native compiler, with `typescript/unstable/async` as its
   programmatic API and per-platform binaries as optional dependencies).
2. `typescript` is listed under `dependencies`, and `package-lock.json` agrees (no `dev` flag on `typescript` or its
   platform packages), so `npm ci` installs it with `NODE_ENV=production`.

### R2. Verifier (`src/crew/ts-verifier.ts`)
1. `verifyStrictTypeScript(files)` type-checks a map of relative paths under `strict`, `noImplicitAny`, `target: ES2022`,
   `module`/`moduleResolution: NodeNext`, `noEmit` (plus `skipLibCheck`, `types: []`), as an ES module package.
2. Primary engine: the compiler API in memory. Files live under a virtual root that never exists on disk (reads inside
   it are answered from the map, or "missing"); lib files come from the real, read-only installation. One warm compiler
   process is reused, checks are serialized, and the process closes when idle or on demand.
3. Fallback engine: an isolated temp directory checked with `tsc --noEmit --strict`, killed after 30 s, always removed.
   Used if the API is unavailable or fails; both engines report the same diagnostics.
4. Result: `{ passed, errorCount, diagnostics: [{ file, line, column, code, message }], elapsedMs, engine, tsVersion,
   filesChecked }`. Only error-category diagnostics count. A genuine error is never suppressed.
5. Unsafe file names (absolute, `..`, backslashes) are rejected.

### R3. Single-file exports
1. The bundle's `resurrected.ts` (and `types.d.ts`) are verified. If strict mode rejects legacy internals that have no
   observable type (TS7006 untyped inner parameter, TS7034 variable, TS2339 undeclared `this.x` class field), exactly
   those members are declared `any` at the migration boundary, listed in `adjustments`, and the code is checked again.
2. If errors remain and the return type came from the Type Alchemist, it is widened to `unknown` and checked once more.
   The pill and `types.d.ts` then show the widened signature.
3. The final result is reported as is, including errors.

### R4. Typed multi-file graphs
1. After whole-graph parity is proven, the legacy graph is replayed on the whole-graph fuzz inputs with every module
   export wrapped (in the sandbox), recording each cross-module call's arguments and return value.
2. Signatures per export: per-file fuzz observations plus observed calls, with parameters typed by the values they
   actually received (unions where callers differ).
3. Each module is emitted as `src/<name>.ts` with parameter/return annotations and JSDoc. Imports keep their `./x.js`
   specifiers, which is how NodeNext resolves sibling `.ts` files. The whole project is verified together, with the same
   boundary fixes as R3.1.
4. The archive and the CLI `--out` directory include `tsconfig.json` (the strict options, `include: ["src/**/*.ts"]`), so
   `npx tsc --noEmit` in the unzipped project checks the typed modules (no `npm install` needed). The patch, SPEC.md and
   Vitest suite point at the `.ts` files.

### R5. Surfacing
1. `typecheck` is attached to `/api/resurrect` results (single and module mode), `/api/export-bundle` responses and
   graph results. `/api/resurrect` stays under 3 s for presets: the warm compiler checks a preset in about 30 ms.
2. The certificate gets a `TypeScript strict check` row (`tsc --strict: 0 errors (1 file, TypeScript 7.0.2)`, or the
   honest error count), deterministic (no timings). SPEC.md gets a `TypeScript Strict Check` status line and lists any
   migration-boundary members.
3. The result is always computed by the server at export time. A client-supplied `typecheck` claim is ignored.
4. The verifier closes with the web server.

### R6. Tests
`src/crew/__tests__/ts-verifier.test.ts` and graph/bundle updates: `passed: true, errorCount: 0` for `legacy-int-halve`,
`stringHash32`, `legacyCounterClass`, `cjsMathUtils`, `mixAB` and both multi-file examples; a deliberate bug
(`const x: number = "boom";`) reported with its real line and message by both engines; typed `.ts` + `tsconfig.json` in
the zip and CLI output that pass `tsc --strict`; tampered claims ignored; no leaked temp files or processes.
`npx tsc --noEmit` and the full `npx vitest run` pass.
