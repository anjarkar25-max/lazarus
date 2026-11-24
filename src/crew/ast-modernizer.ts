// AST-to-AST ES5/CommonJS -> ES2022 modernizer (the engine behind the Necromancer agent).
//
// Legacy code is only PARSED here (acorn) and printed (astring). It is never executed by this
// module. Counterexample refinement runs candidates through a sandbox ProbeExecutor.

import { parse, type Comment } from "acorn";
import { generate } from "astring";
import type * as ESTree from "estree";
import type { CounterexampleReport, ProbeOutcome } from "../fuzzer/types.js";
import { areOutputsEquivalent } from "../fuzzer/differential.js";
import type { ProbeExecutor } from "../sandbox/types.js";
import {
  analyze,
  inferType,
  isInsideLoop,
  lineOf,
  patternIds,
  positionOf,
  usesOwnThisOrArguments,
  walk,
  type Analysis,
  type Binding,
  type Node,
} from "./ast-scope.js";

// ---------------------------------------------------------------------------
// Rules, ladders, and the header codec
// ---------------------------------------------------------------------------

export const RULE_LADDERS = {
  "var-scoping": ["let-const", "off"],
  "bitor0-trunc": ["trunc", "trunc-or0", "off"],
  "function-arrow": ["arrow", "off"],
  "arguments-rest": ["rest", "off"],
  "apply-spread": ["spread", "spread-proven", "off"],
  "loose-equality": ["strict-proven", "off"],
} as const;

export type RuleId = keyof typeof RULE_LADDERS;
export type RuleLevels = Record<RuleId, number>;

/** Application order. var-scoping goes first because it relies on original source positions. */
export const RULE_ORDER: readonly RuleId[] = [
  "var-scoping",
  "arguments-rest",
  "apply-spread",
  "function-arrow",
  "bitor0-trunc",
  "loose-equality",
];

/** Refinement blames riskier rules first. */
export const RISK_ORDER: readonly RuleId[] = [
  "bitor0-trunc",
  "loose-equality",
  "apply-spread",
  "arguments-rest",
  "function-arrow",
  "var-scoping",
];

export function defaultLevels(): RuleLevels {
  return {
    "var-scoping": 0,
    "bitor0-trunc": 0,
    "function-arrow": 0,
    "arguments-rest": 0,
    "apply-spread": 0,
    "loose-equality": 0,
  };
}

export function allOff(): RuleLevels {
  const levels = defaultLevels();
  for (const rule of RULE_ORDER) levels[rule] = RULE_LADDERS[rule].length - 1;
  return levels;
}

export function isRuleOff(rule: RuleId, levels: RuleLevels): boolean {
  return levels[rule] >= RULE_LADDERS[rule].length - 1;
}

export function variantName(rule: RuleId, levels: RuleLevels): string {
  return RULE_LADDERS[rule][Math.min(levels[rule], RULE_LADDERS[rule].length - 1)] ?? "off";
}

export function stepDown(levels: RuleLevels, rule: RuleId): RuleLevels {
  return { ...levels, [rule]: Math.min(levels[rule] + 1, RULE_LADDERS[rule].length - 1) };
}

export function encodeLevels(levels: RuleLevels): string {
  return RULE_ORDER.map((rule) => `${rule}=${variantName(rule, levels)}`).join(" ");
}

export function decodeLevels(text: string): RuleLevels | undefined {
  const levels = defaultLevels();
  for (const token of text.trim().split(/\s+/)) {
    const [name, value] = token.split("=");
    if (name === undefined || value === undefined) return undefined;
    if (!(name in RULE_LADDERS)) return undefined;
    const rule = name as RuleId;
    const index = (RULE_LADDERS[rule] as readonly string[]).indexOf(value);
    if (index < 0) return undefined;
    levels[rule] = index;
  }
  return levels;
}

