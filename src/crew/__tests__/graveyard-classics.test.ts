import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyCertificate } from "../../exporter/cert-crypto.js";
import { NpmImportError, findExternalDependencies, importNpmPackage, parsePackageSpec, type FetchLike } from "../../importer/npm.js";
import { PooledProbeRunner } from "../../sandbox/pool.js";
import { scanLegacyAst } from "../../sandbox/ast-scanner.js";
import { createWebServer } from "../../web/server.js";
import { GRAVEYARD_CLASSICS, findClassic, sha256Of, summarizeClassic } from "../graveyard-classics.js";
import { closeSharedTsVerifier } from "../ts-verifier.js";

const SPECS = ["left-pad@1.3.0", "is-number@3.0.0", "ms@0.7.1", "decamelize@1.2.0", "pad-left@2.1.0"];
const classic = (spec: string) => {
  const c = findClassic(spec);
  if (c === undefined) throw new Error(`no classic ${spec}`);
  return c;
};
const offline: FetchLike = () => Promise.reject(new TypeError("the network must not be touched"));
const status = (code: number): Response => new Response("", { status: code });

afterAll(async () => {
  await closeSharedTsVerifier();
});

describe("the registry", () => {
  it("holds the five iconic classics, in order, each a valid exact npm spec", () => {
    expect(GRAVEYARD_CLASSICS.map((c) => c.spec)).toEqual(SPECS);
    for (const c of GRAVEYARD_CLASSICS) {
      expect(parsePackageSpec(c.spec)).toEqual({ name: c.name, version: c.version, spec: c.spec });
      expect(c.spec).toBe(`${c.name}@${c.version}`);
    }
  });

  it("carries license, provenance, traps and a schema for every classic", () => {
    const licenses = Object.fromEntries(GRAVEYARD_CLASSICS.map((c) => [c.name, c.license]));
    expect(licenses).toEqual({ "left-pad": "WTFPL", "is-number": "MIT", ms: "MIT", decamelize: "MIT", "pad-left": "MIT" });
    for (const c of GRAVEYARD_CLASSICS) {
      expect(c.author.length, c.spec).toBeGreaterThan(3);
      expect(c.homepage, c.spec).toBe(`https://www.npmjs.com/package/${c.name}/v/${c.version}`);
      expect(c.repository, c.spec).toMatch(/^https:\/\/github\.com\/[\w-]+\/[\w-]+$/);
      expect(c.summary.length, c.spec).toBeGreaterThan(20);
      expect(c.traps.length, c.spec).toBeGreaterThanOrEqual(2);
      expect(Object.keys(c.schema).length, c.spec).toBeGreaterThan(0);
      expect(Object.values(c.schema).every((k) => ["integer", "number", "string", "boolean", "json"].includes(k)), c.spec).toBe(true);
    }
    const traps = GRAVEYARD_CLASSICS.flatMap((c) => c.traps).join("\n");
    for (const word of ["coercion", "bitwise", "regex", "padding", "numeric"]) expect(traps, word).toContain(word);
  });

  it("ships snapshots that parse, export one entry function and need no module the sandbox cannot load", () => {
    for (const c of GRAVEYARD_CLASSICS) {
      const scan = scanLegacyAst(c.source);
      expect(scan.parsed, c.spec).toBe(true);
      expect(scan.primary, c.spec).toBeDefined();
      expect(findExternalDependencies(c.source), c.spec).toEqual([]);
      expect(c.source, c.spec).toContain("module.exports");
      expect(c.source, c.spec).not.toMatch(/^\s*(import|export)\s/m);
      expect(Buffer.byteLength(c.source), c.spec).toBeLessThan(32 * 1024);
      expect(summarizeClassic(c).sha256, c.spec).toBe(sha256Of(c.source));
    }
  });

  it("states every deviation from the published file: only is-number and pad-left inline a dependency", () => {
    expect(GRAVEYARD_CLASSICS.filter((c) => c.modifications.length > 0).map((c) => c.name)).toEqual(["is-number", "pad-left"]);
    expect(classic("is-number@3.0.0").modifications[0]).toContain("kind-of");
    expect(classic("pad-left@2.1.0").modifications[0]).toContain("repeat-string");
    expect(classic("is-number@3.0.0").source).toContain("Vendored from kind-of");
    expect(classic("pad-left@2.1.0").source).toContain("Vendored from repeat-string@1.6.1");
  });

  it("keeps the authentic code of each package", () => {
    expect(classic("left-pad@1.3.0").source).toContain("var cache = [");
    expect(classic("left-pad@1.3.0").source).toContain("if (len & 1) pad += ch;");
    expect(classic("left-pad@1.3.0").source).toContain("len >>= 1;");
    expect(classic("ms@0.7.1").source).toContain("if (str.length > 10000) {");
    expect(classic("ms@0.7.1").source).toContain("var y = d * 365.25;");
    expect(classic("decamelize@1.2.0").source).toContain("([A-Z]+)([A-Z][a-z\\d]+)");
    expect(classic("is-number@3.0.0").source).toContain("return (num - num + 1) >= 0;");
    expect(classic("pad-left@2.1.0").source).toContain("return repeat(ch, num - str.length) + str;");
  });

  it("looks a classic up by its exact spec only", () => {
    expect(findClassic("left-pad@1.3.0")?.name).toBe("left-pad");
    for (const spec of ["left-pad@1.2.0", "left-pad", "Left-Pad@1.3.0", "escape-string-regexp@1.0.5", ""]) expect(findClassic(spec), spec).toBeUndefined();
  });
});

