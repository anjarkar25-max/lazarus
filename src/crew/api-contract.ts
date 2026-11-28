// Public API Contract Guard: did the resurrection keep every public export?
//
// For every module of a resurrected graph, the original CommonJS module and its stitched ES2022 module are loaded in the sandbox
// (one vm context per probe, relative require() against the in-memory module map only) and described the same way: each export's
// name, form (named or default), kind (function, class or plain value) and parameter arity (`fn.length`). A legacy export is
// preserved when the modern module still exports it under the same name and form, with the same kind (a prototype constructor that
// became a class counts as the same kind) and the same arity. Extra modern exports are additive and never breaking.
import type { ProbeExecutor } from "../sandbox/types.js";
import { withVirtualFiles } from "../sandbox/virtual-fs.js";

export interface ExportDescriptor {
  readonly name: string;
  /** `default` for `module.exports = fn` / `export default`, `named` for every other export. */
  readonly form: "named" | "default";
  readonly kind: "function" | "class" | "value";
  /** Declared parameter count (`fn.length`), or null for a plain value. */
  readonly arity: number | null;
  /** A function with prototype members (an ES5 constructor). Legacy side only; it may become a class. */
  readonly constructorLike?: boolean;
}

export interface ContractBreak {
  readonly export: string;
  readonly reason: string;
}

export interface ModuleContract {
  readonly file: string;
  readonly legacyExports: ExportDescriptor[];
  readonly modernExports: ExportDescriptor[];
  /** Every legacy export of this module is still exported with the same kind and arity. */
  readonly preserved: boolean;
  /** Why not, one entry per broken export (empty when preserved). */
  readonly breaking: ContractBreak[];
}

export interface ApiContract {
  /** Legacy exports that were removed, renamed, changed kind or changed arity. */
  readonly breakingChanges: number;
  /** Legacy exports across every module of the graph. */
  readonly totalExports: number;
  readonly preservedExports: number;
  readonly modules: ModuleContract[];
}

/** A probe program: loads `path` through the virtual require and describes what it exports. Only plain JSON leaves the sandbox. */
export function buildIntrospectionProbe(path: string): string {
  return `(function () {
  function describe(name, form, v) {
    var t = typeof v;
    if (t === "function") {
      var text = "";
      try { text = Function.prototype.toString.call(v); } catch (e) { text = ""; }
      var kind = /^class[\\s{]/.test(text) ? "class" : "function";
      var proto = [];
      try { proto = Object.getOwnPropertyNames(v.prototype || {}).filter(function (k) { return k !== "constructor"; }); } catch (e) { proto = []; }
      return { name: name, form: form, kind: kind, arity: v.length, constructorLike: kind === "function" && proto.length > 0 };
    }
    return { name: name, form: form, kind: "value", arity: null, constructorLike: false };
  }
  var m = require(${JSON.stringify(`./${path}`)});
  var out = [];
  if (typeof m === "function") {
    out.push(describe("default", "default", m));
    Object.keys(m).sort().forEach(function (k) { out.push(describe(k, "named", m[k])); });
  } else if (m !== null && typeof m === "object") {
    Object.keys(m).sort().forEach(function (k) { out.push(k === "default" ? describe("default", "default", m[k]) : describe(k, "named", m[k])); });
  } else {
    out.push({ name: "default", form: "default", kind: "value", arity: null, constructorLike: false });
  }
  return out;
})()`;
}

const isDescriptor = (v: unknown): v is ExportDescriptor => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o["name"] === "string" && (o["form"] === "named" || o["form"] === "default") && (o["kind"] === "function" || o["kind"] === "class" || o["kind"] === "value") && (o["arity"] === null || typeof o["arity"] === "number");
};

/** The exports of one module, or undefined when the sandbox cannot load it (the contract then says nothing rather than guessing). */
export async function describeExports(executor: ProbeExecutor, files: Readonly<Record<string, string>>, path: string): Promise<ExportDescriptor[] | undefined> {
  try {
    const result = await withVirtualFiles(executor, files).run({ code: buildIntrospectionProbe(path) });
    const list = result.output;
    if (!Array.isArray(list) || !list.every(isDescriptor)) return undefined;
    return list.map((d) => ({ name: d.name, form: d.form, kind: d.kind, arity: d.arity, ...(d.constructorLike === true ? { constructorLike: true } : {}) }));
  } catch {
    return undefined;
  }
}

const label = (d: ExportDescriptor): string => `${d.form === "default" ? "default" : d.name}${d.kind === "value" ? "" : `(${d.arity ?? 0})`}`;

/** What broke between the legacy and the modern exports of one module. */
export function compareExports(legacy: readonly ExportDescriptor[], modern: readonly ExportDescriptor[]): ContractBreak[] {
  const breaks: ContractBreak[] = [];
  for (const l of legacy) {
    const m = modern.find((x) => x.form === l.form && x.name === l.name);
    if (m === undefined) {
      breaks.push({ export: label(l), reason: `${l.form === "default" ? "the default export" : `the export "${l.name}"`} was removed or renamed` });
      continue;
    }
    const liftedConstructor = l.kind === "function" && l.constructorLike === true && m.kind === "class";
    if (l.kind !== m.kind && !liftedConstructor) {
      breaks.push({ export: label(l), reason: `its kind changed from ${l.kind} to ${m.kind}` });
      continue;
    }
    if (l.kind !== "value" && l.arity !== m.arity) breaks.push({ export: label(l), reason: `its parameter count changed from ${l.arity ?? 0} to ${m.arity ?? 0}` });
  }
  return breaks;
}

/** The contract of a graph, from the exports described on both sides (pure). */
export function buildApiContract(modules: ReadonlyArray<{ readonly file: string; readonly legacy: ExportDescriptor[]; readonly modern: ExportDescriptor[] }>): ApiContract {
  const out: ModuleContract[] = modules.map((m) => {
    const breaking = compareExports(m.legacy, m.modern);
    return { file: m.file, legacyExports: m.legacy, modernExports: m.modern, preserved: breaking.length === 0, breaking };
  });
  const totalExports = out.reduce((n, m) => n + m.legacyExports.length, 0);
  const breakingChanges = out.reduce((n, m) => n + m.breaking.length, 0);
  return { breakingChanges, totalExports, preservedExports: totalExports - breakingChanges, modules: out };
}

export interface GuardInput {
  /** Original CommonJS files (path -> source). */
  readonly legacyFiles: Readonly<Record<string, string>>;
  /** Linked ES modules the sandbox can require (esm path -> code). */
  readonly modernGraph: Readonly<Record<string, string>>;
  readonly modules: ReadonlyArray<{ readonly path: string; readonly esmPath: string }>;
  readonly executors: { readonly legacy: ProbeExecutor; readonly modern: ProbeExecutor };
}

/** Describes both sides of every module and compares them. Undefined when any module could not be loaded on either side. */
export async function guardApiContract(input: GuardInput): Promise<ApiContract | undefined> {
  const rows: Array<{ file: string; legacy: ExportDescriptor[]; modern: ExportDescriptor[] }> = [];
  for (const m of input.modules) {
    const legacy = await describeExports(input.executors.legacy, input.legacyFiles, m.path);
    const modern = await describeExports(input.executors.modern, input.modernGraph, m.esmPath);
    if (legacy === undefined || modern === undefined) return undefined;
    rows.push({ file: m.path, legacy, modern });
  }
  return buildApiContract(rows);
}
