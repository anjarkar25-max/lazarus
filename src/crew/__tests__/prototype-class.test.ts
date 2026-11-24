import * as fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { DifferentialFuzzer } from "../../fuzzer/differential.js";
import { PooledProbeRunner } from "../../sandbox/pool.js";
import { scanLegacyAst } from "../../sandbox/ast-scanner.js";
import { RULE_LADDERS, allOff, defaultLevels, modernize, readHeaderLevels, stepDown } from "../ast-modernizer.js";
import { ResurrectionOrchestrator } from "../orchestrator.js";

const pool = new PooledProbeRunner();
const fuzzer = new DifferentialFuzzer(pool);
afterAll(async () => {
  await pool[Symbol.asyncDispose]();
});

const COUNTER = `
// A counter
function Counter(start) {
  this.n = start;
}
Counter.prototype.inc = function (step) {
  this.n = this.n + step;
  return this;
};
Counter.prototype.value = function () {
  return this.n;
};
Counter.create = function (start) {
  return new Counter(start);
};
Counter.VERSION = 2;
var counter = Counter.create(start);
counter.inc(step).inc(step);
counter.value() + Counter.VERSION;
`;

const classOnly = (code: string): string => modernize(code, { levels: { ...allOff(), "prototype-class": 0 } }).code;

describe("prototype-class rule", () => {
  it("lifts a prototype constructor into an ES2022 class with statics", () => {
    const result = modernize(COUNTER);
    expect(result.applied.some((a) => a.rule === "prototype-class" && a.speculative)).toBe(true);
    expect(result.code).toContain("class Counter {");
    expect(result.code).toContain("constructor(start)");
    expect(result.code).toContain("static create(start)");
    expect(result.code).toContain("Counter.VERSION = 2;");
    expect(result.code).not.toContain("Counter.prototype");
    expect(result.code).toContain("// A counter");
  });

  it("is a named rule with a class/off ladder that rolls back to the legacy form", () => {
    expect(RULE_LADDERS["prototype-class"]).toEqual(["class", "off"]);
    const off = modernize(COUNTER, { levels: stepDown(defaultLevels(), "prototype-class") });
    expect(off.code).toContain("Counter.prototype.inc = function");
    expect(off.code).not.toContain("class Counter");
    expect(readHeaderLevels(`// ast-rules: ${"prototype-class=off"}`)?.["prototype-class"]).toBe(1);
  });

  it("keeps exact parity with the legacy specimen (differential, exact mode)", async () => {
    const legacy = scanLegacyAst(COUNTER).primaryExpression;
    const modern = classOnly(COUNTER);
    const report = await fuzzer.fuzz(legacy, modern, { start: "integer", step: "integer" }, { numRuns: 60, seed: 7 });
    expect(report.passed).toBe(true);
    expect(report.exact).toBe(true);
  });

  it("infers the schema of a script specimen from its free variables", () => {
    const scan = scanLegacyAst(COUNTER);
    expect(scan.suggestedSchema).toEqual({ start: "integer", step: "integer" });
    expect(scan.primaryExpression).toContain("function Counter");
  });

  it.each([
    ["called without new", "function C(){ this.a = 1; }\nC.prototype.f = function () { return 1; };\nvar x = C.call({});\nx;"],
    ["this instanceof guard", "function C(){ if (!(this instanceof C)) return new C(); this.a = 1; }\nC.prototype.f = function () { return 1; };\nnew C().f();"],
    ["inheritance via prototype", "function B(){}\nB.prototype.g = function () { return 1; };\nfunction C(){}\nC.prototype = Object.create(B.prototype);\nC.prototype.f = function () { return 2; };\nnew C().f();"],
    ["undeclared assignment (strict-mode hazard)", "function C(){ leaked = 1; }\nC.prototype.f = function () { return 1; };\nnew C().f();"],
    ["duplicate method", "function C(){}\nC.prototype.f = function () { return 1; };\nC.prototype.f = function () { return 2; };\nnew C().f();"],
    ["referenced before members", "function C(){}\nvar early = new C();\nC.prototype.f = function () { return 1; };\nearly;"],
    ["with statement", "function C(o){ with (o) { this.a = a; } }\nC.prototype.f = function () { return 1; };\nnew C({a: 1}).f();"],
    ["arguments.callee", "function C(){ this.a = arguments.callee.name; }\nC.prototype.f = function () { return 1; };\nnew C().f();"],
  ])("leaves the function alone: %s", (_label, code) => {
    const result = modernize(code);
    expect(result.applied.some((a) => a.rule === "prototype-class")).toBe(false);
    expect(result.code).not.toContain("class C");
    expect(result.flagged.some((f) => f.kind === "prototype-kept")).toBe(true);
  });

  it("converts a prototype object literal that restores constructor", () => {
    const code = "function P(x){ this.x = x; }\nP.prototype = { constructor: P, get1: function () { return this.x; }, twice() { return this.x * 2; } };\nnew P(n).twice() + new P(n).get1();";
    const result = modernize(code);
    expect(result.code).toContain("class P {");
    expect(result.code).toContain("twice()");
  });

  it("lifted classes behave identically for any integer input (property)", async () => {
    const code = "function Acc(a){ this.t = a; }\nAcc.prototype.add = function (b) { this.t += b; return this; };\nAcc.prototype.get = function () { return this.t; };\nnew Acc(a).add(b).add(b).get();";
    const modern = classOnly(code);
    expect(modern).toContain("class Acc");
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: -1000, max: 1000 }), async (a, b) => {
        const [l, m] = await Promise.all([
          pool.run({ code, context: { a, b } }),
          pool.run({ code: modern, context: { a, b } }),
        ]);
        expect(m.output).toBe(l.output);
      }),
      { numRuns: 15 }
    );
  });

  it("edge case: -0 and NaN flow through a lifted class exactly", async () => {
    const code = "function Box(v){ this.v = v; }\nBox.prototype.neg = function () { return -this.v; };\nnew Box(n).neg();";
    const report = await fuzzer.fuzz(code, classOnly(code), { n: "integer" }, { numRuns: 60, seed: 3 });
    expect(report.passed).toBe(true);
  });
});

