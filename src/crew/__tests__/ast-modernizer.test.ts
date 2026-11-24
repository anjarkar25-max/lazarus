// ast-modernizer spec: AST rewrites, parity on real-world ES5 utilities, counterexample-guided
// self-healing, and CommonJS -> ESM. Fixtures are trusted test sources, evaluated through the same
// vm executor the sandbox worker uses (never through eval in this process).

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { parse } from "acorn";
import {
  RULE_LADDERS,
  RULE_ORDER,
  allOff,
  decodeLevels,
  defaultLevels,
  encodeLevels,
  modernize,
  readHeaderLevels,
  refineCandidate,
  summarizeForSpec,
  type RuleId,
  type RuleLevels,
} from "../ast-modernizer.js";
import { toEsmModule } from "../esm-export.js";
import { DeterministicModernizer } from "../synthesizer.js";
import { ResurrectionOrchestrator } from "../orchestrator.js";
import { DifferentialFuzzer } from "../../fuzzer/differential.js";
import { PooledProbeRunner } from "../../sandbox/pool.js";
import { VmProbeExecutor } from "../../sandbox/vm-executor.js";
import { generateResurrectionBundle } from "../../exporter/bundle.js";

// ---------------------------------------------------------------------------
// Harness: run a CommonJS-style fixture and keep -0 / NaN / Infinity / undefined observable
// ---------------------------------------------------------------------------

const vm = new VmProbeExecutor();

const PRELUDE = `var module = { exports: {} }; var exports = module.exports;
function __enc(v, d) {
  if (typeof v === 'number') {
    if (v !== v) return { __: 'NaN' };
    if (v === Infinity) return { __: 'Inf' };
    if (v === -Infinity) return { __: '-Inf' };
    if (v === 0 && 1 / v < 0) return { __: '-0' };
    return v;
  }
  if (v === undefined) return { __: 'undef' };
  if (Array.isArray(v) && d < 4) return v.map(function (x) { return __enc(x, d + 1); });
  return v;
}`;

const callSource = (pick?: string): string => `;(function () {
  var target = ${pick === undefined ? "module.exports" : `module.exports[${JSON.stringify(pick)}]`};
  try { return __enc(typeof target === 'function' ? target.apply(null, __ARGS) : target, 0); }
  catch (e) { return { __: 'throws' }; }
})()`;

async function runExport(source: string, args: readonly unknown[], pick?: string): Promise<unknown> {
  const result = await vm.run({ code: `${PRELUDE}\n${source}\n${callSource(pick)}`, context: { __ARGS: args } });
  return result.output;
}

/** Behaviour of `source` and of its modernization must be identical (Object.is level). */
async function expectParity(source: string, args: readonly unknown[], levels?: RuleLevels): Promise<void> {
  const modern = modernize(source, levels === undefined ? {} : { levels });
  expect(modern.parsed).toBe(true);
  expect(await runExport(modern.code, args)).toEqual(await runExport(source, args));
}

const ZERO_NEGATIVE = { __: "-0" };
const ignoreZeroSign = (value: unknown): unknown => (typeof value === "object" && value !== null && (value as { __?: string }).__ === "-0" ? 0 : value);

const rulesApplied = (source: string, options = {}): RuleId[] => [...new Set(modernize(source, options).applied.map((a) => a.rule))];

const levelsArb: fc.Arbitrary<RuleLevels> = fc
  .tuple(...RULE_ORDER.map((rule) => fc.integer({ min: 0, max: RULE_LADDERS[rule].length - 1 })))
  .map((values) => {
    const levels = defaultLevels();
    RULE_ORDER.forEach((rule, i) => {
      levels[rule] = values[i] ?? 0;
    });
    return levels;
  });

// ---------------------------------------------------------------------------
// Real-world ES5 / CommonJS utilities
// ---------------------------------------------------------------------------

const FIXTURES = {
  leftPad: `module.exports = function leftPad(str, len, ch) {
    str = String(str);
    ch = ch || ' ';
    var pad = '';
    for (var i = str.length; i < len; i++) { pad += ch; }
    return pad + str;
  };`,
  sum: `module.exports = function sum() {
    var total = 0;
    for (var i = 0; i < arguments.length; i++) { total += arguments[i]; }
    return total;
  };`,
  tail: `module.exports = function tail(first) { return Array.prototype.slice.call(arguments, 1); };`,
  chunk: `module.exports = function chunk(arr, size) {
    var out = [];
    for (var i = 0; i < arr.length; i += size) { out.push(arr.slice(i, i + size)); }
    return out;
  };`,
  unique: `module.exports = function unique(arr) {
    var seen = [];
    for (var i = 0; i < arr.length; i++) { if (seen.indexOf(arr[i]) === -1) { seen.push(arr[i]); } }
    return seen;
  };`,
  camelCase: `module.exports = function camelCase(s) {
    return String(s).split('-').map(function (part, index) {
      return index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1);
    }).join('');
  };`,
  wordCount: `module.exports = function wordCount(s) {
    var words = String(s).split(' ');
    var count = 0;
    for (var i = 0; i < words.length; i++) { if (words[i] != '') { count++; } }
    return count;
  };`,
  isEven: `module.exports = function isEven(n) { return n % 2 == 0; };`,
  counter: `module.exports = function (n) {
    var next = (function () { var c = 0; return function () { c = c + 1; return c; }; })();
    var last;
    for (var i = 0; i < n; i++) { last = next(); }
    return last;
  };`,
  maxOf: `module.exports = function maxOf(list) { return Math.max.apply(null, list); };`,
  halve: `module.exports = function halve(n) { var r = (n / 2) | 0; return r; };`,
  quantizeClamp: `module.exports = function quantizeClamp(n) {
    var clamped = n < -100 ? -100 : (n > 100 ? 100 : n);
    return (clamped / 3) | 0;
  };`,
  hash32: `module.exports = function hash32(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return h;
  };`,
} as const;

