import * as fc from "fast-check";
import { SandboxError } from "../sandbox/errors.js";
import { PooledProbeRunner } from "../sandbox/pool.js";
import { decodeTagged, describeValue, encodeTagged } from "../sandbox/tagged.js";
import type { ProbeExecutor } from "../sandbox/types.js";
import { formatExactValue } from "../crew/exact-format.js";
import type {
  CounterexampleReport,
  FuzzOptions,
  FuzzReport,
  FuzzTrace,
  InputSchema,
  ParamKind,
  ProbeOutcome,
  ShrinkStep,
  ShrinkTrace,
} from "./types.js";

function arbitraryForKind(kind: ParamKind): fc.Arbitrary<unknown> {
  switch (kind) {
    case "integer":
      return fc.integer({ min: -1_000_000, max: 1_000_000 });
    case "number":
      return fc.oneof(
        fc.constant(-0),
        fc.constant(0),
        fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true })
      );
    case "string":
      return fc.string({ minLength: 0, maxLength: 64 });
    case "boolean":
      return fc.boolean();
    case "json":
      return fc.jsonValue();
  }
}

export function buildRecordArbitrary(schema: InputSchema): fc.Arbitrary<Record<string, unknown>> {
  const shape: Record<string, fc.Arbitrary<unknown>> = {};
  for (const [key, kind] of Object.entries(schema)) {
    shape[key] = arbitraryForKind(kind);
  }
  return fc.record(shape);
}

export function areOutputsEquivalent(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== typeof b || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, idx) => areOutputsEquivalent(item, b[idx]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const recA = a as Record<string, unknown>;
    const recB = b as Record<string, unknown>;
    const keysA = Object.keys(recA);
    const keysB = Object.keys(recB);
    if (keysA.length !== keysB.length) {
      return false;
    }
    return keysA.every(
      (k) => Object.prototype.hasOwnProperty.call(recB, k) && areOutputsEquivalent(recA[k], recB[k])
    );
  }
  return false;
}

/** Boundary values per parameter kind. Mixed into exact runs so sign-of-zero, NaN and int32 edges are always probed. */
const INTEGER_BOUNDARIES: readonly number[] = [0, -0, -1, 1, 2147483647, -2147483648, 2147483648];
const BOUNDARIES: Readonly<Record<ParamKind, readonly unknown[]>> = {
  integer: INTEGER_BOUNDARIES,
  number: [...INTEGER_BOUNDARIES, Number.NaN, Infinity, -Infinity, 0.5, -0.5, 4294967296, Number.MAX_SAFE_INTEGER],
  string: ["", " ", "0", "-0", "NaN", "null", "abc", "\u0000", "Ã©", "0".repeat(40)],
  boolean: [false, true],
  json: [null, undefined, 0, -0, Number.NaN, "", [], {}, [0, -0], true],
};

/** Smallest run count at which the boundary corpus and boundary-biased arbitraries switch on. */
export const BOUNDARY_MIN_RUNS = 50;

export function boundariesForKind(kind: ParamKind): readonly unknown[] {
  const list = (BOUNDARIES as Record<string, readonly unknown[] | undefined>)[kind];
  if (list === undefined) {
    throw new Error(`Unknown parameter kind: ${String(kind)}`);
  }
  return list;
}

/** Like buildRecordArbitrary, but one in four draws comes from the boundary list. */
export function buildBoundaryRecordArbitrary(schema: InputSchema): fc.Arbitrary<Record<string, unknown>> {
  const shape: Record<string, fc.Arbitrary<unknown>> = {};
  for (const [key, kind] of Object.entries(schema)) {
    shape[key] = fc.oneof(
      { weight: 3, arbitrary: arbitraryForKind(kind) },
      { weight: 1, arbitrary: fc.constantFrom(...boundariesForKind(kind)) }
    );
  }
  return fc.record(shape);
}

