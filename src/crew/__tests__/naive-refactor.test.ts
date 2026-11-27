import type { AddressInfo } from "node:net";
import * as fc from "fast-check";
import { parse } from "acorn";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebServer } from "../../web/server.js";
import { naiveRefactor } from "../naive-refactor.js";

const HALVE = "var half = (n / 2) | 0; half;";
const HASH = "var h = 0; for (var i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; } h;";

describe("naiveRefactor (deterministic, no API key)", () => {
  it("rewrites (n / 2) | 0 to Math.floor and var to let, logging each rewrite", () => {
    const r = naiveRefactor("var half = (n / 2) | 0; half");
    expect(r.naiveCode).toBe("let half = Math.floor(n / 2);\nhalf;");
    expect(r.rewrites.map((w) => w.rule)).toEqual(["var-to-let", "bitor0-floor"]);
    expect(r.rewrites[1]).toMatchObject({ before: "n / 2 | 0", after: "Math.floor(n / 2)" });
    for (const w of r.rewrites) expect(w.why.length).toBeGreaterThan(20);
  });

  it("drops the 32-bit truncation in a hash loop", () => {
    const r = naiveRefactor("var h = 0; for (var i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; } h");
    expect(r.naiveCode).toContain("h = h * 31 + text.charCodeAt(i);");
    expect(r.naiveCode).not.toContain("| 0");
    expect(r.rewrites.map((w) => w.rule).sort()).toEqual(["bitor0-dropped", "var-to-let", "var-to-let"]);
  });

  it.each([
    ["x | 0", "Math.trunc(x);", "bitor0-trunc"],
    ["y >>> 0", "Math.trunc(y);", "shift-trunc"],
    ["y >> 0", "Math.trunc(y);", "shift-trunc"],
    ["~~(x / 3)", "Math.trunc(x / 3);", "double-tilde-trunc"],
    ["a == b", "a === b;", "strict-equality"],
    ["a != b", "a !== b;", "strict-equality"],
  ])("%s -> %s (%s)", (code, out, rule) => {
    const r = naiveRefactor(code);
    expect(r.naiveCode).toBe(out);
    expect(r.rewrites.map((w) => w.rule)).toEqual([rule]);
  });

  it("leaves code without a naive-trap pattern untouched, and never throws on bad input", () => {
    expect(naiveRefactor("n < lo ? lo : n > hi ? hi : n")).toEqual({ naiveCode: "n < lo ? lo : n > hi ? hi : n", rewrites: [] });
    const broken = naiveRefactor("function (");
    expect(broken.rewrites).toEqual([]);
    expect(broken.naiveCode).toBe("function (");
    expect(broken.parseError).toBeDefined();
  });

  it("is deterministic and always prints parseable code (property)", () => {
    const atoms = fc.constantFrom("n", "a", "b", "(n / 2)", "(a * 3)", "1");
    const ops = fc.constantFrom("|", "==", "!=", ">>", ">>>", "+", "*");
    const expr = fc.tuple(atoms, ops, atoms).map(([x, op, y]) => (op === "|" || op === ">>" || op === ">>>" ? `${x} ${op} 0` : `${x} ${op} ${y}`));
    fc.assert(
      fc.property(fc.array(expr, { minLength: 1, maxLength: 4 }), fc.boolean(), (parts, useVar) => {
        // Parenthesized, so `x | 0` stays one operation (`a | 0 + b` would parse as `a | (0 + b)`).
        const code = `${useVar ? "var" : "let"} r = ${parts.map((p) => `(${p})`).join(" + ")}; r`;
        const first = naiveRefactor(code);
        expect(naiveRefactor(code)).toEqual(first);
        expect(() => parse(first.naiveCode, { ecmaVersion: "latest", sourceType: "script" })).not.toThrow();
        expect(first.naiveCode).not.toMatch(/\| 0|>> 0|>>> 0|[^=!]==[^=]|\bvar\b/);
      }),
      { numRuns: 200 }
    );
  });
});

