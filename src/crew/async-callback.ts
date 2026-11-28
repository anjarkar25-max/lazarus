// Async Callback Necromancer: Node.js error-first callbacks -> async/await.
//
// `function fn(a, cb)` that reports through `cb(err)` / `cb(null, value)` is lifted, deterministically and with
// acorn + astring only, to `async function fn(a)` that `throw`s and `return`s. The source is parsed, never executed
// here; both versions run only inside the pooled sandbox, where the Exorcist compares their first settlement (value
// with exact Object.is, error by name and message) over fast-check inputs.
import type * as ESTree from "estree";
import type { DifferentialFuzzer } from "../fuzzer/differential.js";
import type { CounterexampleReport, FuzzReport, InputSchema } from "../fuzzer/types.js";
import { decodeTagged } from "../sandbox/tagged.js";
import { modernize, parseProgram, printProgram } from "./ast-modernizer.js";
import { walk } from "./ast-scope.js";
import { inferSignature, renderType, type Observation, type TypeSignature } from "./type-alchemist.js";
import { asyncBlame, describeCounterexample, type RuleBlameEntry } from "./rule-blame.js";
import type { AgentRole, CrewEvent, CrewEventType, ResurrectionResult } from "./types.js";

type Node = ESTree.Node;
type Fn = ESTree.FunctionDeclaration | ESTree.FunctionExpression;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------
export interface ErrorFirstFunction {
  readonly name: string;
  /** Parameters without the callback. */
  readonly params: string[];
  readonly callback: string;
  /** How the harness reaches it after evaluating the source: "name", "module.exports" or "module.exports.x". */
  readonly ref: string;
  readonly exported: boolean;
  readonly line: number;
  /** Set by the Promise-chain pass (es5-idioms.ts); error-first functions leave it unset. */
  readonly style?: "promise-chain";
}

export interface ErrorFirstDetection {
  readonly parsed: boolean;
  readonly parseError?: string;
  readonly functions: ErrorFirstFunction[];
  /** The exported error-first function, or the last one declared. */
  readonly entry?: ErrorFirstFunction;
}

const isIdent = (n: Node | null | undefined, name?: string): n is ESTree.Identifier => n != null && n.type === "Identifier" && (name === undefined || n.name === name);
/** Same test without narrowing (a name mismatch must not exclude the Identifier type in the else branch). */
const isNamed = (n: Node | null | undefined, name: string): boolean => n != null && n.type === "Identifier" && n.name === name;
const lineOf = (n: Node): number => (n as { loc?: { start: { line: number } } | null }).loc?.start.line ?? 0;
const isMember = (n: Node, object: string, property: string): boolean =>
  n.type === "MemberExpression" && !n.computed && isIdent(n.object, object) && isIdent(n.property, property);
/** `module.exports`, `exports.x` or `module.exports.x`. */
function exportTarget(left: Node): { ref: string; key: string | null } | undefined {
  if (isMember(left, "module", "exports")) return { ref: "module.exports", key: null };
  if (left.type === "MemberExpression" && !left.computed && left.property.type === "Identifier") {
    if (isIdent(left.object, "exports")) return { ref: `module.exports.${left.property.name}`, key: left.property.name };
    if (isMember(left.object, "module", "exports")) return { ref: `module.exports.${left.property.name}`, key: left.property.name };
  }
  return undefined;
}

const ERROR_NAME = /^(e|er|err|error|ex|\w*Err|\w*Error)$/;
const isNullish = (n: Node | undefined): boolean =>
  n !== undefined && ((n.type === "Literal" && n.value === null && !("regex" in n)) || isIdent(n, "undefined") || (n.type === "UnaryExpression" && n.operator === "void"));

/** Calls of `cb` inside `fn` (nested functions included) and whether they look error-first. */
function callbackShape(fn: Fn, cb: string): { calls: number; errorFirst: boolean } {
  let calls = 0;
  let errorFirst = false;
  walk(fn.body, (n) => {
    if (n.type === "CallExpression" && isIdent(n.callee, cb)) {
      calls++;
      const a0 = n.arguments[0];
      if (n.arguments.length === 0) errorFirst = true;
      else if (a0 !== undefined && a0.type !== "SpreadElement") {
        if (isNullish(a0) && n.arguments.length >= 2) errorFirst = true;
        if (a0.type === "NewExpression" && a0.callee.type === "Identifier" && /Error$/.test(a0.callee.name)) errorFirst = true;
        if (a0.type === "Identifier" && ERROR_NAME.test(a0.name)) errorFirst = true;
      }
    }
    return undefined;
  });
  return { calls, errorFirst };
}

interface Candidate {
  readonly fn: Fn;
  readonly info: ErrorFirstFunction;
  /** The statement that holds the function (for normalization). */
  readonly statement: ESTree.Statement;
}