/** Deterministic inputs: run i uses boundary (i + j) mod n for parameter j, so combinations rotate. */
export function buildBoundaryCorpus(schema: InputSchema, count: number): Record<string, unknown>[] {
  const keys = Object.keys(schema);
  if (keys.length === 0 || count <= 0) {
    return [];
  }
  const lists = keys.map((k) => boundariesForKind(schema[k] as ParamKind));
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const rec: Record<string, unknown> = {};
    keys.forEach((k, j) => {
      const list = lists[j] ?? [];
      rec[k] = list[(i + j) % list.length];
    });
    out.push(rec);
  }
  return out;
}

function hintFor(legacy: unknown, modern: unknown): string {
  if (typeof legacy === "number" && typeof modern === "number") {
    if (legacy === 0 && modern === 0) return " (sign of zero differs)";
    if (Number.isNaN(legacy) !== Number.isNaN(modern)) return " (NaN differs)";
  }
  if (typeof legacy === "number" && Number.isNaN(legacy) && modern === null) return " (NaN vs null)";
  if (typeof modern === "number" && Number.isNaN(modern) && legacy === null) return " (NaN vs null)";
  return "";
}

function compareOutcomes(
  legacy: ProbeOutcome,
  modern: ProbeOutcome,
  exact: boolean
): { matched: boolean; reason: string } {
  const view = (o: ProbeOutcome): unknown => (exact ? decodeTagged(o.output) : o.output);
  if (legacy.ok && modern.ok) {
    const a = view(legacy);
    const b = view(modern);
    if (areOutputsEquivalent(a, b)) {
      return { matched: true, reason: "Outputs match" };
    }
    return {
      matched: false,
      reason: `Output mismatch: legacy=${describeValue(a)} vs modern=${describeValue(b)}${hintFor(a, b)}`,
    };
  }
  if (!legacy.ok && !modern.ok) {
    return { matched: true, reason: "Both implementations rejected input" };
  }
  if (legacy.ok && !modern.ok) {
    return {
      matched: false,
      reason: `Modern threw ${modern.errorCode ?? "ERROR"} (${modern.errorMessage ?? "unknown"}) while legacy returned ${describeValue(view(legacy))}`,
    };
  }
  return {
    matched: false,
    reason: `Legacy threw ${legacy.errorCode ?? "ERROR"} (${legacy.errorMessage ?? "unknown"}) while modern returned ${describeValue(view(modern))}`,
  };
}

/** The most steps a shrink trace carries, so payloads stay small. */
export const MAX_SHRINK_STEPS = 6;
const MAX_STEP_TEXT = 160;
const clip = (text: string): string => (text.length > MAX_STEP_TEXT ? `${text.slice(0, MAX_STEP_TEXT - 3)}...` : text);

interface FailureRecord {
  readonly inputs: Record<string, unknown>;
  readonly legacy: ProbeOutcome;
  readonly modern: ProbeOutcome;
}

/** Text of one outcome: the value (exact mode keeps -0 / NaN / +0 apart), or `throws CODE (message)`. */
function outcomeText(outcome: ProbeOutcome, exact: boolean): string {
  if (!outcome.ok) return clip(`throws ${outcome.errorCode ?? "ERROR"}${outcome.errorMessage ? ` (${outcome.errorMessage.slice(0, 80)})` : ""}`);
  return clip(exact ? formatExactValue(outcome.output) : describeValue(outcome.output));
}

function stepOf(step: number, record: FailureRecord, exact: boolean): ShrinkStep {
  const input = Object.entries(record.inputs)
    .map(([k, v]) => `${k} = ${exact ? formatExactValue(v, 80) : describeValue(decodeTagged(v), 80)}`)
    .join(", ");
  return { step, input: clip(input), legacyOutput: outcomeText(record.legacy, exact), modernOutput: outcomeText(record.modern, exact) };
}

