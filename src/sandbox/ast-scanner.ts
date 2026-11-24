// Legacy specimen extractor. Parses ES5 / CommonJS source with acorn (it is only parsed, never run),
// finds the functions a module defines or exports, and builds a runnable expression that keeps
// every parameter and the module's helper statements.

import { parse } from "acorn";
import type * as ESTree from "estree";
import { analyze, usesOwnThisOrArguments, walk, patternIds, type Node } from "../crew/ast-scope.js";
import type { ParamKind } from "../fuzzer/types.js";

export interface ScannedFunction {
  name: string;
  /** Source text of every parameter, e.g. `a`, `b = 2`, `...rest`. */
  params: string[];
  /** Bare identifiers a caller supplies (defaults and rest unwrapped). */
  paramNames: string[];
  arity: number;
  isExported: boolean;
  /** `default` for `module.exports = fn`, otherwise the export name. */
  exportedAs?: string;
  kind: "declaration" | "expression" | "arrow" | "method";
  legacyPatterns: string[];
  runnableExpression: string;
  usesThis: boolean;
  usesArguments: boolean;
  line: number;
  /** Fuzz kind per parameter, inferred from how the parameter is used. */
  paramKinds: Record<string, ParamKind>;
}

export interface AstScanResult {
  functions: ScannedFunction[];
  primaryExpression: string;
  detectedIdioms: string[];
  /** False when the source could not be parsed (text fallbacks were used). */
  parsed: boolean;
  parseError?: string;
  primary?: ScannedFunction;
  suggestedSchema: Record<string, ParamKind>;
}

export interface ScanOptions {
  /** Pick this function (by name or export name) as the primary specimen. */
  functionName?: string;
}

type FnNode = ESTree.FunctionDeclaration | ESTree.FunctionExpression | ESTree.ArrowFunctionExpression;

interface Candidate {
  node: FnNode;
  name: string;
  kind: ScannedFunction["kind"];
  exportedAs?: string;
  /** Top-level statement that defines the function and can be dropped from the helper preamble. */
  ownStatement: Node | null;
  isMethod: boolean;
}

const pos = (node: Node): { start: number; end: number } => {
  const n = node as unknown as { start: number; end: number };
  return { start: n.start, end: n.end };
};
const lineOf = (node: Node): number => (node as { loc?: { start: { line: number } } | null }).loc?.start.line ?? 0;

const STRING_METHODS = new Set([
  "charAt", "charCodeAt", "codePointAt", "toUpperCase", "toLowerCase", "trim", "trimStart", "trimEnd", "substring",
  "substr", "padStart", "padEnd", "localeCompare", "normalize", "startsWith", "endsWith", "repeat", "replace", "match", "search", "split",
]);
const ARRAY_METHODS = new Set([
  "map", "forEach", "filter", "reduce", "reduceRight", "push", "pop", "shift", "unshift", "splice", "sort", "reverse",
  "some", "every", "find", "findIndex", "join", "flat",
]);

function parseSource(source: string): { program: ESTree.Program } | { error: string } {
  const attempt = (sourceType: "script" | "module"): ESTree.Program =>
    parse(source, {
      ecmaVersion: "latest",
      sourceType,
      allowReturnOutsideFunction: sourceType === "script",
      allowHashBang: true,
      locations: true,
    }) as unknown as ESTree.Program;
  try {
    return { program: attempt("script") };
  } catch (scriptError: unknown) {
    if (/^\s*(import|export)\b/m.test(source)) {
      try {
        return { program: attempt("module") };
      } catch {
        /* report the script error */
      }
    }
    return { error: scriptError instanceof Error ? scriptError.message : String(scriptError) };
  }
}

// ---------------------------------------------------------------------------
// Idioms
// ---------------------------------------------------------------------------

function exportTarget(left: ESTree.Node): { kind: "default" } | { kind: "named"; name: string } | null {
  if (left.type !== "MemberExpression" || left.computed || left.property.type !== "Identifier") return null;
  const object = left.object;
  const prop = left.property.name;
  const isId = (n: ESTree.Node, name: string): boolean => n.type === "Identifier" && n.name === name;
  if (isId(object, "exports")) return { kind: "named", name: prop };
  if (object.type === "MemberExpression" && !object.computed && isId(object.object, "module") && object.property.type === "Identifier" && object.property.name === "exports") {
    return { kind: "named", name: prop };
  }
  if (isId(object, "module") && prop === "exports") return { kind: "default" };
  return null;
}

