import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FetchLike } from "../../importer/npm.js";
import { createWebServer } from "../server.js";

const LEFT_PAD = "module.exports = leftPad;\nfunction leftPad (str, len, ch) {\n  str = String(str);\n  var i = -1;\n  if (!ch && ch !== 0) ch = ' ';\n  len = len - str.length;\n  while (++i < len) { str = ch + str; }\n  return str;\n}\n";

describe("POST /api/import/npm", () => {
  const requested: string[] = [];
  let mode: "ok" | "missing" | "deps" | "large" | "hostile" = "ok";
  const npmFetch: FetchLike = async (input) => {
    requested.push(input);
    switch (mode) {
      case "missing":
        return new Response("", { status: 404 });
      case "deps":
        return new Response("var k = require('kind-of'); module.exports = function (n) { return k(n); };", { status: 200 });
      case "large":
        return new Response("x", { status: 200, headers: { "content-length": "99999" } });
      case "hostile":
        return new Response(null, { status: 302, headers: { location: "https://evil.example/x.js" } });
      case "ok":
        return new Response(LEFT_PAD, { status: 200 });
    }
  };
  const server = createWebServer({ npmFetch });
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

  async function post(body: unknown, raw = false): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}/api/import/npm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw ? String(body) : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it("imports a package and returns provenance plus scanner output", async () => {
    mode = "ok";
    requested.length = 0;
    const { status, json } = await post({ packageSpec: "left-pad@1.3.0" });
    expect(status).toBe(200);
    expect(requested).toEqual(["https://unpkg.com/left-pad@1.3.0"]);
    expect(json).toMatchObject({ packageName: "left-pad", version: "1.3.0", cdnHost: "unpkg.com", functionName: "leftPad" });
    expect(json.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(json.byteLength).toBe(Buffer.byteLength(LEFT_PAD));
    expect(json.detectedIdioms).toContain("CommonJS export");
  });

  it.each([
    [{ packageSpec: "left-pad" }],
    [{ packageSpec: "../../etc/passwd@1.0.0" }],
    [{ packageSpec: "https://evil.example/a.js@1.0.0" }],
    [{ packageSpec: "left-pad@1.3.0; rm -rf /" }],
    [{ packageSpec: "left-pad@1.3.0?x=1" }],
    [{ packageSpec: 5 }],
    [{}],
    [{ packageSpec: "left-pad@1.3.0", extra: true }],
    [[]],
  ])("rejects %j with 400 and never fetches", async (body) => {
    requested.length = 0;
    const { status, json } = await post(body);
    expect(status).toBe(400);
    expect(json.code).toBe("INVALID_SPEC");
    expect(requested).toEqual([]);
  });

  it("rejects malformed JSON with 400", async () => {
    const { status, json } = await post("{nope", true);
    expect(status).toBe(400);
    expect(json.code).toBe("INVALID_SPEC");
  });

  it.each([
    ["missing", 404, "NOT_FOUND"],
    ["deps", 422, "HAS_DEPENDENCIES"],
    ["large", 413, "TOO_LARGE"],
    ["hostile", 502, "REDIRECT_REJECTED"],
  ] as const)("maps %s to HTTP %i %s with an honest message", async (m, httpStatus, code) => {
    mode = m;
    const { status, json } = await post({ packageSpec: "left-pad@1.3.0" });
    expect(status).toBe(httpStatus);
    expect(json.code).toBe(code);
    expect(typeof json.error).toBe("string");
    if (code === "HAS_DEPENDENCIES") expect(json.details).toMatchObject({ dependencies: ["kind-of"] });
  });

  it("serves the npm Graveyard bar with the four curated chips", async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    for (const spec of ["left-pad@1.3.0", "is-number@3.0.0", "decamelize@1.2.0", "escape-string-regexp@1.0.5"]) {
      expect(html).toContain(`data-spec="${spec}"`);
    }
    expect(html).toContain("Import from npm Graveyard");
    expect(html).toContain("Copy Certificate".toUpperCase());
  });
});

describe("certificate on /api/resurrect", () => {
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

  it("attaches a certificate with the provenance, and the exported SPEC.md carries it", async () => {
    const provenance = { kind: "npm", label: "left-pad", version: "1.3.0", cdnHost: "unpkg.com", byteLength: 300 };
    const res = await fetch(`${baseUrl}/api/resurrect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "leftPad", legacyCode: LEFT_PAD, schema: { str: "string", len: "integer", ch: "string" }, fuzzRuns: 30, seed: 3, provenance }),
    });
    const frames = (await res.text()).split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as { kind: string; result?: { success: boolean; modernCode: string; attempts: number; certificate?: { id: string; markdown: string; provenanceLine: string; parity: { runs: number; mode: string } } } });
    const result = frames.find((f) => f.kind === "result")?.result;
    expect(result?.success).toBe(true);
    const cert = result?.certificate;
    expect(cert?.provenanceLine).toContain("npm `left-pad@1.3.0` via unpkg.com");
    expect(cert?.parity).toMatchObject({ mode: "exact Object.is (tagged)", runs: 30 });

    const bundleRes = await fetch(`${baseUrl}/api/export-bundle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specimenName: "leftPad", legacyCode: LEFT_PAD, modernCode: result?.modernCode, specMarkdown: "# s", fuzzRuns: 30, schema: { str: "string", len: "integer", ch: "string" }, provenance, attempts: result?.attempts }),
    });
    const bundle = (await bundleRes.json()) as { files: Record<string, string> };
    expect(bundle.files["SPEC.md"]).toContain(`Resurrection Certificate ${cert?.id}`);
    expect(bundle.files["SPEC.md"]).toContain("npm `left-pad@1.3.0`");
  });

});
