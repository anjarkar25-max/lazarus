# Design: Flagship Studio Polish

## Deck
A single transformation script cuts the matrix, the legacy diff, certificate + audit, bundle panel and probe card out of
the middle column (strict single-match anchors, re-indented) and rebuilds them as `#verifyDeck` after `</main>` inside
`#pane-single`. Source order is kept, so every pinned order relation still holds. Scripts look elements up by ID, so
behaviour is unchanged. `.deck-grid` is `minmax(0, 1fr) minmax(0, 1fr)` with `min-width: 0` columns.

## Traces
- `orchestrator.ts`: `traceSandbox(agent, run, summarize)` reads the summed `stats.spawns` / `stats.probes` of the
  session's pools before and after the batch and times it with `performance.now()`. Pools are known when the
  orchestrator creates them, or when an injected runner is a `PooledProbeRunner`; otherwise `poolReused` is null and no
  counts are reported. The Architect's existing `modernize()` call is timed in place (no extra work).
- `server.ts`: times its own `scanLegacyAst` (one scan instead of two) and reports the verifier's result after
  `buildExportBundle`. Server traces are streamed immediately and merged into `result.events` (scan first, tsc last).
- `ts-verifier.ts`: `reusedProcess` = the API instance existed before this check.
- UI: the main SSE loop sends `mcp_trace` events to `window.LazarusTrace` and skips the crew-card/log handling.

## PR summary
`generateCertificate` supplies the digest, provenance line, modernized/rolled-back rules, parity, typecheck and
mutation fields (with its validation), so the summary and the certificate cannot disagree. The diff uses the shared LCS
helper. `buildExportBundle` builds one `CertificateInput` and uses it for both.

## Benchmark
`runPreset` mirrors `/api/resurrect`: `scanLegacyAst` → orchestrator (exact, observations) → `inferSignature` →
`buildExportBundle` (the strict check). Module presets go through `resurrectModule`. `runBenchmark` closes the shared
verifier in `finally`; orchestrator and module runs dispose their own pools.
