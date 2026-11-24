import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { decodeTagged, describeValue, encodeTagged, isTagged, tag } from "../tagged.js";
import { VmProbeExecutor } from "../vm-executor.js";
import { isProbeParams } from "../validate.js";
import { SandboxError } from "../errors.js";

const vm = new VmProbeExecutor();

describe("tagged values", () => {
  it("round-trips every value JSON cannot carry", () => {
    for (const value of [Number.NaN, Infinity, -Infinity, -0, undefined]) {
      expect(Object.is(decodeTagged(encodeTagged(value)), value)).toBe(true);
    }
    expect(encodeTagged(-0)).toEqual({ $lazarus: "-0" });
    expect(isTagged(tag("NaN"))).toBe(true);
    expect(isTagged({ $lazarus: "bogus" })).toBe(false);
    expect(isTagged({ $lazarus: "NaN", extra: 1 })).toBe(false);
  });

  it("property: decode(encode(x)) preserves Object.is for numbers, arrays and objects", () => {
    fc.assert(
      fc.property(fc.double({ noDefaultInfinity: false, noNaN: false }), fc.array(fc.double(), { maxLength: 4 }), (x, xs) => {
        const value = { x, xs, nested: { x } };
        const back = decodeTagged(JSON.parse(JSON.stringify(encodeTagged(value)))) as typeof value;
        expect(Object.is(back.x, x)).toBe(true);
        expect(Object.is(back.nested.x, x)).toBe(true);
        expect(back.xs.length).toBe(xs.length);
        back.xs.forEach((v, i) => expect(Object.is(v, xs[i])).toBe(true));
      }),
      { numRuns: 200 }
    );
  });

  it("does not let a __proto__ key pollute prototypes while decoding", () => {
    const decoded = decodeTagged(JSON.parse('{"__proto__": {"polluted": true}, "a": 1}')) as Record<string, unknown>;
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(decoded["a"]).toBe(1);
  });

  it("describes values so that -0, NaN and undefined stay distinguishable", () => {
    expect(describeValue(-0)).toBe("-0");
    expect(describeValue(0)).toBe("0");
    expect(describeValue(Number.NaN)).toBe("NaN");
    expect(describeValue(undefined)).toBe("undefined");
    expect(describeValue("")).toBe('""');
    expect(describeValue([-0, { a: Number.NaN }])).toBe('[-0, { "a": NaN }]');
  });
});

describe("tagged probe encoding in the vm executor", () => {
  it("returns -0, NaN, Infinity and undefined as markers, and plain JSON stays the default", async () => {
    const code = "[-0, NaN, Infinity, -Infinity, undefined, 0]";
    expect((await vm.run({ code, encoding: "tagged" })).output).toEqual([
      { $lazarus: "-0" },
      { $lazarus: "NaN" },
      { $lazarus: "Infinity" },
      { $lazarus: "-Infinity" },
      { $lazarus: "undefined" },
      0,
    ]);
    expect((await vm.run({ code })).output).toEqual([0, null, null, null, null, 0]);
    expect((await vm.run({ code, encoding: "json" })).output).toEqual([0, null, null, null, null, 0]);
  });

  it("delivers tagged inputs to the probe as real values", async () => {
    const context = { a: tag("-0"), b: tag("NaN"), c: tag("Infinity"), d: [tag("-0"), 1] };
    const code = "[Object.is(a, -0), b !== b, c === Infinity, Object.is(d[0], -0), d[1]]";
    expect((await vm.run({ code, context, encoding: "tagged" })).output).toEqual([true, true, true, true, 1]);
    // Without the opt-in the markers are just objects, as before.
    expect((await vm.run({ code: "typeof a", context })).output).toBe("object");
  });

  it("a top-level undefined or -0 result is observable", async () => {
    expect((await vm.run({ code: "undefined", encoding: "tagged" })).output).toEqual({ $lazarus: "undefined" });
    expect((await vm.run({ code: "(-1 / 2) | 0", encoding: "tagged" })).output).toBe(0);
    expect((await vm.run({ code: "Math.trunc(-1 / 2)", encoding: "tagged" })).output).toEqual({ $lazarus: "-0" });
  });

  it("validates the encoding field", () => {
    expect(isProbeParams({ code: "1", encoding: "tagged" })).toBe(true);
    expect(isProbeParams({ code: "1", encoding: "json" })).toBe(true);
    expect(() => isProbeParams({ code: "1", encoding: "xml" })).toThrow(SandboxError);
  });
});
