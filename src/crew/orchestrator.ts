import * as fc from "fast-check";
import { DifferentialFuzzer, buildRecordArbitrary } from "../fuzzer/differential.js";
import type { FuzzTrace } from "../fuzzer/types.js";
import { ProbeRunner } from "../sandbox/runner.js";
import { DeterministicModernizer } from "./synthesizer.js";
import type {
  AgentRole,
  CodeSynthesizer,
  CrewEvent,
  CrewEventType,
  ResurrectionRequest,
  ResurrectionResult,
} from "./types.js";

export class ResurrectionOrchestrator {
  private readonly runner: ProbeRunner;
  private readonly fuzzer: DifferentialFuzzer;
  private readonly synthesizer: CodeSynthesizer;

  constructor(options?: {
    runner?: ProbeRunner;
    fuzzer?: DifferentialFuzzer;
    synthesizer?: CodeSynthesizer;
  }) {
    this.runner = options?.runner ?? new ProbeRunner();
    this.fuzzer = options?.fuzzer ?? new DifferentialFuzzer(this.runner);
    this.synthesizer = options?.synthesizer ?? new DeterministicModernizer();
  }

  async resurrect(request: ResurrectionRequest): Promise<ResurrectionResult> {
    const events: CrewEvent[] = [];
    const emit = (
      agent: AgentRole,
      type: CrewEventType,
      message: string,
      payload?: Record<string, unknown>
    ) => {
      const event: CrewEvent = {
        timestamp: new Date().toISOString(),
        agent,
        type,
        message,
        ...(payload !== undefined ? { payload } : {}),
      };
      events.push(event);
      request.onEvent?.(event);
    };

    // 1. ARCHAEOLOGIST: Probe legacy code on boundary inputs inside sandbox
    emit("archaeologist", "agent_started", `Probing legacy module "${request.name}" in isolated sandbox`);
    const sampleInputs = fc.sample(buildRecordArbitrary(request.schema), {
      numRuns: 5,
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
    });

    const baselineTraces: FuzzTrace[] = [];
    for (const inputs of sampleInputs) {
      const start = Date.now();
      try {
        const res = await this.runner.run({ code: request.legacyCode, context: inputs });
        const outcome = { ok: true, output: res.output, durationMs: res.durationMs };
        baselineTraces.push({ inputs, legacy: outcome, modern: outcome, matched: true });
      } catch (err: unknown) {
        const outcome = {
          ok: false,
          errorMessage: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - start,
        };
        baselineTraces.push({ inputs, legacy: outcome, modern: outcome, matched: true });
      }
    }
    emit("archaeologist", "probe_sampled", `Captured ${baselineTraces.length} baseline runtime traces`, {
      sampleCount: baselineTraces.length,
    });

    // 2. ARCHITECT: Synthesize formal Kiro requirements & behavioral spec
    emit("architect", "agent_started", "Synthesizing formal Kiro specification from observed runtime traces");
    const paramLines = Object.entries(request.schema)
      .map(([k, v]) => `- \`${k}\`: \`${v}\``)
      .join("\n");
    const traceLines = baselineTraces
      .slice(0, 3)
      .map(
        (t) =>
          `- Input \`${JSON.stringify(t.inputs)}\` -> ${
            t.legacy.ok ? `Output \`${JSON.stringify(t.legacy.output)}\`` : `Error \`${t.legacy.errorMessage}\``
          }`
      )
      .join("\n");

    const specMarkdown = [
      `# Specification: ${request.name}`,
      "",
      "## Input Contract",
      paramLines || "- No external parameters",
      "",
      "## Observed Behavioral Invariants",
      traceLines,
      "",
      "## Acceptance Criteria",
      "- Modernized implementation MUST preserve exact `Object.is` output parity across all fuzzed inputs.",
    ].join("\n");

    emit("architect", "spec_generated", "Generated formal behavioral specification", { specMarkdown });

    // 3 & 4. NECROMANCER <-> EXORCIST Self-Healing Loop
    const maxAttempts = request.maxHealingAttempts ?? 3;
    const fuzzRuns = request.fuzzRuns ?? 20;
    let modernCode = "";
    let lastReport = await this.fuzzer.fuzz(request.legacyCode, request.legacyCode, request.schema, {
      numRuns: 1,
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      emit(
        "necromancer",
        "agent_started",
        attempt === 1
          ? "Synthesizing modern TypeScript/ES2022 implementation from spec"
          : `Self-healing implementation (attempt ${attempt}/${maxAttempts}) using shrunk counterexample`
      );

      modernCode = await this.synthesizer.synthesize({
        name: request.name,
        legacyCode: request.legacyCode,
        schema: request.schema,
        specMarkdown,
        traces: baselineTraces,
        attempt,
        ...(attempt > 1 ? { previousCandidate: modernCode } : {}),
        ...(attempt > 1 && lastReport.counterexample ? { counterexample: lastReport.counterexample } : {}),
      });

      emit("necromancer", "code_synthesized", `Produced candidate build #${attempt}`, {
        attempt,
        modernCode,
      });

      emit("exorcist", "agent_started", `Fuzzing candidate #${attempt} across ${fuzzRuns} generated inputs`);
      lastReport = await this.fuzzer.fuzz(request.legacyCode, modernCode, request.schema, {
        numRuns: fuzzRuns,
        ...(request.seed !== undefined ? { seed: request.seed + attempt } : {}),
      });

      emit("exorcist", "fuzz_completed", `Completed ${lastReport.totalRuns} differential runs`, {
        passed: lastReport.passed,
        totalRuns: lastReport.totalRuns,
      });

      if (lastReport.passed) {
        if (attempt > 1) {
          emit("exorcist", "self_healed", `Behavioral parity verified after ${attempt} attempts`);
        }
        emit("exorcist", "completed", `Resurrection complete: 100% parity proven across ${lastReport.totalRuns} runs`);
        return {
          success: true,
          name: request.name,
          legacyCode: request.legacyCode,
          specMarkdown,
          modernCode,
          attempts: attempt,
          fuzzReport: lastReport,
          events,
        };
      }

      emit(
        "exorcist",
        "counterexample_found",
        `Divergence detected: ${lastReport.counterexample?.reason ?? "unknown mismatch"}`,
        { counterexample: lastReport.counterexample }
      );
    }

    emit("exorcist", "completed", `Resurrection finished with unresolved divergence after ${maxAttempts} attempts`);
    return {
      success: false,
      name: request.name,
      legacyCode: request.legacyCode,
      specMarkdown,
      modernCode,
      attempts: maxAttempts,
      fuzzReport: lastReport,
      events,
    };
  }
}
