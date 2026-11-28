# Tasks: V17 UX and E2E Audit
- [x] 1. Drawer manager: `lz-drawers` region, mutual exclusion, Escape with focus return, popover collapse, focus trap.
- [x] 2. Wire Kiro DNA, Verify Bundle and SARIF Audit into the manager (fallback listeners kept).
- [x] 3. CSS polish: focus-visible, disabled and busy states, overflow and drawer sizing at 1366x768 and 1920x1080.
- [x] 4. `aria-busy` on Compare vs. Naive AI, RUN PROBE, the SARIF run button and Simulate 1-Byte Tamper.
- [x] 5. `scripts/e2e-smoke.mjs` and `"test:e2e"` in `package.json`.
- [x] 6. Tests: drawer manager, CSS and markup, spec counts 27, Tab 3 SHA-256 unchanged.
- [x] 7. Live run: `npm run test:e2e` passes with 0 browser errors.
- [x] 8. Verify: `npx tsc --noEmit`, full `npx vitest run`, badges, temp-file cleanup.