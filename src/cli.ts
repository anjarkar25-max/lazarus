// Lazarus CLI: resurrect a local .js/.cjs/.mjs file from the terminal.
//   npm run resurrect -- ./legacy-quantize.cjs --out ./resurrected-out
// Legacy code is only ever parsed here; it runs exclusively inside the pooled sandbox workers.

import * as fs from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ResurrectionOrchestrator } from "./crew/orchestrator.js";
import { toEsmModule } from "./crew/esm-export.js";
import type { CrewEvent } from "./crew/types.js";
import { generateResurrectionBundle, sanitizeIdentifier } from "./exporter/bundle.js";
import type { InputSchema } from "./fuzzer/types.js";
import { scanLegacyAst } from "./sandbox/ast-scanner.js";
import { generateCertificate } from "./exporter/certificate.js";
import { resurrectGraph } from "./crew/graph-resurrector.js";
import { buildGraphBundle } from "./exporter/graph-bundle.js";
import { describeTypecheck } from "./crew/ts-verifier.js";
import { listModuleFunctions, resurrectModule } from "./crew/module-resurrection.js";
import { describeValue } from "./sandbox/tagged.js";
import { runAuditCli } from "./cli-audit.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Directory that relative paths are resolved against. */
  cwd: string;
}

const MAX_SOURCE_BYTES = 256_000;
const DEFAULT_RUNS = 100;

const SchemaArg = z.record(z.string().regex(/^[A-Za-z_$][\w$]*$/, "parameter names must be identifiers"), z.enum(["integer", "number", "string", "boolean", "json"]));

export const USAGE = `lazarus resurrect <file.js|.cjs|.mjs | directory> [options]

Resurrect a legacy ES5 / CommonJS file: extract it with a real AST parser, modernize it, prove
behavioural parity with differential fuzzing inside the sandbox, and write a verified PR bundle.

Options:
  --out, -o <dir>      output directory (default ./resurrected-out)
  --function <name>    function (or export name) to resurrect when the file has several
  --schema <json>      fuzz schema, e.g. '{"n":"integer","s":"string"}' (default: inferred from the code)
  --runs <n>           fuzz runs per attempt, 5-2000 (default ${DEFAULT_RUNS})
  --seed <n>           deterministic fuzz seed
  --name <identifier>  name of the generated function (default: the function's name)
  --help, -h           show this help

Writes resurrected.ts, resurrected.test.ts, SPEC.md and resurrection.patch (plus resurrected.mjs,
legacy.cjs and resurrected.esm.test.ts when the CommonJS -> ESM conversion is exact).
Directory mode: every .js/.cjs file under the directory (node_modules skipped) is resurrected as one
CommonJS dependency graph, leaves first, then the stitched ES module graph is fuzzed end to end against
the original. --entry <file> picks the entry module; --schema then describes its export(s), either flat
or as {"exportName": {...}}. Writes src/, legacy/, resurrected.test.ts, SPEC.md, the CI workflow and
resurrection.patch, or nothing when parity fails.
Exit codes: 0 parity proven, 1 not resurrected, 2 bad usage.
Risk scan without running anything: lazarus audit <dir> [--json] (npm run audit -- <dir>).`;

interface ParsedArgs {
  file?: string;
  out: string;
  fn?: string;
  schema?: string;
  runs: number;
  seed?: number;
  name?: string;
  help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  const parsed: ParsedArgs = { out: "./resurrected-out", runs: DEFAULT_RUNS, help: false };
  const takeValue = (flag: string, index: number): string | { error: string } => {
    const value = argv[index + 1];
    return value === undefined || value.startsWith("--") ? { error: `${flag} needs a value` } : value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--out":
      case "-o":
      case "--function":
      case "--schema":
      case "--runs":
      case "--seed":
      case "--name": {
        const value = takeValue(arg, i);
        if (typeof value !== "string") return value;
        i++;
        if (arg === "--out" || arg === "-o") parsed.out = value;
        else if (arg === "--function") parsed.fn = value;
        else if (arg === "--schema") parsed.schema = value;
        else if (arg === "--name") parsed.name = value;
        else {
          const num = Number(value);
          if (!Number.isInteger(num)) return { error: `${arg} must be an integer` };
          if (arg === "--runs") {
            if (num < 5 || num > 2000) return { error: "--runs must be between 5 and 2000" };
            parsed.runs = num;
          } else {
            parsed.seed = num;
          }
        }
        break;
      }
      default:
        if (arg.startsWith("-")) return { error: `unknown option ${arg}` };
        if (parsed.file !== undefined) return { error: `unexpected extra argument ${arg}` };
        parsed.file = arg;
    }
  }
  return parsed;
}

