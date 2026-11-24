// CommonJS -> ESM conversion for the PR bundle. Only exact conversions are performed: anything that
// cannot be converted without changing behaviour leaves the module as CommonJS and says why.
// Like the rest of the modernizer, this module only parses and prints code; it never runs it.

import { builtinModules } from "node:module";
import type * as ESTree from "estree";
import { modernize, parseProgram, printProgram, type RuleLevels } from "./ast-modernizer.js";
import { analyze, lineOf, usesOwnThisOrArguments, walk, type Node } from "./ast-scope.js";

export interface EsmModuleResult {
  /** ESM source when `complete`, otherwise the modernized CommonJS source. */
  readonly code: string;
  /** Export names ("default" for the default export). Empty when not complete. */
  readonly exports: string[];
  readonly complete: boolean;
  readonly notes: string[];
}

const RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum",
  "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null",
  "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
  "let", "static", "await", "arguments", "eval",
]);

const isExportName = (name: string): boolean => /^[A-Za-z_$][\w$]*$/.test(name) && !RESERVED.has(name);
const ident = (name: string): ESTree.Identifier => ({ type: "Identifier", name });

/** Thrown internally when a construct has no exact ESM equivalent. */
class Incomplete extends Error {}

type Body = ESTree.Program["body"][number];

interface Exported {
  readonly name: string;
  /** The statement that replaces the assignment, or null when an existing declaration is exported in place. */
  readonly node: Body | null;
  /** Declaration to wrap in `export` (`exports.add = add` where `add` is a top-level function or class). */
  readonly wrap?: Node;
}
export interface EsmOptions {
  /** Rule levels for the modernization pass, so rollbacks apply to the ESM output as well. */
  readonly levels?: RuleLevels;
  /**
   * Resolves relative `require("./x")` calls of a multi-file graph. When given, `var m = require("./x")`,
   * `var f = require("./x").f` and `var { a, b } = require("./x")` become `import` declarations of the returned
   * `source` (e.g. "./x.js"), shaped by what that module exports.
   */
  readonly resolveRequire?: (specifier: string) => RequireTarget | undefined;
}
export interface RequireTarget {
  /** Import specifier to emit, e.g. "./money.js". */
  readonly source: string;
  /** Export names of the target ES module ("default" for a default export). */
  readonly exports: readonly string[];
}

