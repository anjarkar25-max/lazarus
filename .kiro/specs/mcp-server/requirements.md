# MCP Server Requirements

- Expose a `run_legacy_probe` tool over the stdio MCP transport, registered as `lazarus-sandbox`.
- Validate inputs with Zod: `code` (non-empty string), optional `context` (string-keyed record).
  The time limit is fixed at 3000 ms by `sandbox-security.md`, so it is not a caller parameter.
- Never execute legacy code in the MCP process: delegate to a sandbox executor
  (`PooledProbeRunner` by default; any `ProbeExecutor` can be injected).
- On success return JSON with `returnValue`, `stdout`, `stderr`, and
  `metrics { durationMs, memoryUsedBytes }` (plus the original `output`, `durationMs`,
  `memoryUsedBytes` fields for compatibility).
- On failure return `isError: true` with `{ error: { code, message } }`, where `code` is a `SandboxErrorCode`.
