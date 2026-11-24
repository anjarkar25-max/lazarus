import { stripTypeScriptTypes } from "node:module";
import { describe, expect, it } from "vitest";
import { generateResurrectionBundle } from "../../exporter/bundle.js";
import { readZip, createZip } from "../../exporter/zip.js";
import { bundleToZipEntries } from "../../exporter/bundle.js";
import { tag } from "../../sandbox/tagged.js";
import { ResurrectionOrchestrator } from "../orchestrator.js";
import { inferSignature, mergeTypes, parseSignature, renderDeclaration, renderJsDoc, renderSignature, renderType, type Observation, type TsType } from "../type-alchemist.js";

const obs = (inputs: Record<string, unknown>, output: unknown, ok = true): Observation => ({ inputs, ok, ...(ok ? { output } : {}) });

describe("inferSignature", () => {
  it("infers primitives, an integer range and NaN behaviour", () => {
    const sig = inferSignature([obs({ n: 7 }, 3), obs({ n: -1 }, 0), obs({ n: 2147483647 }, 1073741823), obs({ n: -2147483648 }, -1073741824)], { n: "integer" });
    expect(renderSignature(sig, "half")).toBe("half(n: number): number");
    expect(sig.returnNotes).toEqual(["integer in [-1073741824, 1073741823]", "fits in a signed 32-bit integer", "never returns NaN"]);
    expect(sig.samples).toBe(4);
  });

  it("decodes tagged wire values exactly (-0, NaN, Infinity, undefined)", () => {
    const sig = inferSignature([obs({ x: 1 }, tag("NaN")), obs({ x: 2 }, tag("-0")), obs({ x: 3 }, tag("Infinity")), obs({ x: 4 }, 1.5)], { x: "number" });
    expect(renderType(sig.returns)).toBe("number");
    expect(sig.returnNotes).toEqual(["number in [0, 1.5]", "may return NaN", "may return Infinity", "may return -0"]);
    const undef = inferSignature([obs({ x: 1 }, tag("undefined")), obs({ x: 2 }, "a")], { x: "integer" });
    expect(renderType(undef.returns)).toBe("string | undefined");
  });

  it("infers unions with null and string notes", () => {
    const sig = inferSignature([obs({ s: "a" }, "abc"), obs({ s: "" }, null), obs({ s: "b" }, "")], { s: "string" });
    expect(renderSignature(sig, "f")).toBe("f(s: string): string | null");
    expect(sig.returnNotes).toEqual(["string length in [0, 3]"]);
  });

  it("infers arrays, including element unions", () => {
    expect(renderType(inferSignature([obs({ a: 1 }, ["x", "y"]), obs({ a: 2 }, [])], { a: "integer" }).returns)).toBe("string[]");
    expect(renderType(inferSignature([obs({ a: 1 }, [1, "x"]), obs({ a: 2 }, [null])], { a: "integer" }).returns)).toBe("(number | string | null)[]");
  });

  it("infers object interfaces with optional fields", () => {
    const sig = inferSignature(
      [obs({ n: 1 }, { total: 10, label: "a" }), obs({ n: 2 }, { total: 20 }), obs({ n: 3 }, { total: 30, label: "c", "bad key": true })],
      { n: "integer" }
    );
    expect(renderType(sig.returns)).toBe('{ total: number; label?: string; "bad key"?: boolean }');
  });

  it("infers observed types for json parameters and counts thrown inputs", () => {
    const sig = inferSignature([obs({ v: [1, 2] }, 2), obs({ v: [] }, 0), obs({ v: "x" }, 0, false)], { v: "json" });
    expect(renderSignature(sig, "len")).toBe("len(v: string | number[]): number");
    expect(sig.throws).toBe(1);
    expect(renderJsDoc(sig)).toContain("throws for 1 of 3 observed inputs");
  });

  it("collapses wide unions and deep values to unknown", () => {
    const wide = [1, "a", true, [1], { a: 1 }].reduce<TsType | undefined>((acc, v) => mergeTypes(acc, inferSignature([obs({ x: 0 }, v)], { x: "integer" }).returns), undefined);
    expect(wide).toEqual({ kind: "unknown" });
    const deep = inferSignature([obs({ x: 0 }, [[[[[1]]]]])], { x: "integer" });
    expect(renderType(deep.returns)).toBe("unknown[][][][]");
  });
});

