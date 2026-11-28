// Resurrect any single legacy specimen the way the Web Studio does, for the CLI, the MCP server and the benchmark:
// classify it (error-first callback, Promise chain, multi-export module or synchronous), run the matching pass in the pooled
// sandbox, and verify the result with the real strict TypeScript check. One path, so every front end reports the same numbers.
// Legacy code runs only inside pooled sandbox workers.
import { classifySpecimen, resurrectAsyncSpecimen, type SpecimenKind } from "./crew/async-specimen.js";
import { formatInputs, formatOutcome } from "./crew/exact-format.js";
import { listModuleFunctions, resurrectModule } from "./crew/module-resurrection.js";
import { ResurrectionOrchestrator } from "./crew/orchestrator.js";
import type { RuleBlameEntry } from "./crew/rule-blame.js";
import { describeTypecheck } from "./crew/ts-verifier.js";
import { inferSignature } from "./crew/type-alchemist.js";
import type { CrewEvent } from "./crew/types.js";
import type { CounterexampleReport, InputSchema } from "./fuzzer/types.js";
import { scanLegacyAst } from "./sandbox/ast-scanner.js";
import { buildExportBundle } from "./web/server.js";

export type ResurrectKind = SpecimenKind | "module";

export interface ResurrectAnyInput {
  /** The specimen's name (also the preferred function name). */
  readonly name: string;
  /** The legacy module exactly as written. */
  readonly source: string;
  /** Flat schema, or per-export schemas for a multi-export module. Default: inferred from the code. */
  readonly schema?: InputSchema | Record<string, InputSchema>;
  readonly fuzzRuns?: number;
  readonly seed?: number;
  /** The function (or export name) to resurrect when the file has several. */
  readonly functionName?: string;
  readonly onEvent?: (event: CrewEvent) => void;
}

export type ExportedBundle = Awaited<ReturnType<typeof buildExportBundle>>;

export interface ResurrectAnyResult {
  readonly kind: ResurrectKind;
  readonly success: boolean;
  readonly name: string;
  readonly attempts: number;
  readonly fuzzRuns: number;
  /** The resurrected code (TypeScript for async specimens). */
  readonly modernCode: string;
  /** The verified PR bundle, when parity was proven. */
  readonly exported?: ExportedBundle;
  /** `tsc --strict: N errors (...)` of the bundle, when there is one. */
  readonly tsc: string;
  readonly tscPassed: boolean;
  readonly ruleBlame?: RuleBlameEntry[];
  /** The counterexample behind a failure, formatted for people. */
  readonly counterexample?: { readonly input: string; readonly legacyOutput: string; readonly modernOutput: string; readonly reason: string };
  readonly schema: InputSchema | Record<string, InputSchema>;
  /** Async passes: how it was lifted and how many inputs resolved or rejected. */
  readonly asyncSummary?: { readonly strategy: string; readonly rewrites: string[]; readonly resolved: number; readonly rejected: number };
}

const NOT_CHECKED = "not checked (no parity)";

/** `{ counterexample }` for a failed run that has one, else nothing (spread into the result). */
function failure(success: boolean, cx: CounterexampleReport | undefined): { counterexample?: NonNullable<ResurrectAnyResult["counterexample"]> } {
  if (success || cx === undefined) return {};
  return { counterexample: { input: formatInputs(cx.inputs), legacyOutput: formatOutcome(cx.legacy), modernOutput: formatOutcome(cx.modern), reason: cx.reason } };
}

const isFlat = (schema: InputSchema | Record<string, InputSchema>): schema is InputSchema => Object.values(schema).every((v) => typeof v === "string");

