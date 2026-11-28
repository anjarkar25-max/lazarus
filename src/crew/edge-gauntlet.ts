// 12-Case Adversarial Edge-Case Gauntlet (V19).
//
// A fixed, deterministic set of notorious JavaScript inputs (-0, NaN, +/-Infinity, int32 edges, -3, the empty string, a NUL, "__proto__"
// and a 64-character mixed string) is run through three implementations of the same specimen in the sandbox workers: the Legacy
// expression, the deterministic Naive AI rewrite, and the Lazarus-proven code. Outputs are compared with the fuzzer's exact tagged
// Object.is semantics, so -0, NaN and undefined stay distinguishable. Nothing runs on the host; no randomness, no network.
import { z } from "zod";
import { areOutputsEquivalent } from "../fuzzer/differential.js";
import type { InputSchema, ParamKind } from "../fuzzer/types.js";
import { SandboxError } from "../sandbox/errors.js";
import { PooledProbeRunner } from "../sandbox/pool.js";
import { scanLegacyAst } from "../sandbox/ast-scanner.js";
import { decodeTagged, describeValue, encodeTagged } from "../sandbox/tagged.js";
import type { ProbeExecutor } from "../sandbox/types.js";
import { naiveRefactor } from "./naive-refactor.js";

export const EDGE_MAX_CODE_CHARS = 64_000;
/** Wall-clock budget of one gauntlet: remaining cases are skipped (never faked) once it is spent. */
export const EDGE_BUDGET_MS = 15_000;

export interface EdgeCase {
  readonly label: string;
  /** `numeric` edges target number-like parameters (`integer` ones only the integral edges); `text` edges target string parameters. `json` parameters take both. */
  readonly family: "numeric" | "text";
  readonly value: number | string;
}

/** 62 ASCII letters and digits plus two non-ASCII characters: exactly 64 UTF-16 code units. */
export const LONG_STRING = `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789\u00e9\u6f22`;

export const EDGE_CASES: readonly EdgeCase[] = [
  { label: "-0", family: "numeric", value: -0 },
  { label: "NaN", family: "numeric", value: Number.NaN },
  { label: "Infinity", family: "numeric", value: Number.POSITIVE_INFINITY },
  { label: "-Infinity", family: "numeric", value: Number.NEGATIVE_INFINITY },
  { label: "2147483647", family: "numeric", value: 2147483647 },
  { label: "2147483648", family: "numeric", value: 2147483648 },
  { label: "-2147483648", family: "numeric", value: -2147483648 },
  { label: "-3", family: "numeric", value: -3 },
  { label: '""', family: "text", value: "" },
  { label: '"\\u0000"', family: "text", value: "\u0000" },
  { label: '"__proto__"', family: "text", value: "__proto__" },
  { label: "64-char string", family: "text", value: LONG_STRING },
];

const NEUTRAL: Readonly<Record<ParamKind, unknown>> = { integer: 1, number: 1, string: "a", boolean: true, json: null };

/**
 * A parameter of kind `kind` takes this edge as is (`raw`), as its text (`text`), or not at all. An `integer` parameter takes only
 * integral edges (-0 and the int32 edges, not NaN or +-Infinity, which are outside its declared domain); a `number` parameter takes
 * every numeric edge; a `json` parameter takes all 12.
 */
function targeting(kind: ParamKind, edge: EdgeCase): "raw" | "text" | "none" {
  if (kind === "json") return "raw";
  if (edge.family === "numeric") {
    if (kind === "integer") return typeof edge.value === "number" && Number.isInteger(edge.value) ? "raw" : "none";
    return kind === "number" ? "raw" : kind === "string" ? "text" : "none";
  }
  return kind === "string" ? "raw" : "none";
}

const textOf = (value: number | string): string => (typeof value === "string" ? value : Object.is(value, -0) ? "-0" : String(value));

/** The sandbox context of one case, or undefined when no parameter of the schema can take the edge. */
export function buildEdgeContext(schema: InputSchema, edge: EdgeCase): Record<string, unknown> | undefined {
  const context: Record<string, unknown> = {};
  let targeted = false;
  for (const [name, kind] of Object.entries(schema)) {
    const how = targeting(kind, edge);
    if (how === "none") context[name] = NEUTRAL[kind];
    else {
      targeted = true;
      context[name] = how === "text" ? textOf(edge.value) : edge.value;
    }
  }
  return targeted ? context : undefined;
}

export interface EdgeGauntletRow {
  readonly label: string;
  readonly inputDisplay: string;
  readonly legacyOut: string;
  readonly naiveOut: string;
  readonly lazarusOut: string;
  /** The Naive AI output equals the Legacy output under exact Object.is (two rejections count as equal). */
  readonly naiveMatch: boolean;
  readonly lazarusMatch: boolean;
}
export interface EdgeGauntletResult {
  readonly total: number;
  readonly lazarusPassed: number;
  readonly naivePassed: number;
  readonly rows: EdgeGauntletRow[];
}

const KindSchema = z.enum(["integer", "number", "string", "boolean", "json"]);
export const EdgeGauntletBodySchema = z
  .object({
    legacyCode: z.string().min(1, "legacyCode is required").max(EDGE_MAX_CODE_CHARS),
    modernCode: z.string().min(1, "modernCode is required").max(EDGE_MAX_CODE_CHARS),
    /** The Naive AI candidate. Defaults to the deterministic naive rewrite of the legacy code. */
    naiveCode: z.string().min(1).max(EDGE_MAX_CODE_CHARS).optional(),
    schema: z.record(z.string().regex(/^(?!__lz)[A-Za-z_$][\w$]*$/, "parameter names must be plain identifiers"), KindSchema).refine((s) => Object.keys(s).length <= 16, "at most 16 parameters"),
    /** Run this exported function of a multi-export module. */
    functionName: z.string().min(1).max(200).optional(),
  })
  .strict();