describe("rendering and validation", () => {
  const sig = inferSignature([obs({ n: 3 }, 1), obs({ n: 4 }, 2)], { n: "integer" });

  it("renders a comment-safe JSDoc block and a valid .d.ts", () => {
    const doc = renderJsDoc({ ...sig, returnNotes: ["evil */ alert(1) /*\nnext line"] }, ["Header"]);
    expect(doc.split("*/").length).toBe(2);
    expect(doc).not.toMatch(/evil \*\//);
    const dts = renderDeclaration(sig, "half");
    expect(dts).toContain("export declare function half(n: number): number;");
    expect(dts).toContain("@param n fuzzed as integer");
    expect(() => stripTypeScriptTypes(dts)).not.toThrow();
  });

  it("accepts its own signatures and rejects malformed or hostile ones", () => {
    expect(parseSignature(JSON.parse(JSON.stringify(sig)))).toEqual(sig);
    expect(parseSignature({ ...sig, returns: { kind: "evil" } })).toBeUndefined();
    expect(parseSignature({ ...sig, params: [{ name: "n; alert(1)", type: { kind: "number" }, fuzzedAs: "integer" }] })).toBeUndefined();
    expect(parseSignature({ ...sig, extra: 1 })).toBeUndefined();
    let deep: TsType = { kind: "number" };
    for (let i = 0; i < 12; i++) deep = { kind: "array", element: deep };
    expect(parseSignature({ ...sig, returns: deep })).toBeUndefined();
    expect(parseSignature("text")).toBeUndefined();
  });
});

describe("bundle integration", () => {
  const base = { specimenName: "half", legacyCode: "(n / 2) | 0", modernCode: "Math.trunc(n / 2) || 0", specMarkdown: "spec", schema: { n: "integer" } };

  it("keeps the untyped bundle byte-identical without a signature", () => {
    const bundle = generateResurrectionBundle(base);
    expect(bundle.files["resurrected.ts"]).toContain("export function half(n: number): unknown {");
    expect(bundle.files["resurrected.ts"].startsWith("/**\n * Autonomously resurrected by Lazarus Kiro Crew\n * Parity verified via fast-check differential fuzzing (100 runs)\n */\n")).toBe(true);
    expect(bundle.files["types.d.ts"]).toBeUndefined();
  });

  it("annotates resurrected.ts and adds types.d.ts (also inside the zip) with a real orchestrated signature", async () => {
    const result = await new ResurrectionOrchestrator().resurrect({ name: "half", legacyCode: "var half = (n / 2) | 0; half;", schema: { n: "integer" }, fuzzRuns: 60, seed: 9, exact: true, collectObservations: true });
    expect(result.success).toBe(true);
    expect(result.observations?.length).toBe(60);
    const sig = inferSignature(result.observations ?? [], { n: "integer" });
    expect(renderSignature(sig, "half")).toBe("half(n: number): number");
    expect(sig.returnNotes).toContain("fits in a signed 32-bit integer");
    expect(sig.returnNotes).toContain("never returns NaN");

    const bundle = generateResurrectionBundle({ ...base, modernCode: result.modernCode, typeSignature: sig });
    const ts = bundle.files["resurrected.ts"];
    expect(ts).toContain("export function half(n: number): number {");
    expect(ts).toContain(" * @param n fuzzed as integer");
    expect(ts).toMatch(/ \* @returns integer in \[-?\d+, \d+\]; fits in a signed 32-bit integer; never returns NaN/);
    expect(() => stripTypeScriptTypes(ts)).not.toThrow();
    expect(bundle.files["types.d.ts"]).toContain("export declare function half(n: number): number;");
    expect(readZip(createZip(bundleToZipEntries(bundle))).map((e) => e.name)).toContain("types.d.ts");
  }, 30_000);

  it("ignores a signature whose parameters do not match the schema", () => {
    const other = inferSignature([obs({ x: 1 }, 1)], { x: "integer" });
    const bundle = generateResurrectionBundle({ ...base, typeSignature: other });
    expect(bundle.files["resurrected.ts"]).toContain("export function half(n: number): unknown {");
    expect(bundle.files["types.d.ts"]).toBeUndefined();
  });
});
