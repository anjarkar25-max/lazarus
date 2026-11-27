// `lazarus audit <dir>`: a deterministic Legacy Risk Report for a folder of ES5 / CommonJS files.
//   npm run audit -- ./examples/legacy-invoice-engine [--json]
// Files are parsed with acorn and never executed. The report flags the patterns that make a naive modernization
// unsafe and recommends the exact `lazarus resurrect` command to run next.
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { parse, type Options } from "acorn";
import type * as ESTree from "estree";
import { walk } from "./crew/ast-scope.js";
import { analyzeGraph } from "./crew/graph-resurrector.js";
import { detectErrorFirst, liftErrorFirst } from "./crew/async-callback.js";
import { resolveRelative } from "./sandbox/virtual-fs.js";

export const MAX_AUDIT_FILES = 500;
export const MAX_AUDIT_FILE_BYTES = 256 * 1024;
export const IGNORED_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", "dist"]);

export type Severity = "high" | "medium" | "info";
export type FindingKind = "bitwise-truncation" | "prototype-chain" | "var-hoisting" | "arguments-usage" | "error-first-callback" | "require-graph" | "external-require" | "parse-error";

export interface Finding {
  readonly kind: FindingKind;
  readonly severity: Severity;
  readonly line: number;
  readonly message: string;
}

export interface FileReport {
  /** Path relative to the audited directory, with "/" separators. */
  readonly file: string;
  readonly bytes: number;
  readonly findings: Finding[];
  readonly counts: Record<Severity, number>;
  readonly fanIn: number;
  readonly fanOut: number;
  /** 100 = nothing risky; see SCORE_WEIGHTS. */
  readonly readiness: number;
}

export interface AuditReport {
  readonly directory: string;
  readonly files: FileReport[];
  readonly skipped: Array<{ readonly file: string; readonly reason: string }>;
  readonly totals: Record<Severity, number> & { readonly files: number };
  readonly graph: { readonly entry: string | null; readonly edges: Array<{ readonly from: string; readonly to: string }>; readonly cycles: string[][] };
  /** Line of the `require()` behind each resolved edge, keyed `from->to` (used to place SARIF results). */
  readonly requireLines: Record<string, number>;
  readonly readiness: number;
  readonly grade: "A" | "B" | "C" | "D";
  readonly recommendedCommand: string;
  readonly notes: string[];
}

export const SCORE_WEIGHTS: Record<Severity, number> = { high: 12, medium: 5, info: 1 };

const gradeFor = (score: number): AuditReport["grade"] => (score >= 85 ? "A" : score >= 70 ? "B" : score >= 50 ? "C" : "D");
const lineOf = (n: ESTree.Node): number => (n as { loc?: { start: { line: number } } | null }).loc?.start.line ?? 0;
const posix = (p: string): string => p.split(nodePath.sep).join("/");

/** .js / .cjs files under `root`, sorted; symlinks and ignored folders are skipped. */
function listSources(root: string, skipped: Array<{ file: string; reason: string }>): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped.push({ file: posix(nodePath.relative(root, dir)) || ".", reason: "folder could not be read" });
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = nodePath.join(dir, e.name);
      const rel = posix(nodePath.relative(root, full));
      if (e.isSymbolicLink()) {
        skipped.push({ file: rel, reason: "symbolic link (not followed)" });
      } else if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) visit(full);
      } else if (e.isFile() && /\.c?js$/i.test(e.name)) {
        if (out.length >= MAX_AUDIT_FILES) {
          skipped.push({ file: rel, reason: `more than ${MAX_AUDIT_FILES} files` });
          continue;
        }
        out.push(rel);
      }
    }
  };
  visit(root);
  return out.sort();
}

function parseFile(source: string): ESTree.Program | { error: string } {
  const base: Options = { ecmaVersion: "latest", locations: true, allowHashBang: true, allowReturnOutsideFunction: true };
  try {
    return parse(source, { ...base, sourceType: "script" }) as unknown as ESTree.Program;
  } catch (scriptErr: unknown) {
    try {
      return parse(source, { ...base, sourceType: "module" }) as unknown as ESTree.Program;
    } catch {
      return { error: scriptErr instanceof Error ? scriptErr.message : String(scriptErr) };
    }
  }
}

