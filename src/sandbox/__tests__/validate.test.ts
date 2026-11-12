// Task 3.4 + 3.5: Unit tests and fast-check property tests for validate.ts

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  isJsonRpcEnvelope,
  isProbeParams,
  isSandboxRequest,
} from "../validate.js";
import { SandboxError } from "../errors.js";

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("isJsonRpcEnvelope", () => {
  it("accepts a valid envelope", () => {
    expect(
      isJsonRpcEnvelope({
        jsonrpc: "2.0",
        id: 1,
        method: "sandbox.ping",
        params: {},
      })
    ).toBe(true);
  });

  it("rejects non-objects", () => {
    for (const v of [null, undefined, 42, "str", []]) {
      expect(() => isJsonRpcEnvelope(v)).toThrow(SandboxError);
    }
  });

  it("rejects wrong jsonrpc version", () => {
    expect(() =>
      isJsonRpcEnvelope({ jsonrpc: "1.0", id: 1, method: "foo", params: {} })
    ).toThrow(SandboxError);
  });

  it("rejects missing jsonrpc", () => {
    expect(() =>
      isJsonRpcEnvelope({ id: 1, method: "foo", params: {} })
    ).toThrow(SandboxError);
  });

  it("rejects invalid id types", () => {
    expect(() =>
      isJsonRpcEnvelope({ jsonrpc: "2.0", id: true, method: "foo", params: {} })
    ).toThrow(SandboxError);
  });

  it("accepts null id", () => {
    expect(
      isJsonRpcEnvelope({ jsonrpc: "2.0", id: null, method: "ping", params: {} })
    ).toBe(true);
  });

  it("rejects empty method", () => {
    expect(() =>
      isJsonRpcEnvelope({ jsonrpc: "2.0", id: 1, method: "", params: {} })
    ).toThrow(SandboxError);
  });

  it("rejects missing params", () => {
    expect(() =>
      isJsonRpcEnvelope({ jsonrpc: "2.0", id: 1, method: "foo" })
    ).toThrow(SandboxError);
  });
});

describe("isProbeParams", () => {
  it("accepts valid probe params", () => {
    expect(isProbeParams({ code: "1 + 1" })).toBe(true);
    expect(isProbeParams({ code: "1 + 1", context: { x: 42 } })).toBe(true);
  });

  it("rejects empty code string", () => {
    expect(() => isProbeParams({ code: "" })).toThrow(SandboxError);
  });

  it("rejects non-string code", () => {
    expect(() => isProbeParams({ code: 42 })).toThrow(SandboxError);
  });

  it("rejects array context", () => {
    expect(() => isProbeParams({ code: "x", context: [1, 2] })).toThrow(SandboxError);
  });

  it("accepts undefined context", () => {
    expect(isProbeParams({ code: "x" })).toBe(true);
  });
});

describe("isSandboxRequest", () => {
  it("accepts sandbox.ping", () => {
    expect(
      isSandboxRequest({ jsonrpc: "2.0", id: 1, method: "sandbox.ping", params: {} })
    ).toBe(true);
  });

  it("accepts sandbox.shutdown", () => {
    expect(
      isSandboxRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "sandbox.shutdown",
        params: {},
      })
    ).toBe(true);
  });

  it("accepts sandbox.probe with valid params", () => {
    expect(
      isSandboxRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "sandbox.probe",
        params: { code: "1 + 1" },
      })
    ).toBe(true);
  });

  it("rejects unknown methods", () => {
    expect(() =>
      isSandboxRequest({
        jsonrpc: "2.0",
        id: 4,
        method: "sandbox.hack",
        params: {},
      })
    ).toThrow(SandboxError);
  });

  it("rejects sandbox.probe with empty code", () => {
    expect(() =>
      isSandboxRequest({
        jsonrpc: "2.0",
        id: 5,
        method: "sandbox.probe",
        params: { code: "" },
      })
    ).toThrow(SandboxError);
  });
});

// ---------------------------------------------------------------------------
// Property-based tests (fast-check)
// ---------------------------------------------------------------------------

describe("property: isJsonRpcEnvelope never throws uncaught", () => {
  it("handles arbitrary input without unhandled exceptions", () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        try {
          isJsonRpcEnvelope(v);
        } catch (e) {
          // Only SandboxError is acceptable
          expect(e).toBeInstanceOf(SandboxError);
        }
      }),
      { numRuns: 500 }
    );
  });
});

describe("property: isProbeParams never throws uncaught", () => {
  it("handles arbitrary input without unhandled exceptions", () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        try {
          isProbeParams(v);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxError);
        }
      }),
      { numRuns: 500 }
    );
  });
});

describe("property: isSandboxRequest never throws uncaught", () => {
  it("handles arbitrary input without unhandled exceptions", () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        try {
          isSandboxRequest(v);
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxError);
        }
      }),
      { numRuns: 500 }
    );
  });
});

describe("property: valid envelope record always passes isJsonRpcEnvelope", () => {
  it("well-formed envelopes are accepted", () => {
    fc.assert(
      fc.property(
        fc.record({
          jsonrpc: fc.constant("2.0"),
          id: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
          method: fc.string({ minLength: 1 }),
          params: fc.anything(),
        }),
        (v) => {
          expect(isJsonRpcEnvelope(v)).toBe(true);
        }
      ),
      { numRuns: 300 }
    );
  });
});
