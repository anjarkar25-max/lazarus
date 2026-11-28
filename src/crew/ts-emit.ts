// Turning verified ES modules into strict TypeScript.
//
// 1. annotateModule: inserts Type Alchemist annotations (parameters, return type, JSDoc) into the exported functions
//    of an ES module, by source position (the code is parsed with acorn, never executed).
// 2. applyBoundaryFixes: driven by real `tsc --strict` diagnostics, declares the members that strict mode cannot type
//    from legacy code (undeclared `this.x` class fields, untyped inner parameters) as explicit `any`, and reports each
//    one. These are the migration boundary of the generated code, never hidden.
import { parse } from "acorn";
import type * as ESTree from "estree";
import { renderJsDoc, renderType, type TypeSignature } from "./type-alchemist.js";
import type { TsDiagnostic } from "./ts-verifier.js";

interface Insertion {
  readonly at: number;
  readonly text: string;
}

const pos = (n: ESTree.Node): { start: number; end: number } => {
  const r = n as unknown as { start: number; end: number };
  return { start: r.start, end: r.end };
};

function applyInsertions(source: string, insertions: Insertion[]): string {
  let out = source;
  for (const ins of [...insertions].sort((a, b) => b.at - a.at)) out = out.slice(0, ins.at) + ins.text + out.slice(ins.at);
  return out;
}

/** Exported function declarations of a module: local function name -> export name. */
function exportedFunctions(program: ESTree.Program): Map<string, { fn: ESTree.FunctionDeclaration; exportedAs: string; statement: ESTree.Node }> {
  const byLocal = new Map<string, ESTree.FunctionDeclaration>();
  const statementOf = new Map<ESTree.FunctionDeclaration, ESTree.Node>();
  for (const s of program.body) {
    if (s.type === "FunctionDeclaration" && s.id) {
      byLocal.set(s.id.name, s);
      statementOf.set(s, s);
    } else if ((s.type === "ExportNamedDeclaration" || s.type === "ExportDefaultDeclaration") && s.declaration?.type === "FunctionDeclaration" && s.declaration.id) {
      const decl = s.declaration as ESTree.FunctionDeclaration;
      byLocal.set(s.declaration.id.name, decl);
      statementOf.set(decl, s);
    }
  }
  const out = new Map<string, { fn: ESTree.FunctionDeclaration; exportedAs: string; statement: ESTree.Node }>();
  const add = (local: string, exportedAs: string): void => {
    const fn = byLocal.get(local);
    if (fn !== undefined) out.set(exportedAs, { fn, exportedAs, statement: statementOf.get(fn) ?? fn });
  };
  for (const s of program.body) {
    if (s.type === "ExportNamedDeclaration") {
      if (s.declaration?.type === "FunctionDeclaration" && s.declaration.id) add(s.declaration.id.name, s.declaration.id.name);
      for (const spec of s.specifiers) {
        if (spec.local.type === "Identifier" && spec.exported.type === "Identifier") add(spec.local.name, spec.exported.name);
      }
    } else if (s.type === "ExportDefaultDeclaration") {
      if (s.declaration.type === "Identifier") add(s.declaration.name, "default");
      else if (s.declaration.type === "FunctionDeclaration" && s.declaration.id) add(s.declaration.id.name, "default");
    }
  }
  return out;
}

export interface AnnotatedModule {
  readonly code: string;
  /** Export names that received annotations. */
  readonly annotated: string[];
}

/**
 * Inserts `: T` after each identifier parameter, `: R` before the body and a JSDoc block above the declaration of every
 * exported function that has a signature. Parameters are matched by position and must have the same names.
 */
export function annotateModule(code: string, signatures: ReadonlyMap<string, TypeSignature>): AnnotatedModule {
  let program: ESTree.Program;
  try {
    program = parse(code, { ecmaVersion: "latest", sourceType: "module", locations: true }) as unknown as ESTree.Program;
  } catch {
    return { code, annotated: [] };
  }
  const insertions: Insertion[] = [];
  const annotated: string[] = [];
  for (const [exportedAs, { fn, statement }] of exportedFunctions(program)) {
    const sig = signatures.get(exportedAs);
    if (sig === undefined || sig.params.length !== fn.params.length) continue;
    const names = fn.params.map((p) => (p.type === "Identifier" ? p.name : p.type === "AssignmentPattern" && p.left.type === "Identifier" ? p.left.name : undefined));
    if (names.some((n, i) => n === undefined || n !== sig.params[i]?.name)) continue;
    fn.params.forEach((p, i) => {
      const param = sig.params[i];
      if (param === undefined) return;
      const target = p.type === "AssignmentPattern" ? p.left : p;
      insertions.push({ at: pos(target).end, text: `: ${renderType(param.type)}` });
    });
    // Right after the parameter list's closing parenthesis: `(a: number): number {`.
    const close = code.lastIndexOf(")", pos(fn.body).start);
    insertions.push({ at: close + 1, text: `: ${renderType(sig.returns)}` });
    const line = code.slice(code.lastIndexOf("\n", pos(statement).start - 1) + 1, pos(statement).start);
    const indent = /^\s*$/.test(line) ? line : "";
    insertions.push({ at: pos(statement).start, text: `${renderJsDoc(sig).split("\n").join(`\n${indent}`)}\n${indent}` });
    annotated.push(exportedAs);
  }
  return { code: applyInsertions(code, insertions), annotated };
}

