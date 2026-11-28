import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BENCHMARK_PRESETS } from "../../benchmark-presets.js";
import { sha256Hex } from "../../exporter/certificate.js";
import type { CounterexampleReport } from "../../fuzzer/types.js";
import { scanLegacyAst } from "../../sandbox/ast-scanner.js";
import { createWebServer } from "../../web/server.js";
import { ResurrectionOrchestrator } from "../orchestrator.js";
import { buildDraftStages, completePipeline, rulesOfCandidate, type PipelineStage } from "../pipeline-stages.js";
import { closeSharedTsVerifier } from "../ts-verifier.js";

const preset = (name: string): { code: string; schema: Record<string, string> } => {
  const p = BENCHMARK_PRESETS.find((x) => x.name === name);
  if (p === undefined) throw new Error(`no preset ${name}`);
  return { code: p.code, schema: p.schema as Record<string, string> };
};

interface Result {
  success: boolean;
  attempts: number;
  modernCode: string;
  proofSeed: number;
  pipelineStages?: PipelineStage[];
  typecheck?: { errorCount: number; passed: boolean };
  purityProof?: { proven: boolean };
  fuzzReport: { totalRuns: number; exact?: boolean };
  certificate?: { signature: { keyId: string; payload: { resurrectedSha256: string } } };
}

afterAll(async () => {
  await closeSharedTsVerifier();
});

