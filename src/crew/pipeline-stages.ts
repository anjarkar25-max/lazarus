// Time-Travel Stepper data: the stages a resurrection really went through.
//
// Nothing here is mocked. The Orchestrator hands over the candidate of every attempt and the counterexamples the Exorcist found; the
// server adds the strict TypeScript the Type Alchemist emitted and what the run proved. A stage that did not happen is not listed (there
// is no `rollback` stage when the first candidate passed).
//   0 legacy      the specimen as written
//   1 candidate   the first AST-modernized candidate (`security-guards` when global-leak-fix or proto-pollution-guard fired)
//   2 rollback    the shrunken counterexample that broke Object.is parity, and the healed code after the rollback
//   3 typed       strict TypeScript (tsc --strict result attached)
//   4 verified    the proven, Ed25519-signed artifact with the five pillars
import type { CounterexampleReport } from "../fuzzer/types.js";
import { defaultLevels, modernize, readHeaderLevels } from "./ast-modernizer.js";
import { formatInputs, formatOutcome } from "./exact-format.js";
import type { RuleBlameEntry } from "./rule-blame.js";

export type StageId = "legacy" | "candidate" | "security-guards" | "rollback" | "typed" | "verified";

/** Rules that make the first candidate a `security-guards` stage. */
export const SECURITY_GUARD_RULES: readonly string[] = ["global-leak-fix", "proto-pollution-guard"];

export interface StageRule {
  readonly rule: string;
  readonly sites: number;
  readonly before: string;
  readonly after: string;
  readonly note: string;
}

export interface StageCounterexample {
  /** 1-based attempt whose differential run found it. */
  readonly attempt: number;
  /** The shrunken failing input, e.g. `n = 2147483648`. */
  readonly input: string;
  readonly legacyOutput: string;
  readonly candidateOutput: string;
  readonly reason: string;
  /** Accepted shrinks fast-check took to reach this input. */
  readonly shrinks: number;
  /** The first failing input, before shrinking, when the failure was shrunk. */
  readonly firstFailure?: string;
}

export interface StageTypecheck {
  readonly passed: boolean;
  readonly errorCount: number;
  readonly filesChecked: number;
  readonly tsVersion: string;
  readonly adjustments: readonly string[];
}

export interface StagePillars {
  readonly parity: { readonly runs: number; readonly exact: boolean };
  /** null when the purity pillar was not measured. */
  readonly purity: { readonly proven: boolean } | null;
  /** Measured by the Mutant Autopsy after the run; the stage cannot know it. */
  readonly mutants: null;
  readonly ed25519: { readonly keyId: string; readonly resurrectedSha256: string } | null;
  readonly seed: number | null;
}

export interface PipelineStage {
  /** 0 to 4: the position in the pipeline (a skipped rollback leaves the numbers as they are). */
  readonly stage: 0 | 1 | 2 | 3 | 4;
  readonly id: StageId;
  /** The pill text. */
  readonly label: string;
  readonly language: "javascript" | "typescript";
  readonly code: string;
  /** The stage whose code this one is shown against (null: nothing to compare with). */
  readonly compareTo: StageId | null;
  /** One line for the stepper's note. */
  readonly summary: string;
  readonly rules?: readonly StageRule[];
  readonly counterexample?: StageCounterexample;
  /** AST rules the Exorcist rolled back (rollback stage). */
  readonly rolledBack?: readonly string[];
  readonly typecheck?: StageTypecheck;
  readonly pillars?: StagePillars;
}

