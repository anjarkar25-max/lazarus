import type { CounterexampleReport, FuzzReport, FuzzTrace, InputSchema } from "../fuzzer/types.js";
import type { PurityProof } from "./purity-audit.js";
import type { RuleBlameEntry } from "./rule-blame.js";
import type { PipelineStage } from "./pipeline-stages.js";

export type AgentRole = "archaeologist" | "architect" | "necromancer" | "exorcist";

export type CrewEventType =
  | "agent_started"
  | "probe_sampled"
  | "spec_generated"
  | "code_synthesized"
  | "fuzz_completed"
  | "counterexample_found"
  | "self_healed"
  | "completed"
  /** Wire trace of a real tool execution (sandbox probe batch, AST scan, strict tsc check). */
  | "mcp_trace";

export interface CrewEvent {
  timestamp: string;
  agent: AgentRole;
  type: CrewEventType;
  message: string;
  payload?: Record<string, unknown>;
}

export interface ResurrectionRequest {
  name: string;
  legacyCode: string;
  schema: InputSchema;
  fuzzRuns?: number;
  seed?: number;
  maxHealingAttempts?: number;
  /** Compare with exact tagged Object.is semantics (-0, NaN, undefined). Defaults to JSON-level for backward compatibility. */
  exact?: boolean;
  /** Record every input/legacy-output pair of the passing fuzz run (for the Type Alchemist). */
  collectObservations?: boolean;
  /** Also run the purity audit (global leaks, prototype safety, input mutation) on a proven resurrection. Off unless asked. */
  purityAudit?: boolean;
  /** Keep the stages of the run (legacy, candidate, rollback) for the Time-Travel Stepper. Off unless asked. */
  recordPipeline?: boolean;
  onEvent?: (event: CrewEvent) => void;
}

export interface SynthesizeContext {
  name: string;
  legacyCode: string;
  schema: InputSchema;
  specMarkdown: string;
  traces: FuzzTrace[];
  attempt: number;
  previousCandidate?: string;
  counterexample?: CounterexampleReport;
}

export interface CodeSynthesizer {
  synthesize(ctx: SynthesizeContext): Promise<string>;
}

export interface ResurrectionResult {
  success: boolean;
  name: string;
  legacyCode: string;
  specMarkdown: string;
  modernCode: string;
  attempts: number;
  fuzzReport: FuzzReport;
  events: CrewEvent[];
  /** Inputs and legacy outcomes of the passing fuzz run (only with collectObservations). */
  observations?: Array<{ inputs: Record<string, unknown>; ok: boolean; output?: unknown }>;
  /** Which AST rules rewrote (or were rolled back in) this resurrection, where, and why (Rule Blame X-Ray). */
  ruleBlame?: RuleBlameEntry[];
  /** The fifth proof pillar, measured in the sandbox (only with `purityAudit` and a proven resurrection). */
  purityProof?: PurityProof;
  /** Stages 0 to 2 of the pipeline, from what really happened (only with `recordPipeline` and a proven resurrection). */
  pipelineStages?: PipelineStage[];
}
