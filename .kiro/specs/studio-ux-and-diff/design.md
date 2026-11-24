# Design: Studio UX and Diff

## Restructure without breaking contracts
The page is rebuilt by moving existing blocks, not by rewriting them: the header's controls, the crew bar and the
three-column `<main>` go into `#pane-single`, `#graphPanel` into `#pane-graph`, and the red-team card's body into
`#pane-redteam` (its `#redteamCard`, `#rtButtons`, `data-attack` buttons and `#rtLog` are kept as they are). Existing
scripts look elements up by ID when they run, so moving them does not change behaviour. The heading text
"LAZARUS // OPERATING TABLE" stays as the Tab 1 title. The transformation script refuses to write anything if any
anchor is missing or ambiguous.

## Tabs
Plain buttons with `role="tab"`, `aria-selected`, roving `tabindex` and `aria-controls`. Switching toggles the panes'
`hidden` attribute and updates `location.hash` with `history.replaceState`. `window.LazarusStudio.switchTab` is exposed
for the tour and for tests.

## Diff
`lzDiffLines` (inline) mirrors `diffLines` (TS) line for line, including the `Uint32Array` table and tie-breaking
(deletion first). `renderDiff` builds a four-column grid per row (old #, new #, sign, text), collapses unchanged runs
outside two lines of context, and writes the stats. It uses `textContent` only.

## Tour
An async sequence with a cancel flag and cleanup callbacks. `waitFor(okEvent, endEvent, timeout, start)` subscribes
before triggering the page's own button, keeps the last `okEvent` detail and resolves on `endEvent`, so a run that ends
without a result is reported as a failure. Spotlight: a `tour-focus` outline plus `scrollIntoView`. The HUD is fixed at
the bottom, `aria-live="polite"`. Animations respect `prefers-reduced-motion`.

## Overflow
Grid tracks use `minmax(0, …)`, and code blocks scroll inside themselves. `html, body { overflow-x: hidden }` is only a
guard: the browser check measures with it switched off and also flags any element whose box crosses the viewport
outside a scroll container.
