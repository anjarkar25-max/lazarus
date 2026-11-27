// Task 3: Runtime validation — type predicates for JSON-RPC 2.0 payloads.
// No external schema library. Pure TypeScript with strict mode.

import { SandboxError } from "./errors.js";
import { validateVirtualFiles } from "./virtual-fs.js";
import type {
  JsonRpcId,
  ProbeParams,
  SandboxRequest,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  // Accept both plain objects ({}) and null-prototype objects (Object.create(null))
  return proto === Object.prototype || proto === null;
}

function isValidId(v: unknown): v is JsonRpcId {
  return typeof v === "string" || typeof v === "number" || v === null;
}

// ---------------------------------------------------------------------------
// 3.1  isJsonRpcEnvelope
// ---------------------------------------------------------------------------

export interface JsonRpcEnvelope {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params: unknown;
}

/**
 * Validates the outer JSON-RPC 2.0 wrapper.
 * Returns true when the value conforms; throws SandboxError(INVALID_REQUEST)
 * on invalid input so callers can either guard-check or catch.
 */
export function isJsonRpcEnvelope(v: unknown): v is JsonRpcEnvelope {
  if (!isPlainObject(v)) {
    throw new SandboxError("INVALID_REQUEST", "Payload must be a JSON object");
  }
  if (v["jsonrpc"] !== "2.0") {
    throw new SandboxError(
      "INVALID_REQUEST",
      `Expected jsonrpc "2.0", got ${JSON.stringify(v["jsonrpc"])}`
    );
  }
  if (!isValidId(v["id"])) {
    throw new SandboxError(
      "INVALID_REQUEST",
      "id must be a string, number, or null"
    );
  }
  if (typeof v["method"] !== "string" || v["method"].length === 0) {
    throw new SandboxError("INVALID_REQUEST", "method must be a non-empty string");
  }
  if (!("params" in v)) {
    throw new SandboxError("INVALID_REQUEST", "params field is required");
  }
  return true;
}

// ---------------------------------------------------------------------------
// 3.2  isProbeParams
// ---------------------------------------------------------------------------

/**
 * Validates `sandbox.probe` params: code is a non-empty string,
 * context (when present) is a plain object.
 */
export function isProbeParams(v: unknown): v is ProbeParams {
  if (!isPlainObject(v)) {
    throw new SandboxError("INVALID_REQUEST", "probe params must be a JSON object");
  }
  if (typeof v["code"] !== "string" || v["code"].length === 0) {
    throw new SandboxError(
      "INVALID_REQUEST",
      "params.code must be a non-empty string"
    );
  }
  if ("context" in v && v["context"] !== undefined) {
    if (!isPlainObject(v["context"])) {
      throw new SandboxError(
        "INVALID_REQUEST",
        "params.context must be a plain object when provided"
      );
    }
  }
  if ("encoding" in v && v["encoding"] !== undefined && v["encoding"] !== "json" && v["encoding"] !== "tagged") {
    throw new SandboxError("INVALID_REQUEST", 'params.encoding must be "json" or "tagged" when provided');
  }
  if ("settle" in v && v["settle"] !== undefined && typeof v["settle"] !== "boolean") {
    throw new SandboxError("INVALID_REQUEST", "params.settle must be a boolean when provided");
  }
  if ("files" in v && v["files"] !== undefined) validateVirtualFiles(v["files"], v["entry"]);
  else if ("entry" in v && v["entry"] !== undefined) throw new SandboxError("INVALID_REQUEST", "params.entry requires params.files");
  return true;
}

// ---------------------------------------------------------------------------
// 3.3  isSandboxRequest
// ---------------------------------------------------------------------------

const KNOWN_METHODS = new Set([
  "sandbox.probe",
  "sandbox.ping",
  "sandbox.shutdown",
]);

/**
 * Full validation: checks the envelope, then validates params for the method.
 * Throws SandboxError(INVALID_REQUEST) on any violation.
 */
export function isSandboxRequest(v: unknown): v is SandboxRequest {
  isJsonRpcEnvelope(v); // throws on invalid envelope

  // After isJsonRpcEnvelope we know v is JsonRpcEnvelope
  const env = v as JsonRpcEnvelope;

  if (!KNOWN_METHODS.has(env.method)) {
    throw new SandboxError(
      "INVALID_REQUEST",
      `Unknown method: ${env.method}`
    );
  }

  if (env.method === "sandbox.probe") {
    isProbeParams(env.params); // throws on invalid params
  }

  return true;
}
