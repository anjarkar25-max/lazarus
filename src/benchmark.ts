// Local benchmark: every curated single-file preset through the real orchestrator (sandboxed differential fuzzing,
// exact Object.is) and the real strict TypeScript verifier, printed as a Markdown table.
//   npm run benchmark            (all presets, 100 fuzz runs each)
//   npm run benchmark -- --runs 40 --only stringHash32,mixAB
// Legacy code runs only inside pooled sandbox workers. All pools and the warm compiler are closed before exit.
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { BENCHMARK_PRESETS, type BenchmarkPreset } from "./benchmark-presets.js";
import { resurrectModule } from "./crew/module-resurrection.js";
import { ResurrectionOrchestrator } from "./crew/orchestrator.js";
import { closeSharedTsVerifier, describeTypecheck } from "./crew/ts-verifier.js";
import { inferSignature } from "./crew/type-alchemist.js";
import type { InputSchema } from "./fuzzer/types.js";
import { scanLegacyAst } from "./sandbox/ast-scanner.js";
import { buildExportBundle } from "./web/server.js";

export interface BenchmarkRow {
  readonly specimen: string;
  readonly success: boolean;
  readonly attempts: number;
  readonly fuzzRuns: number;
  readonly tscPassed: boolean;
  readonly tsc: string;
  readonly durationMs: number;
}

export interface BenchmarkOptions {
  readonly presets?: readonly BenchmarkPreset[];
  readonly fuzzRuns?: number;
  readonly seed?: number;
  readonly onRow?: (row: BenchmarkRow) => void;
}

async function runPreset(preset: BenchmarkPreset, fuzzRuns: number, seed: number): Promise<BenchmarkRow> {
  const started = performance.now();
  if (preset.module === true) {
    const schemas = preset.schema as Record<string, InputSchema>;
    const merged = await resurrectModule(preset.code, { name: preset.name, fuzzRuns, seed, maxHealingAttempts: 3, schemas });
    const verified = merged.success
      ? await buildExportBundle({
          specimenName: preset.name,
          legacyCode: preset.code,
          modernCode: merged.modernCode,
          fuzzRuns: merged.fuzzReport.totalRuns,
          attempts: merged.attempts,
          functions: merged.functions.map((f) => ({ name: f.exportedAs, schema: f.schema, modernCode: f.modernCode })),
        })
      : undefined;
    return {
      specimen: preset.name,
      success: merged.success,
      attempts: merged.attempts,
      fuzzRuns: merged.fuzzReport.totalRuns,
      tscPassed: verified?.typecheck.passed === true,
      tsc: verified !== undefined ? describeTypecheck(verified.typecheck) : "not checked (no parity)",
      durationMs: Math.round(performance.now() - started),
    };
  }
  if (preset.async === true) {
    // The same path as POST /api/resurrect for an error-first callback module.
    const asyncResult = await new ResurrectionOrchestrator().resurrectErrorFirst({ name: preset.name, source: preset.code, schema: preset.schema as InputSchema, fuzzRuns, seed });
    const asyncVerified = asyncResult.success
      ? await buildExportBundle({ specimenName: preset.name, legacyCode: preset.code, modernCode: asyncResult.modernCode, fuzzRuns: asyncResult.fuzzReport.totalRuns, attempts: asyncResult.attempts, schema: preset.schema as InputSchema })
      : undefined;
    return {
      specimen: preset.name,
      success: asyncResult.success,
      attempts: asyncResult.attempts,
      fuzzRuns: asyncResult.fuzzReport.totalRuns,
      tscPassed: asyncVerified?.typecheck.passed === true,
      tsc: asyncVerified !== undefined ? describeTypecheck(asyncVerified.typecheck) : "not checked (no parity)",
      durationMs: Math.round(performance.now() - started),
    };
  }
  const schema = preset.schema as InputSchema;
  // The same path as POST /api/resurrect: extracted specimen, exact Object.is, observed types, verified bundle.
  const result = await new ResurrectionOrchestrator().resurrect({
    name: preset.name,
    legacyCode: scanLegacyAst(preset.code).primaryExpression,
    schema,
    fuzzRuns,
    seed,
    maxHealingAttempts: 3,
    exact: true,
    collectObservations: true,
  });
  const observed = result.success && result.observations !== undefined && result.observations.length > 0 ? inferSignature(result.observations, schema) : undefined;
  const verified = result.success
    ? await buildExportBundle({
        specimenName: preset.name.replace(/[^\w$]/g, "_"),
        legacyCode: preset.code,
        modernCode: result.modernCode,
        fuzzRuns: result.fuzzReport.totalRuns,
        attempts: result.attempts,
        healed: result.attempts > 1,
        schema,
        ...(observed !== undefined ? { typeSignature: observed } : {}),
      })
    : undefined;
  return {
    specimen: preset.name,
    success: result.success,
    attempts: result.attempts,
    fuzzRuns: result.fuzzReport.totalRuns,
    tscPassed: verified?.typecheck.passed === true,
    tsc: verified !== undefined ? describeTypecheck(verified.typecheck) : "not checked (no parity)",
    durationMs: Math.round(performance.now() - started),
  };
}