const isZero = (n: ESTree.Node): boolean => n.type === "Literal" && n.value === 0;

function detectIdioms(program: ESTree.Program): string[] {
  const found = new Set<string>();
  walk(program, (n, parent, key) => {
    switch (n.type) {
      case "VariableDeclaration":
        if (n.kind === "var") found.add("ES5 var declaration");
        break;
      case "BinaryExpression":
        if (n.operator === "|" && (isZero(n.right) || isZero(n.left))) found.add("32-bit bitwise truncation (| 0)");
        if (n.operator === "==" || n.operator === "!=") found.add("Loose equality (== / !=)");
        break;
      case "CallExpression": {
        const callee = n.callee;
        if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
          const method = callee.property.name;
          if (method === "floor" && callee.object.type === "Identifier" && callee.object.name === "Math") found.add("Math.floor division");
          if (method === "charCodeAt") found.add("ASCII charCodeAt loop");
          if (method === "apply") found.add("Function.prototype.apply call");
        }
        break;
      }
      case "AssignmentExpression":
        if (exportTarget(n.left) !== null) found.add("CommonJS export");
        if (n.left.type === "MemberExpression" && !n.left.computed && n.left.property.type === "Identifier" && n.left.property.name === "prototype") {
          found.add("Prototype assignment");
        }
        if (
          n.left.type === "MemberExpression" &&
          n.left.object.type === "MemberExpression" &&
          !n.left.object.computed &&
          n.left.object.property.type === "Identifier" &&
          n.left.object.property.name === "prototype"
        ) {
          found.add("Prototype assignment");
        }
        break;
      case "Identifier":
        if (n.name === "arguments") {
          const isPropertyName = (parent?.type === "MemberExpression" && key === "property" && !parent.computed) || (parent?.type === "Property" && key === "key" && !parent.computed);
          if (!isPropertyName) found.add("ES5 arguments object");
        }
        break;
      default:
    }
    return undefined;
  });
  // Stable, human-friendly order: the original labels first.
  const order = [
    "ES5 var declaration",
    "32-bit bitwise truncation (| 0)",
    "Math.floor division",
    "CommonJS export",
    "ASCII charCodeAt loop",
    "ES5 arguments object",
    "Function.prototype.apply call",
    "Loose equality (== / !=)",
    "Prototype assignment",
  ];
  return order.filter((label) => found.has(label));
}