/**
 * The shrinking journey from the failing evaluations in the order fast-check ran them: it adopts each failing shrink
 * candidate as the new current input, so the first entry is the original failure and the last one is the minimal input.
 * At most MAX_SHRINK_STEPS entries are kept, evenly spaced, the first and the last always included.
 */
export function buildShrinkTrace(log: readonly FailureRecord[], exact: boolean, totalShrinks: number): ShrinkTrace | undefined {
  if (log.length === 0) return undefined;
  const last = log.length - 1;
  const picks = new Set<number>();
  const count = Math.min(log.length, MAX_SHRINK_STEPS);
  for (let i = 0; i < count; i++) picks.add(count === 1 ? 0 : Math.round((i * last) / (count - 1)));
  const steps = [...picks].sort((a, b) => a - b).map((index) => stepOf(index, log[index] as FailureRecord, exact));
  return { initialFailure: stepOf(0, log[0] as FailureRecord, exact), steps, finalMinimal: stepOf(last, log[last] as FailureRecord, exact), totalShrinks };
}

/** Separate executors for each side of the comparison (e.g. two warm pools). */
export interface DifferentialExecutors {
  readonly legacy: ProbeExecutor;
  readonly modern: ProbeExecutor;
}

export class DifferentialFuzzer {
  private readonly executors: DifferentialExecutors | null;

  /**
   * @param runner Executor(s) to use. When omitted, every fuzz() call creates one warm
   *               PooledProbeRunner per side and disposes both when the call finishes.
   */
  constructor(runner?: ProbeExecutor | DifferentialExecutors) {
    if (runner === undefined) {
      this.executors = null;
    } else if ("run" in runner) {
      this.executors = { legacy: runner, modern: runner };
    } else {
      this.executors = runner;
    }
  }

