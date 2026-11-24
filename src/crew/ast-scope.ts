// Scope analysis, generic AST walking and light type inference for the AST modernizer.
// The modernizer only ever PARSES legacy code. Nothing in this file executes it.

import type * as ESTree from "estree";

export type Node = ESTree.Node;

const SKIP_KEYS = new Set(["type", "loc", "start", "end", "range", "comments", "leadingComments", "trailingComments"]);

export function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

export function positionOf(node: Node): { start: number; end: number } {
  const n = node as unknown as { start?: number; end?: number };
  return { start: n.start ?? -1, end: n.end ?? -1 };
}

export function lineOf(node: Node): number {
  return (node as { loc?: { start: { line: number } } | null | undefined }).loc?.start.line ?? 0;
}

/** Depth-first walk. `enter` may return false to skip a node's children. */
export function walk(
  root: Node,
  enter: (node: Node, parent: Node | null, key: string | null) => boolean | void,
  parent: Node | null = null,
  key: string | null = null
): void {
  if (enter(root, parent, key) === false) return;
  const record = root as unknown as Record<string, unknown>;
  for (const k of Object.keys(record)) {
    if (SKIP_KEYS.has(k)) continue;
    const value = record[k];
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) walk(item, enter, root, k);
    } else if (isNode(value)) {
      walk(value, enter, root, k);
    }
  }
}

