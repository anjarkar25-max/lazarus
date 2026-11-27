# Requirements: V12 Grandmaster Autopsy and Audit
## Introduction
Three strictly additive upgrades: a mutant and counterexample autopsy, a deterministic "Naive AI vs. Lazarus" trap
comparison, and a `lazarus audit <dir>` risk scanner with a Render cold-start guard.

Constraints:
- no new top-level tabs;
- no edits to Tab 3 (Red-Team) lines in `public/index.html`;
- no external API dependencies (the naive rewrite is deterministic and needs no API key);
- no new runtime npm dependencies;
- all 852 existing tests keep passing, with no changed or removed response fields.

Where the request and the code base differ:
- **Where the audit is surfaced.** The mutation audit is surfaced by `POST /api/mutation-audit`, which the Studio
  calls after `/api/resurrect` has finished. `/api/resurrect` does not run an audit. The autopsy fields are added to
  the audit result, so they appear wherever the audit is returned. Running the audit inside `/api/resurrect` would
  slow every resurrection and change that stream, so it is not done.
- **Two `status` fields.** The existing mutant field `status` is `"KILLED" | "SURVIVED"`, and tests and the UI depend
  on it. The new lower-case `status` (`"killed" | "survived"`) and the human-readable `operator` therefore live in a
  new `autopsy` object on each mutant. Every existing field is unchanged.
## Requirements
### R1. Mutant and counterexample autopsy
1. Each mutant in a `runMutationAudit` result gains `autopsy` with these fields:
   - `id` and `operator` (the human label, for example `Math.trunc → Math.floor` or `strip | 0`);
   - `status` (`"killed" | "survived"`);
   - `originalLine` and `mutatedLine`: the first changed line, before and after, trimmed;
   - `killerInput` (`null` for a survivor);
   - `legacyOutput` and `mutantOutput`: formatted outcomes, so `-0` is shown as `-0` and `0` as `+0`, and errors as
     `throws <code>`;
   - `divergence`: the fuzzer's `Object.is` reason.
2. `killerInput` is `{ display, inputs, source }`, where `source` says where the input came from:
   - `"boundary-corpus"`: it is a boundary input, already minimal;
   - `"shrunk"`: a kill found in the random phase is replayed with fast-check shrinking (same seed) and the shrunk
     input is reported.

   When shrinking cannot reproduce the kill, the first killing input is reported with `"first-failure"`. Nothing is
   invented.
3. `Mutant` (from `generateMutants`) also gains `originalLine` and `mutatedLine`.
4. In the Tab 1 Verification Deck, the mutation score (`#mutScore`) becomes a button: clickable, keyboard-accessible
   with Enter and Space, with `aria-expanded` and `aria-controls`. It toggles an inline **Mutant Autopsy Inspector**
   (`#mutAutopsy`) inside the mutation card. The inspector is collapsed by default and after every new audit. It shows
   for each mutant:
   - the injected code diff (`- original` / `+ mutated`);
   - the killer input and where it came from;
   - legacy vs mutant output, with the divergence reason.

   It renders with `textContent` only.
### R2. Naive AI vs. Lazarus trap comparison
1. `src/crew/naive-refactor.ts`: `naiveRefactor(code)` is pure and deterministic (acorn + astring, no network, no API
   key). It returns `{ naiveCode, rewrites[] }`, applying the rewrites a hurried LLM typically makes:
   - `(a / b) | 0` → `Math.floor(a / b)`;
   - another `x | 0` → `Math.trunc(x)` where `x` is not an accumulation;
   - `x | 0` around an accumulation (`h * 31 + c`, `h + c`, `h << 5`) → `x` (the 32-bit truncation is dropped);
   - `x >> 0`, `x >>> 0` and `~~x` → `Math.trunc(x)`;
   - `==` / `!=` → `===` / `!==`;
   - `var` → `let`.

   Each rewrite records `{ rule, before, after }`. Code that does not parse, or has no such pattern, is returned
   unchanged with no rewrites.
2. `POST /api/compare-naive` accepts exactly `{ legacyCode, schema?, seed? }` (zod, strict):
   - `legacyCode` is at most the same limit as the other routes;
   - `schema` is a flat schema with at most 16 parameters, and defaults to the scanner's suggested schema.

   The route:
   - extracts the same specimen expression `/api/resurrect` runs;
   - applies `naiveRefactor` to it;
   - fuzzes the legacy specimen against the naive code with the real Exorcist (exact `Object.is`, boundary corpus,
     shrinking, 100 runs) in dedicated pooled sandbox workers (256 MB, 3000 ms per probe);
   - allows one comparison at a time (429 `BUSY` otherwise).
