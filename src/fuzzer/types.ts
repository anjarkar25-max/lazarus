export type ParamKind = "integer" | "number" | "string" | "boolean" | "json";

export type InputSchema = Record<string, ParamKind>;

export interface ProbeOutcome {
  ok: boolean;
  /**
   * The value the probe returned. In exact mode this is the tagged wire form (see sandbox/tagged.ts):
   * identical to the plain value except that -0, NaN, +/-Infinity and undefined appear as
   * `{"$lazarus": ...}` markers, so they survive JSON.
   */
  output?: unknown;
  errorCode?: string;
  errorMessage?: string;
  durationMs: number;
}

export interface FuzzTrace {
  /** Wire form (tagged when the run was exact). */
  inputs: Record<string, unknown>;
  legacy: ProbeOutcome;
  modern: ProbeOutcome;
  matched: boolean;
}

export interface CounterexampleReport {
  /** Wire form (tagged when the run was exact). */
  inputs: Record<string, unknown>;
  legacy: ProbeOutcome;
  modern: ProbeOutcome;
  reason: string;
  /** The comparison that found this was exact (tagged Object.is). Replays must use the same mode. */
  exact?: boolean;
  /** The real shrinking journey fast-check took to reach this input (additive; absent only for synthetic reports). */
  shrinkTrace?: ShrinkTrace;
}

/** One failing input of the shrinking journey, formatted as text so `-0`, `NaN` and `undefined` stay distinguishable. */
export interface ShrinkStep {
  /** 0 is the first failing input; the last step is the minimal one. */
  step: number;
  input: string;
  legacyOutput: string;
  modernOutput: string;
}

export interface ShrinkTrace {
  initialFailure: ShrinkStep;
  /** At most MAX_SHRINK_STEPS representative entries of the failing sequence, first and last included. */
  steps: ShrinkStep[];
  finalMinimal: ShrinkStep;
  /** fast-check's own count of accepted shrinks (0 when the failure came from the boundary corpus). */
  totalShrinks: number;
}

export interface FuzzOptions {
  numRuns?: number;
  seed?: number;
  maxTraces?: number;
  /**
   * Compare with exact Object.is semantics over the tagged encoding. Defaults to true when both
   * executors declare `supportsTaggedEncoding`; otherwise (or when false) values are compared at JSON level.
   */
  exact?: boolean;
  /**
   * Run the deterministic boundary corpus first and bias the random runs towards boundary values.
   * Defaults to true for exact runs of at least 50 runs. Ignored when the run is not exact.
   */
  boundary?: boolean;
  /** Set false to stop at the first failing input without shrinking it (faster; used by the mutation auditor). */
  shrink?: boolean;
  /** Called for every evaluated input with the wire-form inputs and both outcomes (used by the Type Alchemist). */
  observe?: (inputs: Record<string, unknown>, legacy: ProbeOutcome, modern: ProbeOutcome) => void;
  /** Async probes: both sides return a promise that the sandbox settles (see ProbeParams.settle). Needs executors with supportsSettle. */
  settle?: boolean;
  /** Extra deterministic inputs (plain values) run first, before the boundary corpus, e.g. a dictionary of literals from the specimen. */
  examples?: ReadonlyArray<Record<string, unknown>>;
}

export interface FuzzReport {
  passed: boolean;
  totalRuns: number;
  durationMs: number;
  seed: number;
  traces: FuzzTrace[];
  counterexample?: CounterexampleReport;
  /** Whether the comparison was exact (tagged Object.is) or JSON-level. */
  exact?: boolean;
  /** How many of `totalRuns` came from the deterministic boundary corpus. */
  boundaryRuns?: number;
}
