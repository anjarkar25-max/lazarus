import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebServer } from "../../web/server.js";
import { PooledProbeRunner } from "../../sandbox/pool.js";
import { ResurrectionOrchestrator } from "../orchestrator.js";
import {
  EDGE_CASES,
  EdgeGauntletBodySchema,
  EdgeGauntletError,
  LONG_STRING,
  buildEdgeContext,
  prepareEdgeGauntlet,
  runEdgeGauntlet,
  runEdgeGauntletPooled,
  type EdgeGauntletInput,
  type EdgeGauntletResult,
} from "../edge-gauntlet.js";

const HALVE = "var half = (n / 2) | 0; half;";
const processWraps = (): number => process.getActiveResourcesInfo().filter((x) => x === "ProcessWrap").length;

async function proven(legacyCode: string, schema: Record<string, "integer" | "string" | "json">): Promise<string> {
  const r = await new ResurrectionOrchestrator().resurrect({ name: "specimen", legacyCode, schema, fuzzRuns: 60, seed: 3, exact: true });
  expect(r.success).toBe(true);
  return r.modernCode;
}

describe("the 12 edge cases", () => {
  it("are exactly the notorious inputs of the spec, in order", () => {
    expect(EDGE_CASES.map((c) => c.label)).toEqual(["-0", "NaN", "Infinity", "-Infinity", "2147483647", "2147483648", "-2147483648", "-3", '""', '"\\u0000"', '"__proto__"', "64-char string"]);
    expect(Object.is(EDGE_CASES[0]?.value, -0)).toBe(true);
    expect(Number.isNaN(EDGE_CASES[1]?.value)).toBe(true);
    expect(EDGE_CASES.slice(0, 8).every((c) => c.family === "numeric")).toBe(true);
    expect(EDGE_CASES.slice(8).every((c) => c.family === "text")).toBe(true);
    expect(EDGE_CASES[9]?.value).toBe("\u0000");
    expect(EDGE_CASES[10]?.value).toBe("__proto__");
    expect(LONG_STRING).toHaveLength(64);
    expect(LONG_STRING).toMatch(/[^\x00-\x7f]/);
  });

  it("are tailored to the schema: numeric edges for numbers, text edges for strings, both for json, neutral defaults elsewhere", () => {
    const [negZero, nan, , , , , , , empty] = EDGE_CASES;
    if (negZero === undefined || nan === undefined || empty === undefined) throw new Error("cases missing");
    const ints = buildEdgeContext({ n: "integer", flag: "boolean" }, negZero);
    expect(Object.is(ints?.["n"], -0)).toBe(true);
    expect(ints?.["flag"]).toBe(true);
    // NaN and Infinity are outside the domain of an integer parameter, but not of a number.
    expect(buildEdgeContext({ n: "integer" }, nan)).toBeUndefined();
    expect(Number.isNaN(buildEdgeContext({ n: "number" }, nan)?.["n"])).toBe(true);
    expect(buildEdgeContext({ n: "integer" }, empty)).toBeUndefined();
    expect(buildEdgeContext({ flag: "boolean" }, negZero)).toBeUndefined();
    // A string parameter receives a numeric edge as its text, a text edge as is.
    expect(buildEdgeContext({ text: "string" }, negZero)).toEqual({ text: "-0" });
    expect(buildEdgeContext({ text: "string" }, nan)).toEqual({ text: "NaN" });
    expect(buildEdgeContext({ text: "string" }, empty)).toEqual({ text: "" });
    const mixed = buildEdgeContext({ n: "integer", text: "string" }, empty);
    expect(mixed).toEqual({ n: 1, text: "" });
    const json = buildEdgeContext({ a: "json", b: "json" }, nan);
    expect(Number.isNaN(json?.["a"])).toBe(true);
    expect(Number.isNaN(json?.["b"])).toBe(true);
    for (const edge of EDGE_CASES) expect(buildEdgeContext({ a: "json" }, edge), edge.label).toBeDefined();
    for (const edge of EDGE_CASES) expect(buildEdgeContext({ s: "string" }, edge), edge.label).toBeDefined();
    expect(EDGE_CASES.filter((edge) => buildEdgeContext({ n: "number" }, edge) !== undefined).map((e) => e.label)).toEqual(EDGE_CASES.slice(0, 8).map((e) => e.label));
    expect(EDGE_CASES.filter((edge) => buildEdgeContext({ n: "integer" }, edge) !== undefined).map((e) => e.label)).toEqual(["-0", "2147483647", "2147483648", "-2147483648", "-3"]);
  });
});

