import { PooledProbeRunner } from "../sandbox/pool.js";
import type { ProbeExecutor } from "../sandbox/types.js";
import {
  defaultLevels,
  encodeLevels,
  modernize,
  readHeaderLevels,
  refineCandidate,
  type RefinementResult,
  type RuleLevels,
} from "./ast-modernizer.js";
import type { CodeSynthesizer, SynthesizeContext } from "./types.js";

export interface DeterministicModernizerOptions {
  /**
   * Sandbox used to replay a counterexample against candidate rewrites. Defaults to a short-lived
   * PooledProbeRunner that is created only when a counterexample has to be refined.
   */
  readonly executor?: ProbeExecutor;
  /** Set false to leave `| 0` untouched. */
  readonly speculativeTruncation?: boolean;
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/**
 * Necromancer: AST-to-AST ES5/CommonJS -> ES2022 modernizer (no LLM, no API key).
 *
 * Attempt 1 applies every rewrite rule. Each candidate records the rule levels it used in an
 * `// ast-rules:` header, so a later attempt can start from them without any shared state. When
 * Exorcist reports a counterexample, the replayed inputs identify which rule broke parity and only
 * that rule is rolled back (see refineCandidate).
 */
export class DeterministicModernizer implements CodeSynthesizer {
  constructor(private readonly options: DeterministicModernizerOptions = {}) {}

  async synthesize(ctx: SynthesizeContext): Promise<string> {
    const header = `// Resurrected by Lazarus Necromancer (attempt ${ctx.attempt})`;
    let levels: RuleLevels = readHeaderLevels(ctx.previousCandidate) ?? defaultLevels();
    const notes: string[] = [];

    if (ctx.counterexample !== undefined) {
      const refined = await this.refine(ctx, levels);
      levels = refined.levels;
      notes.push(this.describeRefinement(ctx, refined));
    }

    const result = modernize(ctx.legacyCode, {
      levels,
      ...(this.options.speculativeTruncation !== undefined ? { speculativeTruncation: this.options.speculativeTruncation } : {}),
    });
    if (!result.parsed) {
      return [header, "// ast-rules: parse-failed (legacy source kept verbatim)", ...notes, ctx.legacyCode.trim()].join("\n");
    }
    const speculative = result.applied.filter((a) => a.speculative).length;
    return [
      header,
      `// ast-rules: ${encodeLevels(levels)}`,
      ...(speculative > 0 ? [`// ast-speculative: ${speculative} rewrite(s) need Exorcist verification`] : []),
      ...notes,
      result.code,
    ].join("\n");
  }

  private async refine(ctx: SynthesizeContext, start: RuleLevels): Promise<RefinementResult> {
    const counterexample = ctx.counterexample;
    if (counterexample === undefined) throw new Error("refine() requires a counterexample");
    let owned: PooledProbeRunner | undefined;
    try {
      const executor = this.options.executor ?? (owned = new PooledProbeRunner());
      return await refineCandidate({
        legacyCode: ctx.legacyCode,
        start,
        counterexample,
        executor,
        ...(this.options.speculativeTruncation !== undefined ? { speculativeTruncation: this.options.speculativeTruncation } : {}),
      });
    } finally {
      await owned?.close();
    }
  }

  private describeRefinement(ctx: SynthesizeContext, refined: RefinementResult): string {
    const inputs = oneLine(JSON.stringify(ctx.counterexample?.inputs ?? {}), 80);
    if (refined.steps.length === 0) {
      return `// ast-refine: attempt ${ctx.attempt} regenerated from the legacy source; no rewrite rule was implicated by counterexample ${inputs}`;
    }
    const rolledBack = refined.steps.map((s) => `${s.rule} (${s.from} -> ${s.to})`).join(", ");
    const status = refined.matched ? "parity restored" : "parity NOT restored on the counterexample";
    const degraded = refined.degraded ? "; sandbox was unavailable, fell back to the most conservative rules" : "";
    return oneLine(
      `// ast-refine: attempt ${ctx.attempt} blamed ${refined.culprit ?? "none"}; rolled back ${rolledBack}; ${status}${degraded}; counterexample ${inputs}`,
      400
    );
  }
}