export function patternIds(pattern: Node): ESTree.Identifier[] {
  switch (pattern.type) {
    case "Identifier":
      return [pattern];
    case "ObjectPattern":
      return pattern.properties.flatMap((p) => (p.type === "RestElement" ? patternIds(p.argument) : patternIds(p.value)));
    case "ArrayPattern":
      return pattern.elements.flatMap((e) => (e === null ? [] : patternIds(e)));
    case "AssignmentPattern":
      return patternIds(pattern.left);
    case "RestElement":
      return patternIds(pattern.argument);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Scopes and bindings
// ---------------------------------------------------------------------------

export type BindingKind = "var" | "let" | "const" | "param" | "function" | "class" | "catch" | "arguments" | "fname";

export interface Binding {
  readonly name: string;
  kind: BindingKind;
  readonly scope: Scope;
  /** Declaring identifiers (several for repeated `var x`). */
  readonly declIds: ESTree.Identifier[];
  /** Declaring statements (VariableDeclaration for var/let/const, the function/param otherwise). */
  readonly declNodes: Node[];
  readonly refs: Reference[];
  /** The same name was declared with incompatible kinds (param + var, function + var, ...). */
  conflict: boolean;
}

export interface Scope {
  readonly kind: "program" | "function" | "block" | "catch";
  readonly node: Node;
  readonly parent: Scope | null;
  readonly bindings: Map<string, Binding>;
  /** Nearest function or program scope (itself when it is one). */
  fn: Scope;
  isArrow: boolean;
}

export interface Reference {
  readonly id: ESTree.Identifier;
  readonly read: boolean;
  readonly write: boolean;
  readonly scope: Scope;
  readonly binding: Binding | null;
}

export interface Analysis {
  readonly program: ESTree.Program;
  readonly parents: Map<Node, Node | null>;
  readonly scopes: Scope[];
  readonly references: Reference[];
  readonly refByNode: Map<Node, Reference>;
  readonly scopeOfNode: Map<Node, Scope>;
  readonly hasEval: boolean;
  readonly hasWith: boolean;
  /** Program-level `this`, globalThis, window, self or global is used. */
  readonly usesGlobalObject: boolean;
  /** Function declarations that live inside blocks (Annex B semantics). */
  readonly blockFunctionNames: Set<string>;
  readonly allNames: Set<string>;
}

function isReferencePosition(parent: Node | null, key: string | null): boolean {
  if (parent === null) return true;
  switch (parent.type) {
    case "MemberExpression":
      return key !== "property" || parent.computed;
    case "Property":
      return key === "value" || parent.computed;
    case "MethodDefinition":
    case "PropertyDefinition":
      return key === "value" || parent.computed;
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
    case "MetaProperty":
      return false;
    case "ExportSpecifier":
      return key === "local";
    default:
      return true;
  }
}

export function analyze(program: ESTree.Program): Analysis {
  const parents = new Map<Node, Node | null>();
  const scopes: Scope[] = [];
  const scopeOfNode = new Map<Node, Scope>();
  const declIdNodes = new Set<Node>();
  const writeInfo = new Map<Node, { read: boolean; write: boolean }>();
  const pending: Array<{ id: ESTree.Identifier; read: boolean; write: boolean; scope: Scope }> = [];
  const blockFunctionNames = new Set<string>();
  const allNames = new Set<string>();
  let hasWith = false;
  let usesGlobalObject = false;

  const newScope = (kind: Scope["kind"], node: Node, parent: Scope | null): Scope => {
    const scope = { kind, node, parent, bindings: new Map<string, Binding>(), isArrow: false } as Scope;
    scope.fn = kind === "function" || kind === "program" ? scope : (parent as Scope).fn;
    scopes.push(scope);
    scopeOfNode.set(node, scope);
    return scope;
  };

  const declare = (scope: Scope, name: string, kind: BindingKind, id: ESTree.Identifier | null, declNode: Node | null): void => {
    let binding = scope.bindings.get(name);
    if (binding === undefined) {
      binding = { name, kind, scope, declIds: [], declNodes: [], refs: [], conflict: false };
      scope.bindings.set(name, binding);
    } else if (binding.kind === "fname") {
      binding.kind = kind;
    } else if (!(binding.kind === "var" && kind === "var")) {
      binding.conflict = true;
    }
    if (id !== null) binding.declIds.push(id);
    if (declNode !== null) binding.declNodes.push(declNode);
  };

  const markWrites = (target: Node, read: boolean): void => {
    for (const id of patternIds(target)) writeInfo.set(id, { read, write: true });
  };

  const visitChildren = (node: Node, scope: Scope): void => {
    const record = node as unknown as Record<string, unknown>;
    for (const k of Object.keys(record)) {
      if (SKIP_KEYS.has(k)) continue;
      const value = record[k];
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item, node, scope, k);
      } else if (isNode(value)) {
        visit(value, node, scope, k);
      }
    }
  };

  const visitFunction = (
    node: ESTree.FunctionDeclaration | ESTree.FunctionExpression | ESTree.ArrowFunctionExpression,
    outer: Scope
  ): void => {
    if (node.type === "FunctionDeclaration" && node.id) {
      declIdNodes.add(node.id);
      declare(outer.kind === "block" || outer.kind === "catch" ? outer : outer.fn, node.id.name, "function", node.id, node);
      if (outer.kind === "block" || outer.kind === "catch") blockFunctionNames.add(node.id.name);
    }
    const scope = newScope("function", node, outer);
    scope.isArrow = node.type === "ArrowFunctionExpression";
    if (node.type === "FunctionExpression" && node.id) {
      declIdNodes.add(node.id);
      declare(scope, node.id.name, "fname", node.id, node);
    }
    if (!scope.isArrow) declare(scope, "arguments", "arguments", null, null);
    for (const param of node.params) {
      for (const id of patternIds(param)) {
        declIdNodes.add(id);
        declare(scope, id.name, "param", id, param);
      }
    }
    node.params.forEach((param) => visit(param, node, scope, "params"));
    if (node.body.type === "BlockStatement") {
      parents.set(node.body, node);
      for (const statement of node.body.body) visit(statement, node.body, scope, "body");
    } else {
      visit(node.body, node, scope, "body");
    }
  };

  const visit = (node: Node, parent: Node | null, scope: Scope, key: string | null): void => {
    parents.set(node, parent);
    switch (node.type) {
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        visitFunction(node, scope);
        return;
      case "VariableDeclaration": {
        const target = node.kind === "var" ? scope.fn : scope;
        // `using` / `await using` are block-scoped and immutable, like const.
        const kind: BindingKind = node.kind === "var" || node.kind === "let" ? node.kind : "const";
        for (const declarator of node.declarations) {
          for (const id of patternIds(declarator.id)) {
            declIdNodes.add(id);
            declare(target, id.name, kind, id, node);
          }
        }
        visitChildren(node, scope);
        return;
      }
      case "BlockStatement": {
        const block = newScope("block", node, scope);
        for (const statement of node.body) visit(statement, node, block, "body");
        return;
      }
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        const loopScope = newScope("block", node, scope);
        if (node.type !== "ForStatement" && node.left.type !== "VariableDeclaration") markWrites(node.left, false);
        visitChildren(node, loopScope);
        return;
      }
      case "SwitchStatement": {
        visit(node.discriminant, node, scope, "discriminant");
        const block = newScope("block", node, scope);
        for (const switchCase of node.cases) visit(switchCase, node, block, "cases");
        return;
      }
      case "CatchClause": {
        const catchScope = newScope("catch", node, scope);
        if (node.param) {
          for (const id of patternIds(node.param)) {
            declIdNodes.add(id);
            declare(catchScope, id.name, "catch", id, node);
          }
        }
        visitChildren(node, catchScope);
        return;
      }
      case "ClassDeclaration":
        if (node.id) {
          declIdNodes.add(node.id);
          declare(scope, node.id.name, "class", node.id, node);
        }
        visitChildren(node, scope);
        return;
      case "ClassExpression":
        if (node.id) declIdNodes.add(node.id);
        visitChildren(node, scope);
        return;
      case "AssignmentExpression":
        markWrites(node.left, node.operator !== "=");
        visitChildren(node, scope);
        return;
      case "UpdateExpression":
        markWrites(node.argument, true);
        visitChildren(node, scope);
        return;
      case "WithStatement":
        hasWith = true;
        visitChildren(node, scope);
        return;
      case "ThisExpression": {
        let s: Scope = scope.fn;
        while (s.kind === "function" && s.isArrow) s = (s.parent as Scope).fn;
        if (s.kind === "program") usesGlobalObject = true;
        return;
      }
      case "Identifier": {
        allNames.add(node.name);
        if (declIdNodes.has(node) || !isReferencePosition(parent, key)) return;
        const info = writeInfo.get(node) ?? { read: true, write: false };
        pending.push({ id: node, read: info.read, write: info.write, scope });
        return;
      }
      default:
        visitChildren(node, scope);
    }
  };

  const programScope = newScope("program", program, null);
  parents.set(program, null);
  for (const statement of program.body) visit(statement, program, programScope, "body");

  const references: Reference[] = [];
  const refByNode = new Map<Node, Reference>();
  let hasEval = false;
  for (const p of pending) {
    let binding: Binding | null = null;
    for (let s: Scope | null = p.scope; s !== null; s = s.parent) {
      const found = s.bindings.get(p.id.name);
      if (found !== undefined) {
        binding = found;
        break;
      }
    }
    const ref: Reference = { id: p.id, read: p.read, write: p.write, scope: p.scope, binding };
    references.push(ref);
    refByNode.set(p.id, ref);
    if (binding !== null) binding.refs.push(ref);
    else {
      if (p.id.name === "eval") hasEval = true;
      if (["globalThis", "window", "self", "global"].includes(p.id.name)) usesGlobalObject = true;
    }
  }

  return {
    program,
    parents,
    scopes,
    references,
    refByNode,
    scopeOfNode,
    hasEval,
    hasWith,
    usesGlobalObject,
    blockFunctionNames,
    allNames,
  };
}