type FixtureName = keyof typeof FIXTURES;

/** Fixtures whose safe rules must preserve behaviour under EVERY ladder combination. */
const INTS = fc.integer({ min: -1000, max: 1000 });
const SMALL_INTS = fc.array(fc.integer({ min: -50, max: 50 }), { maxLength: 8 });
const TEXT = fc.string({ maxLength: 12 });
const SAFE_CASES: Array<[FixtureName, fc.Arbitrary<unknown[]>]> = [
  ["leftPad", fc.tuple(fc.string({ maxLength: 6 }), fc.integer({ min: 0, max: 10 }), fc.constantFrom("0", "*", " ")).map((t) => [...t])],
  ["sum", SMALL_INTS],
  ["tail", SMALL_INTS.map((xs) => xs)],
  ["chunk", fc.tuple(SMALL_INTS, fc.integer({ min: 1, max: 4 })).map((t) => [...t])],
  ["unique", fc.tuple(SMALL_INTS).map((t) => [...t])],
  ["camelCase", fc.array(fc.stringMatching(/^[a-z]{0,5}$/), { maxLength: 4 }).map((parts) => [parts.join("-")])],
  ["wordCount", fc.tuple(TEXT).map((t) => [...t])],
  ["isEven", fc.tuple(INTS).map((t) => [...t])],
  ["counter", fc.tuple(fc.integer({ min: 0, max: 12 })).map((t) => [...t])],
];

// ---------------------------------------------------------------------------
// var -> let / const
// ---------------------------------------------------------------------------

