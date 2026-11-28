// Hardcore ES5 idiom lifter: prototype inheritance, scope-safe constructors, apply/arguments forwarding and Promise chains.
//
// Everything here is deterministic acorn / astring work (no LLM, no API key). Legacy code is only parsed and printed;
// the original and the lifted code run only inside the pooled sandbox, where the Exorcist compares them.
//
// Two parts:
//  1. Pure analyzers the modernizer's `prototype-class` rule uses (guard, Object.create parent, super call).
//  2. The Promise-chain lifter: `return X.then(h).catch(c)` -> `async function` with `try { ... } catch (err) { ... }`,
//     with its own resurrection pass (same shape as the error-first pass; both settlements are fuzzed).
import type * as ESTree from "estree";
import type { DifferentialFuzzer } from "../fuzzer/differential.js";
import type { CounterexampleReport, FuzzReport, InputSchema } from "../fuzzer/types.js";
import { modernize, parseProgram, printProgram } from "./ast-modernizer.js";
import { usesOwnThisOrArguments, walk } from "./ast-scope.js";
import {
  buildModernHarness,
  literalExamples,
  readEnvelope,
  renderAsyncTypeScript,
  type AsyncCallbackSummary,
  type ErrorFirstFunction,
  type ErrorFirstRequest,
  type ErrorFirstResult,
} from "./async-callback.js";
import { inferSignature, type Observation } from "./type-alchemist.js";
import type { AgentRole, CrewEvent, CrewEventType } from "./types.js";

type Node = ESTree.Node;
const isId = (n: Node | null | undefined, name?: string): n is ESTree.Identifier => n != null && n.type === "Identifier" && (name === undefined || n.name === name);
const lineOf = (n: Node): number => (n as { loc?: { start: { line: number } } | null }).loc?.start.line ?? 0;
const ident = (name: string): ESTree.Identifier => ({ type: "Identifier", name });

// ---------------------------------------------------------------------------
// Part 1: analyzers for the prototype-class rule
// ---------------------------------------------------------------------------

/**
 * `if (!(this instanceof Foo)) return new Foo(a, b);` as the first statement of `function Foo(a, b)`, forwarding exactly
 * the constructor's own parameters. Anything else (other arguments, an else branch, more statements) is not a plain guard.
 */
export function scopeGuardOf(decl: ESTree.FunctionDeclaration): ESTree.IfStatement | undefined {
  const name = decl.id?.name;
  const first = decl.body.body[0];
  if (name === undefined || first === undefined || first.type !== "IfStatement" || (first.alternate !== null && first.alternate !== undefined)) return undefined;
  const test = first.test;
  if (test.type !== "UnaryExpression" || test.operator !== "!") return undefined;
  const inner = test.argument;
  if (inner.type !== "BinaryExpression" || inner.operator !== "instanceof" || inner.left.type !== "ThisExpression" || !isId(inner.right, name)) return undefined;
  const consequent = first.consequent;
  const statement = consequent.type === "BlockStatement" ? (consequent.body.length === 1 ? consequent.body[0] : undefined) : consequent;
  if (statement === undefined || statement.type !== "ReturnStatement" || statement.argument === null || statement.argument === undefined) return undefined;
  const created = statement.argument;
  if (created.type !== "NewExpression" || !isId(created.callee, name) || created.arguments.length !== decl.params.length) return undefined;
  const forwards = created.arguments.every((arg, i) => {
    const param = decl.params[i];
    return arg.type === "Identifier" && param !== undefined && param.type === "Identifier" && param.name === arg.name;
  });
  return forwards ? first : undefined;
}