interface Scan {
  readonly findings: Finding[];
  readonly requires: Array<{ readonly specifier: string; readonly line: number }>;
}

function scanProgram(ast: ESTree.Program): Scan {
  const findings: Finding[] = [];
  const requires: Array<{ specifier: string; line: number }> = [];
  const functions = new Set<string>();
  walk(ast, (n) => {
    if (n.type === "FunctionDeclaration" && n.id) functions.add(n.id.name);
    if (n.type === "VariableDeclarator" && n.id.type === "Identifier" && n.init && n.init.type === "FunctionExpression") functions.add(n.id.name);
    return undefined;
  });
  const protoOwners = new Map<string, { line: number; members: number }>();
  let varCount = 0;
  let firstVarLine = 0;
  walk(ast, (n) => {
    if (n.type === "BinaryExpression") {
      const zeroRight = n.right.type === "Literal" && typeof n.right.value === "number";
      if (n.operator === "|" && n.right.type === "Literal" && n.right.value === 0) {
        findings.push({ kind: "bitwise-truncation", severity: "high", line: lineOf(n), message: "`x | 0` truncates to int32: -0, NaN and Infinity become 0 and values wrap modulo 2^32 (Math.floor / Math.trunc are not equivalent)" });
      } else if ((n.operator === ">>" || n.operator === ">>>" || n.operator === "<<") && zeroRight) {
        findings.push({ kind: "bitwise-truncation", severity: "high", line: lineOf(n), message: `\`x ${n.operator} n\` converts to ${n.operator === ">>>" ? "uint32" : "int32"} before shifting; a Math-based rewrite changes overflow, -0 and NaN results` });
      }
    } else if (n.type === "UnaryExpression" && n.operator === "~" && n.argument.type === "UnaryExpression" && n.argument.operator === "~") {
      findings.push({ kind: "bitwise-truncation", severity: "high", line: lineOf(n), message: "`~~x` truncates to int32 (not the same as Math.trunc for -0, NaN or |x| >= 2^31)" });
    } else if (n.type === "AssignmentExpression" && n.left.type === "MemberExpression") {
      // C.prototype.m = ... or C.prototype = { ... }
      const left = n.left;
      const protoOf = (m: ESTree.Node): string | undefined =>
        m.type === "MemberExpression" && !m.computed && m.property.type === "Identifier" && m.property.name === "prototype" && m.object.type === "Identifier" ? m.object.name : undefined;
      const owner = protoOf(left.object) ?? protoOf(left);
      if (owner !== undefined && functions.has(owner)) {
        const entry = protoOwners.get(owner) ?? { line: lineOf(n), members: 0 };
        entry.members += protoOf(left) !== undefined && n.right.type === "ObjectExpression" ? n.right.properties.length : 1;
        protoOwners.set(owner, entry);
      }
    } else if (n.type === "VariableDeclaration" && n.kind === "var") {
      varCount += n.declarations.length;
      if (firstVarLine === 0) firstVarLine = lineOf(n);
    } else if (n.type === "Identifier" && n.name === "arguments") {
      findings.push({ kind: "arguments-usage", severity: "medium", line: lineOf(n), message: "`arguments` does not exist in arrow functions and is aliased to parameters in sloppy mode; rewrite to rest parameters only after proving parity" });
    } else if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "require") {
      const arg = n.arguments[0];
      if (arg !== undefined && arg.type === "Literal" && typeof arg.value === "string") requires.push({ specifier: arg.value, line: lineOf(n) });
    }
    return undefined;
  });
  for (const [owner, p] of protoOwners) {
    findings.push({ kind: "prototype-chain", severity: "medium", line: p.line, message: `constructor ${owner} with ${p.members} prototype member(s): a class rewrite changes enumerability, strict mode and calls without \`new\`` });
  }
  if (varCount > 0) {
    findings.push({ kind: "var-hoisting", severity: "medium", line: firstVarLine, message: `${varCount} \`var\` binding(s): function-scoped and hoisted; \`let\`/\`const\` change loop closures and use-before-declare behaviour` });
  }
  return { findings, requires };
}