// ---------------------------------------------------------------------------
// Structure helpers
// ---------------------------------------------------------------------------

const LOOPS = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);

/** True when `node` sits inside a loop that belongs to the same function. */
export function isInsideLoop(node: Node, parents: Map<Node, Node | null>): boolean {
  for (let cur = parents.get(node) ?? null; cur !== null; cur = parents.get(cur) ?? null) {
    if (cur.type === "FunctionDeclaration" || cur.type === "FunctionExpression" || cur.type === "ArrowFunctionExpression") return false;
    if (LOOPS.has(cur.type)) return true;
  }
  return false;
}

export function ancestors(node: Node, parents: Map<Node, Node | null>): Node[] {
  const result: Node[] = [];
  for (let cur = parents.get(node) ?? null; cur !== null; cur = parents.get(cur) ?? null) result.push(cur);
  return result;
}

/**
 * Does `fn` (a function node) reference this/arguments/super/new.target in its own body,
 * looking through nested arrows (which inherit them) but not nested ordinary functions?
 */
export function usesOwnThisOrArguments(fn: ESTree.Function, includeArguments = true): boolean {
  let found = false;
  const visitBody = (node: Node): void => {
    walk(node, (n) => {
      if (found) return false;
      if (n !== fn && (n.type === "FunctionExpression" || n.type === "FunctionDeclaration")) return false;
      if (n.type === "ThisExpression" || n.type === "Super" || n.type === "MetaProperty") found = true;
      if (includeArguments && n.type === "Identifier" && n.name === "arguments") found = true;
      return undefined;
    });
  };
  for (const param of fn.params) visitBody(param);
  visitBody(fn.body);
  return found;
}