describe("the snapshots behave like the packages (sandbox spot checks)", () => {
  it.each([
    ["left-pad@1.3.0", { str: "foo", len: 5, ch: "0" }, "00foo"],
    ["left-pad@1.3.0", { str: "foo", len: 6, ch: undefined }, "   foo"],
    ["left-pad@1.3.0", { str: "foo", len: 2, ch: "0" }, "foo"],
    ["is-number@3.0.0", { num: "12" }, true],
    ["is-number@3.0.0", { num: "   " }, false],
    ["is-number@3.0.0", { num: null }, false],
    ["is-number@3.0.0", { num: 5 }, true],
    ["ms@0.7.1", { val: "2 days", options: null }, 172800000],
    ["ms@0.7.1", { val: "1.5h", options: null }, 5400000],
    ["ms@0.7.1", { val: 172800000, options: { long: true } }, "2 days"],
    ["ms@0.7.1", { val: 60000, options: null }, "1m"],
    ["decamelize@1.2.0", { str: "fooBar", sep: "_" }, "foo_bar"],
    ["decamelize@1.2.0", { str: "unicornRainbow", sep: "-" }, "unicorn-rainbow"],
    ["decamelize@1.2.0", { str: "XMLHttpRequest", sep: "_" }, "xml_http_request"],
    ["pad-left@2.1.0", { str: "7", num: 3, ch: "0" }, "007"],
    ["pad-left@2.1.0", { str: "abc", num: 2, ch: "x" }, "abc"],
    ["pad-left@2.1.0", { str: "ab", num: 5, ch: undefined }, "   ab"],
  ])("%s %j returns %j", async (spec, context, expected) => {
    await using pool = new PooledProbeRunner();
    const result = await pool.run({ code: scanLegacyAst(classic(spec).source).primaryExpression, context });
    expect(result.output).toBe(expected);
  }, 20_000);

  it("keeps the trap behaviors that make them classics", async () => {
    await using pool = new PooledProbeRunner();
    const run = async (spec: string, context: Record<string, unknown>): Promise<unknown> => (await pool.run({ code: scanLegacyAst(classic(spec).source).primaryExpression, context, encoding: "tagged" })).output;
    // is-number: Infinity - Infinity is NaN, so NaN, Infinity and a numeric string such as "0x1F" differ.
    expect(await run("is-number@3.0.0", { num: { $lazarus: "NaN" } })).toBe(false);
    expect(await run("is-number@3.0.0", { num: { $lazarus: "Infinity" } })).toBe(false);
    expect(await run("is-number@3.0.0", { num: "0x1F" })).toBe(true);
    // left-pad: a numeric ch of 0 is a valid pad character, and the length is halved with int32 bit operations.
    expect(await run("left-pad@1.3.0", { str: "5", len: 3, ch: 0 })).toBe("005");
    // ms: a non-string, non-number value throws; an invalid unit returns undefined.
    await expect(pool.run({ code: scanLegacyAst(classic("ms@0.7.1").source).primaryExpression, context: { val: true, options: null } })).rejects.toThrow();
    // decamelize: a non-string throws.
    await expect(pool.run({ code: scanLegacyAst(classic("decamelize@1.2.0").source).primaryExpression, context: { str: 5, sep: "_" } })).rejects.toThrow();
  }, 30_000);
});