/** `Object.create(P.prototype)` -> "P". */
export function inheritanceParentOf(expression: ESTree.Node): string | undefined {
  if (expression.type !== "CallExpression" || expression.arguments.length !== 1) return undefined;
  const callee = expression.callee;
  if (callee.type !== "MemberExpression" || callee.computed || !isId(callee.object, "Object") || !isId(callee.property, "create")) return undefined;
  const arg = expression.arguments[0];
  if (arg === undefined || arg.type !== "MemberExpression" || arg.computed || !isId(arg.property, "prototype") || arg.object.type !== "Identifier") return undefined;
  return arg.object.name;
}

export interface SuperCall {
  /** The `Parent.call(this, ...)` / `Parent.apply(this, ...)` statement to replace. */
  readonly statement: ESTree.ExpressionStatement;
  /** Arguments of the `super(...)` call. */
  readonly args: Array<ESTree.Expression | ESTree.SpreadElement>;
}

const mentionsThis = (nodes: readonly Node[]): boolean => {
  let hit = false;
  for (const root of nodes) {
    walk(root, (n) => {
      if (n.type === "ThisExpression") hit = true;
      return undefined;
    });
  }
  return hit;
};

/** True when `fn`'s own body (not its nested functions) returns a value. */
function returnsValue(fn: ESTree.FunctionDeclaration, skip: ESTree.Statement | undefined): boolean {
  let hit = false;
  walk(fn.body, (n) => {
    if (n !== fn.body && (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression")) return false;
    if (n === skip) return false;
    if (n.type === "ReturnStatement" && n.argument !== null && n.argument !== undefined) hit = true;
    return undefined;
  });
  return hit;
}

/**
 * The constructor's first statement (after an optional scope guard) must call the parent: `Parent.call(this, a, b)`,
 * `Parent.apply(this, arguments)` or `Parent.apply(this, [a, b])`. Returns the `super(...)` arguments, or the reason it cannot be one.
 */
export function superCallOf(decl: ESTree.FunctionDeclaration, parent: string, guard: ESTree.IfStatement | undefined): SuperCall | string {
  const statement = decl.body.body[guard === undefined ? 0 : 1];
  if (statement === undefined || statement.type !== "ExpressionStatement" || statement.expression.type !== "CallExpression") return `the constructor does not start with ${parent}.call(this, ...)`;
  const call = statement.expression;
  const callee = call.callee;
  if (callee.type !== "MemberExpression" || callee.computed || !isId(callee.object, parent) || callee.property.type !== "Identifier") return `the constructor does not start with ${parent}.call(this, ...)`;
  const method = callee.property.name;
  if ((method !== "call" && method !== "apply") || call.arguments[0]?.type !== "ThisExpression") return `the constructor does not start with ${parent}.call(this, ...)`;
  if (returnsValue(decl, guard)) return "the constructor returns a value, which a derived class constructor may not";
  const rest = call.arguments.slice(1);
  let args: Array<ESTree.Expression | ESTree.SpreadElement>;
  if (method === "call") {
    if (rest.some((a) => a.type === "SpreadElement")) return `${parent}.call is given a spread argument`;
    args = rest as ESTree.Expression[];
  } else {
    const list = rest[0];
    if (rest.length !== 1 || list === undefined) return `${parent}.apply needs exactly one argument list`;
    if (isId(list, "arguments")) args = [{ type: "SpreadElement", argument: list }];
    else if (list.type === "ArrayExpression" && list.elements.every((e) => e !== null && e.type !== "SpreadElement")) args = list.elements as ESTree.Expression[];
    else return `${parent}.apply is given something other than \`arguments\` or an array literal`;
  }
  if (mentionsThis(args)) return "the super arguments use `this`, which is not available before super()";
  return { statement, args };
}

// ---------------------------------------------------------------------------
// Part 2: Promise chains
// ---------------------------------------------------------------------------
export interface PromiseChainDetection {
  readonly parsed: boolean;
  readonly parseError?: string;
  readonly functions: ErrorFirstFunction[];
  /** The exported chain function, or the last one declared. */
  readonly entry?: ErrorFirstFunction;
}

type Fn = ESTree.FunctionDeclaration | ESTree.FunctionExpression;
type Handler = ESTree.FunctionExpression | ESTree.ArrowFunctionExpression;

interface Chain {
  readonly source: ESTree.Expression;
  readonly then?: Handler;
  readonly catch?: Handler;
}

class NotLiftable extends Error {}

const isFunctionNode = (n: Node | null | undefined): n is Handler => n != null && (n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression");
const isMemberCall = (e: ESTree.Expression, method: string): e is ESTree.SimpleCallExpression & { callee: ESTree.MemberExpression } =>
  e.type === "CallExpression" && e.callee.type === "MemberExpression" && !e.callee.computed && isId(e.callee.property, method) && e.arguments.length === 1;

/** `X.then(h)`, `X.then(h).catch(c)` or `X.catch(c)`; undefined for anything else (longer chains, two-argument then, finally). */
function chainOf(expression: ESTree.Expression): Chain | undefined {
  const handlerOf = (call: ESTree.SimpleCallExpression): Handler | undefined => {
    const arg = call.arguments[0];
    return isFunctionNode(arg) ? arg : undefined;
  };
  if (isMemberCall(expression, "catch")) {
    const c = handlerOf(expression);
    const inner = expression.callee.object;
    if (c === undefined || inner.type === "Super") return undefined;
    if (isMemberCall(inner, "then")) {
      const h = handlerOf(inner);
      const source = inner.callee.object;
      return h === undefined || source.type === "Super" ? undefined : { source, then: h, catch: c };
    }
    if (inner.type === "CallExpression" && inner.callee.type === "MemberExpression" && isId(inner.callee.property, "then")) return undefined;
    return { source: inner, catch: c };
  }
  if (isMemberCall(expression, "then")) {
    const h = handlerOf(expression);
    const source = expression.callee.object;
    return h === undefined || source.type === "Super" ? undefined : { source, then: h };
  }
  return undefined;
}

const exportRef = (left: Node): { ref: string; key: string | null } | undefined => {
  const isMember = (n: Node, object: string, property: string): boolean => n.type === "MemberExpression" && !n.computed && isId(n.object, object) && isId(n.property, property);
  if (isMember(left, "module", "exports")) return { ref: "module.exports", key: null };
  if (left.type === "MemberExpression" && !left.computed && left.property.type === "Identifier") {
    if (isId(left.object, "exports") || isMember(left.object, "module", "exports")) return { ref: `module.exports.${left.property.name}`, key: left.property.name };
  }
  return undefined;
};

interface Candidate {
  readonly fn: Fn;
  readonly info: ErrorFirstFunction;
  readonly chain: Chain;
  readonly statement: ESTree.Statement;
}

function candidatesOf(program: ESTree.Program, preferredName?: string): Candidate[] {
  const out: Candidate[] = [];
  const exportedNames = new Map<string, string>();
  for (const s of program.body) {
    if (s.type === "ExpressionStatement" && s.expression.type === "AssignmentExpression" && s.expression.operator === "=" && isId(s.expression.right)) {
      const target = exportRef(s.expression.left);
      if (target !== undefined) exportedNames.set(s.expression.right.name, target.ref);
    }
  }
  const consider = (fn: Fn, name: string, ref: string, exported: boolean, statement: ESTree.Statement): void => {
    if (fn.async || fn.generator || !fn.params.every((p) => p.type === "Identifier")) return;
    const last = fn.body.body[fn.body.body.length - 1];
    if (last === undefined || last.type !== "ReturnStatement" || last.argument === null || last.argument === undefined) return;
    const chain = chainOf(last.argument);
    if (chain === undefined) return;
    out.push({ fn, chain, statement, info: { name, params: fn.params.map((p) => (p as ESTree.Identifier).name), callback: "", ref, exported, line: lineOf(fn), style: "promise-chain" } });
  };
  const safe = (raw: string | undefined): string | undefined => {
    if (raw === undefined) return undefined;
    const cleaned = raw.replace(/[^A-Za-z0-9_$]/g, "_");
    return cleaned === "" ? undefined : /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
  };
  for (const s of program.body) {
    if (s.type === "FunctionDeclaration" && s.id) {
      const ref = exportedNames.get(s.id.name);
      consider(s, s.id.name, s.id.name, ref !== undefined, s);
    } else if (s.type === "VariableDeclaration") {
      for (const d of s.declarations) if (isId(d.id) && d.init && d.init.type === "FunctionExpression") consider(d.init, d.id.name, d.id.name, exportedNames.has(d.id.name), s);
    } else if (s.type === "ExpressionStatement" && s.expression.type === "AssignmentExpression" && s.expression.operator === "=" && s.expression.right.type === "FunctionExpression") {
      const target = exportRef(s.expression.left);
      if (target === undefined) continue;
      const fn = s.expression.right;
      consider(fn, target.key ?? fn.id?.name ?? safe(preferredName) ?? "resurrected", target.ref, true, s);
    }
  }
  return out;
}

const pickEntry = (functions: readonly ErrorFirstFunction[]): ErrorFirstFunction | undefined =>
  functions.find((f) => f.ref === "module.exports") ?? [...functions].reverse().find((f) => f.exported) ?? functions.at(-1);

export function detectPromiseChain(source: string, options: { entryName?: string } = {}): PromiseChainDetection {
  const parsed = parseProgram(source);
  if ("error" in parsed) return { parsed: false, parseError: parsed.error, functions: [] };
  const functions = candidatesOf(parsed.ast, options.entryName).map((c) => c.info);
  const entry = pickEntry(functions);
  return { parsed: true, functions, ...(entry !== undefined ? { entry } : {}) };
}

// ---- lift -----------------------------------------------------------------
const THENABLE_SAFE = new Set<ESTree.Node["type"]>(["Literal", "TemplateLiteral", "ObjectExpression", "ArrayExpression", "UnaryExpression", "BinaryExpression", "UpdateExpression", "FunctionExpression", "ArrowFunctionExpression", "ThisExpression"]);
/** A value that cannot be a promise: returning it directly equals awaiting it. */
function plainValue(e: ESTree.Expression, thenParam: string | undefined): boolean {
  if (e.type === "Identifier") return e.name === thenParam || e.name === "undefined";
  return THENABLE_SAFE.has(e.type);
}

/** The statements of a handler body; a concise arrow body becomes `return expr`. */
function handlerBody(h: Handler): ESTree.Statement[] {
  return h.body.type === "BlockStatement" ? h.body.body : [{ type: "ReturnStatement", argument: h.body }];
}

/** Handlers move into the enclosing function: refuse anything whose meaning would change there. */
function checkHandler(h: Handler, label: string): void {
  if (h.async || h.generator) throw new NotLiftable(`the ${label} handler is async or a generator`);
  if (h.params.length > 1 || h.params.some((p) => p.type !== "Identifier")) throw new NotLiftable(`the ${label} handler has more than one parameter or a pattern parameter`);
  if (h.type === "FunctionExpression") {
    if (h.id !== null && h.id !== undefined) throw new NotLiftable(`the ${label} handler is a named function expression`);
    if (usesOwnThisOrArguments(h, true)) throw new NotLiftable(`the ${label} handler uses its own this or arguments`);
  }
  for (const statement of handlerBody(h)) {
    walk(statement, (n) => {
      if (n !== statement && (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression")) return false;
      if (n.type === "FunctionDeclaration") throw new NotLiftable(`the ${label} handler declares a function`);
      if (n.type === "VariableDeclaration" && n.kind === "var") throw new NotLiftable(`the ${label} handler declares a var, which would hoist out of its block`);
      return undefined;
    });
    if (statement.type === "FunctionDeclaration" || (statement.type === "VariableDeclaration" && statement.kind === "var")) throw new NotLiftable(`the ${label} handler declares a ${statement.type === "FunctionDeclaration" ? "function" : "var"}`);
  }
}

/** Rewrites the handler's own `return x` statements (not those of nested functions); `await` keeps a chained rejection catchable. */
function mapReturns(statements: readonly ESTree.Statement[], rewrite: (argument: ESTree.Expression | null) => ESTree.Expression | null): ESTree.Statement[] {
  const visit = (s: ESTree.Statement): ESTree.Statement => {
    switch (s.type) {
      case "ReturnStatement":
        return { ...s, argument: rewrite(s.argument ?? null) };
      case "IfStatement":
        return { ...s, consequent: visit(s.consequent), alternate: s.alternate === null || s.alternate === undefined ? null : visit(s.alternate) };
      case "BlockStatement":
        return { ...s, body: s.body.map(visit) };
      case "ForStatement":
      case "WhileStatement":
      case "DoWhileStatement":
      case "ForInStatement":
      case "ForOfStatement":
      case "LabeledStatement":
        return { ...s, body: visit(s.body) } as ESTree.Statement;
      case "TryStatement":
        return { ...s, block: visit(s.block) as ESTree.BlockStatement, handler: s.handler === null || s.handler === undefined ? null : { ...s.handler, body: visit(s.handler.body) as ESTree.BlockStatement }, finalizer: s.finalizer === null || s.finalizer === undefined ? null : (visit(s.finalizer) as ESTree.BlockStatement) };
      case "SwitchStatement":
        return { ...s, cases: s.cases.map((c) => ({ ...c, consequent: c.consequent.map(visit) })) };
      default:
        return s;
    }
  };
  return statements.map(visit);
}

const awaitOf = (argument: ESTree.Expression): ESTree.AwaitExpression => ({ type: "AwaitExpression", argument });

function takenNames(fn: Fn): Set<string> {
  const names = new Set<string>();
  walk(fn, (n) => {
    if (n.type === "Identifier") names.add(n.name);
    return undefined;
  });
  return names;
}

/** Whether evaluating `e` cannot throw synchronously, so it may move inside the `try`. */
function cannotThrow(e: ESTree.Expression): boolean {
  if (e.type === "Identifier" || e.type === "Literal") return true;
  if (e.type === "CallExpression" && e.callee.type === "MemberExpression" && !e.callee.computed && isId(e.callee.object, "Promise") && e.arguments.length <= 1 && (isId(e.callee.property, "resolve") || isId(e.callee.property, "reject"))) {
    const a = e.arguments[0];
    return a === undefined || (a.type !== "SpreadElement" && (a.type === "Identifier" || a.type === "Literal"));
  }
  return false;
}

/** Lifts one chain function in place. Returns the rewrite descriptions. */
function liftChainFunction(fn: Fn, chain: Chain): string[] {
  const body = fn.body.body;
  const last = body[body.length - 1];
  if (last === undefined || last.type !== "ReturnStatement") throw new NotLiftable("the chain is not the last statement");
  if (chain.then !== undefined) checkHandler(chain.then, "then");
  if (chain.catch !== undefined) checkHandler(chain.catch, "catch");
  const rewrites: string[] = [];
  const hasCatch = chain.catch !== undefined;
  const thenParam = chain.then?.params[0]?.type === "Identifier" ? chain.then.params[0].name : undefined;
  const tail: ESTree.Statement[] = [];
  let awaited: ESTree.Expression = chain.source;
  if (hasCatch && !cannotThrow(chain.source)) {
    // A synchronous throw of the source is not part of the promise, so the legacy `.catch` never saw it.
    const taken = takenNames(fn);
    let name = "pending";
    for (let i = 2; taken.has(name); i++) name = `pending${i}`;
    tail.push({ type: "VariableDeclaration", kind: "const", declarations: [{ type: "VariableDeclarator", id: ident(name), init: chain.source }] });
    awaited = ident(name);
  }
  const tryBody: ESTree.Statement[] = [];
  if (chain.then !== undefined) {
    const param = chain.then.params[0];
    const init = awaitOf(awaited);
    if (param !== undefined) tryBody.push({ type: "VariableDeclaration", kind: "const", declarations: [{ type: "VariableDeclarator", id: param, init }] });
    else tryBody.push({ type: "ExpressionStatement", expression: init });
    // With a catch after it, a promise returned by the handler must be awaited inside the try so its rejection is caught.
    const statements = handlerBody(chain.then);
    tryBody.push(...(hasCatch ? mapReturns(statements, (a) => (a === null || plainValue(a, thenParam) ? a : awaitOf(a))) : statements));
    rewrites.push(`.then(${param !== undefined ? (param as ESTree.Identifier).name : ""}) handler -> const ${param !== undefined ? `${(param as ESTree.Identifier).name} = ` : ""}await ...`);
  } else {
    tryBody.push({ type: "ReturnStatement", argument: awaitOf(awaited) });
  }
  if (hasCatch && chain.catch !== undefined) {
    const param = chain.catch.params[0];
    tail.push({
      type: "TryStatement",
      block: { type: "BlockStatement", body: tryBody },
      handler: { type: "CatchClause", param: param !== undefined ? (param as ESTree.Identifier) : null, body: { type: "BlockStatement", body: handlerBody(chain.catch) } },
      finalizer: null,
    });
    rewrites.push(`.catch(${param !== undefined ? (param as ESTree.Identifier).name : ""}) handler -> try { ... } catch (${param !== undefined ? (param as ESTree.Identifier).name : ""}) { ... }`);
  } else {
    tail.push(...tryBody);
  }
  fn.body = { type: "BlockStatement", body: [...body.slice(0, -1), ...tail] };
  fn.async = true;
  return rewrites;
}

export interface PromiseLiftOk {
  readonly ok: true;
  readonly code: string;
  readonly entry: ErrorFirstFunction;
  readonly lifted: string[];
  readonly rewrites: string[];
}
export type PromiseLiftResult = PromiseLiftOk | { readonly ok: false; readonly reason: string };

/** Lifts the entry function's `.then().catch()` chain to async/await. Everything else in the module is left exactly as written. */
export function liftPromiseChain(source: string, options: { entryName?: string } = {}): PromiseLiftResult {
  const parsed = parseProgram(source);
  if ("error" in parsed) return { ok: false, reason: `the source does not parse: ${parsed.error}` };
  const all = candidatesOf(parsed.ast, options.entryName);
  const entryInfo = pickEntry(all.map((c) => c.info));
  const candidate = all.find((c) => c.info === entryInfo);
  if (entryInfo === undefined || candidate === undefined) return { ok: false, reason: "no function ending in `return X.then(h)`, `X.then(h).catch(c)` or `X.catch(c)` was found" };
  let rewrites: string[];
  try {
    rewrites = liftChainFunction(candidate.fn, candidate.chain);
  } catch (err: unknown) {
    if (err instanceof NotLiftable) return { ok: false, reason: err.message };
    throw err;
  }
  // Normalize `module.exports = function (...) {}` to a declaration plus `module.exports = name;`.
  parsed.ast.body = parsed.ast.body.flatMap((s) => {
    if (s === candidate.statement && s.type === "ExpressionStatement" && s.expression.type === "AssignmentExpression" && s.expression.right.type === "FunctionExpression") {
      const fn = s.expression.right;
      const decl: ESTree.FunctionDeclaration = { type: "FunctionDeclaration", id: ident(entryInfo.name), params: fn.params, body: fn.body, async: true, generator: false };
      return [decl, { type: "ExpressionStatement", expression: { ...s.expression, right: ident(entryInfo.name) } }];
    }
    return [s];
  });
  return { ok: true, code: printProgram(parsed.ast, parsed.comments).trim(), entry: entryInfo, lifted: [entryInfo.name], rewrites };
}

/** Fallback candidate: the untouched legacy function behind an `async` wrapper (parity by construction). */
export function asyncWrapper(source: string, entry: ErrorFirstFunction): string {
  const params = entry.params.join(", ");
  return [
    "// Async wrapper: the legacy promise chain is kept as written; only the calling convention changes.",
    `const legacy_${entry.name} = (function () {`,
    "  var module = { exports: {} };",
    "  var exports = module.exports;",
    source.trim(),
    "  ;",
    `  return ${entry.ref};`,
    "})();",
    `async function ${entry.name}(${params}) {`,
    `  return legacy_${entry.name}(${params});`,
    "}",
  ].join("\n");
}

const DESCRIBE = `function __lzDescribe(e) {
    var name = typeof e, message = "";
    try { if (e !== null && typeof e === "object" && typeof e.name === "string") name = e.name; } catch (x) {}
    try { message = e !== null && typeof e === "object" && typeof e.message === "string" ? e.message : String(e); } catch (x) { message = "[unprintable]"; }
    return { name: name, message: message };
  }`;

/** Calls the legacy promise function and settles with its promise (a synchronous throw counts as a rejection). */
export function buildPromiseHarness(source: string, entry: ErrorFirstFunction): string {
  return [
    "(function () {",
    "  var module = { exports: {} };",
    "  var exports = module.exports;",
    source.trim(),
    "  ;",
    `  ${DESCRIBE}`,
    `  var __lzFn = ${entry.ref};`,
    "  var __lzP;",
    `  try { __lzP = __lzFn(${entry.params.join(", ")}); } catch (e) { return Promise.resolve({ settled: "reject", error: __lzDescribe(e) }); }`,
    '  return Promise.resolve(__lzP).then(function (v) { return { settled: "resolve", value: v }; }, function (e) { return { settled: "reject", error: __lzDescribe(e) }; });',
    "})()",
  ].join("\n");
}

// ---- resurrection -----------------------------------------------------------
export interface PromiseChainRequest extends ErrorFirstRequest {}

/** Archaeologist -> Architect -> Necromancer <-> Exorcist for a Promise-chain function, mirroring the error-first pass. */
export async function resurrectPromiseChainWith(fuzzer: DifferentialFuzzer, request: PromiseChainRequest): Promise<ErrorFirstResult> {
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

  emit("archaeologist", "agent_started", `Scanning "${request.name}" for legacy Promise chains (AST only, nothing executed)`);
  const detection = detectPromiseChain(request.source, { entryName: request.name });
  const entry = detection.entry;
  if (entry === undefined) return fail(detection.parsed ? "No Promise-chain function was found" : `The source does not parse: ${detection.parseError ?? "syntax error"}`);
  emit("archaeologist", "probe_sampled", `Found Promise chain ${entry.name}(${entry.params.join(", ")}) returning \`.then(...)\`${detection.functions.length > 1 ? `, plus ${detection.functions.length - 1} other chain function(s)` : ""}`, { functions: detection.functions.map((f) => f.name) });
  const schema: InputSchema = Object.fromEntries(entry.params.map((p) => [p, request.schema[p] ?? "string"]));
  const legacyHarness = buildPromiseHarness(request.source, entry);

  emit("architect", "agent_started", "Writing the async contract");
  const specMarkdown = [
    `# Specification: ${request.name} (Promise chain -> async/await)`,
    "",
    "## Input Contract",
    ...Object.entries(schema).map(([k, v]) => `- \`${k}\`: \`${v}\``),
    "",
    "## Calling Convention",
    `- Legacy: \`${entry.name}(${entry.params.join(", ")})\` returns a promise built with \`.then(...)\` / \`.catch(...)\`.`,
    `- Resurrected: \`await ${entry.name}(${entry.params.join(", ")})\` resolves with the same value or rejects with the same error.`,
    "",
    "## Acceptance Criteria",
    "- The first settlement MUST match on every fuzzed input: resolved values with exact `Object.is` (deep, tagged -0 / NaN / undefined), rejections with the same error `name` and `message`.",
    "- A synchronous throw of the legacy function counts as a rejection (what an awaiting caller observes).",
  ].join("\n");
  emit("architect", "spec_generated", "Generated the async specification", { specMarkdown });

  const lift = liftPromiseChain(request.source, { entryName: request.name });
  const candidates: Array<{ strategy: string; code: string; rewrites: string[]; lifted: string[] }> = [];
  let refusal: string | undefined;
  if (lift.ok && lift.entry.name === entry.name) {
    const polished = modernize(lift.code);
    if (polished.parsed && polished.code.trim() !== lift.code.trim()) candidates.push({ strategy: "lift+modernize", code: polished.code.trim(), rewrites: lift.rewrites, lifted: lift.lifted });
    candidates.push({ strategy: "lift", code: lift.code, rewrites: lift.rewrites, lifted: lift.lifted });
  } else {
    refusal = lift.ok ? "the lifted entry differs from the detected one" : lift.reason;
    emit("necromancer", "agent_started", `Structural lift refused: ${refusal}`);
  }
  candidates.push({ strategy: "async-wrapper", code: asyncWrapper(request.source, entry), rewrites: ["legacy promise chain kept behind an async wrapper"], lifted: [entry.name] });

  const numRuns = request.fuzzRuns ?? 100;
  const examples = literalExamples(request.source, schema);
  let lastReport: FuzzReport | undefined;
  let lastCode = "";
  let attempt = 0;
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
      continue;
    }
    if (attempt > 1) emit("exorcist", "self_healed", `Async parity verified after ${attempt} attempts`);
    emit("exorcist", "completed", `Resurrection complete: 100% async parity proven across ${report.totalRuns} runs (${resolved} resolved, ${rejected} rejected)`);
    const typeSignature = observations.length > 0 ? inferSignature(observations, schema) : undefined;
    const summary: AsyncCallbackSummary = {
      kind: "promise-chain",
      entry: entry.name,
      callback: "",
      params: entry.params,
      lifted: candidate.lifted,
      strategy: candidate.strategy,
      rewrites: candidate.rewrites,
      outcomes: { resolved, rejected },
      legacyHarness,
      modernHarness,
      modernJs: candidate.code,
    };
    const lifted = candidate.strategy !== "async-wrapper";
    return {
      success: true,
      name: request.name,
      legacyCode: request.source,
      specMarkdown,
      modernCode: renderAsyncTypeScript(candidate.code, entry, typeSignature, [`Resurrected by Lazarus Promise-Chain Necromancer (attempt ${attempt}, ${candidate.strategy})`, ...candidate.rewrites.map((r) => `promise-lift: ${r}`)]),
      attempts: attempt,
      fuzzReport: report,
      events,
      ...(typeSignature !== undefined ? { typeSignature } : {}),
      asyncCallback: summary,
      ruleBlame: [
        {
          rule: "promise-async",
          status: lifted ? "applied" : "rolled-back",
          legacyLines: [entry.line],
          resurrectedLines: [],
          sites: 1,
          reason: lifted
            ? `\`${entry.name}\` returned \`.then()${lift.ok && lift.rewrites.some((r) => r.startsWith(".catch")) ? ".catch()" : ""}\`; it became async/await and both settlements matched on ${report.totalRuns} inputs (${resolved} resolved, ${rejected} rejected).`
            : `The chain was not lifted (${refusal ?? "an earlier attempt diverged"}), so the legacy body stays behind an async wrapper.`,
        },
      ],
    };
  }
  const failed = fail(`Resurrection finished with unresolved async divergence after ${attempt} attempts`, lastReport, lastCode);
  return { ...failed, specMarkdown, attempts: attempt };
}