// ---------------------------------------------------------------------------
// Diagnostic-driven boundary fixes
// ---------------------------------------------------------------------------
export interface BoundaryFixes {
  readonly code: string;
  /** Human-readable list of what was declared `any`, e.g. "Counter.n (class field assigned in legacy code)". */
  readonly adjustments: string[];
  readonly changed: boolean;
}

function offsetOf(text: string, line: number, column: number): number {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return -1;
    offset = next + 1;
  }
  return offset + column - 1;
}

const IMPLICIT_PARAM = /^Parameter '([A-Za-z_$][\w$]*)' implicitly has an 'any' type/;
const IMPLICIT_VARIABLE = /^Variable '([A-Za-z_$][\w$]*)' implicitly has type 'any' in some locations/;
const UNKNOWN_VALUE = /^'([A-Za-z_$][\w$]*)' is of type 'unknown'/;
const IMPLICIT_REST = /^Rest parameter '([A-Za-z_$][\w$]*)' implicitly has an 'any\[\]' type/;
const MISSING_PROPERTY = /^Property '([A-Za-z_$][\w$]*)' does not exist on type '([A-Za-z_$][\w$]*)'/;

/**
 * Declares, as explicit `any`, exactly the members strict mode reports as untypeable in legacy code:
 * TS7006 (inner parameter), TS7019 (rest parameter, e.g. the `...args` that replaced `arguments`), TS7034 (variable) and TS2339
 * on a class's own `this.x` (undeclared field), and TS18046 for a `const x = await ...` of a legacy Promise that strict mode cannot
 * type (a `new Promise(...)` without a type argument resolves to `unknown`).
 * Anything else (a real type conflict) is left alone and stays a reported error.
 */
export function applyBoundaryFixes(code: string, diagnostics: readonly TsDiagnostic[], file: string): BoundaryFixes {
  const insertions: Insertion[] = [];
  const adjustments: string[] = [];
  const fields = new Map<string, Set<string>>();
  for (const d of diagnostics) {
    if (d.file !== file) continue;
    const at = offsetOf(code, d.line, d.column);
    if (at < 0) continue;
    if (d.code === 7006 || d.code === 7034) {
      const m = (d.code === 7006 ? IMPLICIT_PARAM : IMPLICIT_VARIABLE).exec(d.message);
      const name = m?.[1];
      if (name === undefined || code.slice(at, at + name.length) !== name) continue;
      if (insertions.some((i) => i.at === at + name.length)) continue;
      insertions.push({ at: at + name.length, text: ": any" });
      adjustments.push(`${d.code === 7006 ? "parameter" : "variable"} ${name} (line ${d.line}): untyped in the legacy code`);
    } else if (d.code === 18046) {
      const name = UNKNOWN_VALUE.exec(d.message)?.[1];
      if (name === undefined) continue;
      // A statement of its own (never the `// promise-lift:` comment that quotes it).
      const declaration = new RegExp(`^[ \\t]*(?:const|let) (${name})(?= = await\\b)`, "m").exec(code);
      if (declaration === null) continue;
      const end = declaration.index + declaration[0].length;
      if (insertions.some((i) => i.at === end)) continue;
      insertions.push({ at: end, text: ": any" });
      adjustments.push(`variable ${name} (line ${d.line}): awaited value of an untyped legacy Promise`);
    } else if (d.code === 7019) {
      const name = IMPLICIT_REST.exec(d.message)?.[1];
      // The diagnostic starts at the `...`; the element type goes after the name.
      if (name === undefined || code.slice(at, at + 3 + name.length) !== `...${name}`) continue;
      if (insertions.some((i) => i.at === at + 3 + name.length)) continue;
      insertions.push({ at: at + 3 + name.length, text: ": any[]" });
      adjustments.push(`rest parameter ...${name} (line ${d.line}): untyped in the legacy code`);
    } else if (d.code === 2339) {
      const m = MISSING_PROPERTY.exec(d.message);
      const [, prop, cls] = m ?? [];
      // Only `this.prop` inside the class itself: an undeclared field, not a misspelt property of some other value.
      if (prop === undefined || cls === undefined || code.slice(Math.max(0, at - 5), at) !== "this.") continue;
      if (!fields.has(cls)) fields.set(cls, new Set());
      fields.get(cls)?.add(prop);
    }
  }
  for (const [cls, props] of fields) {
    const header = new RegExp(`class\\s+${cls}\\b[^{]*\\{`).exec(code);
    if (header === null) continue;
    const lineStart = code.lastIndexOf("\n", header.index) + 1;
    const indent = /^\s*/.exec(code.slice(lineStart))?.[0] ?? "";
    const names = [...props].sort();
    insertions.push({ at: header.index + header[0].length, text: names.map((p) => `\n${indent}  ${p}: any;`).join("") });
    for (const p of names) adjustments.push(`${cls}.${p}: class field assigned in legacy code`);
  }
  return { code: applyInsertions(code, insertions), adjustments, changed: insertions.length > 0 };
}
