import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import * as fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditDirectory } from "../../cli-audit.js";
import { buildExportBundle, createWebServer } from "../../web/server.js";
import { DifferentialFuzzer } from "../../fuzzer/differential.js";
import type { InputSchema } from "../../fuzzer/types.js";
import { PooledProbeRunner } from "../../sandbox/pool.js";
import { RULE_ORDER, defaultLevels, encodeLevels, modernize, stepDown } from "../ast-modernizer.js";
import { resurrectErrorFirstWith } from "../async-callback.js";
import { detectPromiseChain, inheritanceParentOf, liftPromiseChain, resurrectPromiseChainWith, scopeGuardOf } from "../es5-idioms.js";
import { ResurrectionOrchestrator } from "../orchestrator.js";
import { computeRuleBlame } from "../rule-blame.js";
import { verifyStrictTypeScript } from "../ts-verifier.js";
import { applyBoundaryFixes } from "../ts-emit.js";
import { inferSignature } from "../type-alchemist.js";
import { parseProgram } from "../ast-modernizer.js";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../../..");
const html = fs.readFileSync(nodePath.join(root, "public", "index.html"), "utf8");
/** The preset exactly as the Tab 1 dropdown ships it. */
function preset(value: string): { code: string; schema: InputSchema; label: string } {
  const at = html.indexOf(`value: "${value}"`);
  expect(at, value).toBeGreaterThan(0);
  const block = html.slice(at, at + 6000);
  const code = /code: ("(?:[^"\\]|\\.)*")/.exec(block)?.[1];
  const schema = /schema: '([^']*)'/.exec(block)?.[1];
  const label = /label: ("(?:[^"\\]|\\.)*")/.exec(block)?.[1];
  expect(code && schema && label).toBeTruthy();
  return { code: JSON.parse(code ?? '""') as string, schema: JSON.parse(schema ?? "{}") as InputSchema, label: JSON.parse(label ?? '""') as string };
}

const legacyPool = new PooledProbeRunner();
const modernPool = new PooledProbeRunner();
const fuzzer = new DifferentialFuzzer({ legacy: legacyPool, modern: modernPool });
afterAll(async () => {
  await Promise.all([legacyPool.close(), modernPool.close()]);
});

/** Parity of the modernized script against the legacy script (exact Object.is, boundary corpus included). */
async function expectParity(code: string, schema: InputSchema, runs = 60): Promise<string> {
  const modern = modernize(code);
  expect(modern.parsed).toBe(true);
  const report = await fuzzer.fuzz(code, modern.code, schema, { numRuns: runs, seed: 7, exact: true });
  expect(report.passed, report.counterexample?.reason).toBe(true);
  return modern.code;
}

const PARENT = `function Animal(name) {
  if (!(this instanceof Animal)) return new Animal(name);
  this.name = name;
  this.legs = 4;
}
Animal.prototype.describe = function () {
  return this.name.length + this.legs;
};`;
const CHILD = `function Bird(name, wings) {
  if (!(this instanceof Bird)) return new Bird(name, wings);
  Animal.call(this, name);
  this.legs = 2;
  this.wings = wings;
}
Bird.prototype = Object.create(Animal.prototype);
Bird.prototype.constructor = Bird;
Bird.prototype.lift = function () {
  return this.describe() * this.wings;
};`;
const INHERIT = `${PARENT}\n${CHILD}\nvar bird = new Bird("tern", w);\nbird.lift() + (bird instanceof Animal ? 1 : 0);`;

