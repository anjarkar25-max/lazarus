// Multi-export CommonJS resurrection: one orchestrated resurrection per exported function, merged
// into a single result plus one ESM module whose rule levels cover every function.
// Legacy code is only ever executed in the sandbox (through the orchestrator).
import type { FuzzReport, InputSchema } from "../fuzzer/types.js";
import { scanLegacyAst, type ScannedFunction } from "../sandbox/ast-scanner.js";
import { RULE_ORDER, defaultLevels, readHeaderLevels, type RuleLevels } from "./ast-modernizer.js";
import { toEsmModule, type EsmModuleResult } from "./esm-export.js";
import { ResurrectionOrchestrator } from "./orchestrator.js";
import type { CrewEvent, ResurrectionResult } from "./types.js";

export interface ModuleFunctionResult {
  readonly name: string;
  readonly exportedAs: string;
  readonly schema: InputSchema;
  readonly success: boolean;
  readonly attempts: number;
  readonly legacyCode: string;
  readonly modernCode: string;
  readonly events: CrewEvent[];
  readonly fuzzReport: FuzzReport;
}

export interface SkippedFunction {
  readonly name: string;
  readonly reason: string;
}

export interface ModuleResurrectionResult extends ResurrectionResult {
  readonly functions: ModuleFunctionResult[];
  readonly skipped: SkippedFunction[];
  /** Rule levels shared by every function (the most conservative one wins per rule). */
  readonly levels: RuleLevels;
  readonly esm: EsmModuleResult;
}

export interface ModuleOptions {
  readonly name: string;
  readonly orchestrator?: ResurrectionOrchestrator;
  readonly fuzzRuns?: number;
  readonly seed?: number;
  readonly maxHealingAttempts?: number;
  /** Per-function schema overrides, keyed by export name. */
  readonly schemas?: Record<string, InputSchema>;
  readonly onEvent?: (event: CrewEvent) => void;
}

export interface ModuleFunctions {
  readonly functions: ScannedFunction[];
  readonly skipped: SkippedFunction[];
}

/** The exported, `this`-free functions of a CommonJS module, and the ones that cannot be resurrected on their own. */
export function listModuleFunctions(source: string): ModuleFunctions {
  const scan = scanLegacyAst(source);
  const functions: ScannedFunction[] = [];
  const skipped: SkippedFunction[] = [];
  const seen = new Set<string>();
  for (const fn of scan.functions) {
    if (!fn.isExported) continue;
    const exportedAs = fn.exportedAs ?? fn.name;
    if (exportedAs === "default") {
      skipped.push({ name: fn.name, reason: "default export (resurrected as a single function, not part of a module)" });
    } else if (fn.usesThis) {
      skipped.push({ name: exportedAs, reason: "uses `this` (the exports object), so it cannot run as a standalone function" });
    } else if (seen.has(exportedAs)) {
      skipped.push({ name: exportedAs, reason: "exported more than once" });
    } else {
      seen.add(exportedAs);
      functions.push(fn);
    }
  }
  return { functions, skipped };
}

/** Per rule, the highest (most conservative) level any of the candidates ended on. */
export function mergeLevels(candidates: readonly (string | undefined)[]): RuleLevels {
  const merged = defaultLevels();
  for (const code of candidates) {
    const levels = readHeaderLevels(code);
    if (levels === undefined) continue;
    for (const rule of RULE_ORDER) merged[rule] = Math.max(merged[rule], levels[rule]);
  }
  return merged;
}

function mergeReports(results: readonly ModuleFunctionResult[]): FuzzReport {
  const failing = results.find((r) => !r.fuzzReport.passed);
  const first = results[0]?.fuzzReport;
  return {
    passed: results.every((r) => r.fuzzReport.passed),
    totalRuns: results.reduce((sum, r) => sum + r.fuzzReport.totalRuns, 0),
    durationMs: results.reduce((sum, r) => sum + r.fuzzReport.durationMs, 0),
    seed: first?.seed ?? 0,
    traces: results.flatMap((r) => r.fuzzReport.traces).slice(0, 15),
    ...(failing?.fuzzReport.counterexample !== undefined ? { counterexample: failing.fuzzReport.counterexample } : {}),
    exact: results.every((r) => r.fuzzReport.exact === true),
  };
}

export async function resurrectModule(source: string, options: ModuleOptions): Promise<ModuleResurrectionResult> {
  const { functions: candidates, skipped } = listModuleFunctions(source);
  const orchestrator = options.orchestrator ?? new ResurrectionOrchestrator();
  const results: ModuleFunctionResult[] = [];
  const allEvents: CrewEvent[] = [];
  for (const fn of candidates) {
    const exportedAs = fn.exportedAs ?? fn.name;
    const schema: InputSchema = options.schemas?.[exportedAs] ?? fn.paramKinds;
    const events: CrewEvent[] = [];
    const result = await orchestrator.resurrect({
      name: exportedAs,
      legacyCode: fn.runnableExpression,
      schema,
      exact: true,
      ...(options.fuzzRuns !== undefined ? { fuzzRuns: options.fuzzRuns } : {}),
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      ...(options.maxHealingAttempts !== undefined ? { maxHealingAttempts: options.maxHealingAttempts } : {}),
      onEvent: (event) => {
        const tagged: CrewEvent = { ...event, payload: { ...(event.payload ?? {}), functionName: exportedAs } };
        events.push(tagged);
        allEvents.push(tagged);
        options.onEvent?.(tagged);
      },
    });
    results.push({
      name: fn.name,
      exportedAs,
      schema,
      success: result.success,
      attempts: result.attempts,
      legacyCode: fn.runnableExpression,
      modernCode: result.modernCode,
      events,
      fuzzReport: result.fuzzReport,
    });
  }
  const levels = mergeLevels(results.map((r) => r.modernCode));
  const esm = toEsmModule(source, { levels });
  const success = results.length > 0 && results.every((r) => r.success);
  const specMarkdown = [
    `# Module specification: ${options.name}`,
    ``,
    ...results.flatMap((r) => [`## ${r.exportedAs}`, ``, `- Input contract: \`${JSON.stringify(r.schema)}\``, `- Parity: ${r.success ? "proven" : "NOT proven"} after ${r.attempts} attempt(s)`, ``]),
    ...skipped.map((s) => `- Skipped \`${s.name}\`: ${s.reason}`),
  ].join("\n");
  return {
    success,
    name: options.name,
    legacyCode: source,
    specMarkdown,
    modernCode: esm.complete ? esm.code : results.map((r) => `// ${r.exportedAs}\n${r.modernCode}`).join("\n\n"),
    attempts: results.reduce((max, r) => Math.max(max, r.attempts), 0),
    fuzzReport: results.length > 0 ? mergeReports(results) : { passed: false, totalRuns: 0, durationMs: 0, seed: 0, traces: [] },
    events: allEvents,
    functions: results,
    skipped,
    levels,
    esm,
  };
}
