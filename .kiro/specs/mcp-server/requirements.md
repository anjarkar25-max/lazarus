# MCP Server Requirements

- Expose a run_legacy_probe tool over stdio MCP transport.
- Validate inputs (code, optional context, optional timeoutMs) using Zod.
- Delegate execution strictly to ProbeRunner inside the isolated sandbox.
- Return structured JSON output (stdout, stderr, returnValue, durationMs) or structured SandboxError details.
