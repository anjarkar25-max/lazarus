# Design: Kiro DNA and Smart Paste

## Bugfixes
- `lzMakeRunControl()` (inline, between `lz-run:start`/`lz-run:end`): `begin()` aborts the previous controller and
  returns `{ token, signal }`; `isCurrent(token)`; `abort()`. `lzReadSse(response, onData, isCurrent)` stops reading
  as soon as its token is no longer current. The main run handler becomes `startRun()`, which resolves with the result
  of its own run (or `null` when superseded, aborted or failed). The button calls it, as does the tour.
- Audit and probe: the busy guards become abort-and-replace, with token checks before rendering. Both expose `run()`.
- The red-team script reads the body as text, parses it defensively, validates the shape before rendering, uses a 60 s
  `AbortController` timeout and a ticking `RUNNING ATTACK...` pill. It uses only the DOM calls the vm test stubs.

## Stale exports
- `startRun()` dispatches `lazarus:run-start` with `detail.source` = the exact text it posts. A separate inline script
  (`lz-stale:start`/`lz-stale:end`, loaded last) keeps `pending` (source of the latest started run) and `proven`
  (source of the latest successful `lazarus:result`). Superseded runs never emit results, so `pending` is always the
  source of the result that arrives.
- `check()` sets `stale = proven !== null && editor.value !== proven`. It runs on editor `input`, on preset `change`
  (registered after the preset handlers, so the new text is already in place), and is called by both importers after
  they write the editor (programmatic writes fire no `input` event).
- Stale: the export buttons are disabled (only the ones this script disabled are re-enabled later), the proof panels
  get the `lz-stale` class (dimmed), and `#staleHint` is shown. `buildBundleFromCurrentUI()` refuses while
  `LazarusStale.isStale()`. The certificate's SVG button is created per result, so it is re-checked on each result.
- The script only uses `getElementById`, `className`, `disabled`, `hidden`, `value` and `addEventListener`, so the
  vm test drives the shipped script with the fake DOM.
## Kiro DNA
- Three fixed directories (`specs`, `agents`, `steering`) under `<repoRoot>/.kiro`. `safeRead(dir, name)` checks the name
  against `^[A-Za-z0-9][\w.-]*$`, resolves it, requires `realpath(file)` to start with `realpath(dir) + sep`, uses
  `lstat` to refuse symlinks, and caps the size. Spec directories are enumerated the same way.
- `repoRoot` for the server is the same anchor as `publicDir` (`src/web/../..`).
- Requirement counting: first matching strategy wins (`REQ-ids` → `R-headings` → `user-stories` → `bullets`).
- Document view: `resolveKiroDocument` looks the spec up in the enumerated list (exact match) before building a path.

## Drawer
`<aside class="dna-drawer" role="dialog" aria-modal="true" hidden>` plus a scrim, both `position: fixed`, so the page
layout is unchanged. The Chimera diagram is static SVG markup (four organ groups, flow paths with labels). Clicks select
an organ and fill a detail panel with `textContent`. Cards are built from `/api/kiro-dna` on first open, and a spec's
documents load on demand into a `<pre>`.

## Smart paste
- Scanner: top-level `ExpressionStatement` whose expression is an arrow or function expression becomes a `kind:
  "expression"` / `"arrow"` candidate named `anonymous` (or its own id), with `ownStatement` set.
- `inferParamKinds` walks with parents: boolean contexts and string-literal evidence are collected per name. A name is
  boolean only when every reference is in a boolean context (or it is compared with a boolean literal), so a counter
  used in `if (n)` and in arithmetic stays numeric. Evidence order: string > json (array methods) > boolean >
  length hint > integer.
- `/api/scan` reuses `scanLegacyAst`, `listModuleFunctions` and a signature renderer (`integer`/`number` → `number`,
  `json` → `unknown`).
- Page: a `schemaTouched` flag (set by schema input, cleared when a preset, GitHub or npm import fills the editor), a
  350 ms debounce, and a sequence number so a slow response never overwrites a newer one.

## SVG certificate
A 760×420 card: gradient frame, emerald seal, monospace rows. A deterministic string template; `escapeXml` handles
`& < > " '` and strips control characters that XML forbids. `buildExportBundle` returns the `Certificate` object, and
the route renders the SVG from it.

## Audio
A lazily created `AudioContext` on the first switch to ON (a user gesture). `tone(freqs, type)` uses an oscillator and
gain envelope, peak gain 0.05, about 0.35 s. The page's main SSE loop dispatches `lazarus:crew` for every crew event;
the audio script listens for `counterexample_found` and for `lazarus:result` with `success`.
