/// <reference types="node" />
// Task 2: SandboxError class with JSON-RPC 2.0 serialisation.

import type {
  JsonRpcError,
  JsonRpcId,
  SandboxErrorCode,
  SandboxErrorData,
} from "./types.js";

// ---------------------------------------------------------------------------
// Mapping from semantic code → JSON-RPC numeric error code
// Application-defined codes live in the -32000 to -32099 range.
// INVALID_REQUEST uses the standard -32600.
// ---------------------------------------------------------------------------
const NUMERIC_CODES: Record<SandboxErrorCode, number> = {
  INVALID_REQUEST: -32600,
  TIMEOUT: -32001,
  MEMORY_EXCEEDED: -32002,
  NETWORK_BLOCKED: -32003,
  FS_WRITE_DENIED: -32004,
  EXECUTION_ERROR: -32005,
  INTERNAL_ERROR: -32099,
};

const MESSAGES: Record<SandboxErrorCode, string> = {
  INVALID_REQUEST: "Invalid request",
  TIMEOUT: "Execution timed out",
  MEMORY_EXCEEDED: "Memory limit exceeded",
  NETWORK_BLOCKED: "Outbound network access is blocked",
  FS_WRITE_DENIED: "Filesystem write outside allowed directory",
  EXECUTION_ERROR: "Execution error",
  INTERNAL_ERROR: "Internal sandbox error",
};

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly detail: string | undefined;

  constructor(code: SandboxErrorCode, detail?: string) {
    super(detail ?? MESSAGES[code]);
    this.name = "SandboxError";
    this.code = code;
    this.detail = detail;
  }

  toJsonRpcError(id: JsonRpcId): JsonRpcError {
    const data: SandboxErrorData = {
      sandboxCode: this.code,
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
    };

    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: NUMERIC_CODES[this.code],
        message: MESSAGES[this.code],
        data,
      },
    };
  }

  /** Convenience: wrap an arbitrary unknown thrown value as a SandboxError. */
  static from(err: unknown, fallback: SandboxErrorCode = "INTERNAL_ERROR"): SandboxError {
    if (err instanceof SandboxError) return err;
    const detail =
      err instanceof Error ? err.message : String(err);
    return new SandboxError(fallback, detail);
  }
}
