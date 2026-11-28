# Requirements: V17 UX and E2E Audit
The final pre-freeze pass: keyboard and layout polish for the header drawers, and a live-browser smoke test of the real Studio.
Constraints for every requirement: zero new top-level tabs (3 stay), zero edits to the Tab 3 Red-Team CSS, markup and script (the
three SHA-256 assertions in `src/web/__tests__/studio-ui.test.ts` stay byte-identical), zero new runtime dependencies, zero API
keys, and every existing test keeps passing (the only edits to existing assertions are the spec count, 26 to 27, and the tests
count in the badge).
## R1. UX and keyboard polish (`public/index.html`)
1. At most one top-level drawer (Kiro DNA, Verify Bundle, SARIF Audit) is open at a time. Opening one closes the others
   first, with no focus jump to the header, so drawers and scrims never stack.
2. `Escape` closes the open drawer and returns focus to the button that opened it. With no drawer open, `Escape` collapses an
   expanded popover (a control with `aria-expanded="true"` outside the drawers, such as the Shrink Trace waterfall or a Mutant
   Autopsy row) and focuses it. Escape never acts twice for one key press.
3. While a drawer is open, `Tab` and `Shift+Tab` stay inside it (the drawers are `aria-modal`).
4. Every button, select, input, link and `[tabindex]` control shows a visible `:focus-visible` outline (violet, emerald on
   primary buttons) without changing the existing specific outlines.
5. Async buttons show a crisp busy state while a request is in flight (`aria-busy="true"`, a CSS spinner, no pointer events) and
   a clear disabled state: Compare vs. Naive AI, Run SARIF Audit (the drawer's run button), RUN PROBE and Simulate 1-Byte Tamper.
6. No horizontal overflow at 1366x768 and 1920x1080, in Tab 1, Tab 2 and with each drawer open. Drawers fit the viewport.
7. Tab 3 Red-Team lines are untouched.
## R2. Live-browser E2E smoke (`scripts/e2e-smoke.mjs`, `npm run test:e2e`)
1. Zero dependencies: Node's `http`, `child_process`, `fetch` and the built-in `WebSocket` only. It finds Edge or Chrome
   (`E2E_BROWSER` overrides the path), and prints a clear skip message and exits 0 when none exists (exit 1 with `--require-browser`).
2. It starts the real Studio (`createWebServer`) on an ephemeral port, launches the browser headless with a temporary profile
   and a free DevTools port, and always cleans up both (processes and profile directory).
3. Checks at 1366x768 and 1920x1080: no horizontal overflow, header badges visible, no overlapping drawers.
4. Flows: `stringHash32` (tour docks, Causal Strip, Perf Parity chip, Compare vs. Naive AI, Mutant Autopsy, 3-way probe,
   Ed25519 and 1-byte tamper); `legacyReadConfigCb` and `legacyPromiseChain` (`async/await`, `tsc --strict: 0 errors`);
   Tab 2 `legacy-circular-ledger` (amber cycle edges, Cycle Resolved); the three drawers open and close by click and by Escape,
   one at a time.
5. Any `console.error`, uncaught exception (`Runtime.exceptionThrown`) or failed own-origin request fails the run.
## R3. Tests, counts and badges
1. `studio-ui.test.ts` covers the drawer manager (mutual exclusion, Escape, focus return, popover collapse, focus trap) and the
   new CSS and markup.
2. `27 Kiro Specs` in `kiro-dna.test.ts`, `kiro-power.test.ts`, `async-callback.test.ts`, `studio-ui.test.ts` and `#badgeSpecs`;
   `#badgeTests` shows the exact final passing count.
3. `npx tsc --noEmit` is 0, the full `npx vitest run` is green with no leaked node process, `npm run test:e2e` passes, and no
   temporary file is left.