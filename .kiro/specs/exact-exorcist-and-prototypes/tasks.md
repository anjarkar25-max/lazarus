# Tasks: Exact Exorcist and ES5 Prototypes

- [x] 1. Exact Exorcist: `supportsTaggedEncoding`, tagged fuzzing, wire-form reports, boundary corpus/arbitraries, vm `undefined` fix, `exact` seam, refinement update.
- [x] 2. Scanner: script specimens + free-variable schema, named-call preamble, constructor-like `new`.
- [x] 3. Rule `prototype-class` (ladder, safety checks, comments) in `ast-modernizer.ts`.
- [x] 4. `esm-export.ts`: `export function` / `export class` for named exports of declarations; `levels` option.
- [x] 5. `module-resurrection.ts`; bundle `functions`; CLI module mode.
- [x] 6. Web: nested schemas, module results, probe `functionName`, export `functions`; presets `legacyCounterClass`, `cjsMathUtils`; UI function picker.
- [x] 7. Tests (exact Exorcist, prototype class + rollback, multi-export, boundary corpus properties).
- [x] 8. Verify: `tsc`, full `vitest run` under 60 s, no leaked Node processes, browser smoke of the new presets.