export interface AttemptRecord {
  readonly attempt: number;
  readonly code: string;
  counterexample?: CounterexampleReport;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/** The AST rewrites of one candidate, grouped by rule: re-run at the levels recorded in the candidate's own `// ast-rules:` header. */
export function rulesOfCandidate(legacyCode: string, candidate: string, inputs: readonly string[]): StageRule[] | undefined {
  const levels = readHeaderLevels(candidate);
  if (levels === undefined) return undefined;
  const result = modernize(legacyCode, { levels: { ...defaultLevels(), ...levels }, inputs });
  if (!result.parsed) return undefined;
  const byRule = new Map<string, typeof result.applied>();
  for (const a of result.applied) byRule.set(a.rule, [...(byRule.get(a.rule) ?? []), a]);
  return [...byRule.entries()].map(([rule, items]) => {
    const first = items[0];
    return { rule, sites: items.length, before: clip(first?.before ?? "", 60), after: clip(first?.after ?? "", 60), note: clip(first?.note ?? "", 160) };
  });
}

function describeCounterexample(attempt: number, cx: CounterexampleReport): StageCounterexample {
  const trace = cx.shrinkTrace;
  return {
    attempt,
    input: formatInputs(cx.inputs),
    legacyOutput: formatOutcome(cx.legacy),
    candidateOutput: formatOutcome(cx.modern),
    reason: cx.reason,
    shrinks: trace?.totalShrinks ?? 0,
    ...(trace !== undefined && trace.initialFailure.input !== trace.finalMinimal.input ? { firstFailure: trace.initialFailure.input } : {}),
  };
}

export interface DraftInput {
  /** The runnable specimen the Exorcist fuzzed (the extracted expression). */
  readonly legacyCode: string;
  readonly attempts: readonly AttemptRecord[];
  /** The candidate that passed. */
  readonly finalCode: string;
  readonly inputs: readonly string[];
  readonly ruleBlame?: readonly RuleBlameEntry[];
}

/** Stages 0 to 2 from what the Orchestrator really did. */
export function buildDraftStages(input: DraftInput): PipelineStage[] {
  const stages: PipelineStage[] = [];
  const idioms = input.legacyCode.split("\n").length;
  stages.push({ stage: 0, id: "legacy", label: "Legacy", language: "javascript", code: input.legacyCode, compareTo: null, summary: `The specimen as written: ${plural(idioms, "line")} of ES5/CommonJS.` });

  const first = input.attempts[0];
  if (first === undefined) return stages;
  const rules = rulesOfCandidate(input.legacyCode, first.code, input.inputs);
  const guards = (rules ?? []).filter((r) => SECURITY_GUARD_RULES.includes(r.rule));
  const id: StageId = guards.length > 0 ? "security-guards" : "candidate";
  const rewrites = (rules ?? []).reduce((n, r) => n + r.sites, 0);
  const listed = (rules ?? []).map((r) => `${r.rule}${r.sites > 1 ? ` \u00d7${r.sites}` : ""}`).join(", ");
  stages.push({
    stage: 1,
    id,
    label: guards.length > 0 ? "Security Guards" : "Candidate",
    language: "javascript",
    code: first.code,
    compareTo: "legacy",
    rules: rules ?? [],
    summary:
      rules === undefined
        ? "The first draft of the synthesizer (it carries no AST rule header)."
        : `${plural(rewrites, "AST rewrite")}${listed === "" ? "" : `: ${listed}`}${guards.length > 0 ? `; security guards: ${guards.map((g) => g.rule).join(", ")}` : ""}.`,
  });

  const failed = input.attempts.find((a) => a.counterexample !== undefined);
  if (failed?.counterexample !== undefined) {
    const cx = describeCounterexample(failed.attempt, failed.counterexample);
    const rolledBack = (input.ruleBlame ?? []).filter((b) => b.status === "rolled-back").map((b) => b.rule);
    const healedAttempt = input.attempts[input.attempts.length - 1]?.attempt ?? failed.attempt + 1;
    stages.push({
      stage: 2,
      id: "rollback",
      label: "Rollback",
      language: "javascript",
      code: input.finalCode,
      compareTo: id,
      counterexample: cx,
      rolledBack,
      summary: `Counterexample ${clip(cx.input, 60)} broke Object.is parity (legacy ${clip(cx.legacyOutput, 24)} vs candidate ${clip(cx.candidateOutput, 24)}); ${rolledBack.length > 0 ? `rolled back ${rolledBack.join(", ")}` : "the rejected draft was replaced"}; attempt ${healedAttempt} proved parity.`,
    });
  }
  return stages;
}

export interface CompleteInput {
  /** The original source as written: the Studio's legacy side of the diff. */
  readonly legacySource: string;
  /** The strict TypeScript of the bundle (what tsc --strict checked). */
  readonly typedCode: string;
  readonly typecheck: StageTypecheck;
  /** The proven candidate: the code the Ed25519 signature vouches for. */
  readonly finalCode: string;
  readonly pillars: StagePillars;
}

/** Adds stages 3 and 4 and puts the source as written into stage 0. */
export function completePipeline(draft: readonly PipelineStage[], input: CompleteInput): PipelineStage[] {
  const stages: PipelineStage[] = draft.map((s) => (s.stage === 0 ? { ...s, code: input.legacySource } : s));
  const proven = stages[stages.length - 1];
  const tc = input.typecheck;
  stages.push({
    stage: 3,
    id: "typed",
    label: "Typed",
    language: "typescript",
    code: input.typedCode,
    compareTo: proven?.id ?? "legacy",
    typecheck: tc,
    summary: `Type Alchemist: strict TypeScript, tsc --strict: ${plural(tc.errorCount, "error")} across ${plural(tc.filesChecked, "file")} (TypeScript ${tc.tsVersion})${tc.adjustments.length > 0 ? `; ${plural(tc.adjustments.length, "member")} declared any at the migration boundary` : ""}.`,
  });
  const p = input.pillars;
  const proofs = [
    `exact Object.is parity over ${plural(p.parity.runs, "run")}`,
    p.purity === null ? "purity not measured" : p.purity.proven ? "purity proven" : "purity NOT proven",
    "mutants: run the Mutant Autopsy",
    p.ed25519 === null ? "unsigned" : `Ed25519 key ${p.ed25519.keyId}`,
    p.seed === null ? "no seed" : `seed ${p.seed}`,
  ];
  stages.push({ stage: 4, id: "verified", label: "Verified", language: "javascript", code: input.finalCode, compareTo: "legacy", pillars: p, summary: `Verified artifact: ${proofs.join(" \u00b7 ")}.` });
  return stages;
}