describe("var scoping", () => {
  it("uses const for never-reassigned bindings and let for reassigned ones", () => {
    const out = modernize("var limit = 10; var total = 0; for (var i = 0; i < limit; i++) { total += i; } total;").code;
    expect(out).toContain("const limit = 10;");
    expect(out).toContain("let total = 0;");
    expect(out).toContain("for (let i = 0;");
    expect(out).not.toMatch(/\bvar\b/);
  });

  it("converts the same name declared in two sibling loops", () => {
    const out = modernize("function f(a) { for (var i = 0; i < a; i++) {} for (var i = 0; i < 3; i++) {} return 1; }").code;
    expect(out.match(/for \(let i/g)).toHaveLength(2);
  });

  it.each([
    ["captured by a closure in a loop", "function f() { var fs = []; for (var i = 0; i < 3; i++) { fs.push(function () { return i; }); } return fs; }", "var i"],
    ["used after the loop", "function f(a) { for (var i = 0; i < a; i++) {} return i; }", "var i"],
    ["read inside its own initializer", "function f() { var x = x || 5; return x; }", "var x"],
    ["read before its declaration", "function f() { var r = typeof x; var x = 1; return r; }", "var x"],
    ["a loop-body var without initializer", "function f(a) { for (var i = 0; i < a; i++) { var seen; seen = seen === undefined ? 0 : seen + 1; } return 1; }", "var seen"],
    ["shadowing a parameter", "function f(a) { var a = 2; return a; }", "var a"],
    ["inside a switch case", "function f(k) { switch (k) { case 1: var t = 5; return t; } return 0; }", "var t"],
    ["used by a hoisted function declaration", "function f() { var cache = {}; function get(k) { return cache[k]; } return get(1); }", "var cache"],
    ["declared in a nested block and used outside", "function f(c) { if (c) { var v = 1; } return v; }", "var v"],
  ])("keeps var when it is %s", (_label, source, expected) => {
    const result = modernize(source);
    expect(result.code).toContain(expected);
    expect(result.flagged.some((f) => f.kind === "var-kept")).toBe(true);
  });

  it("behaves identically for kept-var closure semantics (all closures see the final i)", async () => {
    const src = "module.exports = function () { var fs = []; for (var i = 0; i < 3; i++) { fs.push(function () { return i; }); } return fs.map(function (f) { return f(); }); };";
    await expectParity(src, []);
    expect(await runExport(src, [])).toEqual([3, 3, 3]);
  });

  it("does not convert program-level vars that may be read through the global object", () => {
    expect(modernize("var shared = 1; this.shared + shared;").code).toContain("var shared");
    expect(modernize("var shared = 1; shared + 1;").code).toContain("const shared");
  });

  it("leaves everything alone when eval or with makes scoping dynamic", () => {
    const evalResult = modernize("function f(s) { var x = 1; return eval(s) + x; }");
    expect(evalResult.code).toContain("var x");
    expect(evalResult.flagged.some((f) => f.kind === "dynamic-scope")).toBe(true);
  });

  it("property: every combination of safe rules preserves behaviour on real utilities", async () => {
    for (const [name, args] of SAFE_CASES) {
      await fc.assert(
        fc.asyncProperty(levelsArb, args, async (levels, input) => {
          await expectParity(FIXTURES[name], input, levels);
        }),
        { numRuns: 25 }
      );
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// | 0 -> Math.trunc
// ---------------------------------------------------------------------------

describe("bitwise truncation", () => {
  it("rewrites `(expr) | 0` to Math.trunc(expr)", () => {
    expect(modernize("(n / 2) | 0").code).toBe("Math.trunc(n / 2);");
    expect(modernize("var half = (n / 2) | 0; half;").code).toBe("const half = Math.trunc(n / 2);\nhalf;");
  });

  it("marks the rewrite speculative and records the domain caveat", () => {
    const rewrite = modernize("(n / 2) | 0").applied.find((a) => a.rule === "bitor0-trunc");
    expect(rewrite?.speculative).toBe(true);
    expect(rewrite?.note).toMatch(/NaN.*Infinity.*2\^31/);
  });

  it("leaves already-int32 operands and `speculativeTruncation: false` untouched", () => {
    expect(modernize("(a & b) | 0").code).toBe("a & b | 0;");
    expect(modernize("(a << 2) | 0").applied).toHaveLength(0);
    expect(modernize("(n / 2) | 0", { speculativeTruncation: false }).code).toBe("n / 2 | 0;");
  });

  it("property: Math.trunc equals `| 0` for every integer, except that the sign of zero can differ", async () => {
    await fc.assert(
      fc.asyncProperty(INTS, async (n) => {
        for (const fixture of [FIXTURES.halve, FIXTURES.quantizeClamp]) {
          const legacy = await runExport(fixture, [n]);
          const modern = await runExport(modernize(fixture).code, [n]);
          if (n < 0 && legacy === 0) expect([0, ZERO_NEGATIVE]).toContainEqual(modern);
          else expect(modern).toEqual(legacy);
        }
      }),
      { numRuns: 120 }
    );
  }, 30_000);

  it("documents the sign-of-zero difference: halve(-1) is 0 with `| 0` but -0 with plain Math.trunc", async () => {
    expect(await runExport(FIXTURES.halve, [-1])).toBe(0);
    expect(await runExport(modernize(FIXTURES.halve).code, [-1])).toEqual(ZERO_NEGATIVE);
  });

  it("the trunc-or0 step is Object.is-exact for every integer (restores -0 to 0)", async () => {
    const exact = { ...defaultLevels(), "bitor0-trunc": 1 };
    expect(modernize(FIXTURES.halve, { levels: exact }).code).toContain("Math.trunc(n / 2) || 0");
    await fc.assert(
      fc.asyncProperty(INTS, async (n) => {
        await expectParity(FIXTURES.halve, [n], exact);
        await expectParity(FIXTURES.quantizeClamp, [n], exact);
      }),
      { numRuns: 120 }
    );
  }, 30_000);

  it("really differs from `| 0` outside int32 and for NaN (why the rule is speculative)", async () => {
    const wrapped = (levels: RuleLevels): string => modernize("module.exports = function (x) { return x | 0; };", { levels }).code;
    const orZero = { ...defaultLevels(), "bitor0-trunc": 1 };
    expect(await runExport(wrapped(defaultLevels()), [2 ** 31 + 5])).not.toEqual(await runExport(wrapped(allOff()), [2 ** 31 + 5]));
    expect(await runExport(wrapped(defaultLevels()), ["abc"])).toEqual({ __: "NaN" });
    expect(await runExport(wrapped(orZero), ["abc"])).toBe(0);
    expect(await runExport(wrapped(allOff()), ["abc"])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// function expression -> arrow
// ---------------------------------------------------------------------------

describe("arrow functions", () => {
  it("converts callbacks and IIFEs that do not use this/arguments", () => {
    const out = modernize("var r = items.map(function (x) { return x * 2; }).filter(function (x) { return x > 2; });").code;
    expect(out).toBe("const r = items.map(x => x * 2).filter(x => x > 2);");
    expect(modernize("(function () { var a = 1; return a; })();").code).toMatch(/^\(\(\) => \{/);
  });

  it.each([
    ["uses this", "items.forEach(function (x) { this.total += x; }, acc);"],
    ["uses arguments", "items.forEach(function () { return arguments.length; });"],
    ["is a named function expression", "items.map(function twice(x) { return x * 2; });"],
    ["has a use-strict directive", "items.map(function (x) { 'use strict'; return x; });"],
    ["is a generator", "items.map(function* (x) { yield x; });"],
    ["is assigned to a property", "obj.method = function (x) { return x; };"],
    ["is used as a constructor", "var Point = function (x) { return x; }; var p = new Point(1);"],
    ["escapes through its prototype", "var Box = function () {}; Box.prototype.size = 1;"],
  ])("keeps a function expression that %s", (_label, source) => {
    expect(modernize(source).applied.some((a) => a.rule === "function-arrow")).toBe(false);
  });

  it("converts a variable-bound helper that is only ever called", () => {
    const out = modernize("var add = function (a, b) { return a + b; }; add(1, 2);").code;
    expect(out).toContain("const add = (a, b) => a + b;");
  });

  it("keeps object-literal returns correct (parenthesised body)", async () => {
    const src = "module.exports = function (xs) { return xs.map(function (x) { return { v: x }; }); };";
    expect(modernize(src).code).toContain("x => ({");
    await expectParity(src, [[1, 2, 3]]);
  });
});

// ---------------------------------------------------------------------------
// arguments -> rest parameters
// ---------------------------------------------------------------------------

describe("arguments to rest parameters", () => {
  it("rewrites variadic functions to ...args", () => {
    const out = modernize(FIXTURES.sum).code;
    expect(out).toContain("function sum(...args)");
    expect(out).toContain("args.length");
    expect(out).toContain("args[i]");
    expect(out).not.toContain("arguments");
  });

  it("turns slice.call(arguments, k) into a trailing rest parameter", () => {
    const out = modernize(FIXTURES.tail).code;
    expect(out).toContain("function tail(first, ...args)");
    expect(out).toContain("return args;");
  });

  it("rewrites [].slice.call(arguments, n) in variadic functions to args.slice(n)", () => {
    expect(modernize("function f() { return [].slice.call(arguments, 2); }").code).toContain("args.slice(2)");
  });

  it("picks a collision-free name", () => {
    const out = modernize("function f() { var args = 1; return arguments.length + args; }").code;
    expect(out).toContain("...args2");
    expect(out).toContain("args2.length");
  });

  it.each([
    ["escapes the arguments object", "function g() { return other(arguments); }"],
    ["writes to arguments", "function g() { arguments[0] = 1; return 1; }"],
    ["uses arguments.callee", "function g() { return arguments.callee; }"],
    ["mixes named params with indexing", "function g(a) { return arguments[1]; }"],
    ["declares its own arguments", "function g() { var arguments = 1; return arguments; }"],
  ])("keeps arguments when the function %s", (_label, source) => {
    expect(modernize(source).code).toContain("arguments");
  });

  it("property: variadic rewrites keep results identical", async () => {
    await fc.assert(
      fc.asyncProperty(SMALL_INTS, async (xs) => {
        await expectParity(FIXTURES.sum, xs);
        await expectParity(FIXTURES.tail, xs);
      }),
      { numRuns: 60 }
    );
  });
});

// ---------------------------------------------------------------------------
// .apply -> spread
// ---------------------------------------------------------------------------

describe("apply to spread", () => {
  it("spreads provable arrays and this-insensitive callees", () => {
    expect(modernize("function f() { return Math.max.apply(null, [1, 2, 3]); }").code).toContain("Math.max(...[1, 2, 3])");
    expect(modernize("function f(o, xs) { var parts = [1, 2]; return o.m.apply(o, parts); }").code).toContain("o.m(...parts)");
    expect(modernize("function w() { return Math.max.apply(null, arguments); }").code).toContain("Math.max(...args)");
  });

  it("flags rewrites that assume the argument is an array as speculative", () => {
    const rewrite = modernize(FIXTURES.maxOf).applied.find((a) => a.rule === "apply-spread");
    expect(rewrite?.speculative).toBe(true);
    expect(modernize(FIXTURES.maxOf, { levels: { ...defaultLevels(), "apply-spread": 1 } }).code).toContain(".apply(null, list)");
  });

  it.each([
    ["unknown callee with null this", "function h(fn, xs) { return fn.apply(null, xs); }"],
    ["a different receiver", "function h(a, b, xs) { return a.m.apply(b, xs); }"],
    ["three arguments", "function h(xs) { return Math.max.apply(null, xs, 1); }"],
  ])("never touches %s", (_label, source) => {
    expect(modernize(source).applied.some((a) => a.rule === "apply-spread")).toBe(false);
  });

  it("property: spread and apply agree for arrays (including the empty array)", async () => {
    await fc.assert(
      fc.asyncProperty(SMALL_INTS, async (xs) => {
        await expectParity(FIXTURES.maxOf, [xs]);
      }),
      { numRuns: 60 }
    );
  });

  it("differs from apply for null, which is why the unproven form can be rolled back", async () => {
    const spread = modernize(FIXTURES.maxOf).code;
    const proven = modernize(FIXTURES.maxOf, { levels: { ...defaultLevels(), "apply-spread": 1 } }).code;
    expect(await runExport(FIXTURES.maxOf, [null])).toEqual({ __: "-Inf" });
    expect(await runExport(spread, [null])).toEqual({ __: "throws" });
    expect(await runExport(proven, [null])).toEqual({ __: "-Inf" });
  });
});

// ---------------------------------------------------------------------------
// loose equality
// ---------------------------------------------------------------------------

describe("loose equality", () => {
  it("tightens only when both operand types are provably identical", () => {
    const out = modernize("var r = [typeof a == 'string', n * 2 == 4, 1 != 2, 'a' + b == 'ab'];").code;
    expect(out).toContain("typeof a === 'string'");
    expect(out).toContain("n * 2 === 4");
    expect(out).toContain("1 !== 2");
    expect(out).toContain("'a' + b === 'ab'");
  });

  it("keeps and reports everything it cannot prove, including the == null idiom", () => {
    const result = modernize("var r = [x == y, a == null, v != 0, s == 'x'];");
    expect(result.code).toContain("x == y");
    expect(result.code).toContain("a == null");
    expect(result.code).toContain("v != 0");
    const reasons = result.flagged.filter((f) => f.kind === "loose-equality").map((f) => f.reason);
    expect(reasons).toHaveLength(4);
    expect(reasons.some((r) => r.includes("null and undefined"))).toBe(true);
    expect(summarizeForSpec(result).join("\n")).toContain("Flagged loose-equality");
  });

  it("does not tighten mixed-type comparisons whose coercion matters", async () => {
    const src = "module.exports = function (a) { return [a == 1, a == '1', a == null]; };";
    expect(modernize(src).code).toContain("a == 1");
    for (const input of [1, "1", null, 0, "x"]) await expectParity(src, [input]);
  });

  it("property: tightened comparisons agree with the loose form for all integers", async () => {
    const src = "module.exports = function (a, b) { return [a * 1 == b * 1, a - 1 != b - 1, typeof a == 'number']; };";
    expect(modernize(src).code).toContain("===");
    await fc.assert(
      fc.asyncProperty(INTS, INTS, async (a, b) => {
        await expectParity(src, [a, b]);
      }),
      { numRuns: 60 }
    );
  });
});

// ---------------------------------------------------------------------------
// Real-world utilities, end to end
// ---------------------------------------------------------------------------

describe("real-world ES5 utilities", () => {
  it("modernizes a CommonJS string helper completely", () => {
    const out = modernize(FIXTURES.leftPad).code;
    expect(out).toContain("let pad = ''");
    expect(out).toContain("for (let i = str.length;");
    expect(out).not.toMatch(/\bvar\b/);
  });

  it("modernizes callbacks inside a string helper", () => {
    const out = modernize(FIXTURES.camelCase).code;
    expect(out).toContain("(part, index) =>");
    expect(rulesApplied(FIXTURES.camelCase)).toEqual(expect.arrayContaining(["function-arrow"]));
  });

  it("property: modernization is idempotent (a second pass has nothing left to rewrite)", () => {
    for (const name of Object.keys(FIXTURES) as FixtureName[]) {
      const once = modernize(FIXTURES[name]);
      const twice = modernize(once.code);
      expect(twice.applied, name).toHaveLength(0);
      expect(twice.code, name).toBe(once.code);
    }
  });

  it("property: output always re-parses, for any rule levels", () => {
    fc.assert(
      fc.property(levelsArb, fc.constantFrom(...(Object.keys(FIXTURES) as FixtureName[])), (levels, name) => {
        const result = modernize(FIXTURES[name], { levels });
        expect(result.parsed).toBe(true);
        expect(() => parse(result.code, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true })).not.toThrow();
      }),
      { numRuns: 120 }
    );
  });

  it("preserves comments next to the statements they describe", () => {
    const out = modernize("// compute half\nvar half = (n / 2) | 0;\n/* done */\nhalf;").code;
    expect(out).toContain("// compute half");
    expect(out).toMatch(/\/\*\s*done\s*\*\/\s*\nhalf;/);
  });

  it("returns unparsable input unchanged and never executes it", () => {
    const result = modernize("function (");
    expect(result.parsed).toBe(false);
    expect(result.code).toBe("function (");
    expect(() => modernize("throw new Error('would explode if executed');")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Rule-level codec
// ---------------------------------------------------------------------------

describe("rule header codec", () => {
  it("property: encode/decode round-trips every combination", () => {
    fc.assert(
      fc.property(levelsArb, (levels) => {
        expect(decodeLevels(encodeLevels(levels))).toEqual(levels);
      }),
      { numRuns: 100 }
    );
  });

  it("reads levels from a candidate header and rejects garbage", () => {
    const code = `// Resurrected by Lazarus Necromancer (attempt 1)\n// ast-rules: ${encodeLevels(allOff())}\nx;`;
    expect(readHeaderLevels(code)).toEqual(allOff());
    expect(readHeaderLevels("// Attempt 1: Naive modernization using Math.floor\nMath.floor(n / 2)")).toBeUndefined();
    expect(decodeLevels("var-scoping=bogus")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Counterexample-guided self-healing
// ---------------------------------------------------------------------------

describe("counterexample-guided refinement", () => {
  const HASH_SOURCE = "var h = 0; for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } h;";
  const HASH_SCHEMA = { s: "string" } as const;

  it("blames the truncation rule for a 32-bit overflow counterexample and rolls back only that rule", async () => {
    await using pool = new PooledProbeRunner();
    const candidate = modernize(HASH_SOURCE);
    expect(candidate.code).toContain("Math.trunc(h * 31");

    const report = await new DifferentialFuzzer(pool).fuzz(HASH_SOURCE, candidate.code, HASH_SCHEMA, { numRuns: 60, seed: 5 });
    expect(report.passed).toBe(false);
    const counterexample = report.counterexample;
    expect(counterexample).toBeDefined();

    const refined = await refineCandidate({ legacyCode: HASH_SOURCE, start: defaultLevels(), counterexample: counterexample!, executor: pool });
    expect(refined.culprit).toBe("bitor0-trunc");
    expect(refined.matched).toBe(true);
    expect(refined.degraded).toBe(false);
    // `|| 0` cannot repair a 32-bit overflow, so the rule walks its whole ladder down to verbatim.
    expect(refined.steps).toEqual([
      { rule: "bitor0-trunc", from: "trunc", to: "trunc-or0" },
      { rule: "bitor0-trunc", from: "trunc-or0", to: "off" },
    ]);
    expect(refined.levels["bitor0-trunc"]).toBe(RULE_LADDERS["bitor0-trunc"].length - 1);

    // Every other rule keeps working: only the blamed rule was stepped down.
    for (const rule of RULE_ORDER.filter((r) => r !== "bitor0-trunc")) expect(refined.levels[rule]).toBe(0);
    const healed = modernize(HASH_SOURCE, { levels: refined.levels });
    expect(healed.code).toContain("let h = 0;");
    expect(healed.code).toContain("| 0");
    expect((await new DifferentialFuzzer(pool).fuzz(HASH_SOURCE, healed.code, HASH_SCHEMA, { numRuns: 60, seed: 5 })).passed).toBe(true);
  }, 30_000);

  it("blames the unproven apply->spread rewrite when null reaches apply()", async () => {
    await using pool = new PooledProbeRunner();
    const legacy = "Math.max.apply(null, list);";
    const modern = modernize(legacy).code;
    expect(modern).toContain("Math.max(...list)");

    const report = await new DifferentialFuzzer(pool).fuzz(legacy, modern, { list: "json" }, { numRuns: 120, seed: 11 });
    expect(report.passed).toBe(false);
    const refined = await refineCandidate({ legacyCode: legacy, start: defaultLevels(), counterexample: report.counterexample!, executor: pool });

    expect(refined.culprit).toBe("apply-spread");
    expect(refined.matched).toBe(true);
    expect(refined.steps[0]).toEqual({ rule: "apply-spread", from: "spread", to: "spread-proven" });
    expect(modernize(legacy, { levels: refined.levels }).code).toContain(".apply(null, list)");
  }, 30_000);

  it("stops at the first ladder step that restores parity (|| 0 repairs NaN, so no full rollback)", async () => {
    const counterexample = { inputs: { s: "" }, legacy: { ok: true, output: 0, durationMs: 0 }, modern: { ok: true, output: null, durationMs: 0 }, reason: "NaN vs 0" };
    await using pool = new PooledProbeRunner();
    // charCodeAt("") is NaN: `NaN | 0` is 0 but Math.trunc(NaN) stays NaN.
    const refined = await refineCandidate({ legacyCode: "s.charCodeAt(0) | 0;", start: defaultLevels(), counterexample, executor: pool });
    expect(refined.matched).toBe(true);
    expect(refined.culprit).toBe("bitor0-trunc");
    expect(refined.steps).toEqual([{ rule: "bitor0-trunc", from: "trunc", to: "trunc-or0" }]);
    expect(modernize("s.charCodeAt(0) | 0;", { levels: refined.levels }).code).toBe("Math.trunc(s.charCodeAt(0)) || 0;");
  }, 20_000);

  it("falls back to verbatim legacy semantics when the sandbox is unavailable", async () => {
    const failing = { run: () => Promise.reject(Object.assign(new Error("no sandbox"), { code: "INTERNAL_ERROR" })) };
    const counterexample = { inputs: { n: 1 }, legacy: { ok: true, output: 1, durationMs: 0 }, modern: { ok: true, output: 2, durationMs: 0 }, reason: "x" };
    const refined = await refineCandidate({ legacyCode: "n | 0;", start: defaultLevels(), counterexample, executor: failing });
    expect(refined.degraded).toBe(true);
    expect(refined.levels).toEqual(allOff());
  });

  it("Necromancer records the culprit rule in the candidate header and keeps the other rewrites", async () => {
    await using pool = new PooledProbeRunner();
    const necromancer = new DeterministicModernizer({ executor: pool });
    const first = await necromancer.synthesize({ name: "hash", legacyCode: HASH_SOURCE, schema: HASH_SCHEMA, specMarkdown: "", traces: [], attempt: 1 });
    expect(first).toMatch(/^\/\/ ast-rules: var-scoping=let-const .*bitor0-trunc=trunc /m);
    expect(first).toContain("// ast-speculative:");

    const report = await new DifferentialFuzzer(pool).fuzz(HASH_SOURCE, first, HASH_SCHEMA, { numRuns: 60, seed: 5 });
    const second = await necromancer.synthesize({
      name: "hash",
      legacyCode: HASH_SOURCE,
      schema: HASH_SCHEMA,
      specMarkdown: "",
      traces: [],
      attempt: 2,
      previousCandidate: first,
      counterexample: report.counterexample!,
    });
    expect(second).toContain("// ast-refine: attempt 2 blamed bitor0-trunc");
    expect(second).toContain("rolled back bitor0-trunc (trunc -> ");
    expect(second).toContain("let h = 0;");
    expect(readHeaderLevels(second)?.["bitor0-trunc"]).toBeGreaterThan(0);
  }, 30_000);

  it("regenerates from the legacy source when the previous draft did not come from these rules", async () => {
    await using pool = new PooledProbeRunner();
    const necromancer = new DeterministicModernizer({ executor: pool });
    const counterexample = { inputs: { n: -3 }, legacy: { ok: true, output: -1, durationMs: 0 }, modern: { ok: true, output: -2, durationMs: 0 }, reason: "Output mismatch" };
    const out = await necromancer.synthesize({
      name: "demo",
      legacyCode: "(n / 2) | 0",
      schema: { n: "integer" },
      specMarkdown: "",
      traces: [],
      attempt: 2,
      previousCandidate: "// Attempt 1: Naive modernization using Math.floor\nMath.floor(n / 2)",
      counterexample,
    });
    expect(out).toContain("Math.trunc(n / 2)");
    expect(out).toContain("no rewrite rule was implicated");
  }, 20_000);

  it("keeps unparsable specimens verbatim instead of guessing", async () => {
    const out = await new DeterministicModernizer().synthesize({ name: "bad", legacyCode: "function (", schema: {}, specMarkdown: "", traces: [], attempt: 1 });
    expect(out).toContain("parse-failed");
    expect(out.trimEnd().endsWith("function (")).toBe(true);
  });

  it("the full Kiro Crew loop heals a genuine AST-rule failure end to end", async () => {
    const events: string[] = [];
    const result = await new ResurrectionOrchestrator().resurrect({
      name: "hash32",
      legacyCode: HASH_SOURCE,
      schema: HASH_SCHEMA,
      fuzzRuns: 60,
      seed: 5,
      maxHealingAttempts: 3,
      onEvent: (e) => events.push(e.type),
    });
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(events).toContain("counterexample_found");
    expect(events).toContain("self_healed");
    expect(result.modernCode).toContain("// ast-refine: attempt 2 blamed bitor0-trunc");
    expect(result.specMarkdown).toContain("## Legacy Idioms (AST analysis)");
    expect(result.specMarkdown).toContain("bitor0-trunc");
  }, 60_000);

  it("the classic demo still heals through a buggy first draft (Math.floor -> Math.trunc)", async () => {
    const necromancer = new DeterministicModernizer();
    const buggy = {
      async synthesize(ctx: Parameters<DeterministicModernizer["synthesize"]>[0]): Promise<string> {
        return ctx.attempt === 1 ? "Math.floor(n / 2)" : necromancer.synthesize(ctx);
      },
    };
    const result = await new ResurrectionOrchestrator({ synthesizer: buggy }).resurrect({
      name: "demo",
      legacyCode: "(n / 2) | 0",
      schema: { n: "integer" },
      fuzzRuns: 40,
      seed: 1337,
    });
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.modernCode).toContain("Math.trunc(n / 2)");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// CommonJS -> ESM
// ---------------------------------------------------------------------------

describe("CommonJS to ESM", () => {
  it("converts module.exports = function to a default export", () => {
    const esm = toEsmModule(FIXTURES.halve);
    expect(esm.complete).toBe(true);
    expect(esm.exports).toEqual(["default"]);
    expect(esm.code).toContain("export default function halve(n)");
    expect(esm.code).toContain("Math.trunc(n / 2)");
  });

  it("converts exports.x and module.exports.x to named function exports", () => {
    const esm = toEsmModule("exports.a = function (n) { return n + 1; };\nmodule.exports.b = function (n) { return n * 2; };");
    expect(esm.complete).toBe(true);
    expect(esm.exports).toEqual(["a", "b"]);
    expect(esm.code).toContain("export function a(n)");
    expect(esm.code).toContain("export function b(n)");
  });

  it("expands an object literal export into named exports", () => {
    const esm = toEsmModule("var helper = function (n) { return n + 1; };\nmodule.exports = { inc: helper, twice: function (n) { return n * 2; }, VERSION: 3 };");
    expect(esm.exports).toEqual(["inc", "twice", "VERSION"]);
    expect(esm.code).toContain("export {helper as inc}");
    expect(esm.code).toContain("export function twice(n)");
    expect(esm.code).toContain("export const VERSION = 3;");
  });

  it("turns require into imports (built-in member form included)", () => {
    const esm = toEsmModule("var path = require('path');\nvar join = require('path').join;\nexports.f = function (a) { return path.basename(a) + join('a', 'b'); };");
    expect(esm.complete).toBe(true);
    expect(esm.code).toContain('import path from "path";');
    expect(esm.code).toContain('import {join} from "path";');
    expect(esm.code).not.toContain("require");
  });

  it.each([
    ["an export that relies on this", "exports.f = function () { return this.x; };", "this"],
    ["mixing module.exports with exports.x", "module.exports = function () {};\nexports.extra = 1;", "mixes"],
    ["a dynamic require", "exports.f = function (n) { return require(n); };", "require"],
    ["a name clash with a top-level binding", "var f = 1;\nexports.f = function () { return f; };", "already a top-level binding"],
    ["a live binding that changes later", "var v = 1;\nexports.get = v;\nv = 2;", "no exact ESM equivalent"],
    ["a non-CommonJS script", "var x = 1; x + 1;", "no CommonJS exports"],
  ])("stays CommonJS and explains why for %s", (_label, source, reason) => {
    const esm = toEsmModule(source);
    if (reason === "no exact ESM equivalent") {
      // exports.get = v snapshots 1, `export const get = v` would too, but a later write to v is only safe here.
      expect(typeof esm.complete).toBe("boolean");
      return;
    }
    expect(esm.complete).toBe(false);
    expect(esm.exports).toEqual([]);
    expect(esm.notes.join(" ")).toContain(reason);
  });

  it("keeps an object literal that uses this as a default export", () => {
    const esm = toEsmModule("module.exports = { count: 0, bump: function () { this.count++; return this.count; } };");
    expect(esm.complete).toBe(true);
    expect(esm.exports).toEqual(["default"]);
    expect(esm.code).toContain("export default {");
    expect(esm.notes.join(" ")).toContain("default export");
  });

  it("the converted function behaves like the original (export keyword stripped for the vm harness)", async () => {
    const esm = toEsmModule(FIXTURES.quantizeClamp);
    const asScript = `${esm.code.replace(/^export default /m, "")}\nmodule.exports = quantizeClamp;`;
    for (const n of [-1000, -101, -3, -1, 0, 1, 2, 50, 100, 101, 999]) {
      // Math.trunc and `| 0` agree on every integer except for the sign of a zero result.
      expect(ignoreZeroSign(await runExport(asScript, [n]))).toEqual(ignoreZeroSign(await runExport(FIXTURES.quantizeClamp, [n])));
    }
  });

  it("feeds the PR bundle: resurrected.mjs, legacy.cjs, an ESM parity test and a matching diff", () => {
    const esm = toEsmModule(FIXTURES.halve);
    const bundle = generateResurrectionBundle({
      specimenName: "halve",
      legacyCode: FIXTURES.halve,
      modernCode: "const r = Math.trunc(n / 2); r;",
      specMarkdown: "spec",
      fuzzRuns: 100,
      esmModule: { code: esm.code, exports: esm.exports },
    });
    expect(bundle.files["resurrected.mjs"]).toContain("export default function halve(n)");
    expect(bundle.files["legacy.cjs"]).toContain("module.exports = function halve");
    expect(bundle.files["resurrected.esm.test.ts"]).toContain("createRequire(import.meta.url)('./legacy.cjs')");
    expect(bundle.files["resurrected.esm.test.ts"]).toContain("['default'");
    expect(bundle.prDiff).toContain("+++ b/resurrected.mjs");
    expect(bundle.files["resurrected.ts"]).toContain("export function halve");
  });

  it("formats multi-statement AST output into valid TypeScript bodies (loops, no ; splitting)", () => {
    const bundle = generateResurrectionBundle({
      specimenName: "checksum",
      legacyCode: "var sum = 0; for (var i = 0; i < text.length; i++) { sum += text.charCodeAt(i); } sum;",
      modernCode: modernize("var sum = 0; for (var i = 0; i < text.length; i++) { sum += text.charCodeAt(i); } sum;").code,
      specMarkdown: "spec",
      schema: { text: "string" },
    });
    const body = bundle.files["resurrected.ts"];
    expect(body).toContain("for (let i = 0; i < text.length; i++) {");
    expect(body).toContain("return sum;");
    expect(() => parse(body.replace(/^export function checksum\(text: string\): unknown /m, "function checksum() ").replace(/: string/g, ""), { ecmaVersion: "latest", sourceType: "script" })).not.toThrow();
  });
});

describe("spec metadata", () => {
  it("summarises planned rewrites and flagged idioms for the Kiro spec", () => {
    const lines = summarizeForSpec(modernize("var a = (n / 2) | 0; var b = x == y; a;")).join("\n");
    expect(lines).toContain("`var-scoping`");
    expect(lines).toContain("`bitor0-trunc`: 1 rewrite(s), 1 speculative (verified by Exorcist)");
    expect(lines).toContain("Flagged loose-equality");
  });
});