/** Rule levels recorded in a previous candidate's `// ast-rules:` header, if it has one. */
export function readHeaderLevels(code: string | undefined): RuleLevels | undefined {
  if (code === undefined) return undefined;
  const match = /^\/\/ ast-rules: (.+)$/m.exec(code);
  return match?.[1] === undefined ? undefined : decodeLevels(match[1]);
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface AppliedRewrite {
  readonly rule: RuleId;
  readonly variant: string;
  readonly line: number;
  readonly before: string;
  readonly after: string;
  readonly speculative: boolean;
  readonly note?: string;
}

export interface FlaggedSite {
  readonly kind: "loose-equality" | "var-kept" | "dynamic-scope";
  readonly line: number;
  readonly text: string;
  readonly reason: string;
}

export interface ModernizeOptions {
  readonly levels?: RuleLevels;
  /** Set false to leave `| 0` untouched (the only rewrite that is not provably equivalent). */
  readonly speculativeTruncation?: boolean;
}

export interface ModernizeResult {
  readonly code: string;
  readonly parsed: boolean;
  readonly levels: RuleLevels;
  readonly applied: AppliedRewrite[];
  readonly flagged: FlaggedSite[];
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Parsing and printing
// ---------------------------------------------------------------------------

export interface ParsedProgram {
  readonly ast: ESTree.Program;
  readonly comments: Comment[];
}
type Parsed = ParsedProgram;

export function parseProgram(source: string): ParsedProgram | { error: string } {
  return parseSource(source);
}

export function printProgram(ast: ESTree.Program, comments: Comment[]): string {
  return print(ast, comments);
}

function parseSource(source: string): Parsed | { error: string } {
  const attempt = (sourceType: "script" | "module"): Parsed => {
    const comments: Comment[] = [];
    const ast = parse(source, {
      ecmaVersion: "latest",
      sourceType,
      allowReturnOutsideFunction: sourceType === "script",
      allowHashBang: true,
      locations: true,
      onComment: comments,
    }) as unknown as ESTree.Program;
    return { ast, comments };
  };
  try {
    return attempt("script");
  } catch (scriptError: unknown) {
    if (/^\s*(import|export)\b/m.test(source)) {
      try {
        return attempt("module");
      } catch {
        /* report the script error below */
      }
    }
    return { error: scriptError instanceof Error ? scriptError.message : String(scriptError) };
  }
}

/** Attach each comment to the statement (or object property) that follows it, so astring can print it. */
function attachCommentsToStatements(ast: ESTree.Program, comments: Comment[]): void {
  const slots: Node[] = [];
  walk(ast, (n, parent, key) => {
    if (parent === null) return;
    const inStatementList =
      ((parent.type === "Program" || parent.type === "BlockStatement" || parent.type === "StaticBlock") && key === "body") ||
      (parent.type === "SwitchCase" && key === "consequent") ||
      (parent.type === "ObjectExpression" && key === "properties");
    if (inStatementList) slots.push(n);
  });
  for (const comment of comments) {
    const printable = { type: comment.type, value: comment.value };
    const next = slots.find((s) => positionOf(s).start >= comment.end);
    if (next !== undefined) {
      const holder = next as unknown as { comments?: unknown[] };
      (holder.comments ??= []).push(printable);
      continue;
    }
    const previous = [...slots].reverse().find((s) => positionOf(s).end <= comment.start);
    if (previous !== undefined) {
      const holder = previous as unknown as { trailingComments?: unknown[] };
      (holder.trailingComments ??= []).push(printable);
    }
  }
}

function print(ast: ESTree.Program, comments: Comment[]): string {
  try {
    attachCommentsToStatements(ast, comments);
    return generate(ast, { indent: "  ", lineEnd: "\n", comments: true }).trimEnd();
  } catch {
    return generate(ast, { indent: "  ", lineEnd: "\n" }).trimEnd();
  }
}

function gen(node: Node): string {
  const text = generate(node, { indent: "  ", lineEnd: " " }).replace(/\s+/g, " ").trim();
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
}

function replaceNode(target: Node, replacement: Node): void {
  const t = target as unknown as Record<string, unknown>;
  const keep: Record<string, unknown> = {};
  for (const key of ["start", "end", "loc", "range", "comments"]) if (key in t) keep[key] = t[key];
  for (const key of Object.keys(t)) delete t[key];
  Object.assign(t, replacement, keep);
}

const ident = (name: string): ESTree.Identifier => ({ type: "Identifier", name });
const member = (object: ESTree.Expression, property: string): ESTree.MemberExpression => ({
  type: "MemberExpression",
  object,
  property: ident(property),
  computed: false,
  optional: false,
});
const call = (callee: ESTree.Expression, args: Array<ESTree.Expression | ESTree.SpreadElement>): ESTree.CallExpression => ({
  type: "CallExpression",
  callee,
  arguments: args,
  optional: false,
});

function isUnshadowedGlobal(node: Node, a: Analysis, name: string): boolean {
  return node.type === "Identifier" && node.name === name && a.refByNode.get(node)?.binding === null;
}

// ---------------------------------------------------------------------------
// Rule: var-scoping
// ---------------------------------------------------------------------------

interface DeclDecision {
  ok: boolean;
  constOk: boolean;
  reason: string;
}

function siteRange(decl: ESTree.VariableDeclaration, a: Analysis): { start: number; end: number; loopHead: boolean; implicitInit: boolean } | null {
  const parent = a.parents.get(decl) ?? null;
  if (parent === null) return null;
  switch (parent.type) {
    case "ForStatement":
      return parent.init === decl ? { ...positionOf(parent), loopHead: true, implicitInit: false } : null;
    case "ForInStatement":
    case "ForOfStatement":
      return parent.left === decl ? { ...positionOf(parent), loopHead: true, implicitInit: true } : null;
    case "BlockStatement":
    case "Program":
      return { ...positionOf(parent), loopHead: false, implicitInit: false };
    default:
      return null;
  }
}

function evaluateVarBinding(binding: Binding, a: Analysis, decisions: Map<ESTree.VariableDeclaration, DeclDecision>): void {
  const decls = binding.declNodes.filter((n): n is ESTree.VariableDeclaration => n.type === "VariableDeclaration");
  const fail = (reason: string): void => {
    for (const d of decls) {
      const decision = decisions.get(d);
      if (decision !== undefined) {
        decision.ok = false;
        if (decision.reason === "") decision.reason = `${binding.name}: ${reason}`;
      }
    }
  };

  if (binding.conflict) return fail("also declared as a parameter, function or catch variable");
  if (a.blockFunctionNames.has(binding.name)) return fail("same name as a function declared inside a block");
  if (binding.scope.kind === "program" && a.usesGlobalObject) return fail("program-level var may be read through the global object");

  const sites = binding.declIds.map((id, i) => {
    const decl = binding.declNodes[i];
    if (decl === undefined || decl.type !== "VariableDeclaration") return null;
    const declarator = decl.declarations.find((d) => patternIds(d.id).includes(id));
    const range = siteRange(decl, a);
    return declarator === undefined || range === null ? null : { decl, declarator, range };
  });
  if (sites.some((s) => s === null)) return fail("declared in a position where block scoping is not equivalent (switch case, bare statement)");
  const valid = sites as Array<NonNullable<(typeof sites)[number]>>;

  // Sites must not overlap, so every reference belongs to exactly one declaration.
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const x = valid[i];
      const y = valid[j];
      if (x !== undefined && y !== undefined && x.range.start < y.range.end && y.range.start < x.range.end) {
        return fail("redeclared in overlapping scopes");
      }
    }
  }

  const assigned = new Map<(typeof valid)[number], typeof binding.refs>();
  for (const site of valid) assigned.set(site, []);
  for (const ref of binding.refs) {
    const start = positionOf(ref.id).start;
    const owner = valid.find((s) => start >= s.range.start && start <= s.range.end);
    if (owner === undefined) return fail("referenced outside the block that declares it");
    if (start < positionOf(owner.declarator).end) return fail("read before or inside its own initializer");
    assigned.get(owner)?.push(ref);
  }

  for (const site of valid) {
    const refs = assigned.get(site) ?? [];
    const inLoop = site.range.loopHead || isInsideLoop(site.decl, a.parents);
    if (inLoop && refs.some((r) => r.scope.fn !== binding.scope.fn)) return fail("captured by a closure inside a loop");
    if (inLoop && !site.range.loopHead && site.declarator.init === null && !site.range.implicitInit) {
      return fail("loop-body var without an initializer keeps its value across iterations");
    }
    for (const ref of refs) {
      for (let cur = a.parents.get(ref.id) ?? null; cur !== null && cur !== binding.scope.fn.node; cur = a.parents.get(cur) ?? null) {
        if (cur.type === "FunctionDeclaration") return fail("used by a hoisted function declaration");
      }
    }
    const decision = decisions.get(site.decl);
    const hasInit = site.declarator.init !== null || site.range.implicitInit;
    if (decision !== undefined && (!hasInit || refs.some((r) => r.write))) decision.constOk = false;
  }
}