export function toEsmModule(source: string, options: EsmOptions = {}): EsmModuleResult {
  const modern = modernize(source, options.levels === undefined ? {} : { levels: options.levels });
  if (!modern.parsed) {
    return { code: source.trim(), exports: [], complete: false, notes: [`could not parse the source: ${modern.error ?? "syntax error"}`] };
  }
  const parsed = parseProgram(modern.code);
  if ("error" in parsed) {
    return { code: modern.code, exports: [], complete: false, notes: [`could not re-parse the modernized source: ${parsed.error}`] };
  }
  const { ast, comments } = parsed;
  const a = analyze(ast);
  const programScope = a.scopes[0];
  const consumed = new Set<Node>();
  const notes: string[] = [];

  const fail = (reason: string): never => {
    throw new Incomplete(reason);
  };
  const isGlobal = (node: Node, name: string): node is ESTree.Identifier =>
    node.type === "Identifier" && node.name === name && a.refByNode.get(node)?.binding === null;
  const hasTopLevelBinding = (name: string): boolean => programScope?.bindings.has(name) === true;

  /** A function exported from a CommonJS module may not rely on `this` (the exports object). */
  const requireThisFree = (fn: ESTree.FunctionExpression | ESTree.ArrowFunctionExpression, label: string): void => {
    let usesThis = false;
    walk(fn, (n) => {
      if (n !== fn && (n.type === "FunctionExpression" || n.type === "FunctionDeclaration")) return false;
      if (n.type === "ThisExpression") usesThis = true;
      return undefined;
    });
    if (usesThis || (fn.type === "FunctionExpression" && usesOwnThisOrArguments(fn, false))) {
      fail(`${label} uses \`this\`, which is the exports object in CommonJS but undefined in an ES module`);
    }
  };

  /** exports.x / module.exports.x  -> named;  module.exports -> default. */
  const classifyTarget = (left: ESTree.Node): { kind: "named"; name: string } | { kind: "default" } | null => {
    if (left.type !== "MemberExpression" || left.computed || left.property.type !== "Identifier") return null;
    const object = left.object;
    const prop = left.property.name;
    if (isGlobal(object, "exports")) {
      consumed.add(object);
      return { kind: "named", name: prop };
    }
    if (
      object.type === "MemberExpression" &&
      !object.computed &&
      object.property.type === "Identifier" &&
      object.property.name === "exports" &&
      isGlobal(object.object, "module")
    ) {
      consumed.add(object.object);
      return { kind: "named", name: prop };
    }
    if (isGlobal(object, "module") && prop === "exports") {
      consumed.add(object);
      return { kind: "default" };
    }
    return null;
  };

  /** `exports.name = local` where `local` is a top-level binding that never changes. */
  const exportExisting = (name: string, rhs: ESTree.Identifier): Exported | null => {
    const binding = a.refByNode.get(rhs)?.binding ?? null;
    // CommonJS exports a snapshot; an ES export is a live binding. They agree only if it never changes.
    if (binding === null || binding.scope.kind !== "program" || binding.conflict || binding.refs.some((r) => r.write)) return null;
    const declaration = binding.declNodes[0];
    if (name === rhs.name && binding.declNodes.length === 1 && declaration !== undefined && (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") && ast.body.includes(declaration)) {
      return { name, node: null, wrap: declaration };
    }
    return {
      name,
      node: {
        type: "ExportNamedDeclaration",
        declaration: null,
        specifiers: [{ type: "ExportSpecifier", local: ident(rhs.name), exported: ident(name) }],
        source: null,
        attributes: [],
      },
    };
  };
  const namedExport = (name: string, rhs: ESTree.Expression): Exported => {
    if (!isExportName(name)) fail(`export name "${name}" is not a valid ES module binding`);
    if (rhs.type === "Identifier") {
      const exported = exportExisting(name, rhs);
      if (exported !== null) return exported;
    }
    if (hasTopLevelBinding(name)) fail(`"${name}" is already a top-level binding, so exporting it would change the module's scope`);

    if (rhs.type === "FunctionExpression") {
      requireThisFree(rhs, `exports.${name}`);
      const ownName = rhs.id === null || rhs.id === undefined ? undefined : a.scopeOfNode.get(rhs)?.bindings.get(rhs.id.name);
      if (ownName !== undefined && ownName.refs.length > 0) fail(`exports.${name} refers to itself through its function name`);
      const declaration: ESTree.FunctionDeclaration = {
        type: "FunctionDeclaration",
        id: ident(name),
        params: rhs.params,
        body: rhs.body,
        generator: rhs.generator,
        async: rhs.async,
      };
      return { name, node: { type: "ExportNamedDeclaration", declaration, specifiers: [], source: null, attributes: [] } };
    }

    if (rhs.type === "ArrowFunctionExpression") requireThisFree(rhs, `exports.${name}`);

    if (rhs.type === "Identifier") {
      const binding = a.refByNode.get(rhs)?.binding ?? null;
      // CommonJS exports a snapshot; an ES export is a live binding. They agree only if it never changes.
      if (binding !== null && binding.scope.kind === "program" && !binding.conflict && binding.refs.every((r) => !r.write)) {
        return {
          name,
          node: {
            type: "ExportNamedDeclaration",
            declaration: null,
            specifiers: [{ type: "ExportSpecifier", local: ident(rhs.name), exported: ident(name) }],
            source: null,
            attributes: [],
          },
        };
      }
    }

    let readsModuleThis = false;
    walk(rhs, (n) => {
      if (n.type === "FunctionExpression" || n.type === "FunctionDeclaration") return false;
      if (n.type === "ThisExpression") readsModuleThis = true;
      return undefined;
    });
    if (readsModuleThis) fail(`exports.${name} reads top-level \`this\``);

    return {
      name,
      node: {
        type: "ExportNamedDeclaration",
        declaration: { type: "VariableDeclaration", kind: "const", declarations: [{ type: "VariableDeclarator", id: ident(name), init: rhs }] },
        specifiers: [],
        source: null,
        attributes: [],
      },
    };
  };

  const expandObjectLiteral = (literal: ESTree.ObjectExpression): Exported[] | null => {
    const result: Exported[] = [];
    try {
      for (const property of literal.properties) {
        if (property.type !== "Property" || property.kind !== "init" || property.computed) return null;
        const key =
          property.key.type === "Identifier"
            ? property.key.name
            : property.key.type === "Literal" && typeof property.key.value === "string"
              ? property.key.value
              : null;
        const value = property.value;
        if (key === null || value.type === "ObjectPattern" || value.type === "ArrayPattern" || value.type === "AssignmentPattern" || value.type === "RestElement") return null;
        if (result.some((r) => r.name === key)) return null;
        result.push(namedExport(key, value));
      }
    } catch (error: unknown) {
      if (error instanceof Incomplete) return null;
      throw error;
    }
    return result;
  };

  const defaultExport = (rhs: ESTree.Expression): Exported[] => {
    if (rhs.type === "FunctionExpression") {
      requireThisFree(rhs, "module.exports");
      if (rhs.id && hasTopLevelBinding(rhs.id.name)) fail(`"${rhs.id.name}" is already a top-level binding`);
      const declaration = {
        type: "FunctionDeclaration",
        id: rhs.id ?? null,
        params: rhs.params,
        body: rhs.body,
        generator: rhs.generator,
        async: rhs.async,
      } as ESTree.FunctionDeclaration;
      return [{ name: "default", node: { type: "ExportDefaultDeclaration", declaration } }];
    }
    if (rhs.type === "ArrowFunctionExpression") requireThisFree(rhs, "module.exports");
    if (rhs.type === "ClassExpression") {
      if (rhs.id && hasTopLevelBinding(rhs.id.name)) fail(`"${rhs.id.name}" is already a top-level binding`);
      const declaration = { ...rhs, type: "ClassDeclaration" } as unknown as ESTree.ClassDeclaration;
      return [{ name: "default", node: { type: "ExportDefaultDeclaration", declaration } }];
    }
    if (rhs.type === "ObjectExpression") {
      const expanded = expandObjectLiteral(rhs);
      if (expanded !== null) return expanded;
      notes.push("module.exports object literal kept as a default export (its members cannot be expanded into named exports exactly)");
    }
    return [{ name: "default", node: { type: "ExportDefaultDeclaration", declaration: rhs } }];
  };

  /** `var x = require("m")` -> import; `var f = require("fs").readFileSync` -> named import (built-ins only). */
  /** Local graph modules: `require("./x")` in a top-level declaration becomes an exact `import`. */
  const graphImportFor = (declaration: ESTree.VariableDeclaration): Body[] | null => {
    const resolver = options.resolveRequire;
    const declarator = declaration.declarations.length === 1 ? declaration.declarations[0] : undefined;
    if (resolver === undefined || declarator === undefined || declarator.init === null || declarator.init === undefined) return null;
    const requireOf = (node: ESTree.Node): { call: ESTree.SimpleCallExpression; spec: string } | null => {
      if (node.type !== "CallExpression" || !isGlobal(node.callee, "require") || node.arguments.length !== 1) return null;
      const arg = node.arguments[0];
      if (arg?.type !== "Literal" || typeof arg.value !== "string" || !(arg.value.startsWith("./") || arg.value.startsWith("../"))) return null;
      return { call: node, spec: arg.value };
    };
    const init = declarator.init;
    const direct = requireOf(init);
    const member = init.type === "MemberExpression" && !init.computed && init.property.type === "Identifier" ? requireOf(init.object) : null;
    const found = direct ?? member;
    if (found === null) return null;
    const target = resolver(found.spec);
    if (target === undefined) fail(`require("${found.spec}") does not resolve to a module of this graph`);
    const resolved = target as RequireTarget;
    consumed.add(found.call.callee);
    const source: ESTree.Literal = { type: "Literal", value: resolved.source };
    const hasDefault = resolved.exports.includes("default");
    const named = (name: string): boolean => name !== "default" && resolved.exports.includes(name);
    const importDecl = (specifiers: ESTree.ImportDeclaration["specifiers"]): Body => ({ type: "ImportDeclaration", specifiers, source, attributes: [] });
    const helper = (): string => {
      const base = `__lz_${resolved.source.replace(/^.*\//, "").replace(/\.[^.]+$/, "").replace(/[^\w$]/g, "_")}`;
      let name = base;
      for (let i = 2; programScope?.bindings.has(name) === true || a.allNames.has(name); i++) name = `${base}${i}`;
      return name;
    };
    const kind = declaration.kind;
    if (direct !== null && declarator.id.type === "Identifier") {
      const local = ident(declarator.id.name);
      // A module with only named exports is used through its namespace object, like the CommonJS exports object.
      return [importDecl([hasDefault ? { type: "ImportDefaultSpecifier", local } : { type: "ImportNamespaceSpecifier", local }])];
    }
    if (member !== null && declarator.id.type === "Identifier" && init.type === "MemberExpression" && init.property.type === "Identifier") {
      const prop = init.property.name;
      if (named(prop)) return [importDecl([{ type: "ImportSpecifier", imported: ident(prop), local: ident(declarator.id.name) }])];
      if (!hasDefault) fail(`require("${found.spec}").${prop}: the module does not export ${prop}`);
      const holder = helper();
      return [
        importDecl([{ type: "ImportDefaultSpecifier", local: ident(holder) }]),
        { type: "VariableDeclaration", kind, declarations: [{ type: "VariableDeclarator", id: ident(declarator.id.name), init: { type: "MemberExpression", object: ident(holder), property: ident(prop), computed: false, optional: false } }] },
      ];
    }
    if (direct !== null && declarator.id.type === "ObjectPattern") {
      const pairs: Array<{ key: string; local: string }> = [];
      let simple = true;
      for (const property of declarator.id.properties) {
        if (property.type !== "Property" || property.computed || property.key.type !== "Identifier" || property.value.type !== "Identifier") {
          simple = false;
          break;
        }
        pairs.push({ key: property.key.name, local: property.value.name });
      }
      if (simple && pairs.every((p) => named(p.key))) {
        return [importDecl(pairs.map((p) => ({ type: "ImportSpecifier", imported: ident(p.key), local: ident(p.local) })))];
      }
      const holder = helper();
      return [
        importDecl([hasDefault ? { type: "ImportDefaultSpecifier", local: ident(holder) } : { type: "ImportNamespaceSpecifier", local: ident(holder) }]),
        { type: "VariableDeclaration", kind, declarations: [{ type: "VariableDeclarator", id: declarator.id, init: ident(holder) }] },
      ];
    }
    fail(`require("${found.spec}") is used in a declaration shape that has no exact ESM equivalent`);
    return null;
  };
  const importFor = (declaration: ESTree.VariableDeclaration): Body | null => {
    const declarator = declaration.declarations.length === 1 ? declaration.declarations[0] : undefined;
    if (declarator === undefined || declarator.id.type !== "Identifier" || declarator.init === null || declarator.init === undefined) return null;
    const requireCall = (node: ESTree.Node): ESTree.SimpleCallExpression | null =>
      node.type === "CallExpression" &&
      isGlobal(node.callee, "require") &&
      node.arguments.length === 1 &&
      node.arguments[0]?.type === "Literal" &&
      typeof node.arguments[0].value === "string"
        ? node
        : null;
    const specifierOf = (call: ESTree.SimpleCallExpression): string => (call.arguments[0] as ESTree.Literal).value as string;

    const direct = requireCall(declarator.init);
    if (direct !== null) {
      consumed.add(direct.callee);
      return {
        type: "ImportDeclaration",
        specifiers: [{ type: "ImportDefaultSpecifier", local: ident(declarator.id.name) }],
        source: { type: "Literal", value: specifierOf(direct) },
        attributes: [],
      };
    }
    const init = declarator.init;
    if (init.type === "MemberExpression" && !init.computed && init.property.type === "Identifier") {
      const inner = requireCall(init.object);
      if (inner !== null && builtinModules.includes(specifierOf(inner).replace(/^node:/, ""))) {
        consumed.add(inner.callee);
        return {
          type: "ImportDeclaration",
          specifiers: [{ type: "ImportSpecifier", imported: ident(init.property.name), local: ident(declarator.id.name) }],
          source: { type: "Literal", value: specifierOf(inner) },
          attributes: [],
        };
      }
    }
    return null;
  };

  try {
    const body: Body[] = [];
    const wrapped = new Set<Node>();
    const exportNames: string[] = [];
    let assignedModuleExports = false;
    let assignedNamed = false;

    for (const statement of ast.body) {
      if (statement.type === "ExpressionStatement" && statement.expression.type === "AssignmentExpression" && statement.expression.operator === "=") {
        const target = classifyTarget(statement.expression.left);
        if (target !== null) {
          const rhs = statement.expression.right;
          const produced = target.kind === "named" ? [namedExport(target.name, rhs)] : defaultExport(rhs);
          if (target.kind === "named") {
            assignedNamed = true;
          } else {
            if (assignedModuleExports) fail("module.exports is assigned more than once");
            assignedModuleExports = true;
          }
          for (const item of produced) {
            if (exportNames.includes(item.name)) fail(`"${item.name}" is exported more than once`);
            exportNames.push(item.name);
            if (item.node !== null) body.push(item.node);
            if (item.wrap !== undefined) wrapped.add(item.wrap);
          }
          continue;
        }
      }
      if (statement.type === "VariableDeclaration") {
        const stitched = graphImportFor(statement);
        if (stitched !== null) {
          // Keep the original statement's position so comments stay where they were.
          const original = statement as unknown as Record<string, unknown>;
          for (const node of stitched) {
            const carrier = node as unknown as Record<string, unknown>;
            for (const k of ["start", "end", "loc"]) if (k in original) carrier[k] = original[k];
          }
          body.push(...stitched);
          continue;
        }
        const imported = importFor(statement);
        if (imported !== null) {
          body.push(imported);
          continue;
        }
      }
      body.push(statement);
    }

    if (assignedModuleExports && assignedNamed) {
      fail("module mixes `module.exports = ...` with `exports.x = ...`; CommonJS would drop one of them");
    }
    for (const ref of a.references) {
      if (ref.binding === null && ["module", "exports", "require", "__dirname", "__filename"].includes(ref.id.name) && !consumed.has(ref.id)) {
        fail(`\`${ref.id.name}\` is used in a way that has no exact ESM equivalent (line ${lineOf(ref.id)})`);
      }
    }
    if (exportNames.length === 0) fail("no CommonJS exports were found");

    const finalBody = body.map((s): Body => {
      if (!wrapped.has(s) || (s.type !== "FunctionDeclaration" && s.type !== "ClassDeclaration")) return s;
      const wrapper: ESTree.ExportNamedDeclaration = { type: "ExportNamedDeclaration", declaration: s, specifiers: [], source: null, attributes: [] };
      const carrier = wrapper as unknown as Record<string, unknown>;
      const original = s as unknown as Record<string, unknown>;
      for (const k of ["start", "end", "loc"]) if (k in original) carrier[k] = original[k];
      return wrapper;
    });
    const converted: ESTree.Program = { ...ast, sourceType: "module", body: finalBody };
    return { code: printProgram(converted, comments), exports: exportNames, complete: true, notes };
  } catch (error: unknown) {
    if (error instanceof Incomplete) {
      return { code: modern.code, exports: [], complete: false, notes: [...notes, error.message] };
    }
    throw error;
  }
}