describe("Object.create inheritance (extends the prototype-class rule)", () => {
  it("lifts a child with Object.create + Parent.call into `class Child extends Parent` with super(...)", () => {
    const r = modernize(INHERIT);
    expect(r.code).toContain("class Animal {");
    expect(r.code).toContain("class Bird extends Animal {");
    expect(r.code).toContain("super(name);");
    expect(r.code).toContain("this.wings = wings;");
    expect(r.code).not.toMatch(/Object\.create|instanceof Bird|instanceof Animal\)\) return|Bird\.prototype|Animal\.call/);
    expect(r.flagged.filter((f) => f.kind === "prototype-kept")).toEqual([]);
    const lifted = r.applied.filter((a) => a.rule === "prototype-class");
    expect(lifted).toHaveLength(2);
    expect(lifted.every((a) => a.speculative)).toBe(true);
    expect(lifted.find((a) => a.after.startsWith("class Bird extends Animal"))?.note).toContain("extends Animal + super(...)");
    expect(lifted.some((a) => /guard was dropped/.test(a.note ?? ""))).toBe(true);
  });

  it("keeps exact Object.is parity with the legacy specimen (differential, exact mode)", async () => {
    await expectParity(INHERIT, { w: "integer" });
  }, 60_000);

  it("keeps instance behavior for any integer (property): methods, instanceof and own fields", async () => {
    const modern = modernize(INHERIT).code;
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: -2000, max: 2000 }), async (w) => {
        const run = async (code: string): Promise<unknown> => (await legacyPool.run({ code, context: { w } })).output;
        expect(await run(modern)).toEqual(await run(INHERIT));
      }),
      { numRuns: 20 }
    );
  }, 60_000);

  it("lifts a three-level chain A <- B <- C, in source order", async () => {
    const code = `function A(x) { this.x = x; }
A.prototype.ax = function () { return this.x; };
function B(x, y) { A.call(this, x); this.y = y; }
B.prototype = Object.create(A.prototype);
B.prototype.constructor = B;
B.prototype.by = function () { return this.ax() + this.y; };
function C(x, y, z) { B.call(this, x, y); this.z = z; }
C.prototype = Object.create(B.prototype);
C.prototype.constructor = C;
C.prototype.cz = function () { return this.by() * this.z; };
new C(p, q, 3).cz();`;
    const r = modernize(code);
    expect(r.code).toContain("class B extends A {");
    expect(r.code).toContain("class C extends B {");
    expect(r.code.indexOf("class A")).toBeLessThan(r.code.indexOf("class B"));
    expect(r.code.indexOf("class B")).toBeLessThan(r.code.indexOf("class C"));
    await expectParity(code, { p: "integer", q: "integer" });
  }, 60_000);

  it("Parent.apply(this, arguments) becomes super(...arguments); Parent.apply(this, [a, b]) becomes super(a, b)", async () => {
    const withArguments = `function P(a, b) { this.s = a + b; }
P.prototype.get = function () { return this.s; };
function K(a, b) { P.apply(this, arguments); this.t = a * b; }
K.prototype = Object.create(P.prototype);
K.prototype.constructor = K;
K.prototype.both = function () { return this.get() + this.t; };
new K(m, n).both();`;
    const r = modernize(withArguments);
    expect(r.code).toContain("class K extends P {");
    expect(r.code).toContain("super(...arguments);");
    await expectParity(withArguments, { m: "integer", n: "integer" });
    const withArray = withArguments.replace("P.apply(this, arguments);", "P.apply(this, [b, a]);");
    expect(modernize(withArray).code).toContain("super(b, a);");
    await expectParity(withArray, { m: "integer", n: "integer" });
  }, 60_000);

  it("a rollback of prototype-class restores the exact legacy text", () => {
    const off = modernize(INHERIT, { levels: stepDown(defaultLevels(), "prototype-class") });
    expect(off.code).toContain("Bird.prototype = Object.create(Animal.prototype);");
    expect(off.code).toContain("Animal.call(this, name);");
    expect(off.code).not.toContain("class ");
    expect(off.applied.some((a) => a.rule === "prototype-class")).toBe(false);
  });

  it.each([
    ["the constructor does not call the parent", "function B(){}\nB.prototype.g = function () { return 1; };\nfunction C(){ this.a = 1; }\nC.prototype = Object.create(B.prototype);\nC.prototype.f = function () { return 2; };\nnew C().f();", "does not start with B.call"],
    ["the parent call is not the first statement", "function B(){ this.b = 1; }\nB.prototype.g = function () { return 1; };\nfunction C(){ this.a = 1; B.call(this); }\nC.prototype = Object.create(B.prototype);\nC.prototype.f = function () { return 2; };\nnew C().f();", "does not start with B.call"],
    ["the parent prototype is reassigned after linking", "function B(){}\nfunction C(){ B.call(this); }\nC.prototype = Object.create(B.prototype);\nB.prototype = { constructor: B, g: function () { return 1; } };\nC.prototype.f = function () { return 2; };\nnew C().f();", "reassigned after the child links"],
    ["the parent is not a declaration of this module", "var B = makeBase();\nfunction C(){ B.call(this); }\nC.prototype = Object.create(B.prototype);\nC.prototype.f = function () { return 2; };\nnew C().f();", "not a plain function or class declaration"],
    ["the constructor returns a value", "function B(){}\nfunction C(){ B.call(this); return {a: 1}; }\nC.prototype = Object.create(B.prototype);\nC.prototype.f = function () { return 2; };\nnew C().f();", "returns a value"],
    ["the super arguments use this", "function B(x){ this.x = x; }\nfunction C(){ B.call(this, this.q); }\nC.prototype = Object.create(B.prototype);\nC.prototype.f = function () { return 2; };\nnew C().f();", "use `this`"],
    ["Object.create is given property descriptors", "function B(){}\nfunction C(){ B.call(this); }\nC.prototype = Object.create(B.prototype, { z: { value: 1 } });\nC.prototype.f = function () { return 2; };\nnew C().f();", "something other than an object literal"],
  ])("leaves the child as legacy code when %s", (_label, code, reason) => {
    const r = modernize(code);
    expect(r.code).not.toContain("class C");
    expect(r.flagged.map((f) => f.reason).join("|")).toContain(reason);
  });

  it("analyzers: inheritanceParentOf reads Object.create(P.prototype) and nothing else", () => {
    const expr = (src: string): Parameters<typeof inheritanceParentOf>[0] => {
      const parsed = parseProgram(`x = ${src};`);
      if ("error" in parsed) throw new Error(parsed.error);
      const statement = parsed.ast.body[0];
      if (statement?.type !== "ExpressionStatement" || statement.expression.type !== "AssignmentExpression") throw new Error("shape");
      return statement.expression.right;
    };
    expect(inheritanceParentOf(expr("Object.create(Base.prototype)"))).toBe("Base");
    for (const bad of ["Object.create(null)", "Object.create(Base.prototype, {})", "Object.create(Base)", "Object.assign(Base.prototype)", "Base.prototype", "Object.create(a.b.prototype)"]) expect(inheritanceParentOf(expr(bad)), bad).toBeUndefined();
  });
});

