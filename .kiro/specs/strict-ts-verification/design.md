# Design: Strict TS Verification

## Engine choice
TypeScript 7 has no in-process JavaScript compiler; `ts.createProgram` does not exist. Its `unstable/async` API spawns
the native compiler and talks to it over IPC, with an optional virtual file system (callbacks; `undefined` falls back
to the real disk, `null` means "does not exist"). That gives in-memory checking with real diagnostics:
`API` -> `updateSnapshot({ openProjects: [<virtual>/tsconfig.json] })` -> `project.program.getProgramDiagnostics()`,
`getSyntacticDiagnostics()` and `getSemanticDiagnostics()`. Each check uses a fresh virtual project id and is closed
afterwards (`closeProjects`), so no source cache can leak between checks while lib files stay warm. Measured: about
200 ms cold, about 30 ms warm, versus about 155 ms per CLI run.

The API is marked unstable, so the CLI engine is a full fallback rather than a stub. It produces the same diagnostics
(same file, line, column, code and message in the smoke test).

## Diagnostics
API positions are UTF-16 offsets in the file text; they are converted to 1-based line/column. Message chains are
flattened. Only category 1 (error) counts. At most 50 diagnostics are returned, and `errorCount` counts all of them.

## Boundary fixes (`src/crew/ts-emit.ts`)
Driven by the compiler's own diagnostics, never by guessing: TS7006/TS7034 insert `: any` after the reported identifier
(checked against the source text); TS2339 is used only when the reported position follows `this.`, and declares the
field in the named class. Every insertion is reported. Real type conflicts are left alone and stay errors.

## Graph types
`callObservationProbe` wraps exports in topological order (dependents capture the wrappers, including
`require('./x').f` captures), runs the entry export on the recorded whole-graph inputs, and returns at most 400 calls per
export. Observations are best effort: if the replay fails, per-file observations still type the module.
`annotateModule` inserts annotations by acorn positions (parameter ends, after the closing parenthesis, JSDoc before
the declaration statement), so the type-erased output is the verified ES module.

## Server
`buildExportBundle()` is shared by `/api/export-bundle`, `/api/export-zip` and `/api/resurrect`, so the live result and
the exported files come from the same check. The certificate callback runs after verification.

## Trade-offs
- Internals of legacy classes (fields, method parameters) have no observable type at the module boundary, so they are
  declared `any` and listed. The exported signature stays fully typed.
- Observed types describe the fuzzed domain. The strict check proves the annotations are consistent with the code, not
  that no other input exists.
- The archive's `tsconfig.json` checks `src/` only: the Vitest suite imports `vitest` and `fast-check`, which need
  `npm install` (CI runs it).
