# Requirements: Kiro DNA and Smart Paste

## Introduction
Three finishing touches with no new workspace tab and no extra vertical sections: a live, read-only Kiro DNA drawer
(specs, agents, steering, and the four-organ architecture), zero-config "paste anything" signature detection, and a
downloadable SVG Resurrection Certificate plus optional, muted-by-default lab audio.

Constraints: strict TypeScript, zero new runtime dependencies, no frameworks in the page (`textContent`/DOM APIs,
SVG built with `createElementNS`), palette per `ui-aesthetics.md`. Pasted code is only parsed (acorn), never executed
outside the sandbox. All 663 existing tests keep passing.

## Requirements

### R0. Production bugfixes (priority 1)
1. **Tab 3 Red-Team Lab.** Clicking an attack must give immediate, unmistakable feedback and always end in a visible
   outcome:
   - a `RUNNING ATTACK...` pill with a live elapsed timer appears at the top of the timeline on click;
   - success renders `CONTAINED` (or `ESCAPED`), the real error code, elapsed ms, `WORKER RESPAWNED & HEALTHY` or
     `NO RESPAWN NEEDED`, and the canary `1 + 1 = 2`;
   - every failure is shown in the timeline with its cause: HTTP status and server error, a non-JSON error page (for
     example a 502 from the host's proxy), a malformed body, a network error, or a client timeout (60 s). Nothing is
     swallowed, and the buttons are always re-enabled.
   Observed while reproducing: locally a real mouse click rendered the result within 300 ms. The code paths that look
   dead in production are a hung request (only a faint "Running" line, no timeout), a non-JSON proxy error page (an
   opaque `Unexpected token '<'`), and a 200 body without the expected fields (an uncaught render error).
2. **Guided Judge Tour race.** Reproduced: start `cjsMathUtils`, then the tour. The tour's click on the still-disabled
   RESURRECT button did nothing, so it adopted the `cjsMathUtils` result, audited the wrong code ("0/0 mutants") and
   probed it ("text is not defined"). Fix:
   - every `/api/resurrect` stream has an `AbortController` and a monotonically increasing run token; starting a run
     (button or tour) aborts the in-flight stream, and frames, results and the run-end of a superseded token are
     ignored (no UI updates, no events);
   - the mutation audit and the probe get the same treatment (abort the in-flight request, ignore stale responses);
   - the tour starts its own run, audit and probe through promise-returning controls (`LazarusRun.start`,
     `LazarusMutation.run`, `LazarusProbe.run`) and checks that each result belongs to its own token and specimen;
   - Cancel aborts the tour's in-flight requests;
   - a stream that fails (network, HTTP error, aborted) is shown on the parity badge and in the log, never left on
     `RUNNING...`.


3. **Stale exports.** The page tracks the exact legacy source string that produced the last successful resurrection
   (captured when that run started, not when it finished). Whenever the editor text stops matching it (typing,
   pasting, switching presets, importing from GitHub or the npm Graveyard):
   - `EXPORT PR BUNDLE`, `Download .zip PR Archive`, `Copy GitHub PR Summary`, `Copy File`, `Download File`, `JSON`
     and `DOWNLOAD CERTIFICATE (.SVG)` are disabled;
   - the previous proof (modern code, spec, parity badge, Verification Deck, certificate, bundle panel) is dimmed and
     marked stale, with the hint `Code changed — click Resurrect Specimen to refresh proof`;
   - building a bundle is refused even if a button is reached some other way.
   Exports re-enable as soon as a new resurrection of the current text succeeds, or when the text is edited back to
   the proven source. Before the first successful run nothing changes (exports already require a run). A failed run
   does not clear the stale state. Tab 3 (Red-Team) is not touched.
### R1. Kiro DNA reader (`src/web/kiro-dna.ts`)
1. `readKiroDna(repoRoot)` reads only `.kiro/specs/*/{requirements,design,tasks}.md`, `.kiro/agents/*.json` and
   `.kiro/steering/*.md`. Directories are enumerated, never taken from input. Every path is resolved and checked to be
   inside its allowlisted directory, after `realpath`. Symlinks are skipped, and files over 256 KB are skipped and
   reported.
2. It returns `{ specCount, specs, agents, steering, generatedFrom }`:
   - `specs`: per spec, `name`, `title`, `requirementCount`, `requirementStyle` (how they were counted, see R1.3),
     `taskCount`, `tasksDone`, and which of the three files exist;
   - `agents`: per agent JSON file, `name`, `description`, `model`, `tools` (validated with zod; invalid files are
     reported, not faked);
   - `steering`: per file, the first `#` heading as `title`, the `inclusion` mode from the front matter, and the
     `fileMatchPattern` when present.
3. Requirement counts are honest for every existing format: distinct `REQ-…-NN` ids, else `### R<n>` headings, else
   `**User Story` headings, else top-level `- ` bullets. The style used is returned with the count.
4. `resolveKiroDocument(repoRoot, spec, file)` returns the text of one spec document when `spec` is the name of an
   enumerated spec and `file` is one of `requirements | design | tasks`, and `undefined` otherwise. Traversal,
   absolute paths, separators and unknown names never reach the file system.

### R2. `GET /api/kiro-dna` and the drawer
1. `GET /api/kiro-dna` returns the R1 metadata (`Cache-Control: no-store`). `GET /api/kiro-dna?spec=<name>&doc=<file>`
   returns one document as `{ spec, doc, text }`; an invalid or unknown name is `400` / `404`.
2. A compact "Kiro DNA" button in the studio header opens a slide-over drawer (`role="dialog"`, `aria-modal`, Esc and a
   close button, focus returns to the button). It takes no layout space when closed.
3. The drawer shows:
   - a four-organ Chimera diagram (Acorn AST parser → Node VM sandbox → fast-check differential fuzzer → TypeScript
     `tsc --strict` compiler) with the inputs and proofs that flow between them; clicking an organ shows what it does
     and where it lives in the code;
   - live cards for every spec (requirement and task counts, progress), with the documents viewable in place;
   - the four Kiro Crew agents (role, model, tools, responsibility) and the steering rules.
4. The header's specs badge is refreshed from the live count.

### R3. Smart paste (`src/sandbox/ast-scanner.ts`, `POST /api/scan`, page)
1. A pasted bare function expression (arrow or anonymous `function`) is detected as the specimen and run by calling it
   with its parameters, like the other function forms.
2. Parameter inference adds:
   - `boolean` for a parameter used only as a condition (`if`/`while`/`for`/ternary test, operand of `!`, inside a
     `&&`/`||` that is itself a condition) or compared with `true`/`false`;
   - `string` for `+` with a string or template literal, or `===`/`!==` comparison with a string literal, in addition
     to string methods and `.length`;
   - numbers stay the default (arithmetic, comparisons with numbers, index use).
   Existing results do not change for any preset.
3. `POST /api/scan { legacyCode }` (zod, size-capped) parses only and returns the suggested schema, the function name,
   a TypeScript-style signature text (`fn(str: string, len: number)`) and the detected idioms. Multi-export modules
   return per-export schemas and signatures.
4. On paste or typing (debounced), when the schema was not edited by hand since the last preset or import, the page
   fills the schema from `/api/scan` and shows "Auto-detected signature: …" in a subtle pill under the editor.
   Preset and importer changes are left alone.

### R4. SVG certificate and audio
1. `renderCertificateSvg(cert, { name })` returns a self-contained, deterministic SVG (no scripts, no external
   references, all text XML-escaped). It shows the specimen name, short SHA-256 digest, Legacy Debt Score, exact
   `Object.is` fuzz runs, mutation kill strength (or "not audited") and the `tsc --strict` status (or "not checked").
   It never claims a result the certificate does not contain.
2. `/api/export-bundle` returns `certificateSvg`, built server-side from the same verified inputs as the certificate.
   A "Download Certificate (.svg)" button in the certificate card saves it.
3. An "Audio: OFF" header toggle (muted by default, not persisted) uses the Web Audio API to play short, quiet tones
   when parity is proven and when a counterexample is caught. Nothing is created or played while it is off.

### R4b. Layout
No new tab or section. At 1366×768 and 1920×1080 there is no horizontal overflow, with the drawer open or closed.

### R5. Tests
Bugfix regressions (no DOM library, no new dependency): the page's own red-team script runs in `node:vm` against a
minimal DOM and a scripted `fetch`, covering the running pill, a contained result, HTTP errors, a non-JSON 502, a
malformed body and a timeout; the shipped run-control core (`lz-run` markers) runs in `node:vm` to show that a new
run aborts the old stream and that stale frames are dropped. Feature tests:
`src/web/__tests__/kiro-dna.test.ts`, `src/exporter/__tests__/certificate-svg.test.ts`, scanner and studio updates:
all specs (including `kiro-dna-and-smart-paste`) and all four agents; traversal blocked; well-formed SVG with name,
digest and `tsc --strict` status; `string` vs `number` vs `boolean` inference on pasted functions; acorn parses all
inline JS; `npx tsc --noEmit`; full `npx vitest run`; no leaked Node processes.
