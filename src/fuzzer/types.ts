export type ParamKind = "integer" | "number" | "string" | "boolean" | "json";

export type InputSchema = Record<string, ParamKind>;

export interface ProbeOutcome {
  ok: boolean;
  output?: unknown;
  errorCode?: string;
  errorMessage?: string;
  durationMs: number;
}

export interface FuzzTrace {
  inputs: Record<string, unknown>;
  legacy: ProbeOutcome;
  modern: ProbeOutcome;
  matched: boolean;
}

export interface CounterexampleReport {
  inputs: Record<string, unknown>;
  legacy: ProbeOutcome;
  modern: ProbeOutcome;
  reason: string;
}

export interface FuzzOptions {
  numRuns?: number;
  seed?: number;
  maxTraces?: number;
}

export interface FuzzReport {
  passed: boolean;
  totalRuns: number;
  durationMs: number;
  seed: number;
  traces: FuzzTrace[];
  counterexample?: CounterexampleReport;
}