export function auditDirectory(dir: string): AuditReport {
  const root = nodePath.resolve(dir);
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
  const skipped: Array<{ file: string; reason: string }> = [];
  const names = listSources(root, skipped);
  const sources = new Map<string, string>();
  for (const rel of names) {
    const full = nodePath.join(root, rel);
    const size = fs.statSync(full).size;
    if (size > MAX_AUDIT_FILE_BYTES) {
      skipped.push({ file: rel, reason: `larger than ${MAX_AUDIT_FILE_BYTES} bytes` });
      continue;
    }
    sources.set(rel, fs.readFileSync(full, "utf8"));
  }
  const known = new Set(sources.keys());
  const scans = new Map<string, Scan>();
  const edges: Array<{ from: string; to: string }> = [];
  const requireLines: Record<string, number> = {};
  for (const [rel, source] of sources) {
    const ast = parseFile(source);
    if ("error" in ast) {
      scans.set(rel, { findings: [{ kind: "parse-error", severity: "high", line: 0, message: `does not parse: ${ast.error}` }], requires: [] });
      continue;
    }
    const scan = scanProgram(ast);
    const errorFirst = detectErrorFirst(source).functions;
    if (errorFirst.length > 0) {
      const lift = liftErrorFirst(source);
      for (const f of errorFirst) {
        const liftable = lift.ok && lift.lifted.includes(f.name);
        scan.findings.push({
          kind: "error-first-callback",
          severity: "medium",
          line: f.line,
          message: `${f.name}(${[...f.params, f.callback].join(", ")}) is a Node.js error-first callback (\`${f.callback}(err)\` / \`${f.callback}(null, value)\`): ${liftable ? "Lazarus lifts it to async/await and proves both settlements" : `not liftable as is (${lift.ok ? "not reached by the lift" : lift.reason}); Lazarus falls back to a promise wrapper`}`,
        });
      }
    }
    for (const r of scan.requires) {
      if (r.specifier.startsWith("./") || r.specifier.startsWith("../")) {
        const resolved = resolveRelative(known, rel, r.specifier);
        if (resolved.ok && !edges.some((e) => e.from === rel && e.to === resolved.path)) {
          edges.push({ from: rel, to: resolved.path });
          requireLines[`${rel}->${resolved.path}`] = r.line;
        }
        else if (!resolved.ok) scan.findings.push({ kind: "external-require", severity: "high", line: r.line, message: `require('${r.specifier}') does not resolve inside the audited folder` });
      } else {
        scan.findings.push({ kind: "external-require", severity: "high", line: r.line, message: `require('${r.specifier}') is a package or Node built-in: it cannot run inside the Lazarus sandbox` });
      }
    }
    scans.set(rel, scan);
  }

  // Cycles (DFS over the resolved edges).
  const out = (f: string): string[] => edges.filter((e) => e.from === f).map((e) => e.to);
  const cycles: string[][] = [];
  const onCycle = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const dfs = (f: string): void => {
    state.set(f, 1);
    stack.push(f);
    for (const t of out(f)) {
      if (state.get(t) === 1) {
        const cycle = stack.slice(stack.indexOf(t));
        cycles.push(cycle);
        for (const c of cycle) onCycle.add(c);
      } else if (state.get(t) === undefined) {
        dfs(t);
      }
    }
    stack.pop();
    state.set(f, 2);
  };
  for (const f of [...known].sort()) if (state.get(f) === undefined) dfs(f);

  const files: FileReport[] = [...scans.keys()].sort().map((rel) => {
    const scan = scans.get(rel) ?? { findings: [], requires: [] };
    const fanOut = out(rel).length;
    const fanIn = edges.filter((e) => e.to === rel).length;
    const findings = [...scan.findings];
    if (fanIn > 0 || fanOut > 0 || onCycle.has(rel)) {
      const high = fanIn >= 3 || fanOut >= 3 || onCycle.has(rel);
      findings.push({
        kind: "require-graph",
        severity: high ? "high" : "info",
        line: 0,
        message: `require graph: fan-in ${fanIn}, fan-out ${fanOut}${onCycle.has(rel) ? ", on a require cycle" : ""}${high ? " (resurrect it as part of the whole graph)" : ""}`,
      });
    }
    findings.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
    const counts: Record<Severity, number> = { high: 0, medium: 0, info: 0 };
    for (const f of findings) counts[f.severity]++;
    const penalty = counts.high * SCORE_WEIGHTS.high + counts.medium * SCORE_WEIGHTS.medium + counts.info * SCORE_WEIGHTS.info;
    return { file: rel, bytes: Buffer.byteLength(sources.get(rel) ?? "", "utf8"), findings, counts, fanIn, fanOut, readiness: Math.max(0, 100 - Math.min(100, penalty)) };
  });

  const totals = { files: files.length, high: 0, medium: 0, info: 0 };
  for (const f of files) for (const s of ["high", "medium", "info"] as const) totals[s] += f.counts[s];
  const readiness = files.length === 0 ? 100 : Math.round(files.reduce((sum, f) => sum + f.readiness, 0) / files.length);
  const entry = files.length > 0 ? (analyzeGraph(Object.fromEntries(sources)).entry ?? null) : null;
  const shownDir = dir.replace(/\\/g, "/").replace(/\/$/, "");
  const notes: string[] = [];
  // Independent require graphs (connected components) are resurrected separately: directory mode treats every file
  // under the folder as one graph.
  const parent = new Map<string, string>(files.map((f) => [f.file, f.file]));
  const findRoot = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) ?? r;
    return r;
  };
  for (const e of edges) parent.set(findRoot(e.from), findRoot(e.to));
  const groups = new Map<string, string[]>();
  for (const f of files) groups.set(findRoot(f.file), [...(groups.get(findRoot(f.file)) ?? []), f.file]);
  const components = [...groups.values()].map((g) => g.sort()).sort((a, b) => b.length - a.length || (a[0] ?? "").localeCompare(b[0] ?? ""));
  const commandFor = (group: string[]): string => {
    if (group.length === 1) return `npm run resurrect -- ${shownDir}/${group[0] ?? ""} --out ./resurrected-out`;
    const groupEntry = analyzeGraph(Object.fromEntries(group.map((f) => [f, sources.get(f) ?? ""]))).entry;
    // The deepest folder holding exactly this group's files, so directory mode sees nothing else.
    const dirs = group.map((f) => f.split("/").slice(0, -1));
    const common: string[] = [];
    for (let i = 0; dirs.every((d) => d[i] !== undefined && d[i] === dirs[0]?.[i]); i++) common.push(dirs[0]?.[i] ?? "");
    const prefix = common.join("/");
    const exclusive = prefix !== "" && files.every((f) => !f.file.startsWith(`${prefix}/`) || group.includes(f.file));
    if (components.length === 1 || !exclusive) return `npm run resurrect -- ${shownDir}${groupEntry !== undefined ? ` --entry ${groupEntry}` : ""} --out ./resurrected-out`;
    const relEntry = groupEntry !== undefined ? groupEntry.slice(prefix.length + 1) : undefined;
    return `npm run resurrect -- ${shownDir}/${prefix}${relEntry !== undefined ? ` --entry ${relEntry}` : ""} --out ./resurrected-out/${prefix.split("/").pop() ?? prefix}`;
  };
  let recommendedCommand: string;
  if (files.length === 0) {
    recommendedCommand = `# no .js / .cjs files found under ${shownDir}`;
  } else {
    recommendedCommand = components.map(commandFor).join("\n");
    if (components.length > 1) notes.push(`${components.length} independent require graphs: resurrect each one separately (one command per graph below).`);
  }
  const external = files.filter((f) => f.findings.some((x) => x.kind === "external-require"));
  if (external.length > 0) notes.push(`${external.length} file(s) require packages, built-ins or files outside the folder (${external.map((f) => f.file).join(", ")}); they cannot run in the sandbox until those requires are removed or vendored.`);
  if (cycles.length > 0) notes.push(`${cycles.length} require cycle(s): ${cycles.map((c) => [...c, c[0]].join(" -> ")).join("; ")}.`);
  if (totals.high > 0) notes.push("High-risk truncation sites are exactly where a naive Math.floor / Math.trunc rewrite breaks exact Object.is parity; let the Exorcist prove each one.");
  return { directory: shownDir, files, skipped, totals, graph: { entry, edges, cycles }, requireLines, readiness, grade: gradeFor(readiness), recommendedCommand, notes };
}

