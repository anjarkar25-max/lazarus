// Multi-file CommonJS dependency graph resurrection.
//
// 1. analyzeGraph: acorn parses every file (never runs it) and extracts relative require() edges, cycles and a
//    deterministic topological order (leaves first, entry last).
// 2. resurrectGraph: each file, leaves first, goes through the AST modernizer and the Exorcist. Every exported
//    function is fuzzed (exact Object.is) with the legacy file and the candidate side by side, both running in the
//    sandbox against the in-memory module map. Divergences roll back the culprit AST rule (self-healing).
//    The final levels feed the CommonJS -> ESM conversion, which rewrites relative require() into imports.
// 3. Whole-graph parity: the original CommonJS graph and the stitched ESM graph are both loaded in the sandbox
//    (the ESM graph through a 1:1 import/export linker) and every export of the entry module is fuzzed end to end.
import { DifferentialFuzzer } from "../fuzzer/differential.js";
import type { CounterexampleReport, FuzzReport, InputSchema, ParamKind } from "../fuzzer/types.js";
import { scanLegacyAst } from "../sandbox/ast-scanner.js";
import { PooledProbeRunner } from "../sandbox/pool.js";
import type { ProbeExecutor } from "../sandbox/types.js";
import { resolveRelative, withVirtualFiles } from "../sandbox/virtual-fs.js";
import type * as ESTree from "estree";
import {
  RISK_ORDER,
  defaultLevels,
  encodeLevels,
  isRuleOff,
  modernize,
  parseProgram,
  printProgram,
  stepDown,
  allOff,
  type RuleId,
  type RuleLevels,
} from "./ast-modernizer.js";
import { analyze, walk } from "./ast-scope.js";
import { toEsmModule } from "./esm-export.js";

// ---------------------------------------------------------------------------
// Graph analysis
// ---------------------------------------------------------------------------
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly specifier: string;
}

export interface GraphProblem {
  readonly file: string;
  readonly kind: "parse-error" | "external-require" | "dynamic-require" | "missing-module" | "path-collision" | "no-entry" | "cycle";
  readonly message: string;
}

export interface ModuleGraph {
  readonly files: string[];
  readonly edges: GraphEdge[];
  /** Strongly connected components with more than one file (or a file requiring itself). */
  readonly cycles: string[][];
  /** Dependencies before dependents; the entry module is last. */
  readonly order: string[];
  readonly entry: string | undefined;
  /** Longest dependency chain below each file (leaves are 0); used to lay the graph out. */
  readonly depth: Record<string, number>;
  readonly esmPaths: Record<string, string>;
  readonly problems: GraphProblem[];
}

const JS_FILE = /\.(c?js)$/i;

/** `lib/money.cjs` -> `lib/money.js`. */
export function esmPathFor(path: string): string {
  return path.replace(JS_FILE, ".js");
}

