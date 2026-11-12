import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SandboxError } from "../sandbox/errors.js";
import { ProbeRunner } from "../sandbox/runner.js";

export interface LegacyProbeInput {
  code: string;
  context?: Record<string, unknown>;
}

export async function executeLegacyProbe(
  runner: ProbeRunner,
  input: LegacyProbeInput
) {
  try {
    const result = await runner.run({
      code: input.code,
      ...(input.context !== undefined ? { context: input.context } : {}),
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err: unknown) {
    const code = err instanceof SandboxError ? err.code : "INTERNAL_ERROR";
    const message = err instanceof Error ? err.message : String(err);

    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: { code, message } }, null, 2),
        },
      ],
    };
  }
}

export function createLazarusMcpServer(runner: ProbeRunner = new ProbeRunner()): McpServer {
  const server = new McpServer({
    name: "lazarus-sandbox",
    version: "1.0.0",
  });

  server.tool(
    "run_legacy_probe",
    "Execute untrusted legacy JavaScript inside the isolated Lazarus sandbox and return output, durationMs, and memoryUsedBytes. Code must evaluate to a final expression or use an IIFE (() => { ... })().",
    {
      code: z.string().min(1).describe("Legacy JavaScript expression or IIFE to probe"),
      context: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional global variables injected into the sandbox probe"),
    },
    async ({ code, context }) =>
      executeLegacyProbe(runner, context !== undefined ? { code, context } : { code })
  );

  return server;
}

const isMain =
  process.argv[1] !== undefined &&
  nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const server = createLazarusMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