describe("runEdgeGauntlet (sandbox)", () => {
  it("runs a numeric specimen through Legacy, Naive AI and Lazarus: the naive rewrite falls into the traps, Lazarus holds exact parity", async () => {
    const modernCode = await proven(HALVE, { n: "integer" });
    const before = processWraps();
    const result = await runEdgeGauntletPooled({ legacyCode: HALVE, modernCode, schema: { n: "integer" } });
    expect(Object.keys(result).sort()).toEqual(["lazarusPassed", "naivePassed", "rows", "total"]);
    expect(result.total).toBe(5);
    expect(result.rows).toHaveLength(5);
    expect(result.lazarusPassed).toBe(5);
    expect(result.naivePassed).toBeLessThan(result.total);
    for (const row of result.rows) {
      expect(Object.keys(row).sort()).toEqual(["inputDisplay", "label", "lazarusMatch", "lazarusOut", "legacyOut", "naiveMatch", "naiveOut"]);
      expect(row.lazarusMatch, row.label).toBe(true);
      expect(row.lazarusOut, row.label).toBe(row.legacyOut);
    }
    expect(result.naivePassed).toBe(result.rows.filter((r) => r.naiveMatch).length);
    const minusThree = result.rows.find((r) => r.label === "-3");
    expect(minusThree).toMatchObject({ inputDisplay: "n = -3", legacyOut: "-1", lazarusOut: "-1", lazarusMatch: true });
    // Legacy `(n / 2) | 0` maps -0 to +0 and truncates toward zero; the naive rewrite is told apart from it.
    expect(result.rows.find((r) => r.label === "-0")).toMatchObject({ inputDisplay: "n = -0", legacyOut: "+0", lazarusOut: "+0" });
    expect(result.rows.filter((r) => !r.naiveMatch && r.lazarusMatch).length).toBeGreaterThan(0);
    // A number parameter also takes NaN and +-Infinity: there the speculative Math.trunc rewrite is caught (Infinity | 0 is 0), which the Exorcist never fuzzes.
    const wide = await runEdgeGauntletPooled({ legacyCode: HALVE, modernCode, schema: { n: "number" } });
    expect(wide.total).toBe(8);
    expect(wide.rows.find((r) => r.label === "Infinity")).toMatchObject({ legacyOut: "+0", lazarusMatch: false });
    expect(wide.rows.find((r) => r.label === "NaN")).toMatchObject({ legacyOut: "+0", lazarusMatch: true });
    expect(processWraps()).toBe(before);
  }, 60_000);

  it("compares with Object.is: -0 differs from +0, NaN equals NaN, and a missing value differs from null", async () => {
    await using legacy = new PooledProbeRunner();
    await using modern = new PooledProbeRunner();
    const run = (input: Partial<EdgeGauntletInput> & Pick<EdgeGauntletInput, "legacyCode" | "modernCode">): Promise<EdgeGauntletResult> =>
      runEdgeGauntlet({ schema: { n: "number" }, ...input }, { legacy, modern });
    // `n + 0` turns -0 into +0 (an exact-parity break that `===` cannot see); NaN stays NaN on both sides.
    const signOfZero = await run({ legacyCode: "n;", modernCode: "n + 0;", naiveCode: "n;" });
    expect(signOfZero.rows.find((r) => r.label === "-0")).toMatchObject({ legacyOut: "-0", lazarusOut: "+0", lazarusMatch: false, naiveMatch: true });
    expect(signOfZero.rows.find((r) => r.label === "NaN")).toMatchObject({ legacyOut: "NaN", lazarusOut: "NaN", lazarusMatch: true });
    expect(signOfZero.rows.find((r) => r.label === "Infinity")).toMatchObject({ legacyOut: "Infinity", lazarusMatch: true });
    expect(signOfZero.lazarusPassed).toBe(signOfZero.total - 1);
    expect(signOfZero.naivePassed).toBe(signOfZero.total);
    // undefined is not null.
    const nullish = await run({ legacyCode: "n > 5 ? undefined : null;", modernCode: "null;", naiveCode: "n > 5 ? undefined : null;" });
    expect(nullish.rows.find((r) => r.label === "Infinity")).toMatchObject({ legacyOut: "undefined", lazarusOut: "null", lazarusMatch: false });
    expect(nullish.rows.find((r) => r.label === "-3")).toMatchObject({ legacyOut: "null", lazarusMatch: true });
    // Two rejections count as a match, one rejection does not.
    const throwing = await run({ legacyCode: "n === 2147483648 ? (function () { throw new Error('boom'); })() : 1;", modernCode: "n === 2147483648 ? (function () { throw new RangeError('other'); })() : 1;", naiveCode: "1;" });
    expect(throwing.rows.find((r) => r.label === "2147483648")).toMatchObject({ lazarusMatch: true, naiveMatch: false });
    expect(throwing.rows.find((r) => r.label === "2147483648")?.legacyOut).toMatch(/^throws EXECUTION_ERROR/);
  }, 60_000);

  it("uses the text and json edges: a string specimen runs all 12 cases, including a NUL, __proto__ and the 64-char string", async () => {
    const legacy = "text.length;";
    const result = await runEdgeGauntletPooled({ legacyCode: legacy, modernCode: "text.length;", schema: { text: "string" } });
    expect(result.total).toBe(12);
    expect(result.lazarusPassed).toBe(12);
    expect(result.naivePassed).toBe(12);
    expect(result.rows.map((r) => r.label)).toEqual(EDGE_CASES.map((c) => c.label));
    expect(result.rows.find((r) => r.label === '"\\u0000"')).toMatchObject({ legacyOut: "1", inputDisplay: 'text = "\\u0000"' });
    expect(result.rows.find((r) => r.label === '"__proto__"')?.legacyOut).toBe("9");
    expect(result.rows.find((r) => r.label === "64-char string")?.legacyOut).toBe("64");
    expect(result.rows.find((r) => r.label === "-0")).toMatchObject({ inputDisplay: 'text = "-0"', legacyOut: "2" });
    const json = await runEdgeGauntletPooled({ legacyCode: "var s = typeof v; s;", modernCode: "typeof v;", schema: { v: "json" } });
    expect(json.total).toBe(12);
    expect(json.lazarusPassed).toBe(12);
    expect(json.rows.find((r) => r.label === "NaN")?.legacyOut).toBe('"number"');
  }, 60_000);

  it("rejects what it cannot run before touching the sandbox", async () => {
    await using legacy = new PooledProbeRunner();
    await using modern = new PooledProbeRunner();
    const code = async (input: EdgeGauntletInput): Promise<string> => {
      try {
        await runEdgeGauntlet(input, { legacy, modern });
      } catch (err: unknown) {
        if (err instanceof EdgeGauntletError) return err.code;
        throw err;
      }
      return "ok";
    };
    expect(await code({ legacyCode: HALVE, modernCode: HALVE, schema: {} })).toBe("NO_SCHEMA");
    expect(await code({ legacyCode: "function (", modernCode: HALVE, schema: { n: "integer" } })).toBe("PARSE_ERROR");
    expect(await code({ legacyCode: "flag ? 1 : 2;", modernCode: "flag ? 1 : 2;", schema: { flag: "boolean" } })).toBe("NO_CASE");
    expect(legacy.stats.probes + modern.stats.probes).toBe(0);
  });

  it("describes the naive candidate it will run", () => {
    expect(prepareEdgeGauntlet({ legacyCode: HALVE, modernCode: HALVE, schema: { n: "integer" } })).toMatchObject({ naiveApplies: true });
    expect(prepareEdgeGauntlet({ legacyCode: "n + 1;", modernCode: "n + 1;", schema: { n: "integer" } }).naiveApplies).toBe(false);
    expect(prepareEdgeGauntlet({ legacyCode: "n + 1;", modernCode: "n + 1;", naiveCode: "n + 2;", schema: { n: "integer" } })).toMatchObject({ naiveCode: "n + 2;", naiveApplies: true });
  });

  it("stops at its budget instead of running forever", async () => {
    await using legacy = new PooledProbeRunner();
    await using modern = new PooledProbeRunner();
    const result = await runEdgeGauntlet({ legacyCode: HALVE, modernCode: HALVE, schema: { n: "integer" } }, { legacy, modern }, { budgetMs: -1 });
    expect(result).toEqual({ total: 0, lazarusPassed: 0, naivePassed: 0, rows: [] });
  });
});