describe("buildDraftStages (pure)", () => {
  const legacy = "var half = (n / 2) | 0; half;";
  const header = "// ast-rules: var-scoping=let-const prototype-class=class arguments-rest=rest apply-spread=spread function-arrow=arrow bitor0-trunc=trunc-or0 loose-equality=strict-proven proto-pollution-guard=guard global-leak-fix=declare";
  const candidate = `// Resurrected by Lazarus Necromancer (attempt 1)\n${header}\nconst half = Math.trunc(n / 2) || 0;\nhalf;`;

  it("lists the legacy specimen and the first candidate with the rules it really applied", () => {
    const stages = buildDraftStages({ legacyCode: legacy, attempts: [{ attempt: 1, code: candidate }], finalCode: candidate, inputs: ["n"] });
    expect(stages.map((s) => [s.stage, s.id])).toEqual([[0, "legacy"], [1, "candidate"]]);
    expect(stages[0]).toMatchObject({ code: legacy, compareTo: null, language: "javascript" });
    expect(stages[1]).toMatchObject({ code: candidate, compareTo: "legacy" });
    expect(stages[1]?.rules?.map((r) => [r.rule, r.sites])).toEqual([["var-scoping", 1], ["bitor0-trunc", 1]]);
    expect(stages[1]?.summary).toBe("2 AST rewrites: var-scoping, bitor0-trunc.");
  });

  it("makes the first stage security-guards only when a security rule fired", () => {
    const leaky = "function f(list) { total = 0; for (var i = 0; i < list.length; i++) { total = total + list[i]; } return total; }\nf(list);";
    const code = `// Resurrected by Lazarus Necromancer (attempt 1)\n${header}\nfunction f(list) {}`;
    const guarded = buildDraftStages({ legacyCode: leaky, attempts: [{ attempt: 1, code }], finalCode: code, inputs: ["list"] });
    expect(guarded[1]).toMatchObject({ id: "security-guards", label: "Security Guards" });
    expect(guarded[1]?.rules?.some((r) => r.rule === "global-leak-fix")).toBe(true);
    expect(guarded[1]?.summary).toContain("security guards: global-leak-fix");
    const plain = buildDraftStages({ legacyCode: legacy, attempts: [{ attempt: 1, code: candidate }], finalCode: candidate, inputs: ["n"] });
    expect(plain[1]?.id).toBe("candidate");
  });

  it("says so when the candidate carries no AST rule header (a synthesizer draft)", () => {
    const draft = "// Attempt 1: Naive modernization using Math.floor\nMath.floor(n / 2);";
    expect(rulesOfCandidate(legacy, draft, ["n"])).toBeUndefined();
    const stages = buildDraftStages({ legacyCode: legacy, attempts: [{ attempt: 1, code: draft }], finalCode: draft, inputs: ["n"] });
    expect(stages[1]).toMatchObject({ id: "candidate", rules: [], summary: "The first draft of the synthesizer (it carries no AST rule header)." });
  });

  it("adds the rollback stage only when a counterexample was recorded, with the counterexample and the healed code", () => {
    const cx: CounterexampleReport = {
      inputs: { n: { $lazarus: "-0" } },
      legacy: { ok: true, output: 0, durationMs: 1 },
      modern: { ok: true, output: { $lazarus: "-0" }, durationMs: 1 },
      reason: "Output mismatch: legacy=0 vs modern=-0 (sign of zero differs)",
      exact: true,
      shrinkTrace: {
        initialFailure: { step: 0, input: "n = -842", legacyOutput: "-421", modernOutput: "-421" },
        steps: [],
        finalMinimal: { step: 3, input: "n = -0", legacyOutput: "+0", modernOutput: "-0" },
        totalShrinks: 3,
      },
    };
    const healed = `// Resurrected by Lazarus Necromancer (attempt 2)\n${header.replace("bitor0-trunc=trunc-or0", "bitor0-trunc=off")}\nconst half = (n / 2) | 0;\nhalf;`;
    const stages = buildDraftStages({
      legacyCode: legacy,
      attempts: [{ attempt: 1, code: candidate, counterexample: cx }, { attempt: 2, code: healed }],
      finalCode: healed,
      inputs: ["n"],
      ruleBlame: [{ rule: "bitor0-trunc", status: "rolled-back", legacyLines: [1], resurrectedLines: [], sites: 1, reason: "" }],
    });
    expect(stages.map((s) => s.id)).toEqual(["legacy", "candidate", "rollback"]);
    const rollback = stages[2];
    expect(rollback).toMatchObject({ stage: 2, label: "Rollback", code: healed, compareTo: "candidate", rolledBack: ["bitor0-trunc"] });
    expect(rollback?.counterexample).toEqual({ attempt: 1, input: "n = -0", legacyOutput: "+0", candidateOutput: "-0", reason: cx.reason, shrinks: 3, firstFailure: "n = -842" });
    expect(rollback?.summary).toBe("Counterexample n = -0 broke Object.is parity (legacy +0 vs candidate -0); rolled back bitor0-trunc; attempt 2 proved parity.");
  });

  it("completePipeline puts the source as written in stage 0 and adds the typed and verified stages", () => {
    const draft = buildDraftStages({ legacyCode: legacy, attempts: [{ attempt: 1, code: candidate }], finalCode: candidate, inputs: ["n"] });
    const full = completePipeline(draft, {
      legacySource: "function half(n) { return (n / 2) | 0; }",
      typedCode: "export function half(n: number): number { return 0; }",
      typecheck: { passed: true, errorCount: 0, filesChecked: 2, tsVersion: "7.0.2", adjustments: ["parameter x (line 1)"] },
      finalCode: candidate,
      pillars: { parity: { runs: 100, exact: true }, purity: { proven: true }, mutants: null, ed25519: { keyId: "abc", resurrectedSha256: "f".repeat(64) }, seed: 42 },
    });
    expect(full.map((s) => [s.stage, s.id, s.language])).toEqual([[0, "legacy", "javascript"], [1, "candidate", "javascript"], [3, "typed", "typescript"], [4, "verified", "javascript"]]);
    expect(full[0]?.code).toBe("function half(n) { return (n / 2) | 0; }");
    expect(full[2]).toMatchObject({ compareTo: "candidate", typecheck: { errorCount: 0 } });
    expect(full[2]?.summary).toBe("Type Alchemist: strict TypeScript, tsc --strict: 0 errors across 2 files (TypeScript 7.0.2); 1 member declared any at the migration boundary.");
    expect(full[3]).toMatchObject({ compareTo: "legacy", code: candidate });
    expect(full[3]?.summary).toBe("Verified artifact: exact Object.is parity over 100 runs \u00b7 purity proven \u00b7 mutants: run the Mutant Autopsy \u00b7 Ed25519 key abc \u00b7 seed 42.");
    expect(draft[0]?.code).toBe(legacy);
  });
});