function regexIdioms(source: string): string[] {
  const idioms: string[] = [];
  if (/\bvar\b/.test(source)) idioms.push("ES5 var declaration");
  if (/\|\s*0\b/.test(source)) idioms.push("32-bit bitwise truncation (| 0)");
  if (/Math\.floor\s*\(/.test(source)) idioms.push("Math.floor division");
  if (/module\.exports|exports\./.test(source)) idioms.push("CommonJS export");
  if (/\.charCodeAt\s*\(/.test(source)) idioms.push("ASCII charCodeAt loop");
  if (/\barguments\b/.test(source)) idioms.push("ES5 arguments object");
  return idioms;
}

// ---------------------------------------------------------------------------
// Function discovery
// ---------------------------------------------------------------------------

const isFunctionNode = (n: ESTree.Node | null | undefined): n is ESTree.FunctionExpression | ESTree.ArrowFunctionExpression =>
  n !== null && n !== undefined && (n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression");

function propertyKeyName(property: ESTree.Property): string | null {
  if (property.computed) return null;
  if (property.key.type === "Identifier") return property.key.name;
  return property.key.type === "Literal" && typeof property.key.value === "string" ? property.key.value : null;
}

function collectCandidates(program: ESTree.Program): { candidates: Candidate[]; exportStatements: Set<Node> } {
  const candidates: Candidate[] = [];
  const exportStatements = new Set<Node>();
  const byBinding = new Map<string, Candidate>();
  const marks: Array<{ binding: string; as: string }> = [];

  for (const statement of program.body) {
    if (statement.type === "FunctionDeclaration" && statement.id) {
      const c: Candidate = { node: statement, name: statement.id.name, kind: "declaration", ownStatement: statement, isMethod: false };
      candidates.push(c);
      byBinding.set(c.name, c);
    } else if (statement.type === "VariableDeclaration") {
      for (const declarator of statement.declarations) {
        if (declarator.id.type === "Identifier" && isFunctionNode(declarator.init)) {
          const c: Candidate = {
            node: declarator.init,
            name: declarator.id.name,
            kind: declarator.init.type === "ArrowFunctionExpression" ? "arrow" : "expression",
            ownStatement: statement.declarations.length === 1 ? statement : null,
            isMethod: false,
          };
          candidates.push(c);
          byBinding.set(c.name, c);
        }
      }
    } else if (statement.type === "ExpressionStatement" && statement.expression.type === "AssignmentExpression" && statement.expression.operator === "=") {
      const target = exportTarget(statement.expression.left);
      if (target === null) continue;
      exportStatements.add(statement);
      const right = statement.expression.right;
      const exportedAs = target.kind === "default" ? "default" : target.name;
      if (isFunctionNode(right)) {
        candidates.push({
          node: right,
          name: target.kind === "named" ? target.name : right.type === "FunctionExpression" && right.id ? right.id.name : "anonymousSpecimen",
          kind: right.type === "ArrowFunctionExpression" ? "arrow" : "expression",
          exportedAs,
          ownStatement: statement,
          isMethod: false,
        });
      } else if (right.type === "Identifier") {
        marks.push({ binding: right.name, as: exportedAs });
      } else if (right.type === "ObjectExpression" && target.kind === "default") {
        for (const property of right.properties) {
          if (property.type !== "Property" || property.kind !== "init") continue;
          const key = propertyKeyName(property);
          if (key === null) continue;
          if (isFunctionNode(property.value)) {
            candidates.push({ node: property.value, name: key, kind: property.method ? "method" : property.value.type === "ArrowFunctionExpression" ? "arrow" : "expression", exportedAs: key, ownStatement: statement, isMethod: property.method });
          } else if (property.value.type === "Identifier") {
            marks.push({ binding: property.value.name, as: key });
          }
        }
      }
    }
  }
  for (const mark of marks) {
    const c = byBinding.get(mark.binding);
    if (c !== undefined && c.exportedAs === undefined) c.exportedAs = mark.as;
  }
  return { candidates, exportStatements };
}

// ---------------------------------------------------------------------------
// Parameters, runnable expression, schema inference
// ---------------------------------------------------------------------------

function paramName(param: ESTree.Pattern): string | null {
  if (param.type === "Identifier") return param.name;
  if (param.type === "AssignmentPattern" && param.left.type === "Identifier") return param.left.name;
  if (param.type === "RestElement" && param.argument.type === "Identifier") return param.argument.name;
  return null;
}

function inferParamKinds(root: Node, names: string[]): Record<string, ParamKind> {
  const kinds = new Map<string, ParamKind>();
  const lengthHint = new Set<string>();
  const wanted = new Set(names);
  walk(root, (n) => {
    if (n.type === "MemberExpression" && n.object.type === "Identifier" && wanted.has(n.object.name)) {
      const name = n.object.name;
      if (n.computed) {
        lengthHint.add(name);
      } else if (n.property.type === "Identifier") {
        const prop = n.property.name;
        if (STRING_METHODS.has(prop)) kinds.set(name, "string");
        else if (ARRAY_METHODS.has(prop) && kinds.get(name) !== "string") kinds.set(name, "json");
        else if (prop === "length") lengthHint.add(name);
      }
    }
    if (n.type === "BinaryExpression" && ["==", "===", "!=", "!=="].includes(n.operator)) {
      const sides: Array<[ESTree.Node, ESTree.Node]> = [[n.left, n.right], [n.right, n.left]];
      for (const [a, b] of sides) {
        if (a.type === "UnaryExpression" && a.operator === "typeof" && a.argument.type === "Identifier" && wanted.has(a.argument.name) && b.type === "Literal") {
          if (b.value === "string") kinds.set(a.argument.name, "string");
          else if (b.value === "boolean") kinds.set(a.argument.name, "boolean");
        }
      }
    }
    return undefined;
  });
  const result: Record<string, ParamKind> = {};
  for (const name of names) result[name] = kinds.get(name) ?? (lengthHint.has(name) ? "string" : "integer");
  return result;
}

function wrapIfAmbiguous(expression: string): string {
  return /^(\{|function\b|class\b)/.test(expression) ? `(${expression})` : expression;
}

/** `return expr` or `var x = expr; return x` bodies reduce to the bare expression. */
function inlineBody(source: string, node: FnNode): string | undefined {
  if (node.body.type !== "BlockStatement" || node.async || node.generator) return undefined;
  if (node.params.some((p) => p.type !== "Identifier") || usesOwnThisOrArguments(node)) return undefined;
  const [first, second, ...rest] = node.body.body;
  if (first === undefined || rest.length > 0) return undefined;
  const slice = (n: Node): string => source.slice(pos(n).start, pos(n).end).trim();
  if (second === undefined) {
    return first.type === "ReturnStatement" && first.argument ? wrapIfAmbiguous(slice(first.argument)) : undefined;
  }
  if (first.type === "VariableDeclaration" && first.declarations.length === 1 && second.type === "ReturnStatement") {
    const declarator = first.declarations[0];
    if (declarator?.id.type === "Identifier" && declarator.init && second.argument?.type === "Identifier" && second.argument.name === declarator.id.name) {
      return wrapIfAmbiguous(slice(declarator.init));
    }
  }
  return undefined;
}

function functionSource(source: string, c: Candidate): string {
  const text = source.slice(pos(c.node).start, pos(c.node).end);
  if (!c.isMethod) return text;
  const fn = c.node as ESTree.FunctionExpression;
  return `${fn.async ? "async " : ""}function${fn.generator ? "*" : ""} ${text}`;
}

const hasName = (nodes: Node[], name: string): boolean => {
  let found = false;
  for (const root of nodes) {
    walk(root, (n, parent, key) => {
      if (found) return false;
      if (n.type === "Identifier" && n.name === name) {
        const isProp = (parent?.type === "MemberExpression" && key === "property" && !parent.computed) || (parent?.type === "Property" && key === "key" && !parent.computed);
        if (!isProp) found = true;
      }
      return undefined;
    });
    if (found) break;
  }
  return found;
};
/** True when `Name.prototype.x = ...` or `Name.prototype = ...` appears among the statements. */
const hasPrototypeMembers = (nodes: Node[], name: string): boolean =>
  nodes.some((s) => {
    if (s.type !== "ExpressionStatement" || s.expression.type !== "AssignmentExpression") return false;
    const left = s.expression.left;
    const target = left.type === "MemberExpression" && left.object.type === "MemberExpression" ? left.object : left;
    return target.type === "MemberExpression" && !target.computed && target.object.type === "Identifier" && target.object.name === name && target.property.type === "Identifier" && target.property.name === "prototype";
  });
function buildRunnable(source: string, c: Candidate, helpers: Node[]): string {
  const args = c.node.params
    .map((p) => {
      const name = paramName(p);
      if (name === null) return "undefined";
      // A rest parameter receives the supplied values, or nothing at all.
      if (p.type === "RestElement") return `...(typeof ${name} !== "undefined" ? [].concat(${name}) : [])`;
      return `typeof ${name} !== "undefined" ? ${name} : undefined`;
    })
    .join(", ");
  if (c.ownStatement !== null && c.kind === "declaration" && helpers.length > 0 && hasName(helpers, c.name)) {
    // Other statements (Name.prototype.x = ..., Name.create = ...) need the binding: keep it, call by name.
    const construct = hasPrototypeMembers(helpers, c.name) ? "new " : "";
    const all = [...helpers, c.ownStatement].sort((a, b) => pos(a).start - pos(b).start);
    const body = all.map((h) => source.slice(pos(h).start, pos(h).end)).join("\n");
    return `(function () {\n${body}\nreturn ${construct}${c.name}(${args});\n})()`;
  }
  const call = `(${functionSource(source, c)})(${args})`;
  if (helpers.length === 0) return inlineBody(source, c.node) ?? call;
  const preamble = helpers.map((h) => source.slice(pos(h).start, pos(h).end)).join("\n");
  return `(function () {\n${preamble}\nreturn ${call};\n})()`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function plainPrimary(trimmed: string): string {
  return trimmed.replace(/^module\.exports\s*=\s*/, "").replace(/;$/, "");
}

export function scanLegacyAst(source: string, options: ScanOptions = {}): AstScanResult {
  const trimmed = source.trim();
  const parsed = parseSource(trimmed);
  if ("error" in parsed) {
    return {
      functions: [],
      primaryExpression: plainPrimary(trimmed),
      detectedIdioms: regexIdioms(trimmed),
      parsed: false,
      parseError: parsed.error,
      suggestedSchema: {},
    };
  }

  const { program } = parsed;
  const detectedIdioms = detectIdioms(program);
  const { candidates, exportStatements } = collectCandidates(program);
  const isDirective = (s: Node): boolean => s.type === "ExpressionStatement" && typeof (s as { directive?: unknown }).directive === "string";

  const functions: ScannedFunction[] = candidates.map((c) => {
    const helpers = program.body.filter((s) => !exportStatements.has(s) && !isDirective(s) && s !== c.ownStatement);
    // Statements that only define other exported functions are helpers too; they are kept above.
    const paramNames = c.node.params.flatMap((p) => {
      const name = paramName(p);
      return name !== null ? [name] : patternIds(p).map((id) => id.name);
    });
    return {
      name: c.name,
      params: c.node.params.map((p) => trimmed.slice(pos(p).start, pos(p).end)),
      paramNames,
      arity: c.node.params.length,
      isExported: c.exportedAs !== undefined,
      ...(c.exportedAs !== undefined ? { exportedAs: c.exportedAs } : {}),
      kind: c.kind,
      legacyPatterns: [...detectedIdioms],
      runnableExpression: buildRunnable(trimmed, c, helpers),
      usesThis: walkUsesThis(c.node),
      usesArguments: usesOwnThisOrArguments(c.node) && !walkUsesThis(c.node),
      line: lineOf(c.node),
      paramKinds: inferParamKinds(c.node.body, paramNames),
    };
  });

  const lastStatement = program.body.at(-1);
  const isScript =
    exportStatements.size === 0 &&
    lastStatement !== undefined &&
    lastStatement.type === "ExpressionStatement" &&
    !isDirective(lastStatement) &&
    (functions.length === 0 || program.body.some((s) => functions.some((f) => hasPrototypeMembers([s], f.name))));
  if (isScript && options.functionName === undefined) {
    const free = freeVariables(program);
    return {
      functions,
      primaryExpression: plainPrimary(trimmed),
      detectedIdioms,
      parsed: true,
      suggestedSchema: free.length > 0 ? inferParamKinds(program, free) : {},
    };
  }
  const wanted = options.functionName;
  const primary =
    (wanted !== undefined ? functions.find((f) => f.name === wanted || f.exportedAs === wanted) : undefined) ??
    functions.find((f) => f.isExported) ??
    functions[0];

  return {
    functions,
    primaryExpression: primary !== undefined ? primary.runnableExpression : plainPrimary(trimmed),
    detectedIdioms,
    parsed: true,
    ...(primary !== undefined ? { primary } : {}),
    suggestedSchema: primary !== undefined ? primary.paramKinds : {},
  };
}

/** Read-only identifiers the program never declares and the platform does not provide: the caller must supply them. */
function freeVariables(program: ESTree.Program): string[] {
  const analysis = analyze(program);
  const provided = new Set(["module", "exports", "require", "arguments", "undefined", "NaN", "Infinity", "console"]);
  const names = new Set<string>();
  for (const ref of analysis.references) {
    if (ref.binding !== null || ref.write || !ref.read) continue;
    const name = ref.id.name;
    if (provided.has(name) || name in globalThis) continue;
    names.add(name);
  }
  return [...names];
}
function walkUsesThis(node: FnNode): boolean {
  let found = false;
  walk(node, (n) => {
    if (found) return false;
    if (n !== node && (n.type === "FunctionExpression" || n.type === "FunctionDeclaration")) return false;
    if (n.type === "ThisExpression") found = true;
    return undefined;
  });
  return found;
}