describe("POST /api/compare-naive (real Exorcist, pooled sandbox)", () => {
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
  const post = async (body: unknown): Promise<{ status: number; data: Record<string, unknown> }> => {
    const res = await fetch(`${baseUrl}/api/compare-naive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };

  it("catches the naive Math.floor rewrite of legacy-int-halve with a real counterexample", async () => {
    const { status, data } = await post({ legacyCode: HALVE, schema: { n: "integer" }, seed: 1337 });
    expect(status).toBe(200);
    expect(data["naiveCode"]).toBe("let half = Math.floor(n / 2);\nhalf;");
    expect(data["passed"]).toBe(false);
    // The boundary corpus reaches n = -0 first: (-0 / 2) | 0 is +0, Math.floor(-0 / 2) is -0.
    expect(data["counterexample"]).toMatchObject({ input: "n = -0", legacyOutput: "+0", naiveOutput: "-0" });
    expect(String((data["counterexample"] as Record<string, unknown>)["reason"])).toContain("sign of zero differs");
  });

  it("also catches it on plain negative odd numbers when -0 is not in play", async () => {
    // A number-free variant: integers only from the random phase would still diverge at every negative odd n.
    const { data } = await post({ legacyCode: "var q = (n * 2 - 3) / 2 | 0; q;", schema: { n: "integer" } });
    expect(data["passed"]).toBe(false);
    const cx = data["counterexample"] as Record<string, string>;
    expect(cx["legacyOutput"]).not.toBe(cx["naiveOutput"]);
  });

  it("catches the dropped | 0 in stringHash32 (32-bit overflow)", async () => {
    const { data } = await post({ legacyCode: HASH, schema: { text: "string" } });
    expect(data["passed"]).toBe(false);
    const cx = data["counterexample"] as Record<string, string>;
    expect(cx["input"]).toMatch(/^text = "/);
    expect(Number(cx["legacyOutput"])).toBeLessThanOrEqual(2147483647);
    expect(Math.abs(Number(cx["naiveOutput"]))).toBeGreaterThan(2147483647);
    expect((data["rewrites"] as Array<{ rule: string }>).some((w) => w.rule === "bitor0-dropped")).toBe(true);
  });

  it("reports an honest pass when the naive rewrite is safe over the fuzzed domain", async () => {
    const { status, data } = await post({ legacyCode: "var sum = 0; for (var i = 0; i < text.length; i++) { sum += text.charCodeAt(i); } sum;", schema: { text: "string" } });
    expect(status).toBe(200);
    expect(data["passed"]).toBe(true);
    expect(data["counterexample"]).toBeUndefined();
    expect(data["totalRuns"]).toBe(100);
    expect(String(data["note"])).toContain("matched the legacy code on all 100 exact Object.is runs");
  });

  it("says so when there is no naive-trap pattern at all (no fuzzing, no fake failure)", async () => {
    const { data } = await post({ legacyCode: "function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }" });
    expect(data).toMatchObject({ passed: true, rewrites: [], totalRuns: 0, schema: { n: "integer", lo: "integer", hi: "integer" } });
    expect(String(data["note"])).toContain("No naive-trap pattern");
  });

  it.each([
    [{}, 400],
    [{ legacyCode: "" }, 400],
    [{ legacyCode: 5 }, 400],
    [{ legacyCode: HALVE, extra: true }, 400],
    [{ legacyCode: HALVE, schema: { n: "float" } }, 400],
    [{ legacyCode: HALVE, schema: { "n-1": "integer" } }, 400],
    [{ legacyCode: HALVE, schema: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, "integer"])) }, 400],
    [{ legacyCode: HALVE, seed: 1.5 }, 400],
    [{ legacyCode: "x".repeat(64_001) }, 400],
    ["not json", 400],
  ])("validates the body: %j -> %i", async (body, expected) => {
    const { status, data } = await post(body);
    expect(status).toBe(expected);
    expect(typeof data["error"]).toBe("string");
  });

  it("refuses unparseable code and specimens without inputs with 422", async () => {
    expect((await post({ legacyCode: "var x = (n / 2 | 0; x;", schema: { n: "integer" } })).status).toBe(422);
    expect((await post({ legacyCode: "var x = 1 | 0; x;" })).status).toBe(422);
  });

  it("runs untrusted code only in the sandbox: a host escape attempt is contained", async () => {
    const { status, data } = await post({ legacyCode: "var r = (typeof process !== 'undefined' && process.env ? 1 : 0) | 0; r + n;", schema: { n: "integer" } });
    expect(status).toBe(200);
    expect(typeof data["passed"]).toBe("boolean");
  });
});

describe("POST /api/probe with compareNaive: 3-way Legacy vs Naive AI vs Lazarus", () => {
  const server = createWebServer();
  let baseUrl = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
  interface Side { ok: boolean; display: string }
  interface ThreeWay { legacy: Side; modern: Side; naive?: Side; naiveCode?: string; naiveApplies?: boolean; naiveDiverges?: boolean; naiveReason?: string; lazarusMatchesLegacy?: boolean; exactParity: boolean }
  const probe = async (body: Record<string, unknown>): Promise<{ status: number; data: ThreeWay }> => {
    const res = await fetch(`${baseUrl}/api/probe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, data: (await res.json()) as ThreeWay };
  };
  const LAZARUS_HALVE = "Math.trunc(n / 2) || 0";
  const tagged = (kind: string): { $lazarus: string } => ({ $lazarus: kind });
  const halve = (n: unknown) => probe({ legacyCode: HALVE, modernCode: LAZARUS_HALVE, context: { n }, compareNaive: true });

  it("keeps the 2-way response unchanged without the flag", async () => {
    const { status, data } = await probe({ legacyCode: HALVE, modernCode: LAZARUS_HALVE, context: { n: -3 } });
    expect(status).toBe(200);
    expect(data.naive).toBeUndefined();
    expect(data.naiveDiverges).toBeUndefined();
    expect(data.exactParity).toBe(true);
  });

  it("flags Naive AI as diverging on -3 (Math.floor) while Lazarus matches Legacy", async () => {
    const { data } = await halve(-3);
    expect(data.legacy.display).toBe("-1");
    expect(data.naive?.display).toBe("-2");
    expect(data.modern.display).toBe("-1");
    expect(data.naiveApplies).toBe(true);
    expect(data.naiveDiverges).toBe(true);
    expect(data.naiveReason).toContain("naive");
    expect(data.lazarusMatchesLegacy).toBe(true);
    expect(data.exactParity).toBe(true);
    expect(data.naiveCode).toContain("Math.floor");
  });

  it("keeps -0 and +0 apart: Naive AI returns -0 where Legacy and Lazarus return +0", async () => {
    const { data } = await halve(tagged("-0"));
    expect(data.legacy.display).toBe("+0");
    expect(data.modern.display).toBe("+0");
    expect(data.naive?.display).toBe("-0");
    expect(data.naiveDiverges).toBe(true);
    expect(data.lazarusMatchesLegacy).toBe(true);
  });

  it("handles NaN: Naive AI keeps NaN where Legacy (| 0) yields +0", async () => {
    const { data } = await halve(tagged("NaN"));
    expect(data.legacy.display).toBe("+0");
    expect(data.naive?.display).toBe("NaN");
    expect(data.naiveDiverges).toBe(true);
    expect(data.lazarusMatchesLegacy).toBe(true);
  });

  it("reports no divergence when the naive rewrite happens to agree", async () => {
    const { data } = await halve(8);
    expect(data.naive?.display).toBe("4");
    expect(data.naiveDiverges).toBe(false);
    expect(data.lazarusMatchesLegacy).toBe(true);
  });

  it("works for a string specimen (stringHash32 style): the naive rewrite loses the 32-bit wrap", async () => {
    const { data } = await probe({ legacyCode: HASH, modernCode: HASH, context: { text: "the quick brown fox jumps" }, compareNaive: true });
    expect(data.naiveApplies).toBe(true);
    expect(data.naiveDiverges).toBe(true);
    expect(data.lazarusMatchesLegacy).toBe(true);
    expect(data.legacy.display).toBe(data.modern.display);
    expect(data.naive?.display).not.toBe(data.legacy.display);
  });

  it("says so when the specimen has no naive-trap pattern", async () => {
    const { data } = await probe({ legacyCode: "n + 1", modernCode: "n + 1", context: { n: 1 }, compareNaive: true });
    expect(data.naiveApplies).toBe(false);
    expect(data.naiveDiverges).toBe(false);
  });

  it("rejects a non-boolean compareNaive", async () => {
    expect((await probe({ legacyCode: HALVE, modernCode: LAZARUS_HALVE, context: { n: 1 }, compareNaive: "yes" })).status).toBe(400);
  });
});