function candidatesOf(program: ESTree.Program, preferredName?: string): Candidate[] {
  const out: Candidate[] = [];
  const exportedNames = new Map<string, string>();
  for (const s of program.body) {
    if (s.type === "ExpressionStatement" && s.expression.type === "AssignmentExpression" && s.expression.operator === "=") {
      const target = exportTarget(s.expression.left);
      if (target !== undefined && isIdent(s.expression.right)) exportedNames.set(s.expression.right.name, target.ref);
    }
  }
  const consider = (fn: Fn, name: string, ref: string, exported: boolean, statement: ESTree.Statement): void => {
    const last = fn.params[fn.params.length - 1];
    if (fn.async || fn.generator || last === undefined || last.type !== "Identifier") return;
    if (!fn.params.every((p) => p.type === "Identifier")) return;
    const shape = callbackShape(fn, last.name);
    if (shape.calls === 0 || !shape.errorFirst) return;
    out.push({
      fn,
      statement,
      info: { name, params: fn.params.slice(0, -1).map((p) => (p as ESTree.Identifier).name), callback: last.name, ref, exported, line: lineOf(fn) },
    });
  };
  for (const s of program.body) {
    if (s.type === "FunctionDeclaration" && s.id) {
      const ref = exportedNames.get(s.id.name);
      consider(s, s.id.name, s.id.name, ref !== undefined, s);
    } else if (s.type === "VariableDeclaration") {
      for (const d of s.declarations) {
        if (isIdent(d.id) && d.init && d.init.type === "FunctionExpression") consider(d.init, d.id.name, d.id.name, exportedNames.has(d.id.name), s);
      }
    } else if (s.type === "ExpressionStatement" && s.expression.type === "AssignmentExpression" && s.expression.operator === "=" && s.expression.right.type === "FunctionExpression") {
      const target = exportTarget(s.expression.left);
      if (target === undefined) continue;
      const fn = s.expression.right;
      const name = target.key ?? fn.id?.name ?? safeName(preferredName) ?? "resurrected";
      consider(fn, name, target.ref, true, s);
    }
  }
  return out;
}

const safeName = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const cleaned = raw.replace(/[^A-Za-z0-9_$]/g, "_");
  return cleaned === "" ? undefined : /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
};

export function detectErrorFirst(source: string, options: { entryName?: string } = {}): ErrorFirstDetection {
  const parsed = parseProgram(source);
  if ("error" in parsed) return { parsed: false, parseError: parsed.error, functions: [] };
  const candidates = candidatesOf(parsed.ast, options.entryName);
  const functions = candidates.map((c) => c.info);
  const entry = functions.find((f) => f.ref === "module.exports") ?? [...functions].reverse().find((f) => f.exported) ?? functions.at(-1);
  return { parsed: true, functions, ...(entry !== undefined ? { entry } : {}) };
}

// ---------------------------------------------------------------------------
// Lift
// ---------------------------------------------------------------------------
export interface LiftOk {
  readonly ok: true;
  /** Script-mode JavaScript: the lifted async functions, everything else untouched (CommonJS exports kept). */
  readonly code: string;
  readonly entry: ErrorFirstFunction;
  /** Names of the functions that were made async. */
  readonly lifted: string[];
  /** One line per rewrite, for the spec. */
  readonly rewrites: string[];
}
export type LiftResult = LiftOk | { readonly ok: false; readonly reason: string };

class NotLiftable extends Error {}

const DEFERRALS = new Set(["setTimeout", "setImmediate", "queueMicrotask"]);

function mentions(node: Node, names: ReadonlySet<string>): boolean {
  let hit = false;
  walk(node, (n) => {
    if (n.type === "Identifier" && names.has(n.name)) hit = true;
    return undefined;
  });
  return hit;
}

const ret = (argument: ESTree.Expression | null): ESTree.ReturnStatement => ({ type: "ReturnStatement", argument });
const thr = (argument: ESTree.Expression): ESTree.ThrowStatement => ({ type: "ThrowStatement", argument });
const id = (name: string): ESTree.Identifier => ({ type: "Identifier", name });
const notNull = (e: ESTree.Expression): ESTree.BinaryExpression => ({ type: "BinaryExpression", operator: "!=", left: e, right: { type: "Literal", value: null, raw: "null" } });

interface LiftCtx {
  readonly cb: string;
  readonly lifted: ReadonlySet<string>;
  readonly rewrites: string[];
  temp: number;
}

/** The deferred function of a tail deferral (`setTimeout(fn, ms)`, `process.nextTick(fn)`, ...), if `e` is one. */
function deferredFunction(e: ESTree.Expression): ESTree.FunctionExpression | ESTree.ArrowFunctionExpression | undefined {
  if (e.type !== "CallExpression") return undefined;
  const fnArg = e.arguments[0];
  const isFn = (a: unknown): a is ESTree.FunctionExpression | ESTree.ArrowFunctionExpression =>
    a !== undefined && a !== null && typeof a === "object" && ((a as Node).type === "FunctionExpression" || (a as Node).type === "ArrowFunctionExpression");
  if (isIdent(e.callee) && DEFERRALS.has(e.callee.name) && isFn(fnArg) && (e.callee.name !== "queueMicrotask" || e.arguments.length === 1)) {
    return e.callee.name === "setTimeout" && e.arguments.length > 2 ? undefined : fnArg;
  }
  if (isMember(e.callee, "process", "nextTick") && isFn(fnArg) && e.arguments.length === 1) return fnArg;
  // Promise.resolve().then(fn)
  const c = e.callee;
  if (
    c.type === "MemberExpression" &&
    !c.computed &&
    isIdent(c.property, "then") &&
    c.object.type === "CallExpression" &&
    isMember(c.object.callee, "Promise", "resolve") &&
    c.object.arguments.length === 0 &&
    e.arguments.length === 1 &&
    isFn(fnArg)
  ) {
    return fnArg;
  }
  return undefined;
}

