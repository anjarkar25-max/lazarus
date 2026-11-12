# MCP Server Design

- Transport: StdioServerTransport from @modelcontextprotocol/sdk.
- Tool: run_legacy_probe wrapping ProbeRunner.run().
- Error Handling: Catch SandboxError and return isError: true with error code and message without crashing the stdio stream.