describe("the Orchestrator records the stages only when asked", () => {
  it("keeps the result as it was without recordPipeline", async () => {
    const r = await new ResurrectionOrchestrator().resurrect({ name: "half", legacyCode: "var half = (n / 2) | 0; half;", schema: { n: "integer" }, fuzzRuns: 40, seed: 3, exact: true });
    expect(r.success).toBe(true);
    expect(r).not.toHaveProperty("pipelineStages");
    const recorded = await new ResurrectionOrchestrator().resurrect({ name: "half", legacyCode: "var half = (n / 2) | 0; half;", schema: { n: "integer" }, fuzzRuns: 40, seed: 3, exact: true, recordPipeline: true });
    expect(recorded.pipelineStages?.map((s) => s.id)).toEqual(["legacy", "candidate"]);
    expect(recorded.pipelineStages?.[1]?.code).toBe(recorded.modernCode);
  }, 30_000);

  it("records no stage for a resurrection that did not succeed", async () => {
    const r = await new ResurrectionOrchestrator({ synthesizer: { synthesize: () => Promise.resolve("0;") } }).resurrect({ name: "half", legacyCode: "var half = (n / 2) | 0; half;", schema: { n: "integer" }, fuzzRuns: 20, seed: 3, exact: true, maxHealingAttempts: 1, recordPipeline: true });
    expect(r.success).toBe(false);
    expect(r).not.toHaveProperty("pipelineStages");
  }, 30_000);
});

