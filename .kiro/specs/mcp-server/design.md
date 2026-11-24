# MCP Server Design

- Transport: `StdioServerTransport` from `@modelcontextprotocol/sdk`.
- Tool: `run_legacy_probe` → `executeLegacyProbe(executor, input)`.
- Executor: one lazily started `PooledProbeRunner` (one warm worker, fresh vm context per call,
  respawned after a timeout or crash). Closed on `SIGINT`, `SIGTERM`, or stdin end.
- Output: `LegacyProbeReport` serialised as a single text content block.
- Errors: `SandboxError` → `isError: true` with code and message; the stdio stream is never broken.
