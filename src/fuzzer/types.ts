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
