// Runtime performance parity: a small, bounded, deterministic micro-benchmark of the legacy specimen against its
// resurrected code, run inside the isolated sandbox (never on the host).
//
// The sandbox has no high-resolution clock, so each side times calibrated batches with Date.now() (a batch is made long
// enough, >= BATCH_TARGET_MS, that the 1 ms clock tick is a small share of it) and reports microseconds per call. The
// runs alternate L, M, M, L so that JIT warm-up and machine drift do not favour one side. The numbers are medians of
// what was measured; nothing is estimated or filled in.
import { z } from "zod";
import { scanLegacyAst } from "../sandbox/ast-scanner.js";
import type { ProbeExecutor } from "../sandbox/types.js";
import type { InputSchema, ParamKind } from "../fuzzer/types.js";
import { parseProgram, printProgram } from "./ast-modernizer.js";
import { detectErrorFirst } from "./async-callback.js";

/** In-sandbox wall budget of one benchmark run (warm-up, calibration and timed batches). */
export const RUN_BUDGET_MS = 34;
/** Sandbox runs per benchmark: legacy, resurrected, resurrected, legacy. */
export const RUN_ORDER = ["legacy", "modern", "modern", "legacy"] as const;
/** Upper bound of the timed work: stays under ~150 ms. */
export const TOTAL_BUDGET_MS = RUN_BUDGET_MS * RUN_ORDER.length;
export const BATCH_TARGET_MS = 3;
export const MAX_BATCH = 1 << 20;
export const MAX_SAMPLES = 12;
export const VECTOR_COUNT = 16;
/** Per-sandbox-run watchdog for the pools the server creates (the benchmark itself takes ~RUN_BUDGET_MS). */
export const PERF_PROBE_TIMEOUT_MS = 900;
export const FASTER_AT = 1.1;
export const SLOWER_AT = 0.9;
export type PerfVerdict = "faster" | "parity" | "slower";

const MAX_CODE_CHARS = 64_000;
const KINDS = ["integer", "number", "string", "boolean", "json"] as const;
const Identifier = z.string().regex(/^(?!__lz)[A-Za-z_$][\w$]*$/, "parameter names must be plain identifiers");
export const PerfParityBodySchema = z
  .object({
    legacyCode: z.string().min(1, "legacyCode is required").max(MAX_CODE_CHARS),
    modernCode: z.string().min(1, "modernCode is required").max(MAX_CODE_CHARS),
    /** Fuzz schema of the specimen (the same one the resurrection used). Defaults to the scanner's suggestion. */
    schema: z
      .record(Identifier, z.enum(KINDS))
      .refine((s) => Object.keys(s).length <= 16, "schema may have at most 16 parameters")
      .optional(),
    functionName: z.string().min(1).max(200).optional(),
  })
  .strict();
export type PerfParityBody = z.infer<typeof PerfParityBodySchema>;

export interface PerfParityResult {
  /** Timed calls over every measured batch of both sides. */
  readonly iterations: number;
  readonly legacyMedianUs: number;
  readonly resurrectedMedianUs: number;
  readonly legacyOpsPerSec: number;
  readonly resurrectedOpsPerSec: number;
  /** legacy time / resurrected time: above 1 means the resurrected code is faster. */
  readonly ratio: number;
  readonly verdict: PerfVerdict;
  /** Distinct input vectors the calls cycled through. */
  readonly inputs: number;
  /** Wall time of the whole benchmark, including sandbox round trips. */
  readonly elapsedMs: number;
  /** The in-sandbox time budget the benchmark was capped to. */
  readonly budgetMs: number;
}
export interface PerfParitySkipped {
  readonly skipped: true;
  readonly reason: string;
}
export class PerfParityError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 422 | 500
  ) {
    super(message);
    this.name = "PerfParityError";
  }
}

const POOLS: Record<ParamKind, readonly unknown[]> = {
  integer: [0, 1, -1, 7, 42, 255, -1000, 65535, 123456, -2147483648],
  number: [0, 0.5, -0.5, 1.5, 3.14159, 100.25, -42.75, 1000000],
  string: ["", "a", "lazarus", "Hello, World", "  padded  ", "The quick brown fox jumps", "\u00fcn\u00efcode", "0123456789"],
  boolean: [true, false],
  json: [[1, 2, 3], { a: 1, b: [2, 3] }, "x", 5, null, []],
};

/** Deterministic argument vectors from the schema: the same schema always gives the same inputs. */
export function representativeInputs(schema: InputSchema, count: number = VECTOR_COUNT): unknown[][] {
  const kinds = Object.values(schema);
  const vectors: unknown[][] = [];
  for (let i = 0; i < count; i++) {
    vectors.push(kinds.map((kind, j) => structuredClone(POOLS[kind][(i + j * 3) % POOLS[kind].length])));
  }
  return vectors;
}

/**
 * The code as a function body whose completion value is returned: the last expression statement becomes `return`.
 * Returns undefined when the code does not end in an expression statement (so there is no value to time).
 */
export function toCallableBody(code: string): string | undefined {
  const parsed = parseProgram(code);
  if ("error" in parsed) return undefined;
  const body = parsed.ast.body;
  const last = body[body.length - 1];
  if (last === undefined || last.type !== "ExpressionStatement" || ("directive" in last && typeof last.directive === "string")) return undefined;
  return printProgram({ ...parsed.ast, body: [...body.slice(0, -1), { type: "ReturnStatement", argument: last.expression }] }, []);
}

