import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SandboxError } from "../sandbox/errors.js";
import { PooledProbeRunner } from "../sandbox/pool.js";
import type { ProbeExecutor } from "../sandbox/types.js";
import { resurrectAny } from "../resurrect-any.js";
import { closeSharedTsVerifier } from "../crew/ts-verifier.js";

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

/** Input of the `resurrect_legacy` tool. */
export interface ResurrectLegacyInput {
  code: string;
  name?: string | undefined;
  functionName?: string | undefined;
  schema?: Record<string, "integer" | "number" | "string" | "boolean" | "json"> | undefined;
  fuzzRuns?: number | undefined;
  seed?: number | undefined;
}

const MAX_RESURRECT_CHARS = 64_000;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const PARAM_KINDS = ["integer", "number", "string", "boolean", "json"] as const;

/** One resurrection at a time: each call starts its own pair of sandbox workers, so a queue bounds the processes. */
let resurrectQueue: Promise<unknown> = Promise.resolve();
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = resurrectQueue.then(work, work);
  resurrectQueue = run.catch(() => undefined);
  return run;
}

/**
 * Resurrects legacy code the way the Web Studio and the CLI do (one router, src/resurrect-any.ts): an error-first callback or a
 * `.then().catch()` Promise chain becomes async/await with both settlements fuzzed; a multi-export module or a synchronous
 * function goes through the AST modernizer and exact `Object.is` differential fuzzing. The result is checked with tsc --strict.
 * Legacy code runs only inside the sandbox workers.
 */
export async function executeResurrect(input: ResurrectLegacyInput) {
  const fail = (code: string, message: string) => ({ isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }, null, 2) }] });
  if (input.code.length === 0 || input.code.length > MAX_RESURRECT_CHARS) return fail("INVALID_REQUEST", `code must be 1 to ${MAX_RESURRECT_CHARS} characters`);
  for (const key of Object.keys(input.schema ?? {})) if (!IDENTIFIER.test(key)) return fail("INVALID_REQUEST", `schema key "${key}" is not an identifier`);
  try {
    const result = await enqueue(async () => {
      try {
        return await resurrectAny({
          name: input.name ?? input.functionName ?? "resurrectedSpecimen",
          source: input.code,
          ...(input.schema !== undefined ? { schema: input.schema } : {}),
          fuzzRuns: input.fuzzRuns ?? 60,
          seed: input.seed ?? 1337,
          ...(input.functionName !== undefined ? { functionName: input.functionName } : {}),
        });
      } finally {
        await closeSharedTsVerifier();
      }
    });
    const report = {
      kind: result.kind,
      success: result.success,
      name: result.name,
      attempts: result.attempts,
      fuzzRuns: result.fuzzRuns,
      parity: result.success ? "exact Object.is" : "not proven",
      tsc: result.tsc,
      tscPassed: result.tscPassed,
      schema: result.schema,
      modernCode: result.modernCode,
      ...(result.asyncSummary !== undefined ? { async: result.asyncSummary } : {}),
      ...(result.ruleBlame !== undefined ? { ruleBlame: result.ruleBlame } : {}),
      ...(result.counterexample !== undefined ? { counterexample: result.counterexample } : {}),
      ...(result.exported !== undefined ? { bundleFiles: [...Object.keys(result.exported.bundle.files), "resurrection.patch"] } : {}),
    };
    return { isError: !result.success, content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
  } catch (err: unknown) {
    return fail(err instanceof SandboxError ? err.code : "INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
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

  server.tool(
    "resurrect_legacy",
    "Resurrect legacy JavaScript into modern ES2022 / strict TypeScript and prove behavioural parity inside the sandbox. Handles synchronous functions and scripts, multi-export CommonJS modules, Node.js error-first callbacks and `.then().catch()` Promise chains (both lifted to async/await with both the resolved and the rejected path fuzzed). Returns the resurrected code, the tsc --strict result, rule blame (which AST rule did what) and, on failure, the counterexample.",
    {
      code: z.string().min(1).max(MAX_RESURRECT_CHARS).describe("The legacy module or snippet, exactly as written"),
      name: z.string().regex(IDENTIFIER).max(80).optional().describe("Name of the specimen (default: the function name)"),
      functionName: z.string().regex(IDENTIFIER).max(80).optional().describe("Function or export to resurrect when the code has several"),
      schema: z.record(z.string().regex(IDENTIFIER), z.enum(PARAM_KINDS)).optional().describe("Fuzz schema {param: kind}; default: inferred from the code"),
      fuzzRuns: z.number().int().min(5).max(500).optional().describe("Fuzz runs per attempt (default 60)"),
      seed: z.number().int().optional().describe("Deterministic fuzz seed (default 1337)"),
    },
    async (input) => executeResurrect(input)
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
