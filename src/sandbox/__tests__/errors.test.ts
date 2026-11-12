// Task 2.3: Unit tests for SandboxError and JSON-RPC serialisation.

import { describe, expect, it } from "vitest";
import { SandboxError } from "../errors.js";
import type { SandboxErrorCode } from "../types.js";

const CODE_MAP: Array<[SandboxErrorCode, number]> = [
  ["INVALID_REQUEST", -32600],
  ["TIMEOUT", -32001],
  ["MEMORY_EXCEEDED", -32002],
  ["NETWORK_BLOCKED", -32003],
  ["FS_WRITE_DENIED", -32004],
  ["EXECUTION_ERROR", -32005],
  ["INTERNAL_ERROR", -32099],
];

describe("SandboxError", () => {
  it("is an instance of Error", () => {
    const err = new SandboxError("TIMEOUT");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SandboxError);
  });

  it("sets .name to SandboxError", () => {
    expect(new SandboxError("INTERNAL_ERROR").name).toBe("SandboxError");
  });

  it.each(CODE_MAP)(
    "maps SandboxErrorCode %s → JSON-RPC code %d",
    (sandboxCode, expectedNumericCode) => {
      const err = new SandboxError(sandboxCode);
      const jsonRpc = err.toJsonRpcError(null);
      expect(jsonRpc.error.code).toBe(expectedNumericCode);
    }
  );

  it("preserves the detail string in .data.detail", () => {
    const err = new SandboxError("EXECUTION_ERROR", "boom");
    const jsonRpc = err.toJsonRpcError(1);
    expect(jsonRpc.error.data?.detail).toBe("boom");
  });

  it("preserves sandboxCode in .data.sandboxCode", () => {
    const err = new SandboxError("TIMEOUT", "took too long");
    const jsonRpc = err.toJsonRpcError(42);
    expect(jsonRpc.error.data?.sandboxCode).toBe("TIMEOUT");
  });

  describe("forwards id unchanged", () => {
    it("string id", () => {
      const jsonRpc = new SandboxError("INTERNAL_ERROR").toJsonRpcError("abc");
      expect(jsonRpc.id).toBe("abc");
    });

    it("numeric id", () => {
      const jsonRpc = new SandboxError("INTERNAL_ERROR").toJsonRpcError(99);
      expect(jsonRpc.id).toBe(99);
    });

    it("null id", () => {
      const jsonRpc = new SandboxError("INTERNAL_ERROR").toJsonRpcError(null);
      expect(jsonRpc.id).toBeNull();
    });
  });

  it("always sets jsonrpc to '2.0'", () => {
    const jsonRpc = new SandboxError("TIMEOUT").toJsonRpcError(1);
    expect(jsonRpc.jsonrpc).toBe("2.0");
  });

  describe("SandboxError.from", () => {
    it("passes through an existing SandboxError unchanged", () => {
      const original = new SandboxError("TIMEOUT", "slow");
      expect(SandboxError.from(original)).toBe(original);
    });

    it("wraps a plain Error", () => {
      const wrapped = SandboxError.from(new Error("oops"));
      expect(wrapped).toBeInstanceOf(SandboxError);
      expect(wrapped.code).toBe("INTERNAL_ERROR");
      expect(wrapped.detail).toBe("oops");
    });

    it("wraps a string", () => {
      const wrapped = SandboxError.from("something bad");
      expect(wrapped.detail).toBe("something bad");
    });

    it("respects the fallback code", () => {
      const wrapped = SandboxError.from(new Error("x"), "EXECUTION_ERROR");
      expect(wrapped.code).toBe("EXECUTION_ERROR");
    });
  });
});
