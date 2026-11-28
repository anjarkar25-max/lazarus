import * as fc from "fast-check";
import { DifferentialFuzzer, buildRecordArbitrary } from "../fuzzer/differential.js";
import type { CounterexampleReport, FuzzTrace } from "../fuzzer/types.js";
import { PooledProbeRunner } from "../sandbox/pool.js";
import type { ProbeExecutor } from "../sandbox/types.js";
import { modernize, summarizeForSpec } from "./ast-modernizer.js";
import { DeterministicModernizer } from "./synthesizer.js";
import { computeRuleBlame } from "./rule-blame.js";
import { resurrectPromiseChainWith } from "./es5-idioms.js";
import { plural } from "../text/plural.js";
import { resurrectErrorFirstWith, type ErrorFirstRequest, type ErrorFirstResult } from "./async-callback.js";
import type {
  AgentRole,
  CodeSynthesizer,
  CrewEvent,
  CrewEventType,
  ResurrectionRequest,
  ResurrectionResult,
} from "./types.js";

interface SessionDeps {
  readonly runner: ProbeExecutor;
  readonly fuzzer: DifferentialFuzzer;
  /** Pools whose real counters back the wire trace (empty when the executors are not pools). */
  readonly pools: readonly PooledProbeRunner[];
}

/** Tool names in wire traces. Sandbox batches go through the `lazarus-sandbox` MCP server's tool. */
export const TRACE_TOOLS = {
  sandboxProbe: "lazarus-sandbox/run_legacy_probe",
  astScan: "lazarus/ast_scan",
  tscStrict: "lazarus/tsc_strict",
} as const;

/** Payload of an `mcp_trace` event, measured from the actual execution. */
export interface WireTrace {
  readonly tool: string;
  readonly durationMs: number;
  /**
   * Sandbox batches: no new worker process had to start during the batch (warm pool reused).
   * Strict tsc: the warm compiler process was reused. In-process steps: null.
   */
  readonly poolReused: boolean | null;
  readonly summary: string;
  /** Sandbox probes actually dispatched during the batch (from the pool counters), when known. */
  readonly probes?: number;
  /** Worker processes started during the batch, when known. */
  readonly spawned?: number;
}

const roundMs = (ms: number): number => Math.round(ms * 100) / 100;

export class ResurrectionOrchestrator {
  private readonly runner: ProbeExecutor | undefined;
  private readonly fuzzer: DifferentialFuzzer | undefined;
  private readonly synthesizer: CodeSynthesizer;

  constructor(options?: {
    runner?: ProbeExecutor;
    fuzzer?: DifferentialFuzzer;
    synthesizer?: CodeSynthesizer;
  }) {
    this.runner = options?.runner;
    this.fuzzer = options?.fuzzer ?? (this.runner !== undefined ? new DifferentialFuzzer(this.runner) : undefined);
    this.synthesizer = options?.synthesizer ?? new DeterministicModernizer();
  }

  async resurrect(request: ResurrectionRequest): Promise<ResurrectionResult> {
    if (this.runner !== undefined && this.fuzzer !== undefined) {
      return this.resurrectWith({ runner: this.runner, fuzzer: this.fuzzer, pools: this.runner instanceof PooledProbeRunner ? [this.runner] : [] }, request);
    }
    // One warm worker per side for the whole session, always torn down on exit.
    await using legacyPool = new PooledProbeRunner();
    await using modernPool = new PooledProbeRunner();
    const fuzzer = this.fuzzer ?? new DifferentialFuzzer({ legacy: legacyPool, modern: modernPool });
    // `return await` is required: a bare `return` would leave the `await using` scope (and
    // close both pools) before the session has finished.
    const pools = this.runner instanceof PooledProbeRunner ? [this.runner, ...(this.fuzzer === undefined ? [modernPool] : [])] : this.fuzzer === undefined ? [legacyPool, modernPool] : [legacyPool];
    return await this.resurrectWith({ runner: this.runner ?? legacyPool, fuzzer, pools }, request);
  }

