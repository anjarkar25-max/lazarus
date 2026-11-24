# Requirements: Flagship Studio Polish

## Introduction
Three final upgrades: a full-width Verification Deck, a live MCP Wire-Trace inspector built from real execution data,
and a one-click GitHub PR summary plus a local benchmark runner. No existing route, DOM hook or test may regress.

Constraints: zero new runtime dependencies, strict TypeScript, no frameworks in the page (`textContent` only),
palette per `ui-aesthetics.md`, SSE transport unchanged. Legacy code still runs only in pooled sandbox workers.

## Requirements

### R1. Verification Deck (`public/index.html`)
1. The three-column Operating Table keeps live input, spec/code output and crew telemetry only.
2. A full-width "Verification Deck" under it holds, at full width, the Self-Healing Matrix (Attempt 1 vs. verified
   code and the red/green LCS diff) and the Legacy vs. Resurrected diff, then a two-column grid with the Resurrection
   Certificate and the Mutation Audit on the left, the PR Bundle Exporter and the Probe card on the right. One column
   below 1100 px.
3. Blocks are moved, not rewritten. IDs, texts and the order relations the tests pin are unchanged
   (matrix before probe, certificate before audit, bundle before probe, signature pill before code).
4. No horizontal overflow at 1366×768 or 1920×1080. The matrix's two columns are each at least 480 px wide at 1366 px.
5. Singular/plural: "1 file" / "2 files", "1 error" / "0 errors" in every `tsc --strict` label (UI badge and tooltip,
   graph verdict, graph log, certificate, SPEC.md, CLI), from one shared `plural()` helper.

### R2. MCP Wire Trace
1. A new crew event type `mcp_trace` with payload `{ tool, durationMs, poolReused, summary, probes?, spawned? }`,
   measured from the actual execution:
   - every sandbox probe batch (Archaeologist sampling, each Exorcist fuzz run): tool
     `lazarus-sandbox/run_legacy_probe` (the MCP server's real tool), wall time, and `probes`/`spawned` from the
     pools' own counters. `poolReused` is true when no worker had to start during the batch, null when the executors
     are not pools;
   - the Architect's AST analysis and the server's specimen scan: `lazarus/ast_scan`, `poolReused: null`;
   - the strict TypeScript check behind `/api/resurrect`: `lazarus/tsc_strict`, the verifier's own `elapsedMs`, and
     `poolReused` = the warm compiler process was reused (`reusedProcess`, a new verifier field).
2. `/api/resurrect` streams these as SSE `event` frames and includes them in the result's `events`.
3. The telemetry card has a `Crew Log | MCP Wire Trace` toggle (Crew Log by default; trace count badge). Trace events
   are shown only in the trace view, so the default log is unchanged.

### R3. PR summary and benchmark
1. `buildGitHubPrSummary(input)` (`src/exporter/pr-summary.ts`) returns deterministic Markdown: title, provenance and
   legacy SHA-256 (plus certificate id), exact `Object.is` run count (boundary share), self-healing summary (attempts,
   rolled-back rules), `tsc --strict` status, mutation kill score only when an audit ran, debt score, modernized idioms
   and a compact unified diff (1 line of context, at most 40 lines, Lazarus' own header comments excluded).
2. `/api/export-bundle` returns `prSummary`, built server-side from the same verified inputs as the certificate
   (client claims about tsc are ignored, the kill score is validated). A "Copy GitHub PR Summary" button in the PR
   Bundle bar copies it.
3. `npm run benchmark` (`npx tsx src/benchmark.ts`) runs every curated single-file preset through the real
   orchestrator and strict verifier and prints a Markdown table (specimen, parity, attempts, fuzz runs, tsc --strict,
   duration ms). `--runs` and `--only` select a subset. Exit code 1 when any row fails. Pools and the warm compiler are
   closed; no processes leak.
4. The benchmark's preset list (`src/benchmark-presets.ts`) is byte-for-byte the UI's presets (tested).

### R4. Tests
`src/exporter/__tests__/pr-summary.test.ts`, `src/web/__tests__/mcp-trace.test.ts`, studio UI updates: summary
determinism and content, singular "1 file", real `mcp_trace` SSE events with measured values on `POST /api/resurrect`,
deck structure, toggle, copy button, inline JS parsed by acorn, benchmark table and preset parity, `npx tsc --noEmit`,
full `npx vitest run`, no leaked Node processes.
