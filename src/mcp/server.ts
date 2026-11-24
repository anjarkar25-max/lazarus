import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SandboxError } from "../sandbox/errors.js";
import { PooledProbeRunner } from "../sandbox/pool.js";
import type { ProbeExecutor } from "../sandbox/types.js";

export interface LegacyProbeInput {
  code: string;
  context?: Record<string, unknown>;
}

/** JSON body returned by run_legacy_probe on success. */
export interface LegacyProbeReport {
  readonly returnValue: unknown;
  /** Same value as returnValue; kept for clients written against the first version. */
  readonly output: unknown;
  readonly stdout: string;
  readonly stderr: string;
  readonly metrics: {
    readonly durationMs: number;
    readonly memoryUsedBytes: number;
  };
  readonly durationMs: number;
  readonly memoryUsedBytes: number;
}

export async function executeLegacyProbe(runner: ProbeExecutor, input: LegacyProbeInput) {
  try {
    const result = await runner.run({
      code: input.code,
      ...(input.context !== undefined ? { context: input.context } : {}),
    });

    const report: LegacyProbeReport = {
      returnValue: result.output,
      output: result.output,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      metrics: { durationMs: result.durationMs, memoryUsedBytes: result.memoryUsedBytes },
      durationMs: result.durationMs,
      memoryUsedBytes: result.memoryUsedBytes,
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(report, null, 2),
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

/**
 * @param runner Defaults to a lazily started warm sandbox worker (no process is spawned
 *               until the first tool call).
 */
export function createLazarusMcpServer(runner: ProbeExecutor = new PooledProbeRunner()): McpServer {
  const server = new McpServer({
    name: "lazarus-sandbox",
    version: "1.1.0",
  });

  server.tool(
    "run_legacy_probe",
    "Execute untrusted legacy JavaScript inside the isolated Lazarus sandbox (256 MB, 3000 ms, no network, no writes outside /tmp/lazarus-sandbox). Returns returnValue, captured stdout/stderr, and metrics. Code must evaluate to a final expression or use an IIFE (() => { ... })().",
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
  const pool = new PooledProbeRunner();
  const server = createLazarusMcpServer(pool);
  const stop = (): void => {
    void pool.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdin.on("end", stop);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