function ruleVarScoping(a: Analysis, applied: AppliedRewrite[], flagged: FlaggedSite[]): void {
  if (a.hasEval || a.hasWith) {
    flagged.push({ kind: "dynamic-scope", line: 0, text: a.hasEval ? "eval" : "with", reason: "dynamic scoping makes var -> let/const unsafe; var kept everywhere" });
    return;
  }
  // A binding can carry `var` declarations even when its kind is "param" or "function" (a conflict),
  // so look at the declaration nodes rather than the binding kind.
  const hasVarDeclaration = (binding: Binding): boolean =>
    binding.declNodes.some((n) => n.type === "VariableDeclaration" && n.kind === "var");
  const decisions = new Map<ESTree.VariableDeclaration, DeclDecision>();
  for (const scope of a.scopes) {
    for (const binding of scope.bindings.values()) {
      if (!hasVarDeclaration(binding)) continue;
      for (const decl of binding.declNodes) {
        if (decl.type === "VariableDeclaration" && decl.kind === "var" && !decisions.has(decl)) {
          decisions.set(decl, { ok: true, constOk: true, reason: "" });
        }
      }
    }
  }
  for (const scope of a.scopes) {
    for (const binding of scope.bindings.values()) if (hasVarDeclaration(binding)) evaluateVarBinding(binding, a, decisions);
  }
  for (const [decl, decision] of decisions) {
    if (decl.kind !== "var") continue;
    if (!decision.ok) {
      flagged.push({ kind: "var-kept", line: lineOf(decl), text: gen(decl), reason: decision.reason });
      continue;
    }
    const before = gen(decl);
    const kind = decision.constOk ? "const" : "let";
    decl.kind = kind;
    applied.push({ rule: "var-scoping", variant: "let-const", line: lineOf(decl), before, after: gen(decl), speculative: false, note: `var -> ${kind}` });
  }
}

