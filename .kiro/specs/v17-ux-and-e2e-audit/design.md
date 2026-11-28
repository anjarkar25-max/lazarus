# Design: V17 UX and E2E Audit
## Drawer manager (`lz-drawers` region, one new `<script>` before the Kiro DNA script)
`lzMakeDrawers(env)` is pure (the DOM comes in through `env`), so tests run it with the minimal fake DOM.
- `register(name, { isOpen, close(restore) })`: each drawer registers itself. `opening(name)` closes every other open drawer with
  `close(false)` (no focus move), so only one is ever open.
- `escape()`: closes the open drawer with `close(true)` (focus back to its button); otherwise collapses the first expanded
  popover that is not inside a drawer: `env.expanded()` returns the candidates, the manager clicks and focuses the first.
- `trap(event)`: on `Tab` with a drawer open, `env.focusables()` gives the visible controls of that drawer and focus wraps.
- One `keydown` listener on `document` handles Escape and Tab. The drawers' own Escape listeners stay as the fallback and only
  attach when `window.LazarusDrawers` is missing, so a drawer works without the manager (and old tests keep their behavior).
- Kiro DNA: `open()` calls `opening("dna")`, `close(restore)` skips the focus move on `false`, and it registers. The Verify Bundle
  and SARIF drawers do the same through `wireDrawer`.
## CSS (new `/* ---- V17 UX polish */` block after the V16 block, outside the Red-Team region)
`:where(...)` focus-visible rules (specificity 0, so existing outlines win); `button:disabled`; `button[aria-busy="true"]` with an
`::after` spinner and `pointer-events: none` (reduced-motion: no animation); drawers `max-width: 100vw`, `overflow-x: hidden`,
`.dna-body` wrapping long tokens; `.studio-header` wraps below 1366px.
## Busy state
Compare vs. Naive AI, RUN PROBE, the SARIF run button and Simulate 1-Byte Tamper set and clear `aria-busy` next to their existing
`disabled` handling.
## E2E runner (`scripts/e2e-smoke.mjs`)
A tiny CDP client over the built-in `WebSocket` (Node 22+): `Page.navigate`, `Runtime.evaluate`, `Emulation.setDeviceMetricsOverride`,
`Runtime.consoleAPICalled` (type `error`), `Runtime.exceptionThrown`, `Log.entryAdded` (level `error`). Steps poll DOM conditions with a
timeout instead of sleeping. The Studio runs in-process on port 0; the browser uses `--headless=new --remote-debugging-port=<free>`
and `--user-data-dir=<tmp>`; the profile directory is removed in a `finally`.