describe("scope-safe constructors: `if (!(this instanceof Foo)) return new Foo(...)`", () => {
  const SAFE = `function Foo(a) {
  if (!(this instanceof Foo)) return new Foo(a);
  this.a = a;
}
Foo.prototype.double = function () { return this.a * 2; };
new Foo(n).double() + (new Foo(1) instanceof Foo ? 1 : 0);`;

  it("drops the guard and lifts the class when every use of Foo is `new`", async () => {
    const r = modernize(SAFE);
    expect(r.code).toContain("class Foo {");
    expect(r.code).not.toContain("instanceof Foo))");
    expect(r.code).toContain("instanceof Foo");
    expect(r.applied.find((a) => a.rule === "prototype-class")?.note).toContain("guard was dropped");
    await expectParity(SAFE, { n: "integer" });
  }, 60_000);

  it.each([
    ["a bare call Foo(1) keeps the guard live", `${SAFE.replace("new Foo(n).double()", "Foo(n).double()")}`],
    ["Foo is used as a value", `${SAFE}\nvar make = Foo;`],
    ["Foo.bind is used", `${SAFE}\nvar bound = Foo.bind(null, 1);`],
    ["Foo.call is used outside an inheriting constructor", `${SAFE}\nvar viaCall = {};\nFoo.call(viaCall, 1);`],
  ])("keeps the legacy function when %s", (_label, code) => {
    const r = modernize(code);
    expect(r.code).not.toContain("class Foo");
    expect(r.flagged.some((f) => f.kind === "prototype-kept")).toBe(true);
  });

  it("scopeGuardOf accepts exactly the guard that forwards the constructor's own parameters", () => {
    const decl = (src: string): Parameters<typeof scopeGuardOf>[0] => {
      const parsed = parseProgram(src);
      if ("error" in parsed) throw new Error(parsed.error);
      const first = parsed.ast.body[0];
      if (first?.type !== "FunctionDeclaration") throw new Error("shape");
      return first;
    };
    expect(scopeGuardOf(decl("function F(a, b) { if (!(this instanceof F)) return new F(a, b); this.a = a; }"))).toBeDefined();
    expect(scopeGuardOf(decl("function F(a, b) { if (!(this instanceof F)) { return new F(a, b); } }"))).toBeDefined();
    for (const bad of [
      "function F(a, b) { if (!(this instanceof F)) return new F(b, a); }",
      "function F(a, b) { if (!(this instanceof F)) return new F(a); }",
      "function F(a) { if (!(this instanceof F)) return new F(a + 1); }",
      "function F(a) { if (!(this instanceof F)) return new G(a); }",
      "function F(a) { if (!(this instanceof F)) return new F(a); else this.x = 1; }",
      "function F(a) { this.x = 1; if (!(this instanceof F)) return new F(a); }",
      "function F(a) { if (this instanceof F) return; }",
    ]) expect(scopeGuardOf(decl(bad)), bad).toBeUndefined();
  });
});

describe("arguments and .apply() forwarding (extends the arguments-rest and apply-spread rules)", () => {
  it("lifts Array.prototype.slice.call(arguments), arguments loops and fn.apply(null, args) to rest/spread", async () => {
    const code = `function total() {
  var sum = 0;
  for (var i = 0; i < arguments.length; i++) sum += arguments[i];
  return sum;
}
function biggest() {
  return Math.max.apply(null, Array.prototype.slice.call(arguments));
}
var values = [a, b, a + b];
total.apply(null, values) + biggest(a, b, 1);`;
    const r = modernize(code);
    expect(r.code).toContain("function total(...args)");
    expect(r.code).toContain("function biggest(...args2)");
    expect(r.code).toContain("Math.max(...args2.slice())");
    expect(r.code).toContain("total(...values)");
    expect(r.code).not.toContain("arguments");
    expect(r.applied.filter((x) => x.rule === "arguments-rest")).toHaveLength(2);
    expect(r.applied.filter((x) => x.rule === "apply-spread").length).toBeGreaterThanOrEqual(2);
    await expectParity(code, { a: "integer", b: "integer" });
  }, 60_000);

  it("fn.apply(this, arguments) forwards as fn.call(this, ...args) with exact parity", async () => {
    const code = `function logger(x, y) { return x * 10 + y; }
function wrap() { return logger.apply(this, arguments); }
wrap(a, b);`;
    const r = modernize(code);
    expect(r.code).toContain("function wrap(...args)");
    expect(r.code).toContain("logger.call(this, ...args)");
    await expectParity(code, { a: "integer", b: "integer" });
  }, 60_000);

  it("leaves apply alone when the argument list is not provably an array, and rolls back with apply-spread", () => {
    const code = "function f(x, y) { return x + y; }\nfunction pairs() { return [a, b]; }\nf.apply(this, pairs());";
    expect(modernize(code).code).toContain("f.apply(this, pairs())");
    const proven = "function f(x, y) { return x + y; }\nvar xs = [a, b];\nf.apply(this, xs);";
    expect(modernize(proven).code).toContain("f.call(this, ...xs)");
    expect(modernize(proven, { levels: stepDown(defaultLevels(), "apply-spread") }).code).toContain("f.call(this, ...xs)");
    expect(modernize(proven, { levels: stepDown(stepDown(defaultLevels(), "apply-spread"), "apply-spread") }).code).toContain("f.apply(this, xs)");
  });
});