  /**
   * Additive async pass: a Node.js error-first callback module (`fn(a, cb)`) is lifted to `async fn(a)` and both
   * settlements are fuzzed in the pooled sandbox (see async-callback.ts). `resurrect()` is unchanged.
   */
  async resurrectErrorFirst(request: ErrorFirstRequest): Promise<ErrorFirstResult> {
    if (this.fuzzer !== undefined) return resurrectErrorFirstWith(this.fuzzer, request);
    await using legacyPool = new PooledProbeRunner();
    await using modernPool = new PooledProbeRunner();
    // `return await` keeps both pools alive until the session has finished.
    return await resurrectErrorFirstWith(new DifferentialFuzzer({ legacy: legacyPool, modern: modernPool }), request);
  }
  /** Additive async pass for a legacy `.then().catch()` Promise chain (see es5-idioms.ts). */
  async resurrectPromiseChain(request: ErrorFirstRequest): Promise<ErrorFirstResult> {
    if (this.fuzzer !== undefined) return resurrectPromiseChainWith(this.fuzzer, request);
    await using legacyPool = new PooledProbeRunner();
    await using modernPool = new PooledProbeRunner();
    return await resurrectPromiseChainWith(new DifferentialFuzzer({ legacy: legacyPool, modern: modernPool }), request);
  }
  private async resurrectWith(deps: SessionDeps, request: ResurrectionRequest): Promise<ResurrectionResult> {
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
    const counters = (): { spawns: number; probes: number } =>
      deps.pools.reduce((acc, p) => ({ spawns: acc.spawns + p.stats.spawns, probes: acc.probes + p.stats.probes }), { spawns: 0, probes: 0 });
    /** Runs a sandbox batch and emits its wire trace from the real timings and pool counters. */
    const traceSandbox = async <T>(agent: AgentRole, run: () => Promise<T>, summarize: (value: T) => string): Promise<T> => {
      const before = counters();
      const started = performance.now();
      const value = await run();
      const durationMs = roundMs(performance.now() - started);
      const after = counters();
      const known = deps.pools.length > 0;
      const trace: WireTrace = {
        tool: TRACE_TOOLS.sandboxProbe,
        durationMs,
        poolReused: known ? after.spawns === before.spawns : null,
        summary: summarize(value),
        ...(known ? { probes: after.probes - before.probes, spawned: after.spawns - before.spawns } : {}),
      };
      emit(agent, "mcp_trace", `${trace.tool} \u00b7 ${durationMs} ms \u00b7 ${trace.summary}`, { ...trace });
      return value;
    };

    // 1. ARCHAEOLOGIST: Probe legacy code on boundary inputs inside sandbox
    emit("archaeologist", "agent_started", `Probing legacy module "${request.name}" in isolated sandbox`);
    const sampleInputs = fc.sample(buildRecordArbitrary(request.schema), {
      numRuns: 5,
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
    });

    const baselineTraces: FuzzTrace[] = [];
    await traceSandbox("archaeologist", async () => {
    for (const inputs of sampleInputs) {
      const start = Date.now();
      try {
        const res = await deps.runner.run({ code: request.legacyCode, context: inputs });
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
    }, () => `${sampleInputs.length} boundary probes of the legacy specimen`);
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

    // AST scan of the legacy code (acorn parse + rewrite analysis, in process; nothing is executed).
    const scanStarted = performance.now();
    const scanned = modernize(request.legacyCode);
    const idiomLines = summarizeForSpec(scanned);
    const scanTrace: WireTrace = {
      tool: TRACE_TOOLS.astScan,
      durationMs: roundMs(performance.now() - scanStarted),
      poolReused: null,
      summary: scanned.parsed ? `${plural(scanned.applied.length, "rewrite site")}, ${scanned.flagged.length} flagged` : "source did not parse",
    };
    emit("architect", "mcp_trace", `${scanTrace.tool} \u00b7 ${scanTrace.durationMs} ms \u00b7 ${scanTrace.summary}`, { ...scanTrace });
    const specMarkdown = [
      `# Specification: ${request.name}`,
      "",
      "## Input Contract",
      paramLines || "- No external parameters",
      "",
      "## Observed Behavioral Invariants",
      traceLines,
      "",
      "## Legacy Idioms (AST analysis)",
      ...idiomLines,
      "",
      "## Acceptance Criteria",
      "- Modernized implementation MUST preserve exact `Object.is` output parity across all fuzzed inputs.",
    ].join("\n");

    emit("architect", "spec_generated", "Generated formal behavioral specification", { specMarkdown });

    // 3 & 4. NECROMANCER <-> EXORCIST Self-Healing Loop
    const maxAttempts = request.maxHealingAttempts ?? 3;
    const fuzzRuns = request.fuzzRuns ?? 20;
    let modernCode = "";
    /** The Exorcist's counterexamples in order: the n-th one ended attempt n (Rule Blame links rollbacks to them). */
    const counterexamples: CounterexampleReport[] = [];
    const blame = (): { ruleBlame: ReturnType<typeof computeRuleBlame> } => ({ ruleBlame: computeRuleBlame(request.legacyCode, modernCode, counterexamples) });
    let lastReport = await traceSandbox(
      "exorcist",
      () =>
        deps.fuzzer.fuzz(request.legacyCode, request.legacyCode, request.schema, {
          numRuns: 1,
          exact: request.exact ?? false,
          ...(request.seed !== undefined ? { seed: request.seed } : {}),
        }),
      (r) => `${plural(r.totalRuns, "warm-up run")} of the oracle against itself`
    );

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
      const observed: NonNullable<ResurrectionResult["observations"]> = [];
      lastReport = await traceSandbox("exorcist", () => deps.fuzzer.fuzz(request.legacyCode, modernCode, request.schema, {
        ...(request.collectObservations === true
          ? { observe: (inputs: Record<string, unknown>, legacy: { ok: boolean; output?: unknown }) => void observed.push({ inputs, ok: legacy.ok, ...(legacy.ok ? { output: legacy.output } : {}) }) }
          : {}),
        numRuns: fuzzRuns,
        exact: request.exact ?? false,
        ...(request.seed !== undefined ? { seed: request.seed + attempt } : {}),
      }), (r) => `${plural(r.totalRuns, "differential run")}, candidate #${attempt} vs legacy: ${r.passed ? "exact parity" : "counterexample found"}`);

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
          ...(request.collectObservations === true ? { observations: observed } : {}),
          ...blame(),
        };
      }
      if (lastReport.counterexample !== undefined) counterexamples.push(lastReport.counterexample);

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
      ...blame(),
    };
  }
}