export async function resurrectAny(input: ResurrectAnyInput): Promise<ResurrectAnyResult> {
  const fuzzRuns = input.fuzzRuns ?? 100;
  const seed = input.seed ?? 1337;
  const hint = input.functionName ?? input.name;
  const klass = classifySpecimen(input.source, hint);
  const events = input.onEvent !== undefined ? { onEvent: input.onEvent } : {};

  // ---- error-first callback or Promise chain: both settlements fuzzed ---------------------------------------------------
  if (klass.kind !== "sync" && klass.entry !== undefined) {
    const entry = klass.entry;
    const given = input.schema !== undefined && isFlat(input.schema) ? input.schema : {};
    const scanned = scanLegacyAst(input.source, { functionName: entry.name }).suggestedSchema;
    const schema: InputSchema = Object.fromEntries(entry.params.map((p) => [p, given[p] ?? scanned[p] ?? "string"]));
    const result = await resurrectAsyncSpecimen(new ResurrectionOrchestrator(), klass.kind, { name: input.name, source: input.source, schema, fuzzRuns, seed, ...events });
    const exported = result.success
      ? await buildExportBundle({ specimenName: entry.name, legacyCode: input.source, modernCode: result.modernCode, fuzzRuns: result.fuzzReport.totalRuns, attempts: result.attempts, schema })
      : undefined;
    return {
      kind: klass.kind,
      success: result.success,
      name: entry.name,
      attempts: result.attempts,
      fuzzRuns: result.fuzzReport.totalRuns,
      modernCode: result.modernCode,
      ...(exported !== undefined ? { exported } : {}),
      tsc: exported !== undefined ? describeTypecheck(exported.typecheck) : NOT_CHECKED,
      tscPassed: exported?.typecheck.passed === true,
      ...(result.ruleBlame !== undefined ? { ruleBlame: result.ruleBlame } : {}),
      ...failure(result.success, result.fuzzReport.counterexample),
      schema,
      ...(result.asyncCallback !== undefined ? { asyncSummary: { strategy: result.asyncCallback.strategy, rewrites: result.asyncCallback.rewrites, resolved: result.asyncCallback.outcomes.resolved, rejected: result.asyncCallback.outcomes.rejected } } : {}),
    };
  }

  // ---- multi-export CommonJS module ------------------------------------------------------------------------------------
  if (input.functionName === undefined && listModuleFunctions(input.source).functions.length >= 2) {
    const schemas = input.schema !== undefined && !isFlat(input.schema) ? input.schema : undefined;
    const merged = await resurrectModule(input.source, { name: input.name, fuzzRuns, seed, maxHealingAttempts: 3, ...(schemas !== undefined ? { schemas } : {}), ...(input.onEvent !== undefined ? { onEvent: input.onEvent } : {}) });
    const exported = merged.success
      ? await buildExportBundle({
          specimenName: input.name,
          legacyCode: input.source,
          modernCode: merged.modernCode,
          fuzzRuns: merged.fuzzReport.totalRuns,
          attempts: merged.attempts,
          functions: merged.functions.map((f) => ({ name: f.exportedAs, schema: f.schema, modernCode: f.modernCode })),
        })
      : undefined;
    return {
      kind: "module",
      success: merged.success,
      name: input.name,
      attempts: merged.attempts,
      fuzzRuns: merged.fuzzReport.totalRuns,
      modernCode: merged.modernCode,
      ...(exported !== undefined ? { exported } : {}),
      tsc: exported !== undefined ? describeTypecheck(exported.typecheck) : NOT_CHECKED,
      tscPassed: exported?.typecheck.passed === true,
      ...failure(merged.success, merged.fuzzReport.counterexample),
      schema: Object.fromEntries(merged.functions.map((f) => [f.exportedAs, f.schema])),
    };
  }

  // ---- synchronous function or script -----------------------------------------------------------------------------------
  const scan = scanLegacyAst(input.source, input.functionName !== undefined ? { functionName: input.functionName } : {});
  const schema: InputSchema = input.schema !== undefined && isFlat(input.schema) ? input.schema : (scan.suggestedSchema as InputSchema);
  const result = await new ResurrectionOrchestrator().resurrect({
    name: input.name,
    legacyCode: scan.primaryExpression,
    schema,
    fuzzRuns,
    seed,
    maxHealingAttempts: 3,
    exact: true,
    collectObservations: true,
    ...events,
  });
  const observed = result.success && result.observations !== undefined && result.observations.length > 0 ? inferSignature(result.observations, schema) : undefined;
  const exported = result.success
    ? await buildExportBundle({
        specimenName: input.name.replace(/[^\w$]/g, "_"),
        legacyCode: input.source,
        modernCode: result.modernCode,
        fuzzRuns: result.fuzzReport.totalRuns,
        attempts: result.attempts,
        healed: result.attempts > 1,
        schema,
        ...(observed !== undefined ? { typeSignature: observed } : {}),
      })
    : undefined;
  return {
    kind: "sync",
    success: result.success,
    name: input.name,
    attempts: result.attempts,
    fuzzRuns: result.fuzzReport.totalRuns,
    modernCode: result.modernCode,
    ...(exported !== undefined ? { exported } : {}),
    tsc: exported !== undefined ? describeTypecheck(exported.typecheck) : NOT_CHECKED,
    tscPassed: exported?.typecheck.passed === true,
    ...(result.ruleBlame !== undefined ? { ruleBlame: result.ruleBlame } : {}),
    ...failure(result.success, result.fuzzReport.counterexample),
    schema,
  };
}
