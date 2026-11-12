import { describe, expect, it } from "vitest";
import { ResurrectionOrchestrator } from "../orchestrator.js";
import type { CodeSynthesizer, CrewEvent } from "../types.js";

describe("ResurrectionOrchestrator (Kiro Crew)", () => {
  it("resurrects legacy ES5 code end-to-end with verified behavioral parity", async () => {
    const events: CrewEvent[] = [];
    const orchestrator = new ResurrectionOrchestrator();

    const result = await orchestrator.resurrect({
      name: "legacy-halve",
      legacyCode: "var half = (n / 2) | 0; half;",
      schema: { n: "integer" },
      fuzzRuns: 20,
      seed: 101,
      onEvent: (ev) => events.push(ev),
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.modernCode).toContain("Math.trunc(n / 2)");
    expect(result.specMarkdown).toContain("# Specification: legacy-halve");
    expect(events.map((e) => e.agent)).toContain("archaeologist");
    expect(events.map((e) => e.agent)).toContain("architect");
    expect(events.map((e) => e.agent)).toContain("necromancer");
    expect(events.map((e) => e.agent)).toContain("exorcist");
  }, 25_000);

  it("self-heals when Exorcist catches a counterexample from Necromancer's first draft", async () => {
    // Simulate a naive first attempt using Math.floor that repairs itself after receiving a counterexample
    const healingSynthesizer: CodeSynthesizer = {
      async synthesize(ctx) {
        if (ctx.attempt === 1) {
          return "Math.floor(n / 2)"; // Buggy for negative odd integers
        }
        expect(ctx.counterexample).toBeDefined();
        return "Math.trunc(n / 2)"; // Repaired after Exorcist counterexample feedback
      },
    };

    const orchestrator = new ResurrectionOrchestrator({ synthesizer: healingSynthesizer });
    const result = await orchestrator.resurrect({
      name: "self-healing-demo",
      legacyCode: "(n / 2) | 0",
      schema: { n: "integer" },
      fuzzRuns: 25,
      seed: 1337,
      maxHealingAttempts: 3,
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.events.some((e) => e.type === "counterexample_found")).toBe(true);
    expect(result.events.some((e) => e.type === "self_healed")).toBe(true);
  }, 25_000);
});