// ---------------------------------------------------------------------------
// Rule: arguments-rest
// ---------------------------------------------------------------------------

const SAFE_ARRAY_METHODS = new Set(["slice", "map", "forEach", "filter", "reduce", "indexOf", "join", "some", "every"]);

type ArgumentsAction =
  | { kind: "rename" }
  | { kind: "slice"; call: ESTree.CallExpression; method: string; rest: ESTree.Expression[] };

function isMemberWriteTarget(target: ESTree.MemberExpression, a: Analysis): boolean {
  const p = a.parents.get(target) ?? null;
  if (p === null) return false;
  if (p.type === "AssignmentExpression" && p.left === target) return true;
  if (p.type === "UpdateExpression") return true;
  if (p.type === "UnaryExpression" && p.operator === "delete") return true;
  return (p.type === "ForInStatement" || p.type === "ForOfStatement") && p.left === target;
}

function classifyArgumentsRef(id: ESTree.Identifier, a: Analysis): ArgumentsAction | null {
  const p = a.parents.get(id) ?? null;
  if (p === null) return null;
  if (p.type === "MemberExpression" && p.object === id) {
    if (isMemberWriteTarget(p, a)) return null;
    if (!p.computed) return p.property.type === "Identifier" && p.property.name === "length" ? { kind: "rename" } : null;
    return p.property.type === "Literal" && typeof p.property.value === "string" ? null : { kind: "rename" };
  }
  if (p.type === "CallExpression") {
    const callee = p.callee;
    if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") return null;
    if (callee.property.name === "apply" && p.arguments.length === 2 && p.arguments[1] === id) return { kind: "rename" };
    if (callee.property.name === "call" && p.arguments[0] === id) {
      const inner = callee.object;
      if (inner.type !== "MemberExpression" || inner.computed || inner.property.type !== "Identifier") return null;
      const method = inner.property.name;
      if (!SAFE_ARRAY_METHODS.has(method)) return null;
      const holder = inner.object;
      const isArrayProto =
        holder.type === "MemberExpression" &&
        !holder.computed &&
        holder.property.type === "Identifier" &&
        holder.property.name === "prototype" &&
        isUnshadowedGlobal(holder.object, a, "Array");
      const isEmptyArray = holder.type === "ArrayExpression" && holder.elements.length === 0;
      if (!isArrayProto && !isEmptyArray) return null;
      const rest = p.arguments.slice(1);
      if (rest.some((r) => r.type === "SpreadElement")) return null;
      return { kind: "slice", call: p, method, rest: rest as ESTree.Expression[] };
    }
  }
  return null;
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  taken.add(name);
  return name;
}

