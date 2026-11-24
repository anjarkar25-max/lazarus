# Tasks: Flagship Studio Polish
- [x] 1. Shared `plural()`; fix every `tsc --strict` label (verifier, graph log, graph SPEC, UI badge tooltip, graph verdict).
- [x] 2. `mcp_trace` event type; measured traces in the orchestrator (sandbox batches, AST scan); `reusedProcess` in the verifier.
- [x] 3. Server: specimen-scan and tsc traces on `/api/resurrect`; `prSummary` on `/api/export-bundle`.
- [x] 4. `src/exporter/pr-summary.ts` (`buildGitHubPrSummary`, `compactDiff`, `stripGeneratedHeader`).
- [x] 5. UI: Verification Deck, `Crew Log | MCP Wire Trace` toggle, Copy GitHub PR Summary button.
- [x] 6. `src/benchmark-presets.ts`, `src/benchmark.ts`, `npm run benchmark`.
- [x] 7. Tests: `pr-summary.test.ts`, `mcp-trace.test.ts`, studio UI and benchmark checks.
- [x] 8. Verify: browser check (overflow, deck widths, live traces), `tsc`, full `vitest run`, leak check, badge counts.