function bodyStatements(fn: ESTree.FunctionExpression | ESTree.ArrowFunctionExpression): ESTree.Statement[] {
  return fn.body.type === "BlockStatement" ? fn.body.body : [{ type: "ExpressionStatement", expression: fn.body }];
}

/** `cb(...)` -> return / throw statements. */
function liftCallbackCall(call: ESTree.CallExpression, ctx: LiftCtx): ESTree.Statement[] {
  if (call.arguments.some((a) => a.type === "SpreadElement")) throw new NotLiftable("the callback is called with a spread argument");
  const [a0, a1] = call.arguments as ESTree.Expression[];
  if (a0 === undefined) {
    ctx.rewrites.push(`${ctx.cb}() -> return`);
    return [ret(null)];
  }
  if (isNullish(a0)) {
    ctx.rewrites.push(`${ctx.cb}(null, value) -> return value`);
    return [ret(a1 ?? null)];
  }
  if (a0.type === "NewExpression" || (a0.type === "Literal" && a0.value !== null) || a0.type === "ObjectExpression" || a0.type === "TemplateLiteral") {
    ctx.rewrites.push(`${ctx.cb}(new Error(...)) -> throw new Error(...)`);
    return [thr(a0)];
  }
  ctx.rewrites.push(`${ctx.cb}(err, value) -> if (err != null) throw err; return value`);
  const simple = (e: ESTree.Expression | undefined): boolean => e === undefined || e.type === "Identifier" || e.type === "Literal";
  if (a0.type === "Identifier" && simple(a1)) {
    return [{ type: "IfStatement", test: notNull(a0), consequent: thr(a0), alternate: null }, ret(a1 ?? null)];
  }
  // Evaluate both arguments first, in order, exactly as the legacy call did.
  const e = `__lzErr${ctx.temp}`;
  const v = `__lzVal${ctx.temp++}`;
  return [
    {
      type: "VariableDeclaration",
      kind: "const",
      declarations: [
        { type: "VariableDeclarator", id: id(e), init: a0 },
        { type: "VariableDeclarator", id: id(v), init: a1 ?? id("undefined") },
      ],
    },
    { type: "IfStatement", test: notNull(id(e)), consequent: thr(id(e)), alternate: null },
    ret(id(v)),
  ];
}

/** `if (err) return cb(err);` / `if (err) { cb(err); }` / `if (err) { return cb(err); }` */
function isErrorGuard(s: ESTree.Statement | undefined, err: string, cb: string): boolean {
  if (s === undefined || s.type !== "IfStatement" || s.alternate !== null || !isIdent(s.test, err)) return false;
  const inner = s.consequent.type === "BlockStatement" && s.consequent.body.length === 1 ? s.consequent.body[0] : s.consequent;
  const call = inner?.type === "ReturnStatement" ? inner.argument : inner?.type === "ExpressionStatement" ? inner.expression : null;
  return call != null && call.type === "CallExpression" && isIdent(call.callee, cb) && call.arguments.length === 1 && isIdent(call.arguments[0], err);
}

function liftStatements(stmts: readonly ESTree.Statement[], ctx: LiftCtx, tail: boolean): ESTree.Statement[] {
  const out: ESTree.Statement[] = [];
  stmts.forEach((s, i) => out.push(...liftStatement(s, ctx, tail && i === stmts.length - 1)));
  return out;
}

function liftBody(s: ESTree.Statement, ctx: LiftCtx, tail: boolean): ESTree.Statement {
  const lifted = liftStatements(s.type === "BlockStatement" ? s.body : [s], ctx, tail);
  return lifted.length === 1 && s.type !== "BlockStatement" ? (lifted[0] as ESTree.Statement) : { type: "BlockStatement", body: lifted };
}