describe("EdgeGauntletBodySchema", () => {
  const ok = { legacyCode: HALVE, modernCode: HALVE, schema: { n: "integer" } };
  it("accepts the documented body and refuses everything else", () => {
    expect(EdgeGauntletBodySchema.safeParse(ok).success).toBe(true);
    expect(EdgeGauntletBodySchema.safeParse({ ...ok, naiveCode: "n;", functionName: "halve" }).success).toBe(true);
    for (const bad of [{}, { ...ok, legacyCode: "" }, { ...ok, modernCode: undefined }, { ...ok, schema: { n: "float" } }, { ...ok, schema: { "bad name": "integer" } }, { ...ok, schema: { __lzInput: "integer" } }, { ...ok, extra: 1 }, { ...ok, naiveCode: 5 }]) {
      expect(EdgeGauntletBodySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("POST /api/edge-gauntlet", () => {
  const server = createWebServer();
  let baseUrl = "";
  const baseline = processWraps();
  const post = async (body: unknown, raw = false): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${baseUrl}/api/edge-gauntlet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw ? String(body) : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    // Closing the server tears the dedicated gauntlet workers down: no leaked worker process.
    const end = Date.now() + 10_000;
    while (processWraps() > baseline && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(processWraps()).toBeLessThanOrEqual(baseline);
  }, 20_000);

  it("returns the scorecard for a verified resurrection", async () => {
    const modernCode = await proven(HALVE, { n: "integer" });
    const { status, json } = await post({ legacyCode: HALVE, modernCode, schema: { n: "integer" } });
    expect(status).toBe(200);
    expect(json["total"]).toBe(5);
    expect(json["lazarusPassed"]).toBe(5);
    expect(json["naivePassed"] as number).toBeLessThan(5);
    expect(json["naiveApplies"]).toBe(true);
    expect(typeof json["naiveCode"]).toBe("string");
    expect(json["rows"]).toHaveLength(5);
    expect((json["rows"] as Array<{ label: string }>).map((r) => r.label)).toEqual(["-0", "2147483647", "2147483648", "-2147483648", "-3"]);
  }, 60_000);

  it("takes an explicit naiveCode and a functionName for a multi-export module", async () => {
    const module = "exports.halve = function (n) { return (n / 2) | 0; };\nexports.twice = function (n) { return n * 2; };";
    const { status, json } = await post({ legacyCode: module, modernCode: "Math.trunc(n / 2) || 0;", naiveCode: "Math.floor(n / 2);", schema: { n: "number" }, functionName: "halve" });
    expect(status).toBe(200);
    const rows = json["rows"] as Array<{ label: string; naiveMatch: boolean; lazarusMatch: boolean }>;
    expect(rows.find((r) => r.label === "-3")).toMatchObject({ naiveMatch: false, lazarusMatch: true });
    expect(rows.find((r) => r.label === "Infinity")?.lazarusMatch).toBe(false);
  }, 30_000);

  it("validates the body: 400 for bad JSON and unknown shapes, 413 for a huge one, 422 for a specimen it cannot run", async () => {
    expect((await post("{nope", true)).status).toBe(400);
    const missing = await post({ legacyCode: HALVE });
    expect(missing.status).toBe(400);
    expect(String(missing.json["error"])).toContain("modernCode");
    expect((await post({ legacyCode: HALVE, modernCode: HALVE, schema: { n: "integer" }, surprise: true })).status).toBe(400);
    expect((await post({ legacyCode: HALVE, modernCode: HALVE, schema: { n: "float" } })).status).toBe(400);
    expect((await post({ legacyCode: "x".repeat(300_000), modernCode: HALVE, schema: { n: "integer" } })).status).toBe(413);
    expect(await post({ legacyCode: HALVE, modernCode: HALVE, schema: {} })).toMatchObject({ status: 422, json: { code: "NO_SCHEMA" } });
    expect(await post({ legacyCode: "function (", modernCode: HALVE, schema: { n: "integer" } })).toMatchObject({ status: 422, json: { code: "PARSE_ERROR" } });
    expect(await post({ legacyCode: "flag ? 1 : 2;", modernCode: "1;", schema: { flag: "boolean" } })).toMatchObject({ status: 422, json: { code: "NO_CASE" } });
  }, 30_000);

  it("answers 429 while another gauntlet is still running, and works again afterwards", async () => {
    const slow = "var end = Date.now() + 250; while (Date.now() < end) {} n;";
    const first = post({ legacyCode: slow, modernCode: "n;", schema: { n: "integer" } });
    await new Promise((r) => setTimeout(r, 200));
    const second = await post({ legacyCode: HALVE, modernCode: HALVE, schema: { n: "integer" } });
    expect(second).toMatchObject({ status: 429, json: { code: "BUSY" } });
    expect((await first).status).toBe(200);
    expect((await post({ legacyCode: HALVE, modernCode: HALVE, schema: { n: "integer" } })).status).toBe(200);
  }, 60_000);

  it("never executes the specimen on the host", async () => {
    const { status, json } = await post({ legacyCode: "process.exit(9); n;", modernCode: "n;", schema: { n: "integer" } });
    expect(status).toBe(200);
    expect((json["rows"] as Array<{ legacyOut: string }>)[0]?.legacyOut).toMatch(/^throws /);
  }, 30_000);
});