const PROGRESS_TYPES = new Set<CrewEvent["type"]>(["agent_started", "counterexample_found", "self_healed", "fuzz_completed"]);

export async function main(argv: readonly string[], io: CliIo = defaultIo()): Promise<number> {
  // `lazarus audit <dir>`: the static Legacy Risk Report (nothing is executed).
  if (argv[0] === "audit") return runAuditCli(argv.slice(1), io);
  const args = parseArgs(argv);
  if ("error" in args) {
    io.stderr(`error: ${args.error}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  if (args.file === undefined) {
    io.stderr(`error: no input file given\n\n${USAGE}\n`);
    return 2;
  }

  // ---- read the specimen -------------------------------------------------
  const inputPath = nodePath.resolve(io.cwd, args.file);
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(inputPath).isDirectory();
  } catch {
    /* reported below as an unreadable file */
  }
  if (isDirectory) return runDirectory(inputPath, args, io);
  if (!/\.(c|m)?js$/i.test(inputPath)) {
    io.stderr(`error: ${args.file} is not a .js, .cjs or .mjs file\n`);
    return 2;
  }
  let source: string;
  try {
    const stat = fs.statSync(inputPath);
    if (!stat.isFile()) throw new Error("not a file");
    if (stat.size > MAX_SOURCE_BYTES) {
      io.stderr(`error: ${args.file} is ${stat.size} bytes; the limit is ${MAX_SOURCE_BYTES}\n`);
      return 2;
    }
    source = fs.readFileSync(inputPath, "utf8");
  } catch (err: unknown) {
    io.stderr(`error: cannot read ${args.file}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  // ---- extract with the AST scanner -------------------------------------
  const scan = scanLegacyAst(source, args.fn !== undefined ? { functionName: args.fn } : {});
  if (!scan.parsed) {
    io.stderr(`error: ${args.file} could not be parsed: ${scan.parseError ?? "syntax error"}\n`);
    return 1;
  }
  if (args.fn !== undefined && scan.primary?.name !== args.fn && scan.primary?.exportedAs !== args.fn) {
    const available = scan.functions.map((f) => f.exportedAs ?? f.name).join(", ") || "none";
    io.stderr(`error: no function named "${args.fn}" (found: ${available})\n`);
    return 2;
  }

  // ---- multi-export module: resurrect every exported function -------------------
  if (args.fn === undefined) {
    const moduleFunctions = listModuleFunctions(source).functions;
    if (moduleFunctions.length >= 2) {
      return runModule(source, scan.detectedIdioms, args, inputPath, io);
    }
  }
  let schema: InputSchema;
  if (args.schema !== undefined) {
    let json: unknown;
    try {
      json = JSON.parse(args.schema);
    } catch {
      io.stderr("error: --schema is not valid JSON\n");
      return 2;
    }
    const checked = SchemaArg.safeParse(json);
    if (!checked.success) {
      io.stderr(`error: invalid --schema: ${checked.error.issues.map((i) => `${i.path.join(".") || "schema"} ${i.message}`).join("; ")}\n`);
      return 2;
    }
    schema = checked.data;
  } else if (scan.primary !== undefined) {
    schema = scan.suggestedSchema as InputSchema;
  } else {
    io.stderr("error: no function found to resurrect; pass --schema to describe the inputs of a plain expression\n");
    return 2;
  }

  const missing = (scan.primary?.paramNames ?? []).filter((p) => !(p in schema));
  if (missing.length > 0) io.stderr(`warning: schema has no entry for parameter(s) ${missing.join(", ")}; they will be undefined\n`);

  const name = sanitizeIdentifier(args.name ?? scan.primary?.name ?? nodePath.basename(inputPath).replace(/\.(c|m)?js$/i, ""));
  io.stdout(`Lazarus: resurrecting ${name} from ${args.file}\n`);
  io.stdout(`  idioms: ${scan.detectedIdioms.join(", ") || "none"}\n`);
  io.stdout(`  inputs: ${JSON.stringify(schema)} (${args.schema !== undefined ? "from --schema" : "inferred"})\n`);

  // ---- resurrect (sandboxed, pooled) ------------------------------------
  const result = await new ResurrectionOrchestrator().resurrect({
    name,
    legacyCode: scan.primaryExpression,
    schema,
    fuzzRuns: args.runs,
    maxHealingAttempts: 3,
    exact: true,
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
    onEvent: (event) => {
      if (PROGRESS_TYPES.has(event.type)) io.stdout(`  [${event.agent}] ${event.message}\n`);
    },
  });

  if (!result.success) {
    const cx = result.fuzzReport.counterexample;
    io.stderr(`\nNOT resurrected: parity could not be proven after ${result.attempts} attempt(s). No files written.\n`);
    if (cx !== undefined) {
      io.stderr(`  counterexample inputs: ${describeValue(cx.inputs)}\n`);
      io.stderr(`  legacy:  ${cx.legacy.ok ? describeValue(cx.legacy.output) : `error ${cx.legacy.errorMessage ?? ""}`}\n`);
      io.stderr(`  modern:  ${cx.modern.ok ? describeValue(cx.modern.output) : `error ${cx.modern.errorMessage ?? ""}`}\n`);
      io.stderr(`  reason:  ${cx.reason}\n`);
    }
    return 1;
  }

  // ---- write the verified bundle ----------------------------------------
  const esm = toEsmModule(source);
  const bundle = generateResurrectionBundle({
    specimenName: name,
    legacyCode: scan.primaryExpression,
    legacySource: source,
    modernCode: result.modernCode,
    specMarkdown: result.specMarkdown,
    fuzzRuns: result.fuzzReport.totalRuns,
    healed: result.attempts > 1,
    schema,
    certificateMarkdown: generateCertificate({ provenance: { kind: "file", label: nodePath.basename(inputPath) }, legacySource: source, modernCode: result.modernCode, fuzz: { totalRuns: result.fuzzReport.totalRuns, exact: result.fuzzReport.exact === true, ...(result.fuzzReport.boundaryRuns !== undefined ? { boundaryRuns: result.fuzzReport.boundaryRuns } : {}) }, attempts: result.attempts, esmComplete: esm.complete }).markdown,
    ...(esm.complete ? { esmModule: { code: esm.code, exports: esm.exports } } : {}),
  });

  const outDir = nodePath.resolve(io.cwd, args.out);
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (err: unknown) {
    io.stderr(`error: cannot create output directory ${args.out}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const files: Array<[string, string]> = [
    ...Object.entries(bundle.files).flatMap(([file, content]) => (content === undefined ? [] : [[file, content] as [string, string]])),
    ["resurrection.patch", `${bundle.prDiff}\n`],
  ];
  for (const [file, content] of files) {
    fs.mkdirSync(nodePath.dirname(nodePath.join(outDir, file)), { recursive: true });
    fs.writeFileSync(nodePath.join(outDir, file), content, "utf8");
  }

  io.stdout(`\nParity proven: ${result.fuzzReport.totalRuns} fuzz runs, ${result.attempts} attempt(s)${result.attempts > 1 ? " (self-healed)" : ""}.\n`);
  io.stdout(`Wrote ${files.length} files to ${outDir}:\n`);
  for (const [file, content] of files) io.stdout(`  ${file} (${Buffer.byteLength(content, "utf8")} bytes)\n`);
  if (!esm.complete) io.stdout(`  note: kept CommonJS (${esm.notes.join("; ") || "no exports"})\n`);
  return 0;
}

async function runModule(source: string, idioms: string[], args: ParsedArgs, inputPath: string, io: CliIo): Promise<number> {
  const name = sanitizeIdentifier(args.name ?? nodePath.basename(inputPath).replace(/\.(c|m)?js$/i, ""));
  const { functions, skipped } = listModuleFunctions(source);
  io.stdout(`Lazarus: resurrecting module ${name} (${functions.map((f) => f.exportedAs ?? f.name).join(", ")}) from ${args.file ?? inputPath}\n`);
  io.stdout(`  idioms: ${idioms.join(", ") || "none"}\n`);
  if (args.schema !== undefined) io.stderr("warning: --schema is ignored for a multi-export module; pass --function to resurrect one export with a schema\n");
  for (const s of skipped) io.stdout(`  skipped ${s.name}: ${s.reason}\n`);
  const result = await resurrectModule(source, {
    name,
    fuzzRuns: args.runs,
    maxHealingAttempts: 3,
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
    onEvent: (event) => {
      const fn = typeof event.payload?.functionName === "string" ? event.payload.functionName : "";
      if (PROGRESS_TYPES.has(event.type)) io.stdout(`  [${fn}/${event.agent}] ${event.message}\n`);
    },
  });
  const failed = result.functions.filter((f) => !f.success);
  if (!result.success) {
    io.stderr(`\nNOT resurrected: parity could not be proven for ${failed.map((f) => f.exportedAs).join(", ") || "any function"}. No files written.\n`);
    const cx = result.fuzzReport.counterexample;
    if (cx !== undefined) io.stderr(`  reason:  ${cx.reason}\n`);
    return 1;
  }
  const bundle = generateResurrectionBundle({
    specimenName: name,
    legacyCode: source,
    legacySource: source,
    modernCode: result.modernCode,
    specMarkdown: result.specMarkdown,
    fuzzRuns: Math.max(...result.functions.map((f) => f.fuzzReport.totalRuns)),
    healed: result.attempts > 1,
    certificateMarkdown: generateCertificate({ provenance: { kind: "file", label: nodePath.basename(inputPath) }, legacySource: source, modernCode: result.modernCode, fuzz: { totalRuns: result.fuzzReport.totalRuns, exact: result.fuzzReport.exact === true }, attempts: result.attempts, esmComplete: result.esm.complete }).markdown,
    ...(result.esm.complete ? { esmModule: { code: result.esm.code, exports: result.esm.exports } } : {}),
    functions: result.functions.map((f) => ({ name: f.exportedAs, schema: f.schema, legacyCode: f.legacyCode, modernCode: f.modernCode })),
  });
  const outDir = nodePath.resolve(io.cwd, args.out);
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (err: unknown) {
    io.stderr(`error: cannot create output directory ${args.out}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const files: Array<[string, string]> = [
    ...Object.entries(bundle.files).flatMap(([file, content]) => (content === undefined ? [] : [[file, content] as [string, string]])),
    ["resurrection.patch", `${bundle.prDiff}\n`],
  ];
  for (const [file, content] of files) {
    fs.mkdirSync(nodePath.dirname(nodePath.join(outDir, file)), { recursive: true });
    fs.writeFileSync(nodePath.join(outDir, file), content, "utf8");
  }
  io.stdout(`\nParity proven for ${result.functions.length} functions: ${result.fuzzReport.totalRuns} fuzz runs in total, up to ${result.attempts} attempt(s).\n`);
  io.stdout(`Wrote ${files.length} files to ${outDir}:\n`);
  for (const [file, content] of files) io.stdout(`  ${file} (${Buffer.byteLength(content, "utf8")} bytes)\n`);
  if (!result.esm.complete) io.stdout(`  note: kept CommonJS (${result.esm.notes.join("; ") || "no exports"})\n`);
  return 0;
}
const MAX_GRAPH_FILES = 64;
const MAX_GRAPH_BYTES = 512 * 1024;

/** .js/.cjs files under `root` (relative, "/"-separated, sorted). Skips node_modules and dot-directories. */
function discoverSources(root: string): { files: Record<string, string> } | { error: string } {
  const files: Record<string, string> = {};
  let total = 0;
  const walkDir = (dir: string, prefix: string): string | undefined => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = nodePath.join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        const problem = walkDir(full, rel);
        if (problem !== undefined) return problem;
      } else if (entry.isFile() && /\.c?js$/i.test(entry.name)) {
        const size = fs.statSync(full).size;
        total += size;
        if (Object.keys(files).length >= MAX_GRAPH_FILES) return `more than ${MAX_GRAPH_FILES} .js/.cjs files`;
        if (size > MAX_SOURCE_BYTES || total > MAX_GRAPH_BYTES) return `sources exceed the ${MAX_GRAPH_BYTES} byte limit`;
        files[rel] = fs.readFileSync(full, "utf8");
      }
    }
    return undefined;
  };
  const problem = walkDir(root, "");
  return problem !== undefined ? { error: problem } : { files };
}

async function runDirectory(dir: string, args: ParsedArgs, io: CliIo): Promise<number> {
  const found = discoverSources(dir);
  if ("error" in found) {
    io.stderr(`error: ${args.file ?? dir}: ${found.error}\n`);
    return 2;
  }
  const count = Object.keys(found.files).length;
  if (count === 0) {
    io.stderr(`error: ${args.file ?? dir} contains no .js or .cjs files\n`);
    return 2;
  }
  let schemas: Record<string, InputSchema> | undefined;
  if (args.schema !== undefined) {
    let json: unknown;
    try {
      json = JSON.parse(args.schema);
    } catch {
      io.stderr("error: --schema is not valid JSON\n");
      return 2;
    }
    const nested = z.record(z.string(), SchemaArg).safeParse(json);
    const flat = SchemaArg.safeParse(json);
    if (flat.success) schemas = { default: flat.data, "*": flat.data };
    else if (nested.success) schemas = nested.data;
    else {
      io.stderr("error: invalid --schema for directory mode (use {\"param\":\"kind\"} or {\"export\":{\"param\":\"kind\"}})\n");
      return 2;
    }
  }
  const name = sanitizeIdentifier(args.name ?? nodePath.basename(dir));
  io.stdout(`Lazarus: resurrecting the ${count}-file CommonJS graph ${name} from ${args.file ?? dir}\n`);
  const result = await resurrectGraph(found.files, {
    name,
    ...(args.fn !== undefined ? { entry: args.fn } : {}),
    ...(schemas !== undefined ? { schemas: expandFlatSchema(schemas, found.files, args.fn) } : {}),
    fileRuns: Math.min(args.runs, 200),
    graphRuns: args.runs,
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
    onProgress: (event) => {
      if (event.kind === "graph") io.stdout(`  order: ${event.graph.order.join(" -> ")} (entry ${event.graph.entry ?? "none"})\n`);
      else if (event.kind === "node") io.stdout(`  [${event.file}] ${event.state.toUpperCase()}: ${event.detail}\n`);
      else io.stdout(`  ${event.message}\n`);
    },
  });
  if (!result.success) {
    io.stderr(`\nNOT resurrected: ${result.error ?? "parity could not be proven"}. No files written.\n`);
    const cx = result.parity?.functions.find((f) => !f.passed)?.counterexample;
    if (cx !== undefined) io.stderr(`  counterexample inputs: ${describeValue(cx.inputs)}\n  reason:  ${cx.reason}\n`);
    return 1;
  }
  const bundle = buildGraphBundle(result, { runs: args.runs });
  const outDir = nodePath.resolve(io.cwd, args.out);
  try {
    for (const [file, content] of Object.entries(bundle.files)) {
      const target = nodePath.join(outDir, file);
      fs.mkdirSync(nodePath.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf8");
    }
  } catch (err: unknown) {
    io.stderr(`error: cannot write to ${args.out}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  io.stdout(`\nWhole-graph parity proven: ${result.parity?.totalRuns ?? 0} exact Object.is runs end to end, ${result.files.length} files resurrected leaves first.\n`);
  if (result.typecheck !== undefined) {
    io.stdout(`${describeTypecheck(result.typecheck)}${result.typecheck.adjustments.length > 0 ? `; ${result.typecheck.adjustments.length} member(s) declared any at the migration boundary` : ""}\n`);
    for (const d of result.typecheck.diagnostics.slice(0, 5)) io.stdout(`  ${d.file}:${d.line}:${d.column} TS${d.code} ${d.message}\n`);
  }
  io.stdout(`Wrote ${Object.keys(bundle.files).length} files to ${outDir}:\n`);
  for (const [file, content] of Object.entries(bundle.files)) io.stdout(`  ${file} (${Buffer.byteLength(content, "utf8")} bytes)\n`);
  return 0;
}

/** A flat `--schema` applies to every export of the entry module. */
function expandFlatSchema(schemas: Record<string, InputSchema>, files: Record<string, string>, entry: string | undefined): Record<string, InputSchema> {
  const flat = schemas["*"];
  if (flat === undefined) return schemas;
  const entryFile = entry ?? Object.keys(files).at(-1) ?? "";
  const out: Record<string, InputSchema> = { default: flat };
  for (const fn of scanLegacyAst(files[entryFile] ?? "").functions) out[fn.exportedAs ?? fn.name] = flat;
  return out;
}
function defaultIo(): CliIo {
  return {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    cwd: process.cwd(),
  };
}

const isMain = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exitCode = 1;
    }
  );
}
