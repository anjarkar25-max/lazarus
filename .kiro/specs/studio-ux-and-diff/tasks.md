# Tasks: Studio UX and Diff
- [x] 1. Map the HTML contracts the existing tests pin (IDs, texts, DOM order) before changing anything.
- [x] 2. `src/web/line-diff.ts`: LCS line diff with prefix/suffix trimming, size fallback, stats.
- [x] 3. Restructure `public/index.html`: header + badges + tour controls, tablist, three panes (existing blocks moved intact), Red-Team Lab with isolation spec.
- [x] 4. Diff UI: Self-Healing Diff in the matrix, Legacy vs. Resurrected toggle, `tsc --strict` badge.
- [x] 5. Event hooks in the existing scripts; Studio script (tabs, shipped diff copy, tour with cancel).
- [x] 6. Live browser verification in headless Edge: no runtime errors, zero overflow per tab at 1366×768 and 1920×1080, full tour, state kept across tabs.
- [x] 7. Tests: `src/web/__tests__/studio-ui.test.ts`.
- [x] 8. Verify: `tsc`, full `vitest run`, leak check; set the tests badge to the real suite size.