function liftStatement(s: ESTree.Statement, ctx: LiftCtx, tail: boolean): ESTree.Statement[] {
  const cbSet = new Set([ctx.cb]);
  if (!mentions(s, cbSet)) return [s];
  const call = s.type === "ReturnStatement" ? s.argument : s.type === "ExpressionStatement" ? s.expression : null;
  if (call != null && call.type === "CallExpression") {
    // cb(...)
    if (isNamed(call.callee, ctx.cb)) {
      if (call.arguments.some((a) => mentions(a, cbSet))) throw new NotLiftable("the callback is passed to itself");
      return liftCallbackCall(call, ctx);
    }
    // helper(args, cb) / helper(args, function (err, res) { if (err) return cb(err); ... })
    if (isIdent(call.callee) && ctx.lifted.has(call.callee.name)) {
      const args = call.arguments.slice(0, -1) as ESTree.Expression[];
      const last = call.arguments[call.arguments.length - 1];
      if (args.some((a) => a.type === ("SpreadElement" as string) || mentions(a, cbSet))) throw new NotLiftable(`${call.callee.name}() gets the callback in an unsupported position`);
      const awaited: ESTree.AwaitExpression = { type: "AwaitExpression", argument: { type: "CallExpression", callee: call.callee, arguments: args, optional: false } };
      if (isIdent(last, ctx.cb)) {
        ctx.rewrites.push(`${call.callee.name}(..., ${ctx.cb}) -> return await ${call.callee.name}(...)`);
        return [ret(awaited)];
      }
      if (last !== undefined && (last.type === "FunctionExpression" || last.type === "ArrowFunctionExpression") && last.params.every((p) => p.type === "Identifier") && last.params.length >= 1) {
        if (s.type === "ExpressionStatement" && !tail) throw new NotLiftable(`the nested ${call.callee.name}() callback is not in tail position`);
        const [errP, resP] = last.params as ESTree.Identifier[];
        const body = bodyStatements(last);
        if (errP === undefined || !isErrorGuard(body[0], errP.name, ctx.cb)) throw new NotLiftable(`the nested ${call.callee.name}() callback does not start with \`if (${errP?.name ?? "err"}) return ${ctx.cb}(${errP?.name ?? "err"});\``);
        const rest = body.slice(1);
        if (rest.some((r) => mentions(r, new Set([errP.name])))) throw new NotLiftable(`\`${errP.name}\` is used outside its guard`);
        ctx.rewrites.push(`${call.callee.name}(..., function (${errP.name}${resP ? `, ${resP.name}` : ""}) { if (${errP.name}) return ${ctx.cb}(${errP.name}); ... }) -> ${resP ? `const ${resP.name} = ` : ""}await ${call.callee.name}(...)`);
        const head: ESTree.Statement =
          resP !== undefined
            ? { type: "VariableDeclaration", kind: "const", declarations: [{ type: "VariableDeclarator", id: id(resP.name), init: awaited }] }
            : { type: "ExpressionStatement", expression: awaited };
        return [head, ...liftStatements(rest, ctx, true)];
      }
      throw new NotLiftable(`${call.callee.name}() is called with an unsupported callback`);
    }
    // setTimeout(function () { cb(...) }, ms) and other tail deferrals
    const deferred = deferredFunction(call);
    if (deferred !== undefined && deferred.params.length === 0) {
      if (!tail && s.type === "ExpressionStatement") throw new NotLiftable("a deferred callback is not in tail position");
      if (call.arguments.slice(1).some((a) => mentions(a, cbSet))) throw new NotLiftable("the callback is used as a deferral argument");
      ctx.rewrites.push("deferred callback (setTimeout / setImmediate / nextTick / microtask) -> unwrapped (timing only)");
      return liftStatements(bodyStatements(deferred), ctx, true);
    }
  }
  switch (s.type) {
    case "IfStatement":
      if (mentions(s.test, cbSet)) break;
      return [{ ...s, consequent: liftBody(s.consequent, ctx, tail), alternate: s.alternate === null || s.alternate === undefined ? null : liftBody(s.alternate, ctx, tail) }];
    case "BlockStatement":
      return [{ ...s, body: liftStatements(s.body, ctx, tail) }];
    case "ForStatement":
    case "WhileStatement":
    case "DoWhileStatement":
    case "ForInStatement":
    case "ForOfStatement": {
      const header = s.type === "ForStatement" ? [s.init, s.test, s.update] : s.type === "WhileStatement" || s.type === "DoWhileStatement" ? [s.test] : [s.left, s.right];
      if (header.some((h) => h != null && mentions(h as Node, cbSet))) break;
      return [{ ...s, body: liftBody(s.body, ctx, false) } as ESTree.Statement];
    }
    case "LabeledStatement":
      return [{ ...s, body: liftBody(s.body, ctx, tail) }];
    case "SwitchStatement":
      if (mentions(s.discriminant, cbSet)) break;
      return [{ ...s, cases: s.cases.map((c) => ({ ...c, consequent: liftStatements(c.consequent, ctx, false) })) }];
    case "TryStatement":
      throw new NotLiftable("the callback is called inside try/catch (a lifted throw would be caught)");
    default:
      break;
  }
  throw new NotLiftable(`the callback \`${ctx.cb}\` is used in an unsupported position (line ${lineOf(s)})`);
}