function ruleArgumentsRest(a: Analysis, applied: AppliedRewrite[]): void {
  if (a.hasEval || a.hasWith) return;
  for (const scope of a.scopes) {
    if (scope.kind !== "function" || scope.isArrow) continue;
    const fn = scope.node as ESTree.FunctionDeclaration | ESTree.FunctionExpression;
    const binding = scope.bindings.get("arguments");
    if (binding === undefined || binding.kind !== "arguments" || binding.conflict || binding.refs.length === 0) continue;
    if (fn.async || fn.generator) continue;
    if (fn.params.some((p) => p.type !== "Identifier")) continue;

    const actions = binding.refs.map((r) => (r.write ? null : classifyArgumentsRef(r.id, a)));
    if (actions.some((x) => x === null)) continue;
    const resolved = actions as ArgumentsAction[];

    if (fn.params.length > 0) {
      const onlyTailSlices = resolved.every(
        (act) =>
          act.kind === "slice" &&
          act.method === "slice" &&
          act.rest.length === 1 &&
          act.rest[0]?.type === "Literal" &&
          act.rest[0].value === fn.params.length
      );
      if (!onlyTailSlices) continue;
    }

    const name = uniqueName("args", a.allNames);
    const before = gen(fn).split("{")[0]?.trim() ?? "function";
    resolved.forEach((act, i) => {
      const ref = binding.refs[i];
      if (ref === undefined) return;
      if (act.kind === "rename") {
        ref.id.name = name;
      } else if (fn.params.length > 0) {
        replaceNode(act.call, resolved.length === 1 ? ident(name) : call(member(ident(name), "slice"), []));
      } else {
        replaceNode(act.call, call(member(ident(name), act.method), act.rest));
      }
    });
    fn.params.push({ type: "RestElement", argument: ident(name) });
    applied.push({
      rule: "arguments-rest",
      variant: "rest",
      line: lineOf(fn),
      before,
      after: gen(fn).split("{")[0]?.trim() ?? "function",
      speculative: false,
      note: `arguments -> ...${name}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Rule: apply-spread
// ---------------------------------------------------------------------------

const THIS_INSENSITIVE_STATICS: Record<string, ReadonlySet<string> | "any"> = {
  Math: "any",
  String: new Set(["fromCharCode", "fromCodePoint"]),
  Date: new Set(["UTC"]),
  Object: new Set(["assign", "keys", "values", "entries"]),
};

function isNullish(node: Node, a: Analysis): boolean {
  return (
    (node.type === "Literal" && node.value === null) ||
    isUnshadowedGlobal(node, a, "undefined") ||
    (node.type === "UnaryExpression" && node.operator === "void")
  );
}

function bindingOfIdentifier(id: ESTree.Identifier, a: Analysis): Binding | null {
  return a.refByNode.get(id)?.binding ?? null;
}

function isProvableArray(node: Node, a: Analysis): boolean {
  if (node.type === "ArrayExpression") return true;
  if (node.type === "Identifier") {
    const binding = bindingOfIdentifier(node, a);
    if (binding === null) return false;
    if (binding.kind === "arguments") return true;
    if (binding.kind === "param") return binding.declNodes[0]?.type === "RestElement";
    if ((binding.kind === "var" || binding.kind === "let" || binding.kind === "const") && !binding.conflict && binding.declIds.length === 1) {
      if (binding.refs.some((r) => r.write)) return false;
      const decl = binding.declNodes[0];
      const declarator = decl?.type === "VariableDeclaration" ? decl.declarations.find((d) => d.id === binding.declIds[0]) : undefined;
      return declarator?.init?.type === "ArrayExpression";
    }
    return false;
  }
  if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed) {
    const calleeObject = node.callee.object;
    const prop = node.callee.property;
    if (prop.type === "Identifier" && prop.name === "from" && isUnshadowedGlobal(calleeObject, a, "Array")) return true;
  }
  return false;
}

function isThisInsensitiveTarget(target: ESTree.Expression, a: Analysis): boolean {
  if (target.type === "MemberExpression" && !target.computed && target.object.type === "Identifier" && target.property.type === "Identifier") {
    const allowed = THIS_INSENSITIVE_STATICS[target.object.name];
    if (allowed !== undefined && isUnshadowedGlobal(target.object, a, target.object.name)) {
      return allowed === "any" || allowed.has(target.property.name);
    }
    return false;
  }
  if (target.type === "Identifier") {
    const binding = bindingOfIdentifier(target, a);
    if (binding === null || binding.conflict || binding.declIds.length !== 1 || binding.refs.some((r) => r.write)) return false;
    const decl = binding.declNodes[0];
    if (decl?.type === "FunctionDeclaration") return !usesOwnThisOrArguments(decl, false);
    if (decl?.type === "VariableDeclaration") {
      const init = decl.declarations.find((d) => d.id === binding.declIds[0])?.init;
      if (init?.type === "FunctionExpression" || init?.type === "ArrowFunctionExpression") return !usesOwnThisOrArguments(init, false);
    }
  }
  return false;
}

function isSimpleReceiver(node: Node): boolean {
  if (node.type === "Identifier" || node.type === "ThisExpression") return true;
  return node.type === "MemberExpression" && !node.computed && isSimpleReceiver(node.object);
}

const SPREAD_NOTE =
  "speculative: assumes the argument is an array; apply() also accepts array-likes and null, spread requires an iterable";

function ruleApplySpread(a: Analysis, level: number, applied: AppliedRewrite[]): void {
  const sites: ESTree.CallExpression[] = [];
  walk(a.program, (n) => {
    if (
      n.type === "CallExpression" &&
      n.callee.type === "MemberExpression" &&
      !n.callee.computed &&
      n.callee.property.type === "Identifier" &&
      n.callee.property.name === "apply" &&
      n.arguments.length === 2 &&
      n.arguments.every((arg) => arg.type !== "SpreadElement")
    ) {
      sites.push(n);
    }
  });
  for (const node of sites) {
    const callee = node.callee as ESTree.MemberExpression;
    const target = callee.object as ESTree.Expression;
    const thisArg = node.arguments[0];
    const arrayArg = node.arguments[1];
    if (thisArg === undefined || arrayArg === undefined) continue;
    const proven = isProvableArray(arrayArg, a);
    if (!proven && level > 0) continue;

    const safe = isNullish(thisArg, a)
      ? isThisInsensitiveTarget(target, a)
      : target.type === "MemberExpression" && isSimpleReceiver(target.object) && gen(target.object) === gen(thisArg);
    if (!safe) continue;

    const before = gen(node);
    replaceNode(node, call(target, [{ type: "SpreadElement", argument: arrayArg as ESTree.Expression }]));
    applied.push({
      rule: "apply-spread",
      variant: proven ? "spread-proven" : "spread",
      line: lineOf(node),
      before,
      after: gen(node),
      speculative: !proven,
      ...(proven ? {} : { note: SPREAD_NOTE }),
    });
  }
}

// ---------------------------------------------------------------------------
// Rule: function-arrow
// ---------------------------------------------------------------------------

function bindingForDeclaratorId(id: ESTree.Identifier, a: Analysis): Binding | null {
  for (const scope of a.scopes) {
    for (const binding of scope.bindings.values()) if (binding.declIds.includes(id)) return binding;
  }
  return null;
}

function usageIsNonConstructor(binding: Binding, a: Analysis): boolean {
  if (binding.conflict || binding.declIds.length !== 1 || binding.refs.some((r) => r.write)) return false;
  return binding.refs.every((ref) => {
    const p = a.parents.get(ref.id) ?? null;
    if (p === null) return false;
    if (p.type === "CallExpression") return true;
    return (
      p.type === "MemberExpression" &&
      p.object === ref.id &&
      !p.computed &&
      p.property.type === "Identifier" &&
      ["call", "apply", "bind"].includes(p.property.name)
    );
  });
}

function ruleFunctionArrow(a: Analysis, applied: AppliedRewrite[]): void {
  const candidates: ESTree.FunctionExpression[] = [];
  walk(a.program, (n) => {
    if (n.type === "FunctionExpression") candidates.push(n);
  });
  for (const fn of candidates.reverse()) {
    if (fn.id !== null && fn.id !== undefined) continue;
    if (fn.generator || fn.async) continue;
    const names = fn.params.map((p) => (p.type === "Identifier" ? p.name : null));
    if (names.some((n) => n === null || n === "arguments" || n === "eval") || new Set(names).size !== names.length) continue;
    if (fn.body.body.some((s) => s.type === "ExpressionStatement" && typeof (s as { directive?: unknown }).directive === "string")) continue;
    if (usesOwnThisOrArguments(fn)) continue;

    const parent = a.parents.get(fn) ?? null;
    let allowed = false;
    if (parent?.type === "CallExpression") {
      allowed = true; // callback argument or IIFE callee
    } else if (parent?.type === "VariableDeclarator" && parent.init === fn && parent.id.type === "Identifier") {
      const binding = bindingForDeclaratorId(parent.id, a);
      allowed = binding !== null && usageIsNonConstructor(binding, a);
    }
    if (!allowed) continue;

    const before = gen(fn).split("{")[0]?.trim() ?? "function";
    const only = fn.body.body.length === 1 ? fn.body.body[0] : undefined;
    const expressionBody = only?.type === "ReturnStatement" && only.argument !== null && only.argument !== undefined ? only.argument : undefined;
    const arrow: ESTree.ArrowFunctionExpression = {
      type: "ArrowFunctionExpression",
      params: fn.params,
      body: expressionBody ?? fn.body,
      expression: expressionBody !== undefined,
      generator: false,
      async: false,
    };
    replaceNode(fn, arrow);
    applied.push({
      rule: "function-arrow",
      variant: "arrow",
      line: lineOf(fn),
      before,
      after: gen(fn).split("=>")[0]?.trim() + " =>",
      speculative: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Rule: bitor0-trunc  (speculative)
// ---------------------------------------------------------------------------

const INT32_OPS = new Set(["|", "&", "^", "<<", ">>"]);

function isInt32Typed(node: Node): boolean {
  if (node.type === "BinaryExpression") return INT32_OPS.has(node.operator);
  if (node.type === "UnaryExpression") return node.operator === "~";
  return node.type === "Literal" && typeof node.value === "number" && Number.isInteger(node.value) && Math.abs(node.value) < 2 ** 31;
}

const TRUNC_NOTE =
  "speculative: Math.trunc differs from `| 0` for NaN, +/-Infinity, |x| >= 2^31 and the sign of zero (-0); verified by Exorcist over the fuzz domain only";
const TRUNC_OR0_NOTE =
  "speculative: `|| 0` restores NaN and -0 to 0 like `| 0`, but +/-Infinity and |x| >= 2^31 still differ; verified by Exorcist over the fuzz domain only";

function ruleBitOr0(a: Analysis, level: number, applied: AppliedRewrite[]): void {
  if ([...a.scopes].some((s) => s.bindings.has("Math"))) return;
  const sites: ESTree.BinaryExpression[] = [];
  walk(a.program, (n) => {
    if (n.type === "BinaryExpression" && n.operator === "|") sites.push(n);
  });
  for (const node of sites) {
    const isZero = (x: Node): boolean => x.type === "Literal" && x.value === 0;
    const operand = isZero(node.right) ? node.left : isZero(node.left) ? node.right : undefined;
    if (operand === undefined || operand.type === "PrivateIdentifier" || operand.type === "SequenceExpression") continue;
    if (isInt32Typed(operand)) continue;
    const before = gen(node);
    const truncated = call(member(ident("Math"), "trunc"), [operand]);
    replaceNode(
      node,
      level === 0 ? truncated : { type: "LogicalExpression", operator: "||", left: truncated, right: { type: "Literal", value: 0, raw: "0" } }
    );
    applied.push({
      rule: "bitor0-trunc",
      variant: level === 0 ? "trunc" : "trunc-or0",
      line: lineOf(node),
      before,
      after: gen(node),
      speculative: true,
      note: level === 0 ? TRUNC_NOTE : TRUNC_OR0_NOTE,
    });
  }
}

// ---------------------------------------------------------------------------
// Rule: loose-equality
// ---------------------------------------------------------------------------

function ruleLooseEquality(a: Analysis, tighten: boolean, applied: AppliedRewrite[], flagged: FlaggedSite[]): void {
  walk(a.program, (n) => {
    if (n.type !== "BinaryExpression" || (n.operator !== "==" && n.operator !== "!=")) return;
    if (n.left.type === "PrivateIdentifier") return;
    const left = inferType(n.left, a);
    const right = inferType(n.right, a);
    const text = gen(n);
    if (left !== undefined && left === right) {
      if (!tighten) return;
      const op = n.operator === "==" ? "===" : "!==";
      n.operator = op;
      applied.push({ rule: "loose-equality", variant: "strict-proven", line: lineOf(n), before: text, after: gen(n), speculative: false, note: `both operands are ${left}` });
      return;
    }
    const nullish = (x: ESTree.Expression): boolean => (x.type === "Literal" && x.value === null) || isUnshadowedGlobal(x, a, "undefined");
    flagged.push({
      kind: "loose-equality",
      line: lineOf(n),
      text,
      reason:
        nullish(n.right) || nullish(n.left)
          ? "`== null` / `== undefined` matches both null and undefined; kept as written"
          : "operand types are not provably identical, so coercion may apply; kept as written",
    });
  });
}

// ---------------------------------------------------------------------------
// Public engine
// ---------------------------------------------------------------------------

export function modernize(source: string, options: ModernizeOptions = {}): ModernizeResult {
  const levels = options.levels ?? defaultLevels();
  const applied: AppliedRewrite[] = [];
  const flagged: FlaggedSite[] = [];

  const parsed = parseSource(source);
  if ("error" in parsed) {
    return { code: source.trim(), parsed: false, levels, applied, flagged, error: parsed.error };
  }
  const { ast, comments } = parsed;
  const on = (rule: RuleId): boolean => !isRuleOff(rule, levels);

  if (on("var-scoping")) ruleVarScoping(analyze(ast), applied, flagged);
  if (on("arguments-rest")) ruleArgumentsRest(analyze(ast), applied);
  if (on("apply-spread")) ruleApplySpread(analyze(ast), levels["apply-spread"], applied);
  if (on("function-arrow")) ruleFunctionArrow(analyze(ast), applied);
  if (on("bitor0-trunc") && options.speculativeTruncation !== false) ruleBitOr0(analyze(ast), levels["bitor0-trunc"], applied);
  ruleLooseEquality(analyze(ast), on("loose-equality"), applied, flagged);

  return { code: print(ast, comments), parsed: true, levels, applied, flagged };
}

/** Markdown bullets describing planned rewrites and flagged idioms, for the Kiro spec. */
export function summarizeForSpec(result: ModernizeResult): string[] {
  const plain = (text: string): string => text.replace(/`/g, "'");
  if (!result.parsed) return [`- Source could not be parsed (${plain(result.error ?? "syntax error")}); it is kept verbatim.`];
  const lines: string[] = [];
  const byRule = new Map<RuleId, AppliedRewrite[]>();
  for (const item of result.applied) byRule.set(item.rule, [...(byRule.get(item.rule) ?? []), item]);
  for (const [rule, items] of byRule) {
    const first = items[0];
    const speculative = items.filter((i) => i.speculative).length;
    lines.push(
      `- \`${rule}\`: ${items.length} rewrite(s)${speculative > 0 ? `, ${speculative} speculative (verified by Exorcist)` : ""}` +
        (first === undefined ? "" : `, e.g. \`${plain(first.before)}\` -> \`${plain(first.after)}\``)
    );
  }
  for (const flag of result.flagged.slice(0, 10)) {
    lines.push(`- Flagged ${flag.kind} (line ${flag.line}): \`${plain(flag.text)}\` - ${flag.reason}`);
  }
  if (result.flagged.length > 10) lines.push(`- ...and ${result.flagged.length - 10} more flagged site(s).`);
  return lines.length > 0 ? lines : ["- No legacy idioms that need rewriting were detected."];
}

// ---------------------------------------------------------------------------
// Counterexample-guided refinement
// ---------------------------------------------------------------------------

export interface RefinementStep {
  readonly rule: RuleId;
  readonly from: string;
  readonly to: string;
}

export interface RefinementResult {
  readonly levels: RuleLevels;
  readonly steps: RefinementStep[];
  /** The rule blamed for the divergence (the first one rolled back). */
  readonly culprit: RuleId | undefined;
  /** The final candidate reproduces the legacy outcome on the counterexample. */
  readonly matched: boolean;
  /** The sandbox failed while probing, so refinement fell back to the most conservative result. */
  readonly degraded: boolean;
  readonly probes: number;
}

export interface RefineInput {
  readonly legacyCode: string;
  readonly start: RuleLevels;
  readonly counterexample: CounterexampleReport;
  readonly executor: ProbeExecutor;
  readonly speculativeTruncation?: boolean;
  readonly maxProbes?: number;
}

export async function refineCandidate(input: RefineInput): Promise<RefinementResult> {
  const { legacyCode, counterexample, executor } = input;
  const maxProbes = input.maxProbes ?? 60;
  let probes = 0;
  let degraded = false;

  const render = (levels: RuleLevels): ModernizeResult =>
    modernize(legacyCode, { levels, ...(input.speculativeTruncation !== undefined ? { speculativeTruncation: input.speculativeTruncation } : {}) });

  const matches = async (levels: RuleLevels): Promise<boolean> => {
    probes++;
    const candidate = render(levels);
    if (!candidate.parsed) return false;
    let modern: ProbeOutcome;
    try {
      const res = await executor.run({ code: candidate.code, context: counterexample.inputs });
      modern = { ok: true, output: res.output, durationMs: res.durationMs };
    } catch (err: unknown) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "INTERNAL_ERROR") degraded = true;
      modern = { ok: false, durationMs: 0 };
    }
    const legacy = counterexample.legacy;
    if (legacy.ok && modern.ok) return areOutputsEquivalent(legacy.output, modern.output);
    return !legacy.ok && !modern.ok;
  };

  const steps: RefinementStep[] = [];
  let culprit: RuleId | undefined;
  let levels = input.start;

  const step = (from: RuleLevels, rule: RuleId): RuleLevels => {
    const next = stepDown(from, rule);
    steps.push({ rule, from: variantName(rule, from), to: variantName(rule, next) });
    culprit ??= rule;
    return next;
  };

  if (await matches(levels)) return { levels, steps, culprit, matched: true, degraded, probes };

  for (let round = 0; round < 12 && probes < maxProbes; round++) {
    const current = render(levels);
    const active = RISK_ORDER.filter((rule) => !isRuleOff(rule, levels));

    // A single rollback that restores parity pins the blame on that rule.
    for (const rule of active) {
      if (probes >= maxProbes) break;
      const trial = stepDown(levels, rule);
      if (await matches(trial)) {
        levels = step(levels, rule);
        return { levels, steps, culprit, matched: true, degraded, probes };
      }
    }

    // No single rollback is enough: roll back the riskiest rule that actually rewrote something.
    const changing = active.find((rule) => current.applied.some((x) => x.rule === rule));
    if (changing === undefined) break;
    levels = step(levels, changing);
    if (await matches(levels)) return { levels, steps, culprit, matched: true, degraded, probes };
  }

  // Last resort: verbatim legacy semantics.
  for (const rule of RISK_ORDER) {
    while (!isRuleOff(rule, levels)) levels = step(levels, rule);
  }
  return { levels, steps, culprit, matched: await matches(levels), degraded, probes };
}
