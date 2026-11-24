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
import { describeValue } from "./sandbox/tagged.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Directory that relative paths are resolved against. */
  cwd: string;
}

const MAX_SOURCE_BYTES = 256_000;
const DEFAULT_RUNS = 100;

const SchemaArg = z.record(z.string().regex(/^[A-Za-z_$][\w$]*$/, "parameter names must be identifiers"), z.enum(["integer", "number", "string", "boolean", "json"]));

export const USAGE = `lazarus resurrect <file.js|.cjs|.mjs> [options]

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
Exit codes: 0 parity proven, 1 not resurrected, 2 bad usage.`;

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
  for (const [file, content] of files) fs.writeFileSync(nodePath.join(outDir, file), content, "utf8");

  io.stdout(`\nParity proven: ${result.fuzzReport.totalRuns} fuzz runs, ${result.attempts} attempt(s)${result.attempts > 1 ? " (self-healed)" : ""}.\n`);
  io.stdout(`Wrote ${files.length} files to ${outDir}:\n`);
  for (const [file, content] of files) io.stdout(`  ${file} (${Buffer.byteLength(content, "utf8")} bytes)\n`);
  if (!esm.complete) io.stdout(`  note: kept CommonJS (${esm.notes.join("; ") || "no exports"})\n`);
  return 0;
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
