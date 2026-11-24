import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRACE_TOOLS, type WireTrace } from "../../crew/orchestrator.js";
import type { CrewEvent } from "../../crew/types.js";
import { createWebServer } from "../server.js";

interface Frame {
  kind: string;
  event?: CrewEvent;
  result?: { success: boolean; events: CrewEvent[]; fuzzReport: { totalRuns: number }; typecheck: { elapsedMs: number; reusedProcess: boolean; filesChecked: number } };
}

describe("MCP wire trace on POST /api/resurrect", () => {
  const server = createWebServer();
  let baseUrl = "";
  let frames: Frame[] = [];
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
    const res = await fetch(`${baseUrl}/api/resurrect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "stringHash32",
        legacyCode: "var h = 0; for (var i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; } h;",
        schema: { text: "string" },
        fuzzRuns: 100,
        seed: 1337,
      }),
    });
    frames = (await res.text()).split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as Frame);
  }, 30_000);
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  const traces = (): Array<{ agent: string; trace: WireTrace }> =>
    frames.filter((f) => f.kind === "event" && f.event?.type === "mcp_trace").map((f) => ({ agent: f.event?.agent ?? "", trace: f.event?.payload as unknown as WireTrace }));

  it("streams real mcp_trace events alongside the crew events", () => {
    const all = traces();
    expect(all.length).toBeGreaterThanOrEqual(6);
    expect(frames.some((f) => f.kind === "event" && f.event?.type === "agent_started")).toBe(true);
    for (const { trace } of all) {
      expect(Object.values(TRACE_TOOLS)).toContain(trace.tool);
      expect(typeof trace.durationMs).toBe("number");
      expect(trace.durationMs).toBeGreaterThanOrEqual(0);
      expect(trace.summary.length).toBeGreaterThan(0);
      expect(trace.summary).not.toMatch(/\(s\)/);
    }
    // Order: the server's specimen scan first, the strict check last.
    expect(all[0]?.trace.tool).toBe(TRACE_TOOLS.astScan);
    expect(all.at(-1)?.trace.tool).toBe(TRACE_TOOLS.tscStrict);
  });

  it("measures sandbox batches from the pools' own counters: cold start first, then the warm pool is reused", () => {
    const sandbox = traces().filter((t) => t.trace.tool === TRACE_TOOLS.sandboxProbe);
    // Archaeologist sampling, the oracle warm-up, and one batch per healing attempt (stringHash32 heals in 2).
    expect(sandbox.map((t) => t.agent)).toEqual(["archaeologist", "exorcist", "exorcist", "exorcist"]);
    expect(sandbox[0]?.trace).toMatchObject({ poolReused: false, probes: 5, spawned: 1, summary: "5 boundary probes of the legacy specimen" });
    expect(sandbox.slice(2).every((t) => t.trace.poolReused === true && t.trace.spawned === 0)).toBe(true);
    const result = frames.find((f) => f.kind === "result")?.result;
    const last = sandbox.at(-1)?.trace;
    // Every differential run executes the legacy code and the candidate once.
    expect(last?.probes).toBe(2 * (result?.fuzzReport.totalRuns ?? 0));
    expect(last?.summary).toBe(`${result?.fuzzReport.totalRuns ?? 0} differential runs, candidate #2 vs legacy: exact parity`);
    expect(sandbox[2]?.trace.summary).toMatch(/candidate #1 vs legacy: counterexample found$/);
  });

  it("reports in-process AST scans as such", () => {
    const scans = traces().filter((t) => t.trace.tool === TRACE_TOOLS.astScan);
    expect(scans.map((t) => t.agent)).toEqual(["archaeologist", "architect"]);
    for (const s of scans) expect(s.trace.poolReused).toBeNull();
    expect(scans[0]?.trace.summary).toBe("specimen extracted: script expression; 3 legacy idioms");
  });

  it("reports the strict tsc check with the verifier's own timing and process reuse", () => {
    const result = frames.find((f) => f.kind === "result")?.result;
    const tsc = traces().find((t) => t.trace.tool === TRACE_TOOLS.tscStrict)?.trace;
    expect(result?.success).toBe(true);
    expect(tsc?.durationMs).toBe(result?.typecheck.elapsedMs);
    expect(tsc?.poolReused).toBe(result?.typecheck.reusedProcess);
    expect(tsc?.summary).toMatch(/^tsc --strict: 0 errors \(2 files, TypeScript [\d.]+\) via typescript-api$/);
  });

  it("includes the same traces in the result's events", () => {
    const result = frames.find((f) => f.kind === "result")?.result;
    const inResult = (result?.events ?? []).filter((e) => e.type === "mcp_trace").map((e) => JSON.stringify(e.payload));
    expect(inResult).toEqual(traces().map((t) => JSON.stringify(t.trace)));
  });

  it("returns a server-built PR summary on export, ignoring client claims about tsc", async () => {
    const res = await fetch(`${baseUrl}/api/export-bundle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specimenName: "half",
        legacyCode: "var half = (n / 2) | 0; half;",
        modernCode: "const half = Math.trunc(n / 2) || 0;\nhalf;",
        schema: { n: "integer" },
        fuzzRuns: 100,
        typecheck: { passed: true, errorCount: 0, filesChecked: 99 },
        mutationAudit: { killed: 4, total: 4 },
      }),
    });
    const body = (await res.json()) as { prSummary: string; typecheck: { filesChecked: number } };
    expect(body.typecheck.filesChecked).toBe(1);
    expect(body.prSummary).toContain("## Resurrect `half` with Lazarus");
    // One file (no inferred signature, so no types.d.ts): singular, computed by the server.
    expect(body.prSummary).toContain("`tsc --strict: 0 errors (1 file, TypeScript");
    expect(body.prSummary).not.toContain("99 files");
    expect(body.prSummary).toContain("- **Mutation audit:** 4/4 mutants killed (100% proof strength).");
    expect(body.prSummary).toContain("```diff\n-var half = (n / 2) | 0; half;\n+const half = Math.trunc(n / 2) || 0;\n+half;\n```");
  });
});
