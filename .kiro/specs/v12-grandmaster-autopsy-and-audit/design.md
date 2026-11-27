# Design: V12 Grandmaster Autopsy and Audit
## Autopsy (`src/crew/mutation-audit.ts`)
- `firstDiff` already finds the first changed line. It now also returns `originalLine` and `mutatedLine` for
  `Mutant`.
- For a killed mutant, the source of the killing input is decided as follows:
  - when `report.boundaryRuns === report.totalRuns`, the kill came from the boundary corpus, whose inputs are
    minimal;
  - otherwise the mutant is fuzzed again with `shrink: true` and the same seed, and the shrunk counterexample is used;
  - if that replay passes (it should not, with the same seed), the first failure is kept as `first-failure`.
- `formatOutcome(outcome)` gives `+0` for positive zero, `-0`, `NaN`, `Infinity`, strings in JSON quotes, and
  `throws <code>` for errors. It reuses `describeValue(decodeTagged(...))`.
- The existing `killingCounterexample`, `status` and `diffSnippet` are untouched.
## Naive refactor (`src/crew/naive-refactor.ts`)
- The code is parsed with `parseProgram`, every node is walked, the tree is changed in place, and the result is
  printed with `printProgram`.
- The rewrites are decided per node:
  - `BinaryExpression |` with a literal `0` right side:
    - when the left side is a `/` expression, it becomes `Math.floor(left)`;
    - when the left side is an accumulation (a `+`, `*`, `<<` or `^` expression that contains an identifier), it
      becomes `left`, so the truncation is dropped;
    - otherwise it becomes `Math.trunc(left)`.
  - `>> 0`, `>>> 0` and `~~x` become `Math.trunc(x)`.
  - `==` and `!=` become `===` and `!==`.
  - `var` declarations become `let`.
- Each rewrite records the printed node before and after. The output is deterministic because it depends only on the
  AST.
## Route `POST /api/compare-naive`
- Body: `CompareNaiveBodySchema` (strict): `legacyCode`, an optional `schema` (record of `KindSchema`, at most 16
  keys), and an optional integer `seed`.
- The legacy side is `scanLegacyAst(legacyCode).primaryExpression`. The naive side is
  `naiveRefactor(primary).naiveCode`.
- It runs on dedicated pools (`naiveLegacy`, `naiveModern`), lazily created and closed with the server, with a
  `naiveBusy` guard. The fuzzer is `DifferentialFuzzer` with
  `{ numRuns: 100, exact: true, boundary: true, seed: seed ?? 1337 }`.
- `counterexample.input` uses the same display as the autopsy. `legacyOutput` and `naiveOutput` use `formatOutcome`.
## CLI audit (`src/cli-audit.ts`)
- The walk is `fs.readdirSync(..., { withFileTypes: true })`, skipping symlinks and the ignored folders, with relative
  POSIX paths, sorted. It stops at 500 files.
- Analysis uses acorn (`ecmaVersion: "latest"`, `sourceType` script, falling back to module) and the existing `walk`:
  - truncation sites;
  - prototype chains: `X.prototype.m = function` or `X.prototype = {...}` where `X` is a declared function;
  - `var` declarations;
  - `arguments` identifiers;
  - literal `require` calls, resolved with `resolveRelative` from `virtual-fs.ts`.
- Graph: fan-out is the resolved requires per file and fan-in the reverse. Cycles are found with a DFS. The entry
  module comes from `analyzeGraph(files).entry`, the same rule as Tab 2.
- Score per file is `100 - min(100, 12·high + 5·medium + 1·info)`. The overall score is the mean over files, rounded.
  Grades: A ≥ 85, B ≥ 70, C ≥ 50, D otherwise.
- Recommended command:
  - several files: `npm run resurrect -- <dir> --entry <entry> --out ./resurrected-out`;
  - one file: `npm run resurrect -- <file> --out ./resurrected-out`.

  A note is added when external requires block resurrection.
- `src/cli.ts`: `main()` checks `args[0] === "audit"` and delegates before parsing the resurrect options.
## Health and cold-start guard
- `GET /api/health` returns `{ ok, uptimeSec, tests, specs }`:
  - `tests` is parsed once from the served page's `#badgeTests`;
  - `specs` is `readKiroDna(repoRoot).specCount`;
  - the header is `Cache-Control: no-store`.
- The page script (`lz-health:start/end`) runs:
  - `fetch("/api/health", { cache: "no-store" })` with an 8 s abort;
  - a 1500 ms timer that shows `#wakePill` (fixed position, so it adds no layout height);
  - on 502, 503, 504 or a network error, one retry after 2 s;
  - on final failure, a message plus a Retry button.

  The pieces are pure helpers so the vm tests can drive them with a fake fetch and fake timers.
## UI placement
- `#naiveBtn` goes right after `#legacyDiffToggle`. `#trapCard` goes after `#legacyDiffBlock` in `.deck-wide`.
  `#mutAutopsy` goes after `#mutTable` in `#mutCard`.
- New scripts are added before the `lz-stale` script, which stays last. They listen to the existing events:
  `lazarus:result`, `lazarus:run-start`, `lazarus:mutation`.
- Tab 3 markup and scripts are not touched. A test compares the Red-Team region of `public/index.html` with `main`.