export function analyzeGraph(files: Readonly<Record<string, string>>, entryHint?: string): ModuleGraph {
  const names = Object.keys(files).filter((f) => JS_FILE.test(f)).sort();
  const known = new Set(names);
  const edges: GraphEdge[] = [];
  const problems: GraphProblem[] = [];
  const deps = new Map<string, string[]>();
  for (const file of names) {
    const parsed = parseProgram(files[file] ?? "");
    deps.set(file, []);
    if ("error" in parsed) {
      problems.push({ file, kind: "parse-error", message: `${file} could not be parsed: ${parsed.error}` });
      continue;
    }
    const a = analyze(parsed.ast);
    walk(parsed.ast, (n) => {
      if (n.type !== "CallExpression" || n.callee.type !== "Identifier" || n.callee.name !== "require" || a.refByNode.get(n.callee)?.binding !== null) return undefined;
      const arg = n.arguments[0];
      if (arg === undefined || arg.type !== "Literal" || typeof arg.value !== "string") {
        problems.push({ file, kind: "dynamic-require", message: `${file} calls require() with a non-literal specifier, so its dependencies cannot be resolved statically` });
        return undefined;
      }
      const spec = arg.value;
      if (!(spec.startsWith("./") || spec.startsWith("../"))) {
        problems.push({ file, kind: "external-require", message: `${file} requires "${spec}", which is not part of this project; host modules and packages cannot run in the sandbox` });
        return undefined;
      }
      const resolved = resolveRelative(known, file, spec);
      if (!resolved.ok) {
        problems.push({ file, kind: "missing-module", message: resolved.reason });
        return undefined;
      }
      if (!edges.some((e) => e.from === file && e.to === resolved.path)) {
        edges.push({ from: file, to: resolved.path, specifier: spec });
        deps.get(file)?.push(resolved.path);
      }
      return undefined;
    });
  }
  for (const list of deps.values()) list.sort();

  const esmPaths: Record<string, string> = {};
  const byEsm = new Map<string, string>();
  for (const file of names) {
    const target = esmPathFor(file);
    const clash = byEsm.get(target);
    if (clash !== undefined) problems.push({ file, kind: "path-collision", message: `${clash} and ${file} would both become ${target}` });
    byEsm.set(target, file);
    esmPaths[file] = target;
  }

  // Tarjan's SCC for cycle detection.
  const cycles: string[][] = [];
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const strong = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of deps.get(v) ?? []) {
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      const selfLoop = component.length === 1 && (deps.get(v) ?? []).includes(v);
      if (component.length > 1 || selfLoop) cycles.push(component.sort());
    }
  };
  for (const file of names) if (!index.has(file)) strong(file);
  cycles.sort((x, y) => (x[0] ?? "").localeCompare(y[0] ?? ""));
  for (const cycle of cycles) {
    problems.push({ file: cycle[0] ?? "", kind: "cycle", message: `circular require chain: ${[...cycle, cycle[0]].join(" -> ")}` });
  }

  // Entry: the requested one, otherwise the single file nobody requires (preferring index/main, then the widest).
  const required = new Set(edges.map((e) => e.to));
  const roots = names.filter((f) => !required.has(f));
  const reach = (start: string): number => {
    const seen = new Set<string>();
    const visit = (f: string): void => {
      if (seen.has(f)) return;
      seen.add(f);
      for (const d of deps.get(f) ?? []) visit(d);
    };
    visit(start);
    return seen.size;
  };
  let entry: string | undefined;
  if (entryHint !== undefined) {
    if (known.has(entryHint)) entry = entryHint;
    else problems.push({ file: entryHint, kind: "no-entry", message: `entry ${entryHint} is not one of the project's .js/.cjs files` });
  } else {
    const preferred = roots.find((f) => /(^|\/)(index|main)\.c?js$/i.test(f));
    entry = preferred ?? [...roots].sort((x, y) => reach(y) - reach(x) || x.localeCompare(y))[0];
    if (entry === undefined && names.length > 0) problems.push({ file: names[0] ?? "", kind: "no-entry", message: "every file is required by another one, so there is no entry module" });
  }

  // Deterministic post-order DFS: dependencies first, entry last.
  const order: string[] = [];
  const done = new Set<string>();
  const active = new Set<string>();
  const visit = (f: string): void => {
    if (done.has(f) || active.has(f)) return;
    active.add(f);
    for (const d of deps.get(f) ?? []) visit(d);
    active.delete(f);
    done.add(f);
    order.push(f);
  };
  for (const f of names) if (f !== entry) visit(f);
  if (entry !== undefined) {
    const at = order.indexOf(entry);
    if (at >= 0) order.splice(at, 1);
    visit(entry);
    if (!order.includes(entry)) order.push(entry);
  }

  const depth: Record<string, number> = {};
  for (const f of order) depth[f] = Math.max(-1, ...(deps.get(f) ?? []).filter((d) => d !== f).map((d) => depth[d] ?? 0)) + 1;

  return { files: names, edges, cycles, order, entry, depth, esmPaths, problems };
}

