/// <reference types="node" />
// Task 7: RpcRouter — reads newline-delimited JSON from stdin, dispatches to
// method handlers, writes newline-delimited JSON responses to stdout.

import * as readline from "node:readline";
import { SandboxError } from "./errors.js";
import { isSandboxRequest } from "./validate.js";
import { ProbeRunner } from "./runner.js";
import type {
  JsonRpcError,
  JsonRpcId,
  JsonRpcSuccess,
  PingResult,
  ProbeExecutor,
  ProbeResult,
  SandboxRequest,
  ShutdownResult,
} from "./types.js";

export interface RouterDeps {
  /** Override for testing — defaults to process.stdin */
  input?: NodeJS.ReadableStream;
  /** Override for testing — defaults to process.stdout */
  output?: NodeJS.WritableStream;
  /** Override for testing — defaults to process.exit */
  exit?: (code: number) => never | void;
  /** Override for testing */
  runner?: ProbeExecutor | undefined;
}

export class RpcRouter {
  private readonly rl: readline.Interface;
  private readonly output: NodeJS.WritableStream;
  private readonly exit: (code: number) => never | void;
  private readonly runner: ProbeExecutor;

  constructor(deps: RouterDeps = {}) {
    const input = deps.input ?? process.stdin;
    this.output = deps.output ?? process.stdout;
    this.exit = deps.exit ?? ((c) => process.exit(c));
    this.runner = deps.runner ?? new ProbeRunner();

    this.rl = readline.createInterface({
      input,
      crlfDelay: Infinity,
      terminal: false,
    });

    this.rl.on("line", (line) => {
      void this.handleLine(line);
    });
  }

  close(): void {
    this.rl.close();
  }

  private writeLine(obj: unknown): void {
    this.output.write(JSON.stringify(obj) + "\n");
  }

  private buildSuccess<R>(id: JsonRpcId, result: R): JsonRpcSuccess<R> {
    return { jsonrpc: "2.0", id, result };
  }

  private extractId(parsed: unknown): JsonRpcId {
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "id" in parsed
    ) {
      const raw = (parsed as Record<string, unknown>)["id"];
      if (typeof raw === "string" || typeof raw === "number" || raw === null) {
        return raw;
      }
    }
    return null;
  }

  private async handleLine(line: string): Promise<void> {
    // 1. Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // JSON parse error: -32700
      const err: JsonRpcError = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      };
      this.writeLine(err);
      return;
    }

    // 2. Validate as a known SandboxRequest
    let request: SandboxRequest;
    try {
      isSandboxRequest(parsed);
      // isSandboxRequest throws on failure; if we reach here, the cast is safe
      request = parsed as SandboxRequest;
    } catch (e) {
      const sandboxErr = SandboxError.from(e, "INVALID_REQUEST");
      this.writeLine(sandboxErr.toJsonRpcError(this.extractId(parsed)));
      return;
    }

    const { id } = request;

    // 3. Dispatch
    try {
      switch (request.method) {
        case "sandbox.ping": {
          const result: PingResult = { pong: true };
          this.writeLine(this.buildSuccess<PingResult>(id, result));
          break;
        }

        case "sandbox.probe": {
          const probeResult: ProbeResult = await this.runner.run(request.params);
          this.writeLine(this.buildSuccess<ProbeResult>(id, probeResult));
          break;
        }

        case "sandbox.shutdown": {
          const result: ShutdownResult = { acknowledged: true };
          this.writeLine(this.buildSuccess<ShutdownResult>(id, result));
          this.rl.close();
          this.exit(0);
          break;
        }
      }
    } catch (e) {
      // Preserve the original SandboxError code; only fall back to EXECUTION_ERROR
      // for unexpected non-SandboxError exceptions.
      const sandboxErr = e instanceof SandboxError ? e : SandboxError.from(e, "EXECUTION_ERROR");
      this.writeLine(sandboxErr.toJsonRpcError(id));
    }
  }
}
