import type { CounterexampleReport, FuzzReport, FuzzTrace, InputSchema } from "../fuzzer/types.js";

export type AgentRole = "archaeologist" | "architect" | "necromancer" | "exorcist";

export type CrewEventType =
  | "agent_started"
  | "probe_sampled"
  | "spec_generated"
  | "code_synthesized"
  | "fuzz_completed"
  | "counterexample_found"
  | "self_healed"
  | "completed";

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
}