// ---------------------------------------------------------------------------
// ESM -> sandbox linker (1:1 mapping of import/export declarations onto the virtual require)
// ---------------------------------------------------------------------------
type Body = ESTree.Program["body"][number];
const id = (name: string): ESTree.Identifier => ({ type: "Identifier", name });
const requireCall = (source: string): ESTree.CallExpression => ({ type: "CallExpression", callee: id("require"), arguments: [{ type: "Literal", value: source }], optional: false });
const exportAssign = (name: string, value: ESTree.Expression): ESTree.ExpressionStatement => ({
  type: "ExpressionStatement",
  expression: { type: "AssignmentExpression", operator: "=", left: { type: "MemberExpression", object: id("exports"), property: id(name), computed: false, optional: false }, right: value },
});

const NAMESPACE_HELPER = "__lzNamespace";
/**
 * Module namespace objects are null-prototype, non-extensible and read-only, tagged "Module". Strict-mode writes to
 * them throw, so the linked graph must not hand out the mutable CommonJS exports object instead.
 */
function namespaceHelper(): Body[] {
  const parsed = parseProgram(
    `function ${NAMESPACE_HELPER}(e) { var ns = Object.create(null); Object.keys(e).sort().forEach(function (k) { ns[k] = e[k]; }); Object.defineProperty(ns, Symbol.toStringTag, { value: "Module" }); return Object.freeze(ns); }`
  );
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.ast.body;
}

/**
 * Turns an ES module into code the sandbox's virtual CommonJS loader can evaluate: imports become requires of the
 * linked module, exports become assignments made once the module body has run, and the module is strict like ESM.
 */