describe("prototype-class rollback by the Necromancer/Exorcist loop", () => {
  // ES5 prototype methods are enumerable, class methods are not: a for-in driver tells them apart.
  const HOSTILE = `
function Bag(items) { this.items = items; }
Bag.prototype.size = function () { return this.items.length; };
var keys = [];
var bag = new Bag([1, 2, 3]);
for (var k in bag) { keys.push(k); }
keys.join(",") + ":" + bag.size() + ":" + n;
`;

  it("detects the divergence, blames prototype-class and rolls back only that rule", async () => {
    const result = await new ResurrectionOrchestrator().resurrect({
      name: "hostileBag",
      legacyCode: HOSTILE.trim(),
      schema: { n: "integer" },
      fuzzRuns: 30,
      seed: 11,
      maxHealingAttempts: 3,
      exact: true,
    });
    expect(result.success).toBe(true);
    expect(result.attempts).toBeGreaterThan(1);
    expect(result.modernCode).not.toContain("class Bag");
    expect(result.modernCode).toContain("Bag.prototype.size = function");
    const levels = readHeaderLevels(result.modernCode);
    expect(levels?.["prototype-class"]).toBe(1);
    // Other rules are untouched by the rollback.
    expect(levels?.["var-scoping"]).toBe(0);
    expect(result.events.some((e) => e.type === "counterexample_found")).toBe(true);
  });

  it("keeps the class when nothing observes the difference", async () => {
    const result = await new ResurrectionOrchestrator().resurrect({
      name: "plainCounter",
      legacyCode: COUNTER.trim(),
      schema: { start: "integer", step: "integer" },
      fuzzRuns: 30,
      seed: 5,
      exact: true,
    });
    expect(result.success).toBe(true);
    expect(result.modernCode).toContain("class Counter");
    expect(readHeaderLevels(result.modernCode)?.["prototype-class"]).toBe(0);
  });
});
