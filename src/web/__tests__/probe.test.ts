import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebServer, type ProbeResponse } from "../server.js";

describe("POST /api/probe", () => {
  const server = createWebServer();
  let baseUrl = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  async function probe(body: unknown, raw = false): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}/api/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ? String(body) : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }
  const ok = async (body: unknown): Promise<ProbeResponse> => {
    const { status, json } = await probe(body);
    expect(status).toBe(200);
    return json as unknown as ProbeResponse;
  };

  const LEGACY = "(n / 2) | 0";

  it("reports exact parity when both sides return the same value", async () => {
    const res = await ok({ legacyCode: LEGACY, modernCode: "Math.trunc(n / 2) || 0", context: { n: 7 } });
    expect(res.exactParity).toBe(true);
    expect(res.legacy).toMatchObject({ ok: true, display: "3" });
    expect(res.modern).toMatchObject({ ok: true, display: "3" });
    expect(res.reason).toContain("Object.is parity");
  });

  it("distinguishes -0 from +0 (the sign of zero is a mismatch)", async () => {
    // `(-1 / 2) | 0` is +0; plain Math.trunc(-0.5) is -0.
    const res = await ok({ legacyCode: LEGACY, modernCode: "Math.trunc(n / 2)", context: { n: -1 } });
    expect(res.exactParity).toBe(false);
    expect(res.legacy.display).toBe("0");
    expect(res.modern.display).toBe("-0");
    expect(res.reason).toContain("sign of zero differs");
  });

  it("accepts a tagged -0 input and the exact rewrite stays in parity for it", async () => {
    const res = await ok({ legacyCode: LEGACY, modernCode: "Math.trunc(n / 2) || 0", context: { n: { $lazarus: "-0" } } });
    expect(res.exactParity).toBe(true);
    expect(res.modern.display).toBe("0");
    const asserted = await ok({ legacyCode: "Object.is(n, -0)", modernCode: "Object.is(n, -0)", context: { n: { $lazarus: "-0" } } });
    expect(asserted.legacy.display).toBe("true");
  });

  it("treats NaN as equal to NaN and different from 0", async () => {
    const same = await ok({ legacyCode: "x * 2", modernCode: "x + x", context: { x: { $lazarus: "NaN" } } });
    expect(same.exactParity).toBe(true);
    expect(same.legacy.display).toBe("NaN");

    const different = await ok({ legacyCode: "x | 0", modernCode: "Math.trunc(x)", context: { x: { $lazarus: "NaN" } } });
    expect(different.exactParity).toBe(false);
    expect(different.legacy.display).toBe("0");
    expect(different.modern.display).toBe("NaN");
    expect(different.reason).toContain("NaN differs");
  });

  it("handles the empty string, large integers and undefined results", async () => {
    expect((await ok({ legacyCode: "s.length", modernCode: "s.length", context: { s: "" } })).legacy.display).toBe("0");
    expect((await ok({ legacyCode: LEGACY, modernCode: "Math.trunc(n / 2) || 0", context: { n: 2147483648 } })).exactParity).toBe(true);
    const undef = await ok({ legacyCode: "void n", modernCode: "undefined", context: { n: 1 } });
    expect(undef.exactParity).toBe(true);
    expect(undef.legacy.display).toBe("undefined");
  });

  it("extracts the specimen from a multi-parameter CommonJS module before probing", async () => {
    const res = await ok({
      legacyCode: "module.exports = function mix(a, b) {\n  var s = a * 3 + b;\n  return (s / 2) | 0;\n};",
      modernCode: "Math.trunc((a * 3 + b) / 2) || 0",
      context: { a: 5, b: 4 },
    });
    expect(res.legacy.display).toBe("9");
    expect(res.exactParity).toBe(true);
  });

  it("captures console output for the judge", async () => {
    const res = await ok({ legacyCode: "console.log('hi', n); n", modernCode: "n", context: { n: 3 } });
    expect(res.legacy.stdout).toBe("hi 3");
    expect(res.modern.stdout).toBeUndefined();
  });

  it("counts two rejections as parity and one rejection as a mismatch", async () => {
    const both = await ok({ legacyCode: "null.x", modernCode: "undefined.y", context: {} });
    expect(both.exactParity).toBe(true);
    expect(both.legacy.ok).toBe(false);
    expect(both.reason).toContain("both implementations rejected");

    const one = await ok({ legacyCode: "1 + 1", modernCode: "null.x", context: {} });
    expect(one.exactParity).toBe(false);
    expect(one.reason).toContain("modern failed");
  });

  it("enforces the sandbox timeout on a hostile snippet", async () => {
    const started = Date.now();
    const res = await ok({ legacyCode: "while (true) {}", modernCode: "1", context: {} });
    expect(res.legacy).toMatchObject({ ok: false, errorCode: "TIMEOUT" });
    expect(res.exactParity).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
    // The pool recovers: the next probe on the same server still works.
    expect((await ok({ legacyCode: "1", modernCode: "1", context: {} })).exactParity).toBe(true);
  }, 15_000);

  describe("rejects invalid payloads", () => {
    it.each([
      ["a missing modernCode", { legacyCode: "1", context: {} }, "modernCode"],
      ["an empty legacyCode", { legacyCode: "", modernCode: "1" }, "legacyCode"],
      ["a non-string code", { legacyCode: 1, modernCode: "1" }, "legacyCode"],
      ["an array context", { legacyCode: "1", modernCode: "1", context: [1] }, "context"],
      ["an internal context key", { legacyCode: "1", modernCode: "1", context: { __lzInput: 1 } }, "context"],
      ["a non-identifier context key", { legacyCode: "1", modernCode: "1", context: { "a-b": 1 } }, "context"],
      ["an unknown field", { legacyCode: "1", modernCode: "1", context: {}, extra: true }, ""],
      ["oversized code", { legacyCode: "x".repeat(70_000), modernCode: "1" }, "legacyCode"],
    ])("%s -> HTTP 400 with the offending path", async (_label, body, path) => {
      const { status, json } = await probe(body);
      expect(status).toBe(400);
      expect(json["error"]).toBe("Invalid probe payload");
      const issues = json["issues"] as Array<{ path: string; message: string }>;
      expect(issues.length).toBeGreaterThan(0);
      if (path !== "") expect(issues.some((i) => i.path.startsWith(path))).toBe(true);
    });

    it("rejects malformed JSON and oversized bodies without running anything", async () => {
      const bad = await probe("{not json", true);
      expect(bad.status).toBe(400);
      expect(bad.json["error"]).toBe("Invalid JSON body");
      const huge = await probe({ legacyCode: "x".repeat(400_000), modernCode: "1" });
      expect(huge.status).toBe(413);
    });
  });
});