describe("POST /api/resurrect: pipelineStages from the real run", () => {
  const server = createWebServer();
  let baseUrl = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
  async function resurrect(name: string, extra: Record<string, unknown> = {}, body?: { code: string; schema: unknown }): Promise<Result> {
    const p = body ?? preset(name);
    const res = await fetch(`${baseUrl}/api/resurrect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, legacyCode: p.code, schema: p.schema, fuzzRuns: 100, seed: 9, ...extra }) });
    const frames = (await res.text()).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as { kind: string; result?: Result });
    const result = frames.find((x) => x.kind === "result")?.result;
    if (result === undefined) throw new Error("no result");
    return result;
  }
  const ids = (r: Result): string[] => (r.pipelineStages ?? []).map((s) => s.id);

  it("stringHash32: the first candidate breaks 32-bit parity, bitor0-trunc is rolled back, and the healed code is verified", async () => {
    const r = await resurrect("stringHash32");
    expect(r.success).toBe(true);
    expect(r.attempts).toBe(2);
    expect(ids(r)).toEqual(["legacy", "candidate", "rollback", "typed", "verified"]);
    const [legacy, candidate, rollback, typed, verified] = r.pipelineStages ?? [];
    expect(legacy).toMatchObject({ stage: 0, code: preset("stringHash32").code, compareTo: null });
    expect(candidate?.stage).toBe(1);
    expect(candidate?.rules?.some((x) => x.rule === "bitor0-trunc")).toBe(true);
    expect(candidate?.code).toContain("Math.trunc");
    expect(rollback).toMatchObject({ stage: 2, compareTo: "candidate", rolledBack: ["bitor0-trunc"] });
    expect(rollback?.counterexample?.legacyOutput).toBe("338917376");
    expect(rollback?.counterexample?.candidateOutput).toBe("7.220840233776351e+59");
    expect(rollback?.counterexample?.reason).toContain("Output mismatch");
    expect(rollback?.counterexample?.attempt).toBe(1);
    expect(rollback?.code).toBe(r.modernCode);
    expect(rollback?.code).not.toContain("Math.trunc");
    expect(rollback?.code).toContain("| 0");
    expect(typed).toMatchObject({ stage: 3, language: "typescript", compareTo: "rollback" });
    expect(typed?.typecheck).toMatchObject({ passed: true, errorCount: 0 });
    expect(typed?.code).toContain("export function");
    expect(verified).toMatchObject({ stage: 4, compareTo: "legacy", code: r.modernCode });
  }, 60_000);

  it("legacy-int-halve: a draft the Exorcist rejects ('Math.floor' loses the sign of zero) is a rollback stage with the exact counterexample", async () => {
    const r = await resurrect("legacy-int-halve", { simulateBuggyFirstDraft: true });
    expect(r.success).toBe(true);
    expect(r.attempts).toBe(2);
    expect(ids(r)).toEqual(["legacy", "candidate", "rollback", "typed", "verified"]);
    const candidate = r.pipelineStages?.[1];
    const rollback = r.pipelineStages?.[2];
    expect(candidate?.code).toContain("Math.floor");
    expect(candidate?.summary).toBe("The first draft of the synthesizer (it carries no AST rule header).");
    expect(rollback?.counterexample).toMatchObject({ attempt: 1, input: "n = -0", legacyOutput: "+0", candidateOutput: "-0" });
    expect(rollback?.summary).toContain("the rejected draft was replaced; attempt 2 proved parity");
    expect(rollback?.code).toBe(r.modernCode);
    expect(rollback?.code).not.toContain("Math.floor");
  }, 60_000);

  it("legacy-int-halve without the buggy draft passes at once, so there is no rollback stage and the numbers keep their places", async () => {
    const r = await resurrect("legacy-int-halve");
    expect(r.attempts).toBe(1);
    expect(ids(r)).toEqual(["legacy", "candidate", "typed", "verified"]);
    expect((r.pipelineStages ?? []).map((s) => s.stage)).toEqual([0, 1, 3, 4]);
  }, 60_000);

  it("legacyLeakyMutator: stage 1 is security-guards with global-leak-fix", async () => {
    const r = await resurrect("legacyLeakyMutator");
    expect(ids(r)).toEqual(["legacy", "security-guards", "typed", "verified"]);
    const guards = r.pipelineStages?.[1];
    expect(guards?.label).toBe("Security Guards");
    expect(guards?.rules?.map((x) => x.rule)).toContain("global-leak-fix");
    expect(guards?.code).toContain("let total = 0;");
    expect(guards?.summary).toContain("security guards: global-leak-fix");
    expect(r.pipelineStages?.[3]?.pillars?.purity).toEqual({ proven: true });
  }, 60_000);

  it("legacyUnsafeMerge: stage 1 is security-guards with proto-pollution-guard, and the typed stage reports its migration boundary", async () => {
    const r = await resurrect("legacyUnsafeMerge");
    expect(ids(r)).toEqual(["legacy", "security-guards", "typed", "verified"]);
    const guards = r.pipelineStages?.[1];
    expect(guards?.rules?.map((x) => x.rule)).toContain("proto-pollution-guard");
    expect(guards?.code).toContain('key === "__proto__"');
    expect(guards?.summary).toContain("security guards: proto-pollution-guard");
    expect(r.pipelineStages?.[2]?.typecheck?.adjustments.length).toBeGreaterThan(0);
    expect(r.pipelineStages?.[2]?.summary).toContain("declared any at the migration boundary");
  }, 60_000);

  it("every stage is real: ordered, with a base that exists, the verified stage is the signed code and its pillars match the response", async () => {
    const r = await resurrect("stringHash32", { seed: 4242 });
    const stages = r.pipelineStages ?? [];
    expect(stages.map((s) => s.stage)).toEqual([...stages.map((s) => s.stage)].sort());
    const known = new Set(["legacy", ...stages.map((s) => s.id)]);
    for (const s of stages) {
      expect(s.code.length, s.id).toBeGreaterThan(0);
      expect(s.summary.length, s.id).toBeGreaterThan(10);
      if (s.compareTo !== null) expect(known.has(s.compareTo), `${s.id} -> ${s.compareTo}`).toBe(true);
    }
    const verified = stages[stages.length - 1];
    expect(verified?.id).toBe("verified");
    expect(sha256Hex(verified?.code ?? "")).toBe(r.certificate?.signature.payload.resurrectedSha256);
    expect(verified?.pillars).toEqual({
      parity: { runs: r.fuzzReport.totalRuns, exact: true },
      purity: { proven: true },
      mutants: null,
      ed25519: { keyId: r.certificate?.signature.keyId, resurrectedSha256: r.certificate?.signature.payload.resurrectedSha256 },
      seed: 4242,
    });
    expect(verified?.summary).toContain("seed 4242");
    expect(verified?.summary).toContain(`Ed25519 key ${r.certificate?.signature.keyId}`);
  }, 60_000);

  it("is reproducible: the same seed gives the same stages", async () => {
    const a = await resurrect("stringHash32", { seed: 77 });
    const b = await resurrect("stringHash32", { seed: 77 });
    expect(b.pipelineStages).toEqual(a.pipelineStages);
  }, 90_000);

  it("leaves a multi-export module, an error-first callback and a failed run without stages", async () => {
    const math = BENCHMARK_PRESETS.find((p) => p.name === "cjsMathUtils");
    const mod = await resurrect("cjsMathUtils", { fuzzRuns: 20 }, { code: math?.code ?? "", schema: math?.schema });
    expect(mod.success).toBe(true);
    expect(mod).not.toHaveProperty("pipelineStages");
    const cb = BENCHMARK_PRESETS.find((p) => p.name === "legacyReadConfigCb");
    const asyncResult = await resurrect("legacyReadConfigCb", { fuzzRuns: 20 }, { code: cb?.code ?? "", schema: cb?.schema });
    expect(asyncResult).not.toHaveProperty("pipelineStages");
    expect(scanLegacyAst(cb?.code ?? "").parsed).toBe(true);
  }, 90_000);
});