export function linkEsmForSandbox(code: string): string {
  const parsed = parseProgram(code);
  if ("error" in parsed) throw new Error(`stitched module does not parse: ${parsed.error}`);
  const body: Body[] = [];
  const tail: ESTree.Statement[] = [];
  for (const statement of parsed.ast.body) {
    if (statement.type === "ImportDeclaration") {
      const source = String(statement.source.value);
      for (const spec of statement.specifiers) {
        const init: ESTree.Expression =
          spec.type === "ImportDefaultSpecifier"
            ? { type: "MemberExpression", object: requireCall(source), property: id("default"), computed: false, optional: false }
            : spec.type === "ImportNamespaceSpecifier"
              ? { type: "CallExpression", callee: id(NAMESPACE_HELPER), arguments: [requireCall(source)], optional: false }
              : { type: "MemberExpression", object: requireCall(source), property: id(spec.imported.type === "Identifier" ? spec.imported.name : String(spec.imported.value)), computed: false, optional: false };
        body.push({ type: "VariableDeclaration", kind: "const", declarations: [{ type: "VariableDeclarator", id: id(spec.local.name), init }] });
      }
      if (statement.specifiers.length === 0) body.push({ type: "ExpressionStatement", expression: requireCall(source) });
      continue;
    }
    if (statement.type === "ExportNamedDeclaration") {
      if (statement.source !== null && statement.source !== undefined) throw new Error("re-exports are not produced by the converter");
      const decl = statement.declaration;
      if (decl !== null && decl !== undefined) {
        body.push(decl);
        if (decl.type === "VariableDeclaration") {
          for (const d of decl.declarations) if (d.id.type === "Identifier") tail.push(exportAssign(d.id.name, id(d.id.name)));
        } else if (decl.id !== null && decl.id !== undefined) {
          tail.push(exportAssign(decl.id.name, id(decl.id.name)));
        }
      }
      for (const spec of statement.specifiers) {
        const local = spec.local.type === "Identifier" ? spec.local.name : String(spec.local.value);
        const exported = spec.exported.type === "Identifier" ? spec.exported.name : String(spec.exported.value);
        tail.push(exportAssign(exported, id(local)));
      }
      continue;
    }
    if (statement.type === "ExportDefaultDeclaration") {
      const decl = statement.declaration;
      if ((decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") && decl.id !== null && decl.id !== undefined) {
        body.push(decl as ESTree.FunctionDeclaration | ESTree.ClassDeclaration);
        tail.push(exportAssign("default", id(decl.id.name)));
      } else {
        const value: ESTree.Expression =
          decl.type === "FunctionDeclaration"
            ? { ...decl, type: "FunctionExpression" }
            : decl.type === "ClassDeclaration"
              ? { ...decl, type: "ClassExpression" }
              : (decl as ESTree.Expression);
        body.push({ type: "VariableDeclaration", kind: "const", declarations: [{ type: "VariableDeclarator", id: id("__lz_default"), init: value }] });
        tail.push(exportAssign("default", id("__lz_default")));
      }
      continue;
    }
    body.push(statement);
  }
  const strict: ESTree.Directive = { type: "ExpressionStatement", expression: { type: "Literal", value: "use strict", raw: '"use strict"' }, directive: "use strict" };
  const usesNamespace = parsed.ast.body.some((s) => s.type === "ImportDeclaration" && s.specifiers.some((x) => x.type === "ImportNamespaceSpecifier"));
  const helper = usesNamespace ? namespaceHelper() : [];
  return printProgram({ type: "Program", sourceType: "script", body: [strict, ...helper, ...body, ...tail] }, []);
}

// ---------------------------------------------------------------------------
// Resurrection
// ---------------------------------------------------------------------------
export type NodeState = "dead" | "probing" | "healing" | "resurrected" | "failed";

export type GraphProgress =
  | { readonly kind: "graph"; readonly graph: ModuleGraph }
  | { readonly kind: "node"; readonly file: string; readonly state: NodeState; readonly detail: string }
  | { readonly kind: "log"; readonly message: string };

export interface ExportProbe {
  readonly name: string;
  /** "default" for `module.exports = function`. */
  readonly exportedAs: string;
  readonly schema: InputSchema;
}

export interface FileResult {
  readonly path: string;
  readonly esmPath: string;
  readonly legacyCode: string;
  /** Modernized CommonJS that passed the per-file Exorcist. */
  readonly modernCjs: string;
  readonly esmCode: string;
  readonly esmExports: string[];
  readonly levels: RuleLevels;
  readonly rulesApplied: RuleId[];
  readonly rolledBack: RuleId[];
  readonly attempts: number;
  readonly healed: boolean;
  readonly probes: ExportProbe[];
  readonly fuzzRuns: number;
  readonly success: boolean;
  readonly notes: string[];
}

export interface GraphParity {
  readonly passed: boolean;
  readonly exact: boolean;
  readonly totalRuns: number;
  readonly functions: Array<{ readonly name: string; readonly exportedAs: string; readonly schema: InputSchema; readonly passed: boolean; readonly totalRuns: number; readonly counterexample?: CounterexampleReport }>;
}

export interface GraphResurrectionResult {
  readonly success: boolean;
  readonly name: string;
  readonly graph: ModuleGraph;
  readonly files: FileResult[];
  readonly parity: GraphParity | undefined;
  readonly error?: string;
  readonly durationMs: number;
}

export interface GraphOptions {
  readonly name: string;
  readonly entry?: string;
  /** Schemas for the entry module's exports, keyed by export name ("default" for module.exports = fn). */
  readonly schemas?: Record<string, InputSchema>;
  /** Fuzz runs per exported function, per file. */
  readonly fileRuns?: number;
  /** Fuzz runs per entry export for the whole-graph check. */
  readonly graphRuns?: number;
  readonly seed?: number;
  readonly maxAttempts?: number;
  readonly onProgress?: (event: GraphProgress) => void;
  /** Executors to use; by default two warm pools are created and disposed. */
  readonly executors?: { readonly legacy: ProbeExecutor; readonly modern: ProbeExecutor };
}

const callFor = (path: string, probe: ExportProbe): string => {
  const args = Object.keys(probe.schema).join(", ");
  const target = `require(${JSON.stringify(`./${path}`)})`;
  return probe.exportedAs === "default" ? `${target}(${args})` : `${target}[${JSON.stringify(probe.exportedAs)}](${args})`;
};

/** Exported functions of one file, with schemas (overrides win, then inference). */
function probesOf(source: string, overrides?: Record<string, InputSchema>): ExportProbe[] {
  const scan = scanLegacyAst(source);
  const seen = new Set<string>();
  const result: ExportProbe[] = [];
  for (const fn of scan.functions) {
    if (!fn.isExported || fn.usesThis) continue;
    const exportedAs = fn.exportedAs ?? fn.name;
    if (seen.has(exportedAs)) continue;
    seen.add(exportedAs);
    const schema = overrides?.[exportedAs] ?? overrides?.[fn.name] ?? (fn.paramKinds as Record<string, ParamKind>);
    result.push({ name: fn.name, exportedAs, schema });
  }
  return result;
}

async function fuzzAll(
  fuzzer: DifferentialFuzzer,
  probes: readonly ExportProbe[],
  legacyCall: (p: ExportProbe) => string,
  modernCall: (p: ExportProbe) => string,
  runs: number,
  seed: number | undefined
): Promise<{ reports: Array<{ probe: ExportProbe; report: FuzzReport }>; failing?: { probe: ExportProbe; report: FuzzReport } }> {
  const reports: Array<{ probe: ExportProbe; report: FuzzReport }> = [];
  for (const probe of probes) {
    const report = await fuzzer.fuzz(legacyCall(probe), modernCall(probe), probe.schema, { numRuns: runs, exact: true, ...(seed !== undefined ? { seed } : {}) });
    reports.push({ probe, report });
    if (!report.passed) return { reports, failing: { probe, report } };
  }
  return { reports };
}

export async function resurrectGraph(files: Readonly<Record<string, string>>, options: GraphOptions): Promise<GraphResurrectionResult> {
  if (options.executors !== undefined) return resurrectWith(files, options, options.executors);
  await using legacy = new PooledProbeRunner();
  await using modern = new PooledProbeRunner();
  return await resurrectWith(files, options, { legacy, modern });
}

async function resurrectWith(
  files: Readonly<Record<string, string>>,
  options: GraphOptions,
  executors: { readonly legacy: ProbeExecutor; readonly modern: ProbeExecutor }
): Promise<GraphResurrectionResult> {
  const started = Date.now();
  const emit = (event: GraphProgress): void => options.onProgress?.(event);
  const graph = analyzeGraph(files, options.entry);
  emit({ kind: "graph", graph });
  const fail = (error: string, done: FileResult[] = [], parity?: GraphParity): GraphResurrectionResult => ({
    success: false,
    name: options.name,
    graph,
    files: done,
    parity,
    error,
    durationMs: Date.now() - started,
  });
  if (graph.files.length === 0) return fail("no .js or .cjs files were found");
  if (graph.problems.length > 0) {
    return fail(`the project cannot be resurrected as a graph: ${graph.problems.map((p) => p.message).join("; ")}`);
  }
  const fileRuns = options.fileRuns ?? 60;
  const graphRuns = options.graphRuns ?? 100;
  const maxAttempts = options.maxAttempts ?? 4;
  const legacyFiles: Record<string, string> = {};
  for (const f of graph.files) legacyFiles[f] = files[f] ?? "";
  const results: FileResult[] = [];
  const esmByFile = new Map<string, { code: string; exports: string[] }>();
  /** CommonJS -> ESM for one file, with its relative requires stitched to the dependencies' ES modules. */
  const esmFor = (file: string, levels: RuleLevels): ReturnType<typeof toEsmModule> =>
    toEsmModule(legacyFiles[file] ?? "", {
      levels,
      resolveRequire: (spec) => {
        const resolved = resolveRelative(new Set(graph.files), file, spec);
        if (!resolved.ok) return undefined;
        const target = esmByFile.get(resolved.path);
        if (target === undefined) return undefined;
        const fromDir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
        return { source: relativeSpecifier(fromDir, graph.esmPaths[resolved.path] ?? resolved.path), exports: target.exports };
      },
    });

  for (const file of graph.order) {
    const source = legacyFiles[file] ?? "";
    emit({ kind: "node", file, state: "probing", detail: `Exorcist fuzzing the exports of ${file}` });
    const probes = probesOf(source, file === graph.entry ? options.schemas : undefined);
    let levels = defaultLevels();
    let attempts = 0;
    let healed = false;
    let fuzzRuns = 0;
    const notes: string[] = [];
    const rolledBack: RuleId[] = [];
    let passed = false;
    let candidate = modernize(source, { levels });
    const legacyExec = withVirtualFiles(executors.legacy, legacyFiles);
    while (attempts < maxAttempts) {
      attempts++;
      candidate = modernize(source, { levels });
      if (!candidate.parsed) break;
      const modernFiles = { ...legacyFiles, [file]: candidate.code };
      const modernExec = withVirtualFiles(executors.modern, modernFiles);
      const fuzzer = new DifferentialFuzzer({ legacy: legacyExec, modern: modernExec });
      const call = (p: ExportProbe): string => callFor(file, p);
      const outcome = await fuzzAll(fuzzer, probes, call, call, fileRuns, options.seed);
      fuzzRuns += outcome.reports.reduce((sum, r) => sum + r.report.totalRuns, 0);
      if (outcome.failing === undefined) {
        passed = true;
        break;
      }
      const cx = outcome.failing.report.counterexample;
      emit({ kind: "node", file, state: "healing", detail: `${outcome.failing.probe.exportedAs}: ${cx?.reason ?? "divergence"}; rolling back the culprit AST rule` });
      // Blame: the first applied, still-active rule whose rollback alone restores parity on the counterexample.
      const applied = new Set(candidate.applied.map((a) => a.rule));
      const active = RISK_ORDER.filter((rule) => !isRuleOff(rule, levels) && applied.has(rule));
      let culprit: RuleId | undefined;
      if (cx !== undefined) {
        for (const rule of active) {
          const trial = modernize(source, { levels: stepDown(levels, rule) });
          const trialExec = withVirtualFiles(executors.modern, { ...legacyFiles, [file]: trial.code });
          // Replay the exact (tagged) counterexample against the candidate with only this rule rolled back.

          const [l, m] = await Promise.all([
            legacyExec.run({ code: call(outcome.failing.probe), context: cx.inputs, encoding: "tagged" }).then((r) => ({ ok: true, v: JSON.stringify(r.output) }), () => ({ ok: false, v: "" })),
            trialExec.run({ code: call(outcome.failing.probe), context: cx.inputs, encoding: "tagged" }).then((r) => ({ ok: true, v: JSON.stringify(r.output) }), () => ({ ok: false, v: "" })),
          ]);
          if (l.ok === m.ok && l.v === m.v) {
            culprit = rule;
            break;
          }
        }
      }
      const blame = culprit ?? active[0];
      if (blame === undefined) {
        notes.push("divergence remains with every AST rule rolled back");
        break;
      }
      levels = stepDown(levels, blame);
      rolledBack.push(blame);
      healed = true;
      emit({ kind: "log", message: `${file}: rolled back ${blame} (${culprit !== undefined ? "confirmed on the counterexample" : "riskiest applied rule"})` });
    }
    if (!passed && candidate.parsed) {
      // Last resort: verbatim legacy semantics.
      levels = allOff();
      candidate = modernize(source, { levels });
      const fuzzer = new DifferentialFuzzer({ legacy: legacyExec, modern: withVirtualFiles(executors.modern, { ...legacyFiles, [file]: candidate.code }) });
      const call = (p: ExportProbe): string => callFor(file, p);
      const outcome = await fuzzAll(fuzzer, probes, call, call, fileRuns, options.seed);
      fuzzRuns += outcome.reports.reduce((sum, r) => sum + r.report.totalRuns, 0);
      passed = outcome.failing === undefined;
      if (passed) notes.push("kept every AST rule off (verbatim legacy semantics)");
    }
    // ESM conversion with stitched imports of already-resurrected dependencies.
    const esm = esmFor(file, levels);
    if (!esm.complete) notes.push(...esm.notes);
    const success = passed && candidate.parsed && esm.complete;
    const result: FileResult = {
      path: file,
      esmPath: graph.esmPaths[file] ?? esmPathFor(file),
      legacyCode: source,
      modernCjs: candidate.code,
      esmCode: esm.complete ? `// ast-rules: ${encodeLevels(levels)}\n${esm.code}` : "",
      esmExports: esm.exports,
      levels,
      rulesApplied: [...new Set(candidate.applied.map((a) => a.rule))],
      rolledBack,
      attempts,
      healed,
      probes,
      fuzzRuns,
      success,
      notes,
    };
    results.push(result);
    if (!success) {
      emit({ kind: "node", file, state: "failed", detail: notes.join("; ") || "parity could not be proven" });
      return fail(`${file} could not be resurrected: ${notes.join("; ") || "parity could not be proven"}`, results);
    }
    esmByFile.set(file, { code: esm.code, exports: esm.exports });
    emit({ kind: "node", file, state: "resurrected", detail: `${probes.length} export(s), ${fuzzRuns} runs, ${attempts} attempt(s)${healed ? `, rolled back ${rolledBack.join(", ")}` : ""}` });
  }

  // Whole-graph parity: original CommonJS graph vs stitched ESM graph, end to end through the entry module.
  const entry = graph.entry ?? graph.order.at(-1) ?? "";
  const esmEntry = graph.esmPaths[entry] ?? entry;
  emit({ kind: "log", message: `Whole-graph Exorcist: ${entry} (CommonJS graph) vs ${esmEntry} (stitched ESM graph)` });
  const entryProbes = results.find((r) => r.path === entry)?.probes ?? [];
  if (entryProbes.length === 0) return fail(`${entry} exports no function to check end to end`, results);
  const legacyGraphExec = withVirtualFiles(executors.legacy, legacyFiles);
  const linkGraph = (override?: { file: string; code: string }): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const r of results) {
      const code = override !== undefined && override.file === r.path ? override.code : (esmByFile.get(r.path)?.code ?? "");
      out[r.esmPath] = linkEsmForSandbox(code);
    }
    return out;
  };
  const modernCall = (probe: ExportProbe): string =>
    probe.exportedAs === "default" ? `require(${JSON.stringify(`./${esmEntry}`)}).default(${Object.keys(probe.schema).join(", ")})` : callFor(esmEntry, probe);
  const checkGraph = async (modernGraph: Record<string, string>, runs: number, seed: number | undefined): Promise<GraphParity> => {
    const fuzzer = new DifferentialFuzzer({ legacy: legacyGraphExec, modern: withVirtualFiles(executors.modern, modernGraph) });
    const functions: GraphParity["functions"] = [];
    let total = 0;
    for (const probe of entryProbes) {
      const report = await fuzzer.fuzz(callFor(entry, probe), modernCall(probe), probe.schema, { numRuns: runs, exact: true, ...(seed !== undefined ? { seed } : {}) });
      total += report.totalRuns;
      functions.push({ name: probe.name, exportedAs: probe.exportedAs, schema: probe.schema, passed: report.passed, totalRuns: report.totalRuns, ...(report.counterexample !== undefined ? { counterexample: report.counterexample } : {}) });
      if (!report.passed) break;
    }
    return { passed: functions.every((f) => f.passed), exact: true, totalRuns: total, functions };
  };
  /** Exact (tagged) replay of one entry export on a whole-graph counterexample. */
  const replays = async (modernGraph: Record<string, string>, probe: ExportProbe, inputs: Record<string, unknown>): Promise<boolean> => {
    const run = (exec: ProbeExecutor, code: string): Promise<string> =>
      exec.run({ code, context: inputs, encoding: "tagged" }).then(
        (r) => `ok:${JSON.stringify(r.output)}`,
        () => "threw"
      );
    const [l, m] = await Promise.all([run(legacyGraphExec, callFor(entry, probe)), run(withVirtualFiles(executors.modern, modernGraph), modernCall(probe))]);
    return l === m;
  };

  let modernGraph: Record<string, string>;
  try {
    modernGraph = linkGraph();
  } catch (err: unknown) {
    return fail(`the stitched ESM graph could not be linked: ${err instanceof Error ? err.message : String(err)}`, results);
  }
  let parity = await checkGraph(modernGraph, graphRuns, options.seed);
  let graphRounds = 0;
  // Graph-level self-healing: a whole-graph counterexample the per-file checks missed is pinned on one file's AST rule.
  while (!parity.passed && graphRounds < maxAttempts) {
    graphRounds++;
    const bad = parity.functions.find((f) => !f.passed);
    const probe = entryProbes.find((p) => p.exportedAs === bad?.exportedAs);
    const cx = bad?.counterexample;
    if (probe === undefined || cx === undefined) break;
    emit({ kind: "log", message: `Whole-graph counterexample for ${probe.exportedAs}: ${cx.reason}; searching for the culprit rule across ${results.length} files` });
    let fixed: { index: number; rule: RuleId; levels: RuleLevels; code: string; exports: string[] } | undefined;
    search: for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r === undefined) continue;
      for (const rule of RISK_ORDER) {
        if (isRuleOff(rule, r.levels) || !r.rulesApplied.includes(rule)) continue;
        const levels = stepDown(r.levels, rule);
        const esm = esmFor(r.path, levels);
        if (!esm.complete) continue;
        let trialGraph: Record<string, string>;
        try {
          trialGraph = linkGraph({ file: r.path, code: esm.code });
        } catch {
          continue;
        }
        if (await replays(trialGraph, probe, cx.inputs)) {
          fixed = { index: i, rule, levels, code: esm.code, exports: esm.exports };
          break search;
        }
      }
    }
    if (fixed === undefined) break;
    const before = results[fixed.index];
    if (before === undefined) break;
    emit({ kind: "node", file: before.path, state: "healing", detail: `whole-graph counterexample pinned on ${fixed.rule}; rolling it back` });
    const updated: FileResult = {
      ...before,
      levels: fixed.levels,
      modernCjs: modernize(before.legacyCode, { levels: fixed.levels }).code,
      esmCode: `// ast-rules: ${encodeLevels(fixed.levels)}\n${fixed.code}`,
      rolledBack: [...before.rolledBack, fixed.rule],
      healed: true,
      attempts: before.attempts + 1,
      notes: [...before.notes, `rolled back ${fixed.rule} after a whole-graph counterexample (${cx.reason})`],
    };
    results[fixed.index] = updated;
    esmByFile.set(before.path, { code: fixed.code, exports: fixed.exports });
    emit({ kind: "node", file: before.path, state: "resurrected", detail: `rolled back ${fixed.rule} (whole-graph counterexample)` });
    modernGraph = linkGraph();
    parity = await checkGraph(modernGraph, graphRuns, options.seed);
  }
  if (!parity.passed) {
    const bad = parity.functions.find((f) => !f.passed);
    return fail(`whole-graph parity failed for ${bad?.exportedAs ?? "an export"}: ${bad?.counterexample?.reason ?? "divergence"}`, results, parity);
  }
  emit({ kind: "log", message: `Whole-graph parity proven: ${parity.totalRuns} exact Object.is runs across ${parity.functions.length} entry export(s)${graphRounds > 0 ? ` after ${graphRounds} graph-level rollback(s)` : ""}` });
  return { success: true, name: options.name, graph, files: results, parity, durationMs: Date.now() - started };
}

/** Relative import specifier from a directory to a file, always starting with "./" or "../". */
export function relativeSpecifier(fromDir: string, toPath: string): string {
  const from = fromDir === "" ? [] : fromDir.split("/");
  const to = toPath.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  const ups = from.length - common;
  const rest = to.slice(common).join("/");
  return ups === 0 ? `./${rest}` : `${"../".repeat(ups)}${rest}`;
}