export type EdgeGauntletInput = z.infer<typeof EdgeGauntletBodySchema>;

/** A request the gauntlet cannot run (raised before any sandbox probe). `status` is the HTTP status the server answers with. */
export class EdgeGauntletError extends Error {
  constructor(
    message: string,
    readonly code: "NO_SCHEMA" | "PARSE_ERROR" | "NO_CASE",
    readonly status: 422
  ) {
    super(message);
    this.name = "EdgeGauntletError";
  }
}

export interface EdgeGauntletExecutors {
  readonly legacy: ProbeExecutor;
  readonly modern: ProbeExecutor;
}

interface SideOutcome {
  readonly ok: boolean;
  readonly value: unknown;
  readonly display: string;
}

async function runSide(executor: ProbeExecutor, code: string, context: Record<string, unknown>): Promise<SideOutcome> {
  try {
    const result = await executor.run({ code, context: encodeTagged(context) as Record<string, unknown>, encoding: "tagged" });
    const value = decodeTagged(result.output);
    // Positive zero is shown as "+0" so that it reads differently from "-0".
    return { ok: true, value, display: Object.is(value, 0) ? "+0" : describeValue(value, 120) };
  } catch (err: unknown) {
    const code2 = err instanceof SandboxError ? err.code : "INTERNAL_ERROR";
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, value: undefined, display: `throws ${code2}${message === "" ? "" : ` (${message.slice(0, 60)})`}` };
  }
}

const sameOutcome = (a: SideOutcome, b: SideOutcome): boolean => (a.ok && b.ok ? areOutputsEquivalent(a.value, b.value) : a.ok === b.ok);

/** What will be run: the legacy expression and the naive candidate. Throws EdgeGauntletError before any probe. */
export function prepareEdgeGauntlet(input: EdgeGauntletInput): { legacyRunnable: string; naiveCode: string; naiveApplies: boolean } {
  if (Object.keys(input.schema).length === 0) throw new EdgeGauntletError("No input to probe: give a schema with at least one parameter", "NO_SCHEMA", 422);
  const scan = scanLegacyAst(input.legacyCode, input.functionName === undefined ? {} : { functionName: input.functionName });
  if (!scan.parsed) throw new EdgeGauntletError(`The specimen does not parse: ${scan.parseError ?? "syntax error"}`, "PARSE_ERROR", 422);
  const legacyRunnable = scan.primaryExpression;
  if (input.naiveCode !== undefined) return { legacyRunnable, naiveCode: input.naiveCode, naiveApplies: true };
  const naive = naiveRefactor(legacyRunnable);
  if (naive.parseError !== undefined) throw new EdgeGauntletError(`The specimen does not parse: ${naive.parseError}`, "PARSE_ERROR", 422);
  return { legacyRunnable, naiveCode: naive.naiveCode, naiveApplies: naive.rewrites.length > 0 };
}

/** Runs every applicable edge case through Legacy, Naive AI and Lazarus in the given sandbox executors. */
export async function runEdgeGauntlet(input: EdgeGauntletInput, executors: EdgeGauntletExecutors, options: { readonly budgetMs?: number } = {}): Promise<EdgeGauntletResult> {
  const { legacyRunnable, naiveCode } = prepareEdgeGauntlet(input);
  const deadline = Date.now() + (options.budgetMs ?? EDGE_BUDGET_MS);
  const rows: EdgeGauntletRow[] = [];
  let runnable = 0;
  for (const edge of EDGE_CASES) {
    const context = buildEdgeContext(input.schema, edge);
    if (context === undefined) continue;
    runnable++;
    if (Date.now() > deadline) continue;
    const legacy = await runSide(executors.legacy, legacyRunnable, context);
    const naive = await runSide(executors.modern, naiveCode, context);
    const lazarus = await runSide(executors.modern, input.modernCode, context);
    const shown = Object.entries(input.schema).map(([name]) => `${name} = ${describeValue(context[name], 60)}`);
    rows.push({
      label: edge.label,
      inputDisplay: shown.join(", "),
      legacyOut: legacy.display,
      naiveOut: naive.display,
      lazarusOut: lazarus.display,
      naiveMatch: sameOutcome(legacy, naive),
      lazarusMatch: sameOutcome(legacy, lazarus),
    });
  }
  if (runnable === 0) throw new EdgeGauntletError("None of the 12 edge inputs fits this schema (it has only boolean parameters)", "NO_CASE", 422);
  return { total: rows.length, lazarusPassed: rows.filter((r) => r.lazarusMatch).length, naivePassed: rows.filter((r) => r.naiveMatch).length, rows };
}

/** Same, with two short-lived warm workers that are closed before this returns (no leaked process). */
export async function runEdgeGauntletPooled(input: EdgeGauntletInput, options: { readonly budgetMs?: number } = {}): Promise<EdgeGauntletResult> {
  prepareEdgeGauntlet(input);
  await using legacy = new PooledProbeRunner();
  await using modern = new PooledProbeRunner();
  return await runEdgeGauntlet(input, { legacy, modern }, options);
}