/** Runs the presets one after another. Always closes the warm compiler, even when a preset throws. */
export async function runBenchmark(options: BenchmarkOptions = {}): Promise<BenchmarkRow[]> {
  const rows: BenchmarkRow[] = [];
  try {
    for (const preset of options.presets ?? BENCHMARK_PRESETS) {
      const row = await runPreset(preset, options.fuzzRuns ?? 100, options.seed ?? 1337);
      rows.push(row);
      options.onRow?.(row);
    }
  } finally {
    await closeSharedTsVerifier();
  }
  return rows;
}

export function renderBenchmarkTable(rows: readonly BenchmarkRow[]): string {
  const header = ["| Specimen | Parity | Attempts | Fuzz runs | tsc --strict | Duration (ms) |", "| --- | --- | ---: | ---: | --- | ---: |"];
  const body = rows.map((r) => `| \`${r.specimen}\` | ${r.success ? "exact Object.is" : "**FAILED**"} | ${r.attempts} | ${r.fuzzRuns} | ${r.tsc} | ${r.durationMs} |`);
  return [...header, ...body].join("\n");
}

function parseArgs(argv: readonly string[]): { runs: number; only?: string[] } | { error: string } {
  let runs = 100;
  let only: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--runs") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 5 || n > 1000) return { error: "--runs must be an integer between 5 and 1000" };
      runs = n;
      i++;
    } else if (arg === "--only") {
      if (value === undefined) return { error: "--only needs a comma-separated list of preset names" };
      only = value.split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    } else {
      return { error: `unknown argument ${arg ?? ""}` };
    }
  }
  return only !== undefined ? { runs, only } : { runs };
}

const isMain = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if ("error" in args) {
    process.stderr.write(`error: ${args.error}\n`);
    process.exitCode = 2;
  } else {
    const presets = args.only === undefined ? BENCHMARK_PRESETS : BENCHMARK_PRESETS.filter((p) => args.only?.includes(p.name));
    if (presets.length === 0) {
      process.stderr.write(`error: no preset matches --only (available: ${BENCHMARK_PRESETS.map((p) => p.name).join(", ")})\n`);
      process.exitCode = 2;
    } else {
      process.stdout.write(`Lazarus benchmark: ${presets.length} preset(s), ${args.runs} fuzz runs each, seed 1337\n\n`.replace(" preset(s)", presets.length === 1 ? " preset" : " presets"));
      const started = performance.now();
      runBenchmark({ presets, fuzzRuns: args.runs, onRow: (r) => process.stderr.write(`  ${r.specimen}: ${r.durationMs} ms\n`) }).then(
        (rows) => {
          process.stdout.write(`${renderBenchmarkTable(rows)}\n\n`);
          const failed = rows.filter((r) => !r.success || !r.tscPassed);
          process.stdout.write(`Total: ${Math.round(performance.now() - started)} ms; ${rows.length - failed.length}/${rows.length} with exact parity and tsc --strict passing.\n`);
          process.stdout.write("Note: the UI's legacy-int-halve preset adds a simulated buggy first draft; the benchmark runs the real Necromancer only.\n");
          process.exitCode = failed.length > 0 ? 1 : 0;
        },
        (err: unknown) => {
          process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
          process.exitCode = 1;
        }
      );
    }
  }
}