/** The classification: honest ratio thresholds, no rounding games. */
export function classify(ratio: number): PerfVerdict {
  if (ratio >= FASTER_AT) return "faster";
  if (ratio <= SLOWER_AT) return "slower";
  return "parity";
}
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? Number.NaN) : ((sorted[mid - 1] ?? Number.NaN) + (sorted[mid] ?? Number.NaN)) / 2;
}
/** Four significant digits: sub-microsecond medians keep their precision. */
const round = (n: number): number => Number(n.toPrecision(4));

/** The probe evaluated in the sandbox. `lzBench` is the only input; the result is plain JSON. */
export const BENCH_PROBE = `(function (cfg) {
  var fn = new Function(cfg.params.join(","), cfg.body);
  var vs = cfg.vectors, n = vs.length, sink = 0;
  function call(i) {
    try { var r = fn.apply(undefined, vs[i % n]); sink = (sink + (typeof r === "number" ? r : 1)) | 0; }
    catch (e) { sink = (sink + 7) | 0; }
  }
  function batch(k) { var t0 = Date.now(); for (var i = 0; i < k; i++) call(i); return Date.now() - t0; }
  var start = Date.now(), w = 0;
  while (Date.now() - start < cfg.warmupMs && w < 5000) { call(w); w++; }
  var k = 8;
  while (k < cfg.maxBatch) {
    if (batch(k) >= cfg.batchMs) break;
    k *= 2;
    if (Date.now() - start > cfg.budgetMs / 2) break;
  }
  var samples = [], calls = 0;
  while (Date.now() - start < cfg.budgetMs && samples.length < cfg.maxSamples) {
    var e = batch(k);
    calls += k;
    samples.push(Math.max(e, 0.5) * 1000 / k);
  }
  return { samples: samples, calls: calls, batch: k, warmups: w, sink: sink };
})(lzBench)`;

interface BenchRun {
  readonly samples: number[];
  readonly calls: number;
}
async function bench(executor: ProbeExecutor, params: readonly string[], body: string, vectors: unknown[][]): Promise<BenchRun> {
  const cfg = { params, body, vectors, budgetMs: RUN_BUDGET_MS, warmupMs: Math.round(RUN_BUDGET_MS / 5), batchMs: BATCH_TARGET_MS, maxBatch: MAX_BATCH, maxSamples: MAX_SAMPLES };
  const result = await executor.run({ code: BENCH_PROBE, context: { lzBench: cfg } });
  const out = result.output;
  if (typeof out !== "object" || out === null) throw new PerfParityError("the benchmark probe returned no result", 500);
  const rec = out as { samples?: unknown; calls?: unknown };
  const samples = Array.isArray(rec.samples) ? rec.samples.filter((s): s is number => typeof s === "number" && Number.isFinite(s) && s > 0) : [];
  if (samples.length === 0 || typeof rec.calls !== "number") throw new PerfParityError("the benchmark collected no timing samples (the code ran too slowly or could not be called)", 422);
  return { samples, calls: rec.calls };
}

export interface PerfParityInput {
  readonly legacy: ProbeExecutor;
  readonly modern: ProbeExecutor;
  readonly legacyCode: string;
  readonly modernCode: string;
  readonly schema?: InputSchema;
  readonly functionName?: string;
}

/** Runs the benchmark. Executors are the pooled sandbox runners; this function never evaluates code itself. */
export async function runPerfParity(input: PerfParityInput): Promise<PerfParityResult | PerfParitySkipped> {
  if (detectErrorFirst(input.legacyCode, input.functionName !== undefined ? { entryName: input.functionName } : {}).entry !== undefined) {
    return { skipped: true, reason: "Error-first callback specimen: the micro-benchmark covers synchronous specimens." };
  }
  const scan = scanLegacyAst(input.legacyCode, input.functionName === undefined ? {} : { functionName: input.functionName });
  if (!scan.parsed) throw new PerfParityError(`the legacy code does not parse: ${scan.parseError ?? "syntax error"}`, 422);
  const schema: InputSchema = input.schema ?? (scan.suggestedSchema as InputSchema);
  const params = Object.keys(schema);
  if (params.length === 0) throw new PerfParityError("No input to benchmark: give a schema or a specimen with parameters", 422);
  const legacyBody = toCallableBody(scan.primaryExpression);
  const modernBody = toCallableBody(input.modernCode);
  if (legacyBody === undefined || modernBody === undefined) {
    return { skipped: true, reason: "The specimen does not end in a value-producing expression, so there is nothing to time." };
  }
  const vectors = representativeInputs(schema);
  const started = Date.now();
  const samples: Record<"legacy" | "modern", number[]> = { legacy: [], modern: [] };
  let iterations = 0;
  for (const side of RUN_ORDER) {
    const run = await bench(side === "legacy" ? input.legacy : input.modern, params, side === "legacy" ? legacyBody : modernBody, vectors);
    samples[side].push(...run.samples);
    iterations += run.calls;
  }
  const legacyUs = median(samples.legacy);
  const modernUs = median(samples.modern);
  if (!(legacyUs > 0) || !(modernUs > 0)) throw new PerfParityError("the benchmark could not measure a positive time", 422);
  const ratio = legacyUs / modernUs;
  return {
    iterations,
    legacyMedianUs: round(legacyUs),
    resurrectedMedianUs: round(modernUs),
    legacyOpsPerSec: Math.round(1_000_000 / legacyUs),
    resurrectedOpsPerSec: Math.round(1_000_000 / modernUs),
    ratio: round(ratio),
    verdict: classify(ratio),
    inputs: vectors.length,
    elapsedMs: Date.now() - started,
    budgetMs: TOTAL_BUDGET_MS,
  };
}