3. It returns `{ naiveCode, rewrites, passed, totalRuns, counterexample? }` with
   `counterexample = { input, legacyOutput, naiveOutput, reason }`. `input` is a display string such as `n = -3`, and
   `inputs` holds the raw wire form.
   - When no naive pattern exists it returns `passed: true`, `rewrites: []` and a `note`.
   - When the naive rewrite happens to match over the fuzz runs it returns `passed: true` honestly.
4. Tab 1: a compact secondary **Compare vs. Naive AI** button sits next to the Legacy vs. Resurrected Diff toggle. It
   is shown only after a successful single-function Tab 1 resurrection, and hidden again when a new run starts.
   Clicking it reveals a **Trap Card** in the deck:
   - **Left (crimson), Naive AI Refactor:** the naive code, the rewrites, and the exact failing input with legacy vs
     naive output (or the honest pass message).
   - **Right (emerald), Lazarus Proven:** the verified code, the parity badge (`100% Exact Object.is Parity`) and the
     mutation kill score (or a prompt to run the audit).

   The card renders with `textContent` only. The request is abortable and token-guarded like the other deck requests.
### R3. `lazarus audit <dir>` and the Render cold-start guard
1. `src/cli-audit.ts` provides `auditDirectory(dir)` and `runAuditCli(args, io)`.
   - It scans `.js` and `.cjs` files recursively, skipping `node_modules`, `.git` and `dist`, and never following
     symlinks. It refuses more than 500 files or files over 256 KB, and reports those as skipped.
   - Each file is parsed with acorn and never executed.
   - Findings per file:
     - bitwise truncation traps (`| 0`, `>> n`, `>>> n`, `~~x`, `<< n`): `high`;
     - constructor + `prototype` method chains: `medium`;
     - `var` declarations and `arguments` usage: `medium`;
     - relative `require('./...')` graph fan-in and fan-out: `info`, or `high` when either is at least 3 or the file
       is on a cycle;
     - external requires (packages, built-ins), which cannot run in the sandbox: `high`.
   - The score is deterministic: a migration readiness score from 0 to 100 overall and per file, a grade, and the
     exact recommended `lazarus` resurrection command (directory mode with the detected entry module).
2. Output: Markdown/terminal tables by default, or `--json` for the full JSON report. Exit codes: `0` report written,
   `2` bad usage or an unreadable directory.
3. Wiring:
   - `src/cli.ts` dispatches `audit` as the first argument to `runAuditCli`, so `tsx src/cli.ts audit <dir>` works;
   - `package.json` gets `"audit": "tsx src/cli.ts audit"`;
   - `power-lazarus/skills/resurrect-legacy-js/SKILL.md` mentions `npm run audit -- <dir>`;
   - the existing `resurrect` CLI behaviour is unchanged.
4. `GET /api/health` returns `{ ok: true, uptimeSec, tests, specs }`:
   - `tests` is the verified test count from the page badge;
   - `specs` is the live count of `.kiro/specs` folders;
   - the response is not cached.

   The existing `/health` route is unchanged.
5. Cold-start guard: on load, the Studio pings `/api/health` silently.
   - Only if no answer arrives within 1.5 s, a small non-blocking pill appears: "Waking Lazarus sandbox on Render…".
   - The pill clears the moment `/api/health` answers 200.
   - A 502, 503 or 504 (or a network error) is retried once automatically. If the retry also fails, the pill shows a
     clear message with a Retry button instead of a raw browser error.
   - The guard never blocks the page.
### R4. Tests, verification and badges
1. New tests:
   - `src/crew/__tests__/naive-refactor.test.ts`: rewrites, real counterexamples on `legacy-int-halve` and
     `stringHash32`, honest passes on safe functions, and `/api/compare-naive` validation.
   - `src/__tests__/cli-audit.test.ts`: `examples/legacy-invoice-engine` and `examples/legacy-text-pipeline`, in table
     and `--json` modes.
2. Extended tests:
   - `mutation-audit.test.ts`: the autopsy payloads.
   - `studio-ui.test.ts`: the inspector, the trap card, the cold-start guard, `/api/health`, and no Tab 3 diff lines
     against `main`.
   - `kiro-dna.test.ts`: `21 Kiro Specs`.
3. `npx tsc --noEmit` exits 0, the full `npx vitest run` passes, and no Node processes leak. `#badgeSpecs` reads
   `21 Kiro Specs` and `#badgeTests` the exact final passing test count.