/** Markdown report (tables render in terminals and in GitHub). */
export function renderAuditMarkdown(r: AuditReport): string {
  const lines: string[] = [];
  lines.push(`# Lazarus Legacy Risk Report: ${r.directory}`, "");
  lines.push(`Migration readiness: **${r.readiness}/100 (grade ${r.grade})** · ${r.totals.files} file(s) · ${r.totals.high} high · ${r.totals.medium} medium · ${r.totals.info} info`, "");
  lines.push("| File | Readiness | High | Medium | Info | Fan-in | Fan-out |", "|---|---:|---:|---:|---:|---:|---:|");
  for (const f of r.files) lines.push(`| ${f.file} | ${f.readiness} | ${f.counts.high} | ${f.counts.medium} | ${f.counts.info} | ${f.fanIn} | ${f.fanOut} |`);
  lines.push("", "## Findings", "");
  const all = r.files.flatMap((f) => f.findings.map((x) => ({ file: f.file, ...x })));
  if (all.length === 0) lines.push("No risky patterns found.");
  else {
    lines.push("| Severity | File:line | Pattern | Detail |", "|---|---|---|---|");
    const order: Record<Severity, number> = { high: 0, medium: 1, info: 2 };
    for (const x of [...all].sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line)) {
      lines.push(`| ${x.severity.toUpperCase()} | ${x.file}${x.line > 0 ? `:${x.line}` : ""} | ${x.kind} | ${x.message.replace(/\|/g, "\\|")} |`);
    }
  }
  lines.push("", "## Require graph", "");
  lines.push(r.graph.edges.length === 0 ? "No relative requires between the audited files." : r.graph.edges.map((e) => `- ${e.from} -> ${e.to}`).join("\n"));
  if (r.graph.entry !== null) lines.push("", `Entry module: \`${r.graph.entry}\``);
  if (r.skipped.length > 0) lines.push("", "## Skipped", "", ...r.skipped.map((s) => `- ${s.file}: ${s.reason}`));
  if (r.notes.length > 0) lines.push("", "## Notes", "", ...r.notes.map((n) => `- ${n}`));
  lines.push("", r.recommendedCommand.includes("\n") ? "## Next steps" : "## Next step", "", "```bash", r.recommendedCommand, "```", "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// SARIF 2.1.0 (GitHub Code Scanning)
// ---------------------------------------------------------------------------
export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
export const SARIF_TOOL_VERSION = "14.0.0";
const INFORMATION_URI = "https://github.com/anjarkar25-max/lazarus";

export type SarifLevel = "error" | "warning" | "note";
export interface SarifRule {
  readonly id: string;
  readonly name: string;
  readonly shortDescription: { readonly text: string };
  readonly fullDescription: { readonly text: string };
  readonly help: { readonly text: string };
  readonly helpUri: string;
  readonly defaultConfiguration: { readonly level: SarifLevel };
}
export interface SarifResult {
  readonly ruleId: string;
  readonly ruleIndex: number;
  readonly level: SarifLevel;
  readonly message: { readonly text: string };
  readonly locations: ReadonlyArray<{ readonly physicalLocation: { readonly artifactLocation: { readonly uri: string; readonly uriBaseId: "%SRCROOT%" }; readonly region: { readonly startLine: number } } }>;
}
export interface SarifLog {
  readonly $schema: string;
  readonly version: "2.1.0";
  readonly runs: ReadonlyArray<{
    readonly tool: { readonly driver: { readonly name: string; readonly fullName: string; readonly informationUri: string; readonly semanticVersion: string; readonly rules: readonly SarifRule[] } };
    readonly columnKind: "utf16CodeUnits";
    readonly results: readonly SarifResult[];
  }>;
}

const rule = (id: string, name: string, short: string, full: string, fix: string, level: SarifLevel): SarifRule => ({
  id,
  name,
  shortDescription: { text: short },
  fullDescription: { text: full },
  help: { text: fix },
  helpUri: INFORMATION_URI,
  defaultConfiguration: { level },
});
/** Stable rule table: ids never change meaning. Order is the `ruleIndex`. */
export const SARIF_RULES: readonly SarifRule[] = [
  rule("LAZ001", "BitwiseTruncation", "Bitwise int32 truncation (x | 0, ~~x, x >> 0)", "Bitwise truncation converts to int32: -0, NaN and Infinity become 0 and values wrap modulo 2^32, so a Math.floor or Math.trunc rewrite changes results.", "Resurrect the file with Lazarus: the Exorcist proves exact Object.is parity and rolls back any rewrite that breaks -0, NaN or 32-bit wrap-around. Do not replace the truncation by hand.", "error"),
  rule("LAZ002", "ErrorFirstCallback", "Node.js error-first callback", "A function that reports its result through cb(err) / cb(null, value) can be converted to async/await only if both the success and the failure settlements are preserved.", "Resurrect it with Lazarus: it lifts the callback to async/await and proves both settlements, or falls back to a promise wrapper.", "warning"),
  rule("LAZ003", "PrototypeChain", "Constructor with prototype members", "A class rewrite of a prototype chain changes enumerability, strict mode and calls without new.", "Let Lazarus convert the prototype chain to a class only after the Exorcist proves parity; roll the rule back when it finds a counterexample.", "warning"),
  rule("LAZ004", "VarOrArgumentsHoisting", "var hoisting or arguments object", "var is function scoped and hoisted, and arguments is not available in arrow functions, so let/const and rest rewrites can change behavior.", "Rewrite to const/let and rest parameters only after proving parity; Lazarus does this with a fuzzed proof and rolls back on a counterexample.", "warning"),
  rule("LAZ005", "CircularOrUnresolvableRequire", "Circular or unresolvable CommonJS require", "Modules that require each other, or that require packages, built-ins or files outside the audited folder, need whole-graph handling: partial exports in a cycle and host modules inside the sandbox.", "Resurrect the whole require graph (npm run resurrect -- <dir> --entry <file>): Lazarus resolves cycles as ES module live bindings and proves whole-graph Object.is parity. Vendor or remove host and package requires first.", "warning"),
  rule("LAZ006", "UnparseableFile", "File does not parse", "The file is not valid JavaScript for the parser, so no other rule could be evaluated for it.", "Fix the syntax error, then audit again.", "error"),
];
const RULE_OF_KIND: Record<FindingKind, string> = {
  "bitwise-truncation": "LAZ001",
  "error-first-callback": "LAZ002",
  "prototype-chain": "LAZ003",
  "var-hoisting": "LAZ004",
  "arguments-usage": "LAZ004",
  "require-graph": "LAZ005",
  "external-require": "LAZ005",
  "parse-error": "LAZ006",
};
const LEVEL_OF_SEVERITY: Record<Severity, SarifLevel> = { high: "error", medium: "warning", info: "note" };

/** The audited folder as a repository-relative prefix, or "" when it is "." or cannot be one (absolute, or climbs out). */
function sarifPrefix(directory: string): string {
  const d = directory.replace(/\\/g, "/").replace(/\/+$/, "");
  if (d === "" || d === "." || d.startsWith("/") || /^[A-Za-z]:/.test(d) || d.split("/").includes("..")) return "";
  return `${d.replace(/^\.\//, "")}/`;
}

/** SARIF 2.1.0 log for a report. Pure and deterministic. Result lines are 1-based. */
export function renderSarif(report: AuditReport): SarifLog {
  const prefix = sarifPrefix(report.directory);
  const cycleOf = new Map<string, number>();
  report.graph.cycles.forEach((cycle, i) => cycle.forEach((f) => cycleOf.set(f, i)));
  /** First require() line of a file that points into the same cycle, else the first require of the file, else 1. */
  const requireLine = (file: string): number => {
    const own = report.graph.edges.filter((e) => e.from === file);
    const inCycle = own.filter((e) => cycleOf.has(file) && cycleOf.get(e.to) === cycleOf.get(file));
    const lines = (inCycle.length > 0 ? inCycle : own).map((e) => report.requireLines[`${e.from}->${e.to}`] ?? 0).filter((n) => n > 0);
    return lines.length > 0 ? Math.min(...lines) : 1;
  };
  const results: SarifResult[] = [];
  for (const f of report.files) {
    for (const finding of f.findings) {
      const ruleId = RULE_OF_KIND[finding.kind];
      const ruleIndex = SARIF_RULES.findIndex((r) => r.id === ruleId);
      const fix = SARIF_RULES[ruleIndex]?.help.text ?? "";
      results.push({
        ruleId,
        ruleIndex,
        level: LEVEL_OF_SEVERITY[finding.severity],
        message: { text: `${finding.message}. Fix: ${fix}` },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: `${prefix}${f.file}`, uriBaseId: "%SRCROOT%" },
              region: { startLine: finding.line > 0 ? finding.line : finding.kind === "require-graph" ? requireLine(f.file) : 1 },
            },
          },
        ],
      });
    }
  }
  results.sort((a, b) => (a.locations[0]?.physicalLocation.artifactLocation.uri ?? "").localeCompare(b.locations[0]?.physicalLocation.artifactLocation.uri ?? "") || (a.locations[0]?.physicalLocation.region.startLine ?? 0) - (b.locations[0]?.physicalLocation.region.startLine ?? 0) || a.ruleId.localeCompare(b.ruleId));
  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "Lazarus", fullName: "Lazarus Legacy Risk Audit", informationUri: INFORMATION_URI, semanticVersion: SARIF_TOOL_VERSION, rules: SARIF_RULES } },
        columnKind: "utf16CodeUnits",
        results,
      },
    ],
  };
}