  private async runSingle(
    executor: ProbeExecutor,
    code: string,
    context: Record<string, unknown>,
    exact: boolean,
    settle = false
  ): Promise<ProbeOutcome> {
    const start = Date.now();
    try {
      const res = await executor.run({ code, context, ...(exact ? { encoding: "tagged" as const } : {}), ...(settle ? { settle: true } : {}) });
      return {
        ok: true,
        output: res.output,
        durationMs: res.durationMs,
      };
    } catch (err: unknown) {
      const errorCode = err instanceof SandboxError ? err.code : "INTERNAL_ERROR";
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        errorCode,
        errorMessage,
        durationMs: Date.now() - start,
      };
    }
  }

  async fuzz(
    legacyCode: string,
    modernCode: string,
    schema: InputSchema,
    options: FuzzOptions = {}
  ): Promise<FuzzReport> {
    if (this.executors !== null) {
      return this.fuzzWith(this.executors, legacyCode, modernCode, schema, options);
    }
    await using legacy = new PooledProbeRunner();
    await using modern = new PooledProbeRunner();
    // `return await` keeps both pools alive until the run finishes (see orchestrator.ts).
    return await this.fuzzWith({ legacy, modern }, legacyCode, modernCode, schema, options);
  }

  private async fuzzWith(
    executors: DifferentialExecutors,
    legacyCode: string,
    modernCode: string,
    schema: InputSchema,
    options: FuzzOptions
  ): Promise<FuzzReport> {
    const startedAt = Date.now();
    const numRuns = options.numRuns ?? 25;
    const maxTraces = options.maxTraces ?? 15;
    const traces: FuzzTrace[] = [];
    const failuresByKey = new Map<string, CounterexampleReport>();
    /** Every failing evaluation, in order: after the first failure this is the shrink path fast-check walked. */
    const failureLog: FailureRecord[] = [];

    const supportsTagged =
      executors.legacy.supportsTaggedEncoding === true && executors.modern.supportsTaggedEncoding === true;
    const exact = supportsTagged && (options.exact ?? true);
    const boundary = exact && (options.boundary ?? numRuns >= BOUNDARY_MIN_RUNS);
    const settle = options.settle === true;
    if (settle && (executors.legacy.supportsSettle !== true || executors.modern.supportsSettle !== true)) {
      throw new Error("Async (settle) fuzzing needs executors that support ProbeParams.settle (the pooled sandbox runner)");
    }

    const evaluate = async (inputs: Record<string, unknown>): Promise<boolean> => {
      const wire = exact ? (encodeTagged(inputs) as Record<string, unknown>) : inputs;
      const [legacy, modern] = await Promise.all([
        this.runSingle(executors.legacy, legacyCode, wire, exact, settle),
        this.runSingle(executors.modern, modernCode, wire, exact, settle),
      ]);
      options.observe?.(wire, legacy, modern);
      const { matched, reason } = compareOutcomes(legacy, modern, exact);
      if (traces.length < maxTraces) {
        traces.push({ inputs: wire, legacy, modern, matched });
      }
      if (!matched) {
        failuresByKey.set(JSON.stringify(wire), { inputs: wire, legacy, modern, reason, ...(exact ? { exact } : {}) });
        failureLog.push({ inputs: wire, legacy, modern });
      }
      return matched;
    };

    const examples = (options.examples ?? []).slice(0, Math.floor(numRuns / 2));
    const corpus = [...examples, ...(boundary ? buildBoundaryCorpus(schema, Math.max(0, Math.floor(numRuns / 2) - examples.length)) : [])];
    let corpusExecuted = 0;
    for (const inputs of corpus) {
      corpusExecuted++;
      if (!(await evaluate(inputs))) {
        // Boundary inputs are already minimal, so there is nothing to shrink.
        const failure = failuresByKey.get(JSON.stringify(exact ? encodeTagged(inputs) : inputs));
        const corpusTrace = failure !== undefined ? buildShrinkTrace(failureLog, exact, 0) : undefined;
        return {
          passed: false,
          totalRuns: corpusExecuted,
          durationMs: Date.now() - startedAt,
          seed: options.seed ?? 0,
          traces,
          ...(failure !== undefined ? { counterexample: corpusTrace !== undefined ? { ...failure, shrinkTrace: corpusTrace } : failure } : {}),
          exact,
          boundaryRuns: corpusExecuted,
        };
      }
    }

    const recordArb = boundary ? buildBoundaryRecordArbitrary(schema) : buildRecordArbitrary(schema);
    const property = fc.asyncProperty(recordArb, evaluate);

    const details = await fc.check(property, {
      numRuns: numRuns - corpusExecuted,
      ...(options.shrink === false ? { endOnFailure: true } : {}),
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
    });

    const durationMs = Date.now() - startedAt;
    const totalRuns = corpusExecuted + details.numRuns;

    if (!details.failed) {
      return {
        passed: true,
        totalRuns,
        durationMs,
        seed: details.seed,
        traces,
        exact,
        boundaryRuns: corpusExecuted,
      };
    }

    const shrunkInputs = details.counterexample?.[0] ?? {};
    const shrunkWire = exact ? (encodeTagged(shrunkInputs) as Record<string, unknown>) : shrunkInputs;
    const shrunkKey = JSON.stringify(shrunkWire);
    const fallbackFailure = Array.from(failuresByKey.values()).at(-1);
    const counterexample: CounterexampleReport = failuresByKey.get(shrunkKey) ??
      fallbackFailure ?? {
        inputs: shrunkWire,
        legacy: { ok: false, durationMs: 0 },
        modern: { ok: false, durationMs: 0 },
        reason: "Behavioral divergence detected",
        ...(exact ? { exact } : {}),
      };

    const shrinkTrace = buildShrinkTrace(failureLog, exact, details.numShrinks);
    return {
      passed: false,
      totalRuns,
      durationMs,
      seed: details.seed,
      traces,
      counterexample: shrinkTrace !== undefined ? { ...counterexample, shrinkTrace } : counterexample,
      exact,
      boundaryRuns: corpusExecuted,
    };
  }
}
