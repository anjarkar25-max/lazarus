# Requirements: Studio UX and Diff

## Introduction
Reorganize the single long Operating Table page into "Lazarus Studio": a compact header, three workspace tabs, a real
line-by-line diff in the Self-Healing Matrix (plus a Legacy vs. Resurrected view), and a one-click Guided Judge Tour
that drives the live product. Backend routes and every DOM contract the existing tests rely on stay unchanged.

Constraints: zero new runtime dependencies, strict TypeScript for the helper, no frameworks in the page
(`textContent`/DOM APIs only), palette and SSE transport per `ui-aesthetics.md`. Nothing in the UI runs legacy code;
every live action goes through the existing sandboxed routes.

## Requirements

### R1. Studio shell
1. Header: Lazarus brand, proof badges (`<N> Verified Tests`, `<N> Kiro Specs`, `Exact Object.is`, `tsc --strict`), the
   "Run 20s Guided Judge Tour" button and a Cancel button while the tour runs. The specs badge equals the number of
   folders in `.kiro/specs`; the tests badge states the real suite size.
2. Tabs (`role="tablist"`, ARIA-linked panels, arrow-key navigation, `#single` / `#graph` / `#redteam` deep links):
   - **1 · Single File & npm Graveyard**: the existing Operating Table (presets, editor, GitHub and npm importers, crew
     telemetry, signature pill, `tsc --strict` badge, Self-Healing Matrix, certificate, mutation audit, probe card, PR
     bundle and `.zip` exporter).
   - **2 · Multi-File Project (Stitch Graph)**: the existing graph workspace.
   - **3 · Sandbox Red-Team Lab**: the four attack buttons, the containment and canary timeline, and a sandbox
     isolation spec summary.
3. Panes are hidden, never removed, so switching tabs keeps results, inputs and running state.
4. All existing IDs, classes, texts and the DOM order relations used by tests are preserved; existing scripts are
   untouched apart from event hooks.
5. No horizontal overflow at 1366×768 or 1920×1080 on any tab, measured with the page's overflow guard disabled.

### R2. Line diff
1. `src/web/line-diff.ts`: `diffLines(old, new)` returns `same` / `del` / `add` lines with 1-based old/new line numbers,
   based on the longest common subsequence after trimming the common prefix and suffix. Inside a change, deletions come
   before additions. CRLF is normalized; a trailing newline adds no line. Above 250,000 LCS cells the middle falls back
   to all deletions then all additions (still a correct, if not minimal, diff).
2. The page ships an identical plain-JS copy between `lz-diff:start` and `lz-diff:end`; tests run it against the module.
3. The Self-Healing Matrix shows the diff from the rejected draft to the verified code with line numbers, `-`/`+` signs,
   red/green rows, `−N / +M` stats and collapsed unchanged runs (2 lines of context).
4. A "Legacy vs. Resurrected Diff" toggle under the resurrected code shows the specimen against the resurrected code.

### R3. Guided Judge Tour
1. Real live calls only, driven through the page's own controls:
   1. Tab 1, load `stringHash32`, run the resurrection (`POST /api/resurrect`), spotlight the Self-Healing Diff and the
      `tsc --strict` badge;
   2. run the mutation audit (`POST /api/mutation-audit`) and report the real kill score;
   3. probe `NaN` (`POST /api/probe`) and report the real parity verdict;
   4. a completion banner with buttons to Tab 2 and Tab 3.
2. Each step waits for the page's own result events (`lazarus:result`/`run-end`, `lazarus:mutation`/`mutation-end`,
   `lazarus:probe`/`probe-end`) with a timeout. A failed step stops the tour with the real reason, never a fake success.
3. Cancel stops the tour at once (requests already sent finish on their own). About 14–20 s end to end.

### R4. Tests (`src/web/__tests__/studio-ui.test.ts`)
`GET /` serves the three tabs and panes with the right content in each, the diff renderer, the tour controls and hooks,
unique IDs, correct badges, and inline scripts that parse with acorn. The LCS helper produces exact hunks for single-
and multi-line edits and edge cases, reconstructs both sides, is minimal, and matches the shipped inline copy on
random inputs. `npx tsc --noEmit`, full `npx vitest run`, no leaked Node processes.