export const AUDIT_USAGE = `lazarus audit <dir> [--json | --sarif] [--out <file>]
Scan every .js / .cjs file under <dir> (node_modules, .git and dist are skipped) with acorn, without running
anything, and print a Legacy Risk Report: bitwise truncation traps, prototype chains, var / arguments usage, the
require() graph, a migration readiness score and the exact resurrection command to run next.
  --json      print the full report as JSON
  --sarif     print a SARIF 2.1.0 log for GitHub Code Scanning (rules LAZ001-LAZ006)
  --out <f>   write the report to <f> instead of stdout (relative to the current directory)
  --help, -h  show this help
Exit codes: 0 report written, 2 bad usage or unreadable directory.`;

export interface AuditIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
}

export function runAuditCli(argv: readonly string[], io: AuditIo): number {
  let json = false;
  let sarif = false;
  let out: string | undefined;
  let dir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--json") json = true;
    else if (arg === "--sarif") sarif = true;
    else if (arg === "--out" || arg === "-o") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        io.stderr(`error: ${arg} needs a file name\n\n${AUDIT_USAGE}\n`);
        return 2;
      }
      out = value;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      io.stdout(`${AUDIT_USAGE}\n`);
      return 0;
    } else if (arg.startsWith("-")) {
      io.stderr(`error: unknown option ${arg}\n\n${AUDIT_USAGE}\n`);
      return 2;
    } else if (dir !== undefined) {
      io.stderr(`error: unexpected extra argument ${arg}\n\n${AUDIT_USAGE}\n`);
      return 2;
    } else dir = arg;
  }
  if (dir === undefined) {
    io.stderr(`error: no directory given\n\n${AUDIT_USAGE}\n`);
    return 2;
  }
  if (json && sarif) {
    io.stderr(`error: --json and --sarif cannot be combined\n\n${AUDIT_USAGE}\n`);
    return 2;
  }
  let report: AuditReport;
  try {
    const resolved = nodePath.resolve(io.cwd, dir);
    report = auditDirectory(resolved);
    // Show the directory as the user typed it.
    const typed = dir.replace(/\\/g, "/").replace(/(.)\/+$/, "$1");
    report = { ...report, directory: typed, recommendedCommand: report.recommendedCommand.split(resolved.replace(/\\/g, "/")).join(typed) };
  } catch (err: unknown) {
    io.stderr(`error: cannot audit ${dir}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const text = sarif ? `${JSON.stringify(renderSarif(report), null, 2)}\n` : json ? `${JSON.stringify(report, null, 2)}\n` : renderAuditMarkdown(report);
  if (out !== undefined) {
    const target = nodePath.resolve(io.cwd, out);
    try {
      fs.mkdirSync(nodePath.dirname(target), { recursive: true });
      fs.writeFileSync(target, text, "utf8");
    } catch (err: unknown) {
      io.stderr(`error: cannot write ${out}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
    io.stdout(`Wrote ${sarif ? "SARIF 2.1.0" : json ? "JSON" : "Markdown"} report for ${report.directory} to ${out} (${report.totals.high} high, ${report.totals.medium} medium, ${report.totals.info} info)\n`);
    return 0;
  }
  io.stdout(text);
  return 0;
}