describe("importNpmPackage with a source", () => {
  const classicFetch = (calls: string[], answer: () => Response | Promise<Response>): FetchLike => async (input) => {
    calls.push(input);
    return answer();
  };

  it("snapshot: serves the classic with no network and says where it came from", async () => {
    const result = await importNpmPackage("left-pad@1.3.0", { fetch: offline, source: "snapshot" });
    expect(result).toMatchObject({ packageName: "left-pad", version: "1.3.0", spec: "left-pad@1.3.0", cdnHost: "lazarus-curated", origin: "curated-snapshot", license: "WTFPL", functionName: "leftPad" });
    expect(result.url).toBe("https://www.npmjs.com/package/left-pad/v/1.3.0");
    expect(result.sha256).toBe(sha256Of(classic("left-pad@1.3.0").source));
    expect(result.byteLength).toBe(Buffer.byteLength(classic("left-pad@1.3.0").source));
    expect(result.suggestedSchema).toEqual({ str: "string", len: "integer", ch: "string" });
    expect(result.classic?.traps.length).toBeGreaterThan(1);
    expect(result.classic?.author).toBe("azer (Azer Koçulu)");
    expect(result).not.toHaveProperty("fallback");
  });

  it("snapshot: every classic imports offline with its curated schema and metadata", async () => {
    for (const c of GRAVEYARD_CLASSICS) {
      const r = await importNpmPackage(c.spec, { fetch: offline, source: "snapshot" });
      expect(r, c.spec).toMatchObject({ origin: "curated-snapshot", license: c.license, spec: c.spec });
      expect(r.source, c.spec).toBe(c.source);
      expect(r.suggestedSchema, c.spec).toEqual(c.schema);
      expect(r.detectedIdioms.length, c.spec).toBeGreaterThan(0);
    }
  });

  it("snapshot: refuses a package that is not a curated classic (it never invents one)", async () => {
    const error = await importNpmPackage("escape-string-regexp@1.0.5", { fetch: offline, source: "snapshot" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NpmImportError);
    expect((error as NpmImportError).code).toBe("NOT_FOUND");
    expect((error as NpmImportError).message).toContain("not one of the curated");
    const wrongVersion = await importNpmPackage("left-pad@1.2.0", { fetch: offline, source: "snapshot" }).catch((e: unknown) => e);
    expect((wrongVersion as NpmImportError).code).toBe("NOT_FOUND");
  });

  it.each([
    ["a CDN timeout", () => new Promise<Response>(() => undefined), "TIMEOUT"],
    ["a rate limit (HTTP 429)", () => Promise.resolve(status(429)), "UPSTREAM_ERROR"],
    ["an outage (HTTP 503)", () => Promise.resolve(status(503)), "UPSTREAM_ERROR"],
    ["an unreachable CDN", () => Promise.reject(new TypeError("fetch failed")), "UPSTREAM_ERROR"],
    ["a 404", () => Promise.resolve(status(404)), "NOT_FOUND"],
    ["a hostile redirect", () => Promise.resolve(new Response(null, { status: 302, headers: { location: "https://evil.example/x.js" } })), "REDIRECT_REJECTED"],
    ["a body the sandbox cannot run (it requires a module)", () => Promise.resolve(new Response("var k = require('kind-of'); module.exports = function (n) { return k(n); };")), "HAS_DEPENDENCIES"],
    ["an oversized body", () => Promise.resolve(new Response("x", { headers: { "content-length": "99999" } })), "TOO_LARGE"],
  ])("auto: falls back cleanly to the curated snapshot after %s", async (_label, answer, code) => {
    const calls: string[] = [];
    const result = await importNpmPackage("left-pad@1.3.0", { fetch: classicFetch(calls, answer), source: "auto", timeoutMs: 40 });
    expect(result).toMatchObject({ origin: "curated-snapshot", cdnHost: "lazarus-curated", license: "WTFPL", source: classic("left-pad@1.3.0").source });
    expect(result.fallback?.code).toBe(code);
    expect(typeof result.fallback?.message).toBe("string");
    expect(calls[0]).toBe("https://unpkg.com/left-pad@1.3.0");
  });

  it("auto: tries the live CDN first and keeps what it serves when it works", async () => {
    const live = "module.exports = function leftPad(str, len) { return String(str) + len; };\n";
    const calls: string[] = [];
    const result = await importNpmPackage("left-pad@1.3.0", { fetch: classicFetch(calls, () => new Response(live)), source: "auto" });
    expect(calls).toEqual(["https://unpkg.com/left-pad@1.3.0"]);
    expect(result).toMatchObject({ origin: "live-cdn", cdnHost: "unpkg.com", license: "WTFPL", source: live });
    expect(result).not.toHaveProperty("fallback");
    expect(result.classic?.author).toBe("azer (Azer Koçulu)");
  });

  it("auto: a package that is not a classic behaves exactly like live (the error is not hidden)", async () => {
    const error = await importNpmPackage("escape-string-regexp@1.0.5", { fetch: classicFetch([], () => status(503)), source: "auto" }).catch((e: unknown) => e);
    expect((error as NpmImportError).code).toBe("UPSTREAM_ERROR");
    const ok = await importNpmPackage("escape-string-regexp@1.0.5", { fetch: classicFetch([], () => new Response("module.exports = function (s) { return s; };")), source: "auto" });
    expect(ok).not.toHaveProperty("origin");
    expect(ok.cdnHost).toBe("unpkg.com");
  });

  it("live (the default) is unchanged: a classic still reports the CDN failure instead of falling back", async () => {
    const timeout = await importNpmPackage("left-pad@1.3.0", { fetch: classicFetch([], () => new Promise<Response>(() => undefined)), timeoutMs: 30 }).catch((e: unknown) => e);
    expect((timeout as NpmImportError).code).toBe("TIMEOUT");
    const explicit = await importNpmPackage("left-pad@1.3.0", { fetch: classicFetch([], () => status(429)), source: "live" }).catch((e: unknown) => e);
    expect((explicit as NpmImportError).code).toBe("UPSTREAM_ERROR");
    const ok = await importNpmPackage("left-pad@1.3.0", { fetch: classicFetch([], () => new Response("module.exports = function (a) { return a; };")) });
    expect(ok).not.toHaveProperty("origin");
    expect(ok).not.toHaveProperty("license");
  });
});

describe("GET /api/graveyard-classics and POST /api/import/npm with a source", () => {
  let mode: "down" | "slow" | "ok" = "down";
  const requested: string[] = [];
  const npmFetch: FetchLike = async (input) => {
    requested.push(input);
    if (mode === "down") return new Response("", { status: 429 });
    if (mode === "slow") return new Promise<Response>(() => undefined);
    return new Response("module.exports = function leftPad(str, len, ch) { return str; };");
  };
  const server = createWebServer({ npmFetch });
  let baseUrl = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
  const post = async (body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${baseUrl}/api/import/npm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it("lists the five classics with metadata, byte length and digest, without their source", async () => {
    const res = await fetch(`${baseUrl}/api/graveyard-classics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { count: number; classics: Array<Record<string, unknown>> };
    expect(body.count).toBe(5);
    expect(body.classics.map((c) => c["spec"])).toEqual(SPECS);
    for (const c of body.classics) {
      expect(c).not.toHaveProperty("source");
      expect(c["sha256"]).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof c["byteLength"]).toBe("number");
      expect(typeof c["license"]).toBe("string");
      expect((c["traps"] as string[]).length).toBeGreaterThan(1);
      expect(c["schema"]).toEqual(classic(String(c["spec"])).schema);
    }
    expect(body.classics[0]).toMatchObject({ name: "left-pad", license: "WTFPL", functionName: "leftPad" });
    expect(requested).toEqual([]);
  });

  it("source: snapshot never calls the CDN", async () => {
    requested.length = 0;
    const { status: code, json } = await post({ packageSpec: "ms@0.7.1", source: "snapshot" });
    expect(code).toBe(200);
    expect(json).toMatchObject({ origin: "curated-snapshot", license: "MIT", cdnHost: "lazarus-curated" });
    expect(requested).toEqual([]);
  });

  it("source: auto falls back when the CDN rate-limits or hangs (live judging never flakes)", async () => {
    mode = "down";
    const limited = await post({ packageSpec: "left-pad@1.3.0", source: "auto" });
    expect(limited.status).toBe(200);
    expect(limited.json).toMatchObject({ origin: "curated-snapshot", fallback: { code: "UPSTREAM_ERROR" } });
    mode = "ok";
    expect(await post({ packageSpec: "left-pad@1.3.0", source: "auto" })).toMatchObject({ status: 200, json: { origin: "live-cdn", cdnHost: "unpkg.com" } });
  }, 30_000);

  it("keeps the strict body: no source means live, an unknown source or key is a 400, a non-classic snapshot is a 404", async () => {
    mode = "down";
    expect(await post({ packageSpec: "left-pad@1.3.0" })).toMatchObject({ status: 502, json: { code: "UPSTREAM_ERROR" } });
    expect((await post({ packageSpec: "left-pad@1.3.0", source: "cache" })).status).toBe(400);
    expect((await post({ packageSpec: "left-pad@1.3.0", source: "auto", extra: true })).status).toBe(400);
    expect(await post({ packageSpec: "escape-string-regexp@1.0.5", source: "snapshot" })).toMatchObject({ status: 404, json: { code: "NOT_FOUND" } });
  });

  it("serves the Famous npm Classics chip strip", async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    expect(html).toContain('id="classicChips"');
    for (const spec of SPECS) expect(html).toContain(`class="gy-chip gy-classic" data-spec="${spec}"`);
  });
});

describe("each classic resurrects end to end (offline snapshot -> full resurrection and 5-pillar proof)", () => {
  // The CDN must never be touched: the import is a snapshot import and the whole run is local.
  const server = createWebServer({ npmFetch: offline });
  let baseUrl = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  interface Result {
    success: boolean;
    attempts: number;
    modernCode: string;
    proofSeed: number;
    numRuns: number;
    fuzzReport: { passed: boolean; exact: boolean; totalRuns: number };
    typecheck: { passed: boolean; errorCount: number };
    purityProof?: { proven: boolean };
    certificate?: { provenanceLine: string; signature: { payload: Record<string, unknown>; signatureB64: string; publicKeyPem: string; keyId: string } };
  }

  it.each(SPECS)("%s: 100%% exact parity, tsc --strict: 0 errors, purity proven and an Ed25519 signature that verifies", async (spec) => {
    const imported = await fetch(`${baseUrl}/api/import/npm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packageSpec: spec, source: "snapshot" }) });
    expect(imported.status).toBe(200);
    const data = (await imported.json()) as { packageName: string; version: string; cdnHost: string; url: string; byteLength: number; license: string; source: string; suggestedSchema: Record<string, string> };
    const name = data.packageName.replace(/-([a-z0-9])/g, (_m, c: string) => (c as string).toUpperCase()).replace(/[^A-Za-z0-9_$]/g, "_");
    const provenance = { kind: "npm", label: data.packageName, version: data.version, cdnHost: data.cdnHost, url: data.url, byteLength: data.byteLength, license: data.license };
    const started = Date.now();
    const res = await fetch(`${baseUrl}/api/resurrect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, legacyCode: data.source, schema: data.suggestedSchema, fuzzRuns: 100, provenance }) });
    const text = await res.text();
    const frames = text.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as { kind: string; result?: Result; message?: string });
    const result = frames.find((f) => f.kind === "result")?.result;
    expect(result, JSON.stringify(frames.find((f) => f.kind === "error"))).toBeDefined();
    if (result === undefined) return;
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.fuzzReport).toMatchObject({ passed: true, exact: true });
    expect(result.numRuns).toBeGreaterThanOrEqual(100);
    expect(result.typecheck).toMatchObject({ passed: true, errorCount: 0 });
    expect(result.purityProof?.proven).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
    const sig = result.certificate?.signature;
    expect(sig?.keyId).toMatch(/^[0-9a-f]{16}$/);
    if (sig === undefined) return;
    expect(sig.payload["tscStrictErrors"]).toBe(0);
    expect(sig.payload["proofSeed"]).toBe(result.proofSeed);
    expect(verifyCertificate({ payload: sig.payload, signatureB64: sig.signatureB64, publicKeyPem: sig.publicKeyPem, resurrectedCode: result.modernCode })).toMatchObject({ valid: true, trustedKey: true });
    // The certificate names the package, the curated host and its license.
    expect(result.certificate?.provenanceLine).toContain(`${data.packageName}@${data.version}`);
    expect(result.certificate?.provenanceLine).toContain("lazarus-curated");
    expect(result.certificate?.provenanceLine).toContain(data.license);
  }, 90_000);

  it("a classic resurrects with the CDN down: IMPORT NPM (auto) falls back, the run is unaffected", async () => {
    const down = createWebServer({ npmFetch: () => Promise.resolve(status(429)) });
    await new Promise<void>((resolve) => down.listen(0, "127.0.0.1", () => resolve()));
    try {
      const base = `http://127.0.0.1:${(down.address() as AddressInfo).port}`;
      const res = await fetch(`${base}/api/import/npm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packageSpec: "decamelize@1.2.0", source: "auto" }) });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { origin: string; fallback: { code: string }; source: string; suggestedSchema: Record<string, string> };
      expect(data).toMatchObject({ origin: "curated-snapshot", fallback: { code: "UPSTREAM_ERROR" } });
      const run = await fetch(`${base}/api/resurrect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "decamelize", legacyCode: data.source, schema: data.suggestedSchema, fuzzRuns: 50 }) });
      const frames = (await run.text()).split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as { kind: string; result?: Result });
      expect(frames.find((f) => f.kind === "result")?.result?.success).toBe(true);
    } finally {
      await new Promise<void>((resolve) => down.close(() => resolve()));
    }
  }, 60_000);
});