// ---------------------------------------------------------------------------
// Type inference (used only to prove `==` is equivalent to `===`)
// ---------------------------------------------------------------------------

export type TypeTag = "number" | "string" | "boolean" | "undefined" | "null";

const COMPARISON_OPS = new Set(["==", "!=", "===", "!==", "<", "<=", ">", ">=", "in", "instanceof"]);
const ARITHMETIC_OPS = new Set(["-", "*", "/", "%", "**"]);
const BITWISE_OPS = new Set(["|", "&", "^", "<<", ">>"]);
const CONVERTER_GLOBALS: Record<string, TypeTag> = { String: "string", Number: "number", Boolean: "boolean", parseInt: "number", parseFloat: "number" };

function isUnshadowedGlobal(node: Node, analysis: Analysis, name: string): boolean {
  return node.type === "Identifier" && node.name === name && analysis.refByNode.get(node)?.binding === null;
}

export function inferType(node: Node, analysis: Analysis): TypeTag | undefined {
  switch (node.type) {
    case "Literal": {
      if (node.value === null) return "null";
      const t = typeof node.value;
      return t === "number" || t === "string" || t === "boolean" ? t : undefined;
    }
    case "TemplateLiteral":
      return "string";
    case "Identifier":
      return isUnshadowedGlobal(node, analysis, "undefined") ? "undefined" : undefined;
    case "UnaryExpression": {
      if (node.operator === "typeof") return "string";
      if (node.operator === "!") return "boolean";
      if (node.operator === "void") return "undefined";
      if (node.operator === "+") return "number";
      if (node.operator === "-" || node.operator === "~") return inferType(node.argument, analysis) === "number" ? "number" : undefined;
      return undefined;
    }
    case "BinaryExpression": {
      if (COMPARISON_OPS.has(node.operator)) return "boolean";
      if (node.operator === ">>>") return "number";
      const left = node.left.type === "PrivateIdentifier" ? undefined : inferType(node.left, analysis);
      const right = inferType(node.right, analysis);
      if (ARITHMETIC_OPS.has(node.operator) || BITWISE_OPS.has(node.operator)) {
        return left === "number" || right === "number" ? "number" : undefined;
      }
      if (node.operator === "+") {
        if (left === "string" || right === "string") return "string";
        return left === "number" && right === "number" ? "number" : undefined;
      }
      return undefined;
    }
    case "ConditionalExpression": {
      const a = inferType(node.consequent, analysis);
      return a !== undefined && a === inferType(node.alternate, analysis) ? a : undefined;
    }
    case "SequenceExpression": {
      const last = node.expressions[node.expressions.length - 1];
      return last === undefined ? undefined : inferType(last, analysis);
    }
    case "CallExpression": {
      const callee = node.callee;
      if (callee.type === "Identifier") {
        const tag = CONVERTER_GLOBALS[callee.name];
        if (tag !== undefined && isUnshadowedGlobal(callee, analysis, callee.name)) return tag;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