function liftFunction(fn: Fn, info: ErrorFirstFunction, lifted: ReadonlySet<string>, rewrites: string[]): void {
  const ctx: LiftCtx = { cb: info.callback, lifted, rewrites, temp: 0 };
  // A nested binding of the same name would make every reference ambiguous.
  walk(fn.body, (n) => {
    if ((n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") && n.params.some((p) => isIdent(p, info.callback))) {
      throw new NotLiftable(`a nested function redeclares \`${info.callback}\``);
    }
    if (n.type === "VariableDeclarator" && isIdent(n.id, info.callback)) throw new NotLiftable(`\`${info.callback}\` is redeclared`);
    return undefined;
  });
  const body = liftStatements(fn.body.body, ctx, true);
  const block: ESTree.BlockStatement = { type: "BlockStatement", body };
  if (mentions(block, new Set([info.callback]))) throw new NotLiftable(`\`${info.callback}\` is still referenced after the lift`);
  fn.body = block;
  fn.params = fn.params.slice(0, -1);
  fn.async = true;
}

/** Lifts every error-first function it can (helpers first; a helper that cannot be lifted blocks its callers). */
export function liftErrorFirst(source: string, options: { entryName?: string } = {}): LiftResult {
  const first = parseProgram(source);
  if ("error" in first) return { ok: false, reason: `the source does not parse: ${first.error}` };
  let names = new Set(candidatesOf(first.ast, options.entryName).map((c) => c.info.name));
  if (names.size === 0) return { ok: false, reason: "no error-first callback function (cb(err) / cb(null, value)) was found" };
  const reasons = new Map<string, string>();
  for (let round = 0; round < 10; round++) {
    const parsed = parseProgram(source);
    if ("error" in parsed) return { ok: false, reason: parsed.error };
    const program = parsed.ast;
    const candidates = candidatesOf(program, options.entryName).filter((c) => names.has(c.info.name));
    const rewrites: string[] = [];
    let failed: string | undefined;
    for (const c of candidates) {
      try {
        liftFunction(c.fn, c.info, names, rewrites);
      } catch (err: unknown) {
        if (!(err instanceof NotLiftable)) throw err;
        reasons.set(c.info.name, err.message);
        failed = c.info.name;
        break;
      }
    }
    if (failed !== undefined) {
      names = new Set([...names].filter((n) => n !== failed));
      if (names.size === 0) break;
      continue;
    }
    // Every remaining call of a lifted function must be awaited (the patterns above produce exactly that).
    let unawaited: string | undefined;
    walk(program, (n, parent) => {
      if (n.type === "CallExpression" && isIdent(n.callee) && names.has(n.callee.name) && parent?.type !== "AwaitExpression") unawaited = n.callee.name;
      return undefined;
    });
    if (unawaited !== undefined) {
      reasons.set(unawaited, `${unawaited}() is still called with a callback from code that is not lifted`);
      names = new Set([...names].filter((n) => n !== unawaited));
      if (names.size === 0) break;
      continue;
    }
    // Normalize `module.exports = function (...) {}` to a declaration plus `module.exports = name;`.
    const entryCandidate = pickEntry(candidates.map((c) => c.info));
    if (entryCandidate === undefined) break;
    program.body = program.body.flatMap((s) => {
      if (s.type === "ExpressionStatement" && s.expression.type === "AssignmentExpression" && s.expression.right.type === "FunctionExpression") {
        const c = candidates.find((x) => x.statement === s);
        if (c !== undefined) {
          const fn = s.expression.right;
          const decl: ESTree.FunctionDeclaration = { type: "FunctionDeclaration", id: id(c.info.name), params: fn.params, body: fn.body, async: true, generator: false };
          return [decl, { type: "ExpressionStatement", expression: { ...s.expression, right: id(c.info.name) } }];
        }
      }
      return [s];
    });
    return { ok: true, code: printProgram(program, []).trim(), entry: entryCandidate, lifted: candidates.map((c) => c.info.name), rewrites: [...new Set(rewrites)] };
  }
  const entry = detectErrorFirst(source, options).entry;
  return { ok: false, reason: (entry !== undefined ? reasons.get(entry.name) : undefined) ?? [...reasons.values()][0] ?? "the error-first function could not be lifted" };
}

function pickEntry(functions: readonly ErrorFirstFunction[]): ErrorFirstFunction | undefined {
  return functions.find((f) => f.ref === "module.exports") ?? [...functions].reverse().find((f) => f.exported) ?? functions.at(-1);
}

/** Fallback candidate: the untouched legacy function behind a `new Promise` wrapper (parity by construction). */
export function promiseWrapper(source: string, entry: ErrorFirstFunction): string {
  const params = entry.params.join(", ");
  return [
    `// Promise wrapper: the legacy body is kept as is; only the calling convention changes.`,
    `const legacy_${entry.name} = (function () {`,
    `  var module = { exports: {} };`,
    `  var exports = module.exports;`,
    source.trim(),
    `  ;`,
    `  return ${entry.ref};`,
    `})();`,
    `async function ${entry.name}(${params}) {`,
    `  return new Promise(function (resolve, reject) {`,
    `    legacy_${entry.name}(${params}${params ? ", " : ""}function (err, value) {`,
    `      if (err !== null && err !== undefined) reject(err);`,
    `      else resolve(value);`,
    `    });`,
    `  });`,
    `}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Sandbox harnesses (both settle to the same envelope; the fuzzer compares envelopes exactly)
// ---------------------------------------------------------------------------
export type SettledEnvelope = { readonly settled: "resolve"; readonly value: unknown } | { readonly settled: "reject"; readonly error: { readonly name: string; readonly message: string } };

const DESCRIBE = `function __lzDescribe(e) {
    var name = typeof e, message = "";
    try { if (e !== null && typeof e === "object" && typeof e.name === "string") name = e.name; } catch (x) {}
    try { message = e !== null && typeof e === "object" && typeof e.message === "string" ? e.message : String(e); } catch (x) { message = "[unprintable]"; }
    return { name: name, message: message };
  }`;

/** Calls the legacy `fn(...params, cb)` and settles with its first callback (or synchronous throw). */
export function buildLegacyHarness(source: string, entry: ErrorFirstFunction): string {
  const args = [...entry.params, "__lzCb"].join(", ");
  return [
    "(function () {",
    "  var module = { exports: {} };",
    "  var exports = module.exports;",
    source.trim(),
    "  ;",
    `  ${DESCRIBE}`,
    `  var __lzFn = ${entry.ref};`,
    "  return new Promise(function (__lzResolve) {",
    "    var __lzDone = false;",
    "    function __lzCb(err, value) {",
    "      if (__lzDone) return;",
    "      __lzDone = true;",
    "      if (err !== null && err !== undefined) __lzResolve({ settled: \"reject\", error: __lzDescribe(err) });",
    "      else __lzResolve({ settled: \"resolve\", value: value });",
    "    }",
    `    try { __lzFn(${args}); } catch (e) { if (!__lzDone) { __lzDone = true; __lzResolve({ settled: "reject", error: __lzDescribe(e) }); } }`,
    "  });",
    "})()",
  ].join("\n");
}

/** Awaits the modern `fn(...params)` into the same envelope. */
export function buildModernHarness(modernJs: string, entryName: string, params: readonly string[]): string {
  return [
    "(function () {",
    "  var module = { exports: {} };",
    "  var exports = module.exports;",
    modernJs.trim(),
    "  ;",
    `  ${DESCRIBE}`,
    "  var __lzP;",
    `  try { __lzP = ${entryName}(${params.join(", ")}); } catch (e) { return Promise.resolve({ settled: "reject", error: __lzDescribe(e) }); }`,
    "  return Promise.resolve(__lzP).then(function (v) { return { settled: \"resolve\", value: v }; }, function (e) { return { settled: \"reject\", error: __lzDescribe(e) }; });",
    "})()",
  ].join("\n");
}

/** The envelope of a probe output (tagged wire form), or undefined when it is not one. */
export function readEnvelope(output: unknown): SettledEnvelope | undefined {
  const v = decodeTagged(output);
  if (v === null || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  if (r["settled"] === "resolve") return { settled: "resolve", value: r["value"] };
  if (r["settled"] === "reject" && r["error"] !== null && typeof r["error"] === "object") {
    const e = r["error"] as Record<string, unknown>;
    return { settled: "reject", error: { name: String(e["name"]), message: String(e["message"]) } };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Typed TypeScript module
// ---------------------------------------------------------------------------
/** TypeScript for the lifted module: CommonJS export lines dropped, the entry exported with typed parameters. */
export function renderAsyncTypeScript(modernJs: string, entry: ErrorFirstFunction, signature: TypeSignature | undefined, header: readonly string[] = []): string {
  const parsed = parseProgram(modernJs);
  let body = modernJs;
  if (!("error" in parsed)) {
    parsed.ast.body = parsed.ast.body.filter((s) => !(s.type === "ExpressionStatement" && s.expression.type === "AssignmentExpression" && exportTarget(s.expression.left) !== undefined));
    body = printProgram(parsed.ast, []).trim();
  }
  const typeOf = (name: string): string => {
    const p = signature?.params.find((x) => x.name === name);
    return p !== undefined ? renderType(p.type) : "unknown";
  };
  const params = entry.params.map((p) => `${p}: ${typeOf(p)}`).join(", ");
  const returns = signature !== undefined ? renderType(signature.returns) : "unknown";
  const head = new RegExp(`^async function ${entry.name}\\(([^)]*)\\) \\{`, "m");
  const typed = body.replace(head, () => `export async function ${entry.name}(${params}): Promise<${returns}> {`);
  return [...header.map((h) => `// ${h}`), typed, ""].join("\n");
}

/**
 * The runnable JavaScript of a resurrected async TypeScript module (only the entry signature carries types). Returns
 * undefined when the text is not such a module.
 */
export function stripAsyncTypes(ts: string, entry: ErrorFirstFunction): string | undefined {
  const head = new RegExp(`^export async function ${entry.name}\\([^\\n]*\\{$`, "m");
  if (!head.test(ts)) return undefined;
  const js = ts.replace(head, () => `async function ${entry.name}(${entry.params.join(", ")}) {`);
  return "error" in parseProgram(js) ? undefined : js;
}
// ---------------------------------------------------------------------------
// Literal dictionary (deterministic extra inputs)
// ---------------------------------------------------------------------------
export const MAX_LITERAL_EXAMPLES = 24;
/**
 * Inputs built from the specimen's own string and number literals (a fuzzing dictionary), so the success path of
 * code that validates its input (`"port=" + 443`) is reached deterministically, not only by chance.
 */
export function literalExamples(source: string, schema: InputSchema): Array<Record<string, unknown>> {
  const parsed = parseProgram(source);
  if ("error" in parsed) return [];
  const strings = new Set<string>();
  const numbers = new Set<number>();
  walk(parsed.ast, (n) => {
    if (n.type === "Literal" && !("regex" in n && n.regex)) {
      if (typeof n.value === "string" && n.value.length <= 40) strings.add(n.value);
      if (typeof n.value === "number" && Number.isFinite(n.value)) numbers.add(n.value);
    }
    return undefined;
  });
  const nums = [...numbers].sort((a, b) => a - b);
  // Short literals first: they are the prefixes and keywords input validation looks for ("port=", "on", "#").
  const strs = [...strings].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const valuesFor = (kind: string): unknown[] => {
    switch (kind) {
      case "string": {
        // Numbers, then each literal, then literal + number (so "port=" + 443 is tried), round-robin per literal.
        const out = new Set<string>();
        for (const n of nums) out.add(String(n));
        for (const s of strs) out.add(s);
        for (const n of [...nums].sort((a, b) => Math.abs(b) - Math.abs(a))) for (const s of strs) out.add(s + String(n));
        return [...out];
      }
      case "integer":
        return [...new Set(nums.filter(Number.isInteger).flatMap((n) => [n - 1, n, n + 1]))];
      case "number":
        return [...new Set(nums.flatMap((n) => [n - 1, n, n + 0.5, n + 1]))];
      case "boolean":
        return [true, false];
      default:
        return [...strs, ...nums];
    }
  };
  const keys = Object.keys(schema);
  if (keys.length === 0) return [];
  const lists = keys.map((k) => valuesFor(schema[k] ?? "string"));
  const longest = Math.max(0, ...lists.map((l) => l.length));
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < Math.min(longest, MAX_LITERAL_EXAMPLES); i++) {
    const rec: Record<string, unknown> = {};
    keys.forEach((k, j) => {
      const list = lists[j] ?? [];
      if (list.length > 0) rec[k] = list[i % list.length];
    });
    if (Object.keys(rec).length === keys.length) out.push(rec);
  }
  return out;
}
// ---------------------------------------------------------------------------
// Resurrection (Archaeologist -> Architect -> Necromancer <-> Exorcist)
// ---------------------------------------------------------------------------
export interface ErrorFirstRequest {
  readonly name: string;
  /** The legacy module exactly as written. */
  readonly source: string;
  readonly schema: InputSchema;
  readonly fuzzRuns?: number;
  readonly seed?: number;
  readonly onEvent?: (event: CrewEvent) => void;
}

export interface AsyncCallbackSummary {
  /** Set by the Promise-chain pass; the error-first pass leaves it unset. */
  readonly kind?: "promise-chain";
  readonly entry: string;
  readonly callback: string;
  readonly params: string[];
  readonly lifted: string[];
  /** "lift+modernize" | "lift" | "promise-wrapper" */
  readonly strategy: string;
  readonly rewrites: string[];
  /** Legacy outcomes over the passing fuzz run. */
  readonly outcomes: { readonly resolved: number; readonly rejected: number };
  readonly legacyHarness: string;
  readonly modernHarness: string;
  /** The verified async module as plain JavaScript (what the sandbox ran). */
  readonly modernJs: string;
}

export type ErrorFirstResult = ResurrectionResult & { readonly asyncCallback?: AsyncCallbackSummary; readonly typeSignature?: TypeSignature; readonly ruleBlame?: RuleBlameEntry[] };

export async function resurrectErrorFirstWith(fuzzer: DifferentialFuzzer, request: ErrorFirstRequest): Promise<ErrorFirstResult> {
  const events: CrewEvent[] = [];
  const emit = (agent: AgentRole, type: CrewEventType, message: string, payload?: Record<string, unknown>): void => {
    const event: CrewEvent = { timestamp: new Date().toISOString(), agent, type, message, ...(payload !== undefined ? { payload } : {}) };
    events.push(event);
    request.onEvent?.(event);
  };
  const fail = (message: string, report?: FuzzReport, modernCode = ""): ErrorFirstResult => {
    emit("exorcist", "completed", message);
    return { success: false, name: request.name, legacyCode: request.source, specMarkdown: "", modernCode, attempts: 0, fuzzReport: report ?? { passed: false, totalRuns: 0, durationMs: 0, seed: request.seed ?? 0, traces: [] }, events };
  };

  emit("archaeologist", "agent_started", `Scanning "${request.name}" for Node.js error-first callbacks (AST only, nothing executed)`);
  const detection = detectErrorFirst(request.source, { entryName: request.name });
  const entry = detection.entry;
  if (entry === undefined) return fail(detection.parsed ? "No error-first callback function was found" : `The source does not parse: ${detection.parseError ?? "syntax error"}`);
  emit("archaeologist", "probe_sampled", `Found error-first ${entry.name}(${[...entry.params, entry.callback].join(", ")}) with callback \`${entry.callback}\`${detection.functions.length > 1 ? `, plus ${detection.functions.length - 1} error-first helper(s)` : ""}`, {
    functions: detection.functions.map((f) => f.name),
  });
  const schema: InputSchema = Object.fromEntries(entry.params.map((p) => [p, request.schema[p] ?? "string"]));
  const legacyHarness = buildLegacyHarness(request.source, entry);

  emit("architect", "agent_started", "Writing the async contract");
  const specMarkdown = [
    `# Specification: ${request.name} (error-first callback -> async/await)`,
    "",
    "## Input Contract",
    ...(Object.entries(schema).map(([k, v]) => `- \`${k}\`: \`${v}\``)),
    "",
    "## Calling Convention",
    `- Legacy: \`${entry.name}(${[...entry.params, entry.callback].join(", ")})\`, settling through \`${entry.callback}(err)\` or \`${entry.callback}(null, value)\`.`,
    `- Resurrected: \`await ${entry.name}(${entry.params.join(", ")})\` resolves with \`value\` or rejects with the same error.`,
    "",
    "## Acceptance Criteria",
    "- The first settlement MUST match on every fuzzed input: resolved values with exact `Object.is` (deep, tagged -0 / NaN / undefined), rejections with the same error `name` and `message`.",
    "- A synchronous throw of the legacy function counts as a rejection (what an awaiting caller observes).",
  ].join("\n");
  emit("architect", "spec_generated", "Generated the async specification", { specMarkdown });

  const lift = liftErrorFirst(request.source, { entryName: request.name });
  const candidates: Array<{ strategy: string; code: string; rewrites: string[]; lifted: string[] }> = [];
  if (lift.ok && lift.entry.name === entry.name) {
    const polished = modernize(lift.code);
    if (polished.parsed && polished.code.trim() !== lift.code.trim()) candidates.push({ strategy: "lift+modernize", code: polished.code.trim(), rewrites: lift.rewrites, lifted: lift.lifted });
    candidates.push({ strategy: "lift", code: lift.code, rewrites: lift.rewrites, lifted: lift.lifted });
  } else {
    emit("necromancer", "agent_started", `Structural lift refused: ${lift.ok ? "the lifted entry differs from the detected one" : lift.reason}`);
  }
  candidates.push({ strategy: "promise-wrapper", code: promiseWrapper(request.source, entry), rewrites: ["legacy body kept behind a new Promise wrapper"], lifted: [entry.name] });

  const numRuns = request.fuzzRuns ?? 100;
  const examples = literalExamples(request.source, schema);
  let lastReport: FuzzReport | undefined;
  let lastCode = "";
  let attempt = 0;
  let firstCounterexample: { attempt: number; cx: CounterexampleReport } | undefined;
  for (const candidate of candidates) {
    attempt++;
    emit("necromancer", "agent_started", `Attempt ${attempt}: ${candidate.strategy}`);
    emit("necromancer", "code_synthesized", `Produced async candidate #${attempt} (${candidate.strategy})`, { attempt, modernCode: candidate.code, strategy: candidate.strategy });
    const modernHarness = buildModernHarness(candidate.code, entry.name, entry.params);
    emit("exorcist", "agent_started", `Fuzzing both settlements (resolve and reject) across ${numRuns} inputs in the pooled sandbox`);
    const observations: Observation[] = [];
    let resolved = 0;
    let rejected = 0;
    const report = await fuzzer.fuzz(legacyHarness, modernHarness, schema, {
      numRuns,
      exact: true,
      boundary: true,
      settle: true,
      examples,
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      observe: (inputs, legacy) => {
        const env = legacy.ok ? readEnvelope(legacy.output) : undefined;
        if (env === undefined) return;
        if (env.settled === "resolve") resolved++;
        else rejected++;
        observations.push(env.settled === "resolve" ? { inputs, ok: true, output: (legacy.output as Record<string, unknown>)["value"] } : { inputs, ok: false });
      },
    });
    lastReport = report;
    lastCode = candidate.code;
    emit("exorcist", "fuzz_completed", `Completed ${report.totalRuns} async differential runs (${resolved} resolved, ${rejected} rejected)`, { passed: report.passed, totalRuns: report.totalRuns });
    if (!report.passed) {
      const cx: CounterexampleReport | undefined = report.counterexample;
      emit("exorcist", "counterexample_found", `Divergence detected: ${cx?.reason ?? "settlements differ"}`, { counterexample: cx, attempt });
      if (cx !== undefined) firstCounterexample ??= { attempt, cx };
      continue;
    }
    if (attempt > 1) emit("exorcist", "self_healed", `Async parity verified after ${attempt} attempts`);
    emit("exorcist", "completed", `Resurrection complete: 100% async parity proven across ${report.totalRuns} runs (${resolved} resolved, ${rejected} rejected)`);
    const typeSignature = observations.length > 0 ? inferSignature(observations, schema) : undefined;
    return {
      success: true,
      name: request.name,
      legacyCode: request.source,
      specMarkdown,
      modernCode: renderAsyncTypeScript(candidate.code, entry, typeSignature, [`Resurrected by Lazarus Async Callback Necromancer (attempt ${attempt}, ${candidate.strategy})`, ...candidate.rewrites.map((r) => `async-lift: ${r}`)]),
      attempts: attempt,
      fuzzReport: report,
      events,
      ...(typeSignature !== undefined ? { typeSignature } : {}),
      ruleBlame: [
        asyncBlame("callback-async", {
          applied: candidate.strategy !== "promise-wrapper",
          line: entry.line,
          reason:
            candidate.strategy !== "promise-wrapper"
              ? `\`${entry.name}(${[...entry.params, entry.callback].join(", ")})\` became \`async ${entry.name}(${entry.params.join(", ")})\` (${candidate.strategy}); both settlements matched on ${report.totalRuns} inputs.`
              : `The callback was not lifted${lift.ok ? " (an earlier attempt diverged)" : ` (${lift.reason})`}, so the legacy body stays behind a Promise wrapper.`,
          ...(candidate.strategy === "promise-wrapper" && firstCounterexample !== undefined ? { counterexample: describeCounterexample(firstCounterexample.attempt, firstCounterexample.cx) } : {}),
        }),
      ],
      asyncCallback: {
        entry: entry.name,
        callback: entry.callback,
        params: entry.params,
        lifted: candidate.lifted,
        strategy: candidate.strategy,
        rewrites: candidate.rewrites,
        outcomes: { resolved, rejected },
        legacyHarness,
        modernHarness,
        modernJs: candidate.code,
      },
    };
  }
  const failed = fail(`Resurrection finished with unresolved async divergence after ${attempt} attempts`, lastReport, lastCode);
  return { ...failed, specMarkdown, attempts: attempt };
}