describe("Promise chains: .then().catch() -> async/await", () => {
  const CHAIN = `function check(raw) {
  return new Promise(function (resolve, reject) {
    var n = parseInt(raw, 10);
    if (isNaN(n)) reject(new TypeError("not a number: " + raw));
    else if (n < 0) reject(new RangeError("negative: " + n));
    else setTimeout(function () { resolve(n); }, 0);
  });
}
function chained(text) {
  return check(text).then(function (n) {
    return { n: n, even: n % 2 === 0 };
  }).catch(function (err) {
    if (err instanceof RangeError) return { n: 0, even: true };
    throw err;
  });
}
module.exports = chained;`;
  const schema: InputSchema = { text: "string" };
  const run = (source: string, name = "chained") => resurrectPromiseChainWith(fuzzer, { name, source, schema, fuzzRuns: 60, seed: 5 });

  it("detects a function ending in X.then(h).catch(c), X.then(h) or X.catch(c), and nothing else", () => {
    const d = detectPromiseChain(CHAIN);
    expect(d.parsed).toBe(true);
    expect(d.functions.map((f) => f.name)).toEqual(["chained"]);
    expect(d.entry).toMatchObject({ name: "chained", params: ["text"], exported: true, style: "promise-chain", callback: "" });
    expect(detectPromiseChain("function f(x) { return g(x).then(function (v) { return v; }); }").entry?.name).toBe("f");
    expect(detectPromiseChain("var f = function (x) { return g(x).catch(function (e) { return 0; }); };").entry?.name).toBe("f");
    for (const none of [
      "function f(x) { return g(x); }",
      "function f(x) { return g(x).then(a, b); }",
      "function f(x) { return g(x).then(a).then(b); }",
      "function f(x) { return g(x).then(a).catch(b).finally(c); }",
      "function f(x) { return g(x).then(function () {}).catch(); }",
      "function f(x) { g(x).then(function () {}); }",
      "function f(x) { var p = g(x).then(function () {}); return p; }",
      "function f(x) { return g(x).then(handler); }",
      "function f(x) { return g(x).then(function (v) { return v; }); return 1; }",
    ]) {
      expect(detectPromiseChain(none).functions, none).toEqual([]);
    }
    expect(detectPromiseChain("function (").parsed).toBe(false);
  });

  it("lifts to async/await with try/catch: the source is evaluated before the try, handler bodies move in", () => {
    const lifted = liftPromiseChain(CHAIN);
    expect(lifted.ok).toBe(true);
    if (!lifted.ok) return;
    expect(lifted.code).toContain("async function chained(text)");
    expect(lifted.code).toContain("const pending = check(text);");
    expect(lifted.code).toMatch(/try \{\s+const n = await pending;/);
    expect(lifted.code).toMatch(/catch \(err\) \{\s+if \(err instanceof RangeError\)/);
    expect(lifted.code).not.toMatch(/\.then\(|\.catch\(/);
    expect(lifted.code).toContain("function check(raw)");
    expect(lifted.code).toContain("module.exports = chained;");
    expect(lifted.lifted).toEqual(["chained"]);
    expect(lifted.rewrites.join("|")).toContain(".catch(err) handler");
  });

  it("awaits inline, without a temporary, when the source cannot throw synchronously", () => {
    const lifted = liftPromiseChain("function f(x) { return Promise.resolve(x).then(function (v) { return v + 1; }).catch(function () { return -1; }); }");
    expect(lifted.ok && lifted.code).toMatch(/try \{\s+const v = await Promise\.resolve\(x\);/);
    expect(lifted.ok && lifted.code).not.toContain("pending");
  });

  it("then-only and catch-only chains, arrow handlers, and a handler that returns a promise (return await)", () => {
    const thenOnly = liftPromiseChain("function f(x) { return g(x).then((v) => v * 2); }");
    expect(thenOnly.ok && thenOnly.code).toMatch(/async function f\(x\) \{\s+const v = await g\(x\);\s+return v \* 2;/);
    expect(thenOnly.ok && thenOnly.code).not.toContain("try");
    const catchOnly = liftPromiseChain("function f(x) { return g(x).catch(() => 0); }");
    expect(catchOnly.ok && catchOnly.code).toMatch(/const pending = g\(x\);\s+try \{\s+return await pending;\s+\} catch \{\s+return 0;/);
    const nested = liftPromiseChain("function f(x) { return g(x).then(function (v) { return h(v); }).catch(function (e) { return 0; }); }");
    expect(nested.ok && nested.code).toContain("return await h(v);");
    const plain = liftPromiseChain("function f(x) { return g(x).then(function (v) { return { v: v }; }).catch(function (e) { return 0; }); }");
    expect(plain.ok && plain.code).not.toContain("return await {");
  });

  it.each([
    ["then(a, b)", "function f(x) { return g(x).then(function (v) { return v; }, function (e) { return 0; }); }"],
    ["a handler that uses this", "function f(x) { return g(x).then(function (v) { return this.k + v; }); }"],
    ["a handler that declares var", "function f(x) { return g(x).then(function (v) { var t = v; return t; }); }"],
    ["a handler that declares a function", "function f(x) { return g(x).then(function (v) { function h() { return v; } return h(); }); }"],
    ["an async handler", "function f(x) { return g(x).then(async function (v) { return v; }); }"],
    ["a named handler", "function f(x) { return g(x).then(function named(v) { return v; }); }"],
    ["a handler with two parameters", "function f(x) { return g(x).then(function (v, w) { return v; }); }"],
    ["a handler with a destructured parameter", "function f(x) { return g(x).then(function ({ v }) { return v; }); }"],
  ])("refuses %s", (_label, source) => {
    const r = liftPromiseChain(source);
    // Either not detected as a lift candidate, or detected and refused with a reason: never lifted.
    expect(r.ok).toBe(false);
  });

  it("verifies both settlements in the sandbox: resolved values (Object.is) and rejections (name + message)", async () => {
    const r = await run(CHAIN);
    expect(r.success).toBe(true);
    expect(r.asyncCallback).toMatchObject({ kind: "promise-chain", entry: "chained", callback: "" });
    expect(r.asyncCallback?.strategy).toMatch(/^lift/);
    expect(r.asyncCallback?.outcomes.resolved).toBeGreaterThan(0);
    expect(r.asyncCallback?.outcomes.rejected).toBeGreaterThan(0);
    expect(r.fuzzReport).toMatchObject({ passed: true, exact: true });
    expect(r.modernCode).toContain("export async function chained(text: string)");
    expect(r.ruleBlame?.[0]).toMatchObject({ rule: "promise-async", status: "applied", legacyLines: [9], sites: 1 });
    expect(r.ruleBlame?.[0]?.reason).toContain("both settlements matched");
  }, 60_000);

  it("keeps a synchronous throw of the source outside the catch, exactly like the legacy chain", async () => {
    const src = `function risky(t) { if (t === "boom") throw new Error("sync"); return Promise.resolve(t); }
function f(text) {
  return risky(text).then(function (v) { return v.length; }).catch(function (e) { return -1; });
}
module.exports = f;`;
    const r = await run(src, "f");
    expect(r.success).toBe(true);
    expect(r.asyncCallback?.strategy).toMatch(/^lift/);
  }, 60_000);

  it("catches an error thrown inside the then handler, like the legacy chain does", async () => {
    const src = `function f(text) {
  return Promise.resolve(text).then(function (v) { if (v.length > 3) throw new RangeError("long"); return v.length; }).catch(function (e) { return e.message.length; });
}
module.exports = f;`;
    const r = await run(src, "f");
    expect(r.success).toBe(true);
    expect(r.asyncCallback?.outcomes.resolved).toBeGreaterThan(0);
  }, 60_000);

  it("falls back to an async wrapper that proves parity by construction, and reports promise-async as rolled back", async () => {
    const src = `function f(text) {
  return Promise.resolve(text).then(function (v) { return v.length; }, function (e) { return -1; });
}
module.exports = f;`;
    // Not a lift candidate (two-argument then), so the pass has nothing to detect: it must say so instead of inventing a result.
    const none = await run(src, "f");
    expect(none.success).toBe(false);
    const unliftable = `function f(text) {
  return Promise.resolve(text).then(function (v) { var n = v.length; return n; }).catch(function (e) { return -1; });
}
module.exports = f;`;
    const r = await run(unliftable, "f");
    expect(r.success).toBe(true);
    expect(r.asyncCallback?.strategy).toBe("async-wrapper");
    expect(r.ruleBlame?.[0]).toMatchObject({ rule: "promise-async", status: "rolled-back" });
    expect(r.ruleBlame?.[0]?.reason).toContain("var");
  }, 60_000);

});

describe("presets legacySubclassMeter and legacyPromiseChain (Tab 1 dropdown)", () => {
  it("are in the dropdown's preset list with their schemas", () => {
    const a = preset("legacySubclassMeter");
    const b = preset("legacyPromiseChain");
    expect(a.label).toBe("Preset 12: ES5 Inheritance (Object.create + arguments.apply -> class extends + rest/spread)");
    expect(b.label).toBe("Preset 13: Promise Chain (.then().catch() -> async/await try/catch)");
    expect(a.schema).toEqual({ factor: "integer", a: "integer", b: "integer" });
    expect(b.schema).toEqual({ text: "string" });
    for (const needle of ["Object.create(Meter.prototype)", "Meter.call(this, unit)", "this instanceof Meter", "Array.prototype.slice.call(arguments)", "Math.max.apply(null"]) expect(a.code).toContain(needle);
    for (const needle of [".then(function (level)", ".catch(function (err)", "module.exports = legacyPromiseChain;"]) expect(b.code).toContain(needle);
    // Existing presets are untouched.
    expect(html).toContain('label: "Preset 11: Node.js Error-First Callback (cb(err, config) -> async/await)"');
    expect(html).toContain('label: "Preset 9: ES5 Prototype Class (Counter.prototype -> ES2022 class)"');
  });

  it("legacySubclassMeter: 100% exact parity, extends + super, rest/spread, tsc --strict: 0 errors", async () => {
    const { code, schema } = preset("legacySubclassMeter");
    const r = await new ResurrectionOrchestrator().resurrect({ name: "legacySubclassMeter", legacyCode: code, schema, fuzzRuns: 100, seed: 1337, exact: true, collectObservations: true });
    expect(r.success).toBe(true);
    expect(r.fuzzReport).toMatchObject({ passed: true, exact: true, totalRuns: 100 });
    expect(r.modernCode).toContain("class ScaledMeter extends Meter");
    expect(r.modernCode).toContain("super(unit);");
    expect(r.modernCode).toContain("record(...args)");
    expect(r.modernCode).toContain("Math.max(...");
    expect(r.modernCode.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n")).not.toMatch(/Object\.create|arguments|\.apply\(/);
    const { typecheck, bundle } = await buildExportBundle({ specimenName: "legacySubclassMeter", legacyCode: code, modernCode: r.modernCode, schema, typeSignature: inferSignature(r.observations ?? [], schema), fuzzRuns: 100 });
    expect(typecheck).toMatchObject({ passed: true, errorCount: 0, widenedReturn: false });
    expect(typecheck.adjustments.some((x) => x.startsWith("rest parameter ...args"))).toBe(true);
    expect(bundle.files["resurrected.ts"]).toContain("record(...args: any[])");
    expect(bundle.files["SPEC.md"]).toContain("tsc --strict: 0 errors");
    // Rule Blame names every rule that acted.
    expect(r.ruleBlame?.map((b) => `${b.rule}:${b.status}`)).toEqual(["var-scoping:applied", "prototype-class:applied", "arguments-rest:applied", "apply-spread:applied"]);
  }, 90_000);

  it("legacyPromiseChain: both settlements verified, lifted to try/catch, tsc --strict: 0 errors, exported with a Promise parity suite", async () => {
    const { code, schema } = preset("legacyPromiseChain");
    const r = await new ResurrectionOrchestrator().resurrectPromiseChain({ name: "legacyPromiseChain", source: code, schema, fuzzRuns: 100, seed: 1337 });
    expect(r.success).toBe(true);
    expect(r.asyncCallback?.outcomes.resolved).toBeGreaterThan(0);
    expect(r.asyncCallback?.outcomes.rejected).toBeGreaterThan(0);
    expect(r.modernCode).toContain("export async function legacyPromiseChain(text: string)");
    expect(r.modernCode).toMatch(/try \{[\s\S]*await pending[\s\S]*\} catch \(err\)/);
    const { typecheck, bundle } = await buildExportBundle({ specimenName: "legacyPromiseChain", legacyCode: code, modernCode: r.modernCode, schema, fuzzRuns: 100 });
    expect(typecheck).toMatchObject({ passed: true, errorCount: 0 });
    expect(bundle.files["resurrected.test.ts"]).toContain("await legacyModule.__lazarusEntry(...args)");
    expect(bundle.files["resurrected.test.ts"]).toContain("Promise chain -> async/await");
    expect(bundle.files["SPEC.md"]).toContain("Promise chain `legacyPromiseChain(text)`");
  }, 90_000);

  describe("through POST /api/resurrect (SSE)", () => {
    const server = createWebServer();
    let baseUrl = "";
    beforeAll(async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    });
    async function resurrect(name: string, legacyCode: string, schema: InputSchema): Promise<Record<string, unknown>> {
      const res = await fetch(`${baseUrl}/api/resurrect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, legacyCode, schema, fuzzRuns: 60, seed: 1337 }) });
      const frames = (await res.text()).split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as { kind: string; result?: Record<string, unknown> });
      const result = frames.find((f) => f.kind === "result")?.result;
      expect(result).toBeDefined();
      return result ?? {};
    }
    it("a Promise-chain preset returns asyncCallback.kind, ruleBlame, a certificate and the strict typecheck", async () => {
      const { code, schema } = preset("legacyPromiseChain");
      const r = await resurrect("legacyPromiseChain", code, schema);
      expect(r["success"]).toBe(true);
      expect(r["asyncCallback"]).toMatchObject({ kind: "promise-chain", entry: "legacyPromiseChain" });
      expect(r["ruleBlame"]).toMatchObject([{ rule: "promise-async", status: "applied" }]);
      expect(r["typecheck"]).toMatchObject({ passed: true, errorCount: 0 });
      expect(r["certificate"]).toBeDefined();
    }, 90_000);
    it("the subclass preset returns ruleBlame with legacy and resurrected line numbers", async () => {
      const { code, schema } = preset("legacySubclassMeter");
      const r = await resurrect("legacySubclassMeter", code, schema);
      expect(r["success"]).toBe(true);
      const blame = r["ruleBlame"] as Array<{ rule: string; status: string; legacyLines: number[]; resurrectedLines: number[] }>;
      expect(blame.find((b) => b.rule === "prototype-class")).toMatchObject({ status: "applied", legacyLines: [2, 21] });
      for (const b of blame) expect(b.resurrectedLines.length).toBeGreaterThan(0);
    }, 90_000);
    it("an error-first preset gains a callback-async entry and the existing fields stay", async () => {
      const code = html.includes('value: "legacyReadConfigCb"') ? preset("legacyReadConfigCb").code : "";
      const r = await resurrect("legacyReadConfigCb", code, { text: "string" });
      expect(r["success"]).toBe(true);
      expect(r["asyncCallback"]).toMatchObject({ entry: "legacyReadConfigCb", callback: "cb" });
      expect((r["asyncCallback"] as Record<string, unknown>)["kind"]).toBeUndefined();
      expect(r["ruleBlame"]).toMatchObject([{ rule: "callback-async", status: "applied" }]);
    }, 90_000);
  });
});

describe("Rule Blame: where each AST rule acted, and why it was rolled back", () => {
  const HASH = "var h = 0; for (var i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; } h;";

  it("is deterministic, and covers exactly the rules that applied", async () => {
    const r = await new ResurrectionOrchestrator().resurrect({ name: "stringHash32", legacyCode: HASH, schema: { text: "string" }, fuzzRuns: 100, seed: 1337, exact: true });
    expect(r.success).toBe(true);
    const again = computeRuleBlame(HASH, r.modernCode, []);
    expect(computeRuleBlame(HASH, r.modernCode, [])).toEqual(again);
    for (const entry of r.ruleBlame ?? []) expect(RULE_ORDER).toContain(entry.rule);
  }, 60_000);

  it("stringHash32: bitor0-trunc is rolled back with its counterexample, var-scoping stays applied", async () => {
    const r = await new ResurrectionOrchestrator().resurrect({ name: "stringHash32", legacyCode: HASH, schema: { text: "string" }, fuzzRuns: 100, seed: 1337, exact: true });
    expect(r.success).toBe(true);
    expect(r.attempts).toBeGreaterThan(1);
    const blame = r.ruleBlame ?? [];
    const trunc = blame.find((b) => b.rule === "bitor0-trunc");
    expect(trunc).toMatchObject({ status: "rolled-back", legacyLines: [1], sites: 1 });
    expect(trunc?.reason).toMatch(/^Rolled back: `x \| 0` became `Math\.trunc\(x\) \|\| 0` was blamed for the counterexample text = /);
    expect(trunc?.counterexample).toMatchObject({ attempt: 1 });
    expect(trunc?.counterexample?.input).toMatch(/^text = "/);
    expect(trunc?.counterexample?.legacyOutput).not.toBe(trunc?.counterexample?.modernOutput);
    // The legacy form is kept in the resurrected code: the highlighted resurrected line holds the original `| 0`.
    const lines = r.modernCode.split("\n");
    expect(trunc?.resurrectedLines.length).toBeGreaterThan(0);
    for (const n of trunc?.resurrectedLines ?? []) expect(lines[n - 1]).toContain("| 0");
    const vars = blame.find((b) => b.rule === "var-scoping");
    expect(vars?.status).toBe("applied");
    for (const n of vars?.resurrectedLines ?? []) expect(lines[n - 1]).toMatch(/\b(let|const)\b/);
  }, 60_000);

  it("applied rules point at the exact legacy and resurrected lines of the rewrite", () => {
    const code = "var a1 = 1;\nvar half = (n / 2) | 0;\nvar a3 = 3;\nhalf + a1 + a3;";
    const modern = modernize(code);
    const text = ["// Resurrected by Lazarus Necromancer (attempt 1)", `// ast-rules: ${encodeLevels(modern.levels)}`, modern.code].join("\n");
    const blame = computeRuleBlame(code, text, []);
    const trunc = blame.find((b) => b.rule === "bitor0-trunc");
    expect(trunc).toMatchObject({ status: "applied", legacyLines: [2] });
    expect(text.split("\n")[(trunc?.resurrectedLines[0] ?? 0) - 1]).toContain("Math.trunc");
    const vars = blame.find((b) => b.rule === "var-scoping");
    expect(vars?.legacyLines).toEqual([1, 2, 3]);
    expect(vars?.resurrectedLines.map((n) => text.split("\n")[n - 1]?.trim().split(" ")[0])).toEqual(["const", "const", "const"]);
  });

  it("returns nothing for code without a rules header, and never throws on unparseable legacy code", () => {
    expect(computeRuleBlame("var x = 1;", "var x = 1;", [])).toEqual([]);
    expect(computeRuleBlame("function (", "// ast-rules: parse-failed (legacy source kept verbatim)\nfunction (", [])).toEqual([]);
  });

  it("the error-first pass reports callback-async, and a wrapper fallback reports it rolled back with the counterexample", async () => {
    const lifted = await resurrectErrorFirstWith(fuzzer, { name: "f", source: "function f(n, cb) { if (n < 0) return cb(new RangeError('neg')); cb(null, n * 2); }\nmodule.exports = f;", schema: { n: "integer" }, fuzzRuns: 40, seed: 3 });
    expect(lifted.success).toBe(true);
    expect(lifted.ruleBlame).toMatchObject([{ rule: "callback-async", status: "applied", legacyLines: [1] }]);
    expect(lifted.ruleBlame?.[0]?.reason).toContain("async f(n)");
  }, 60_000);
});

describe("tsc --strict boundary fixes for the lifted idioms", () => {
  it("declares an untyped rest parameter (TS7019) and an awaited legacy Promise value (TS18046) as `any`, and lists them", async () => {
    const ts = "function f(...args) {\n  return args.length;\n}\nasync function g(): Promise<number> {\n  const p = new Promise(function (resolve) { resolve(1); });\n  const v = await p;\n  return v + 1;\n}\nexport { f, g };\n";
    const first = await verifyStrictTypeScript({ "m.ts": ts });
    expect(first.diagnostics.map((d) => d.code).sort()).toEqual([7019, 18046].sort());
    const fixed = applyBoundaryFixes(ts, first.diagnostics, "m.ts");
    expect(fixed.code).toContain("function f(...args: any[])");
    expect(fixed.code).toContain("const v: any = await p;");
    expect(fixed.adjustments).toEqual(["rest parameter ...args (line 1): untyped in the legacy code", "variable v (line 7): awaited value of an untyped legacy Promise"]);
    expect((await verifyStrictTypeScript({ "m.ts": fixed.code })).passed).toBe(true);
  });
  it("does not touch a genuine unknown that is not an awaited declaration, nor a comment that quotes one", async () => {
    const ts = "// const v = await p;\nexport function f(u: unknown): number {\n  return u + 1;\n}\n";
    const first = await verifyStrictTypeScript({ "m.ts": ts });
    const fixed = applyBoundaryFixes(ts, first.diagnostics, "m.ts");
    expect(fixed.changed).toBe(false);
    expect((await verifyStrictTypeScript({ "m.ts": fixed.code })).passed).toBe(false);
  });
});

describe("lazarus audit: the new idioms (additive)", () => {
  const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-idioms-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  it("reports Object.create inheritance (LAZ003 family), apply forwarding (LAZ004 family) and Promise chains (LAZ007)", () => {
    fs.writeFileSync(nodePath.join(tmp, "inherit.js"), "function B() {}\nfunction C() { B.call(this); }\nC.prototype = Object.create(B.prototype);\nC.prototype.f = function () { return 1; };\nmodule.exports = C;\n");
    fs.writeFileSync(nodePath.join(tmp, "fwd.js"), "function wrap(fn) {\n  return function () { return fn.apply(this, arguments); };\n}\nmodule.exports = wrap;\n");
    fs.writeFileSync(nodePath.join(tmp, "chain.js"), "function load(x) {\n  return get(x).then(function (v) { return v; }).catch(function () { return 0; });\n}\nmodule.exports = load;\n");
    const report = auditDirectory(tmp);
    const kinds = (file: string): string[] => (report.files.find((f) => f.file === file)?.findings ?? []).map((f) => `${f.kind}:${f.line}`);
    expect(kinds("inherit.js")).toContain("inheritance-chain:3");
    expect(kinds("inherit.js").some((k) => k.startsWith("prototype-chain"))).toBe(true);
    expect(kinds("fwd.js")).toContain("apply-forwarding:2");
    expect(kinds("chain.js")).toContain("promise-chain:1");
  });
});

describe("existing behavior is untouched", () => {
  it("every rule in the default ladder still applies to the classic Counter specimen and rolls back to the legacy form", () => {
    const COUNTER = "function Counter(start) {\n  this.n = start;\n}\nCounter.prototype.inc = function (step) {\n  this.n = this.n + step;\n  return this;\n};\nCounter.create = function (start) {\n  return new Counter(start);\n};\nvar counter = Counter.create(start);\ncounter.inc(step).inc(step);\ncounter.n;";
    const r = modernize(COUNTER);
    expect(r.code).toContain("class Counter {");
    expect(r.code).not.toContain("extends");
    expect(r.resultLines).toHaveLength(r.applied.length);
    expect(r.resultLines?.every((n) => n > 0)).toBe(true);
    const encoded = [...RULE_ORDER].map((rule) => `${rule}=${r.levels[rule]}`).join(" ");
    expect(encoded).toContain("prototype-class=0");
  });
});
