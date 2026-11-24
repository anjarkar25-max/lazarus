import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebServer } from "../server.js";

describe("Lazarus Web Telemetry Server", () => {
  const server = createWebServer();
  let baseUrl = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("serves the Resurrection Operating Table HTML at GET /", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("LAZARUS // OPERATING TABLE");
  });

  async function resurrect(body: Record<string, unknown>): Promise<{ result: { success: boolean; attempts: number; fuzzReport: { totalRuns: number } }; ms: number }> {
    const started = Date.now();
    const res = await fetch(`${baseUrl}/api/resurrect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const ms = Date.now() - started;
    const frames = text.split("\n\n").filter((f) => f.startsWith("data: "));
    const final = frames
      .map((f) => JSON.parse(f.slice(6)) as { kind: string; result?: { success: boolean; attempts: number; fuzzReport: { totalRuns: number } } })
      .find((f) => f.kind === "result");
    if (final?.result === undefined) throw new Error(`no result frame in: ${text.slice(0, 200)}`);
    return { result: final.result, ms };
  }

  it("fuzzes 100 inputs by default and finishes a live resurrection in under 3 seconds", async () => {
    const { result, ms } = await resurrect({
      name: "live-depth",
      legacyCode: "var half = (n / 2) | 0; half;",
      schema: { n: "integer" },
      seed: 7,
    });
    expect(result.success).toBe(true);
    expect(result.fuzzReport.totalRuns).toBe(100);
    expect(ms).toBeLessThan(3000);
  }, 20_000);

  it("caps requested depth at 150 runs and still stays under 3 seconds", async () => {
    const { result, ms } = await resurrect({
      name: "live-depth-cap",
      legacyCode: "var half = (n / 2) | 0; half;",
      schema: { n: "integer" },
      fuzzRuns: 5000,
      seed: 7,
    });
    expect(result.fuzzReport.totalRuns).toBe(150);
    expect(ms).toBeLessThan(3000);
  }, 20_000);

  it("streams live self-healing SSE events and final parity result on POST /api/resurrect", async () => {
    const res = await fetch(`${baseUrl}/api/resurrect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "sse-self-heal",
        legacyCode: "(n / 2) | 0",
        schema: { n: "integer" },
        fuzzRuns: 15,
        seed: 1337,
        simulateBuggyFirstDraft: true,
      }),
    });

    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(bodyText).toContain('"type":"counterexample_found"');
    expect(bodyText).toContain('"type":"self_healed"');
    expect(bodyText).toContain('"success":true');
  }, 60_000);
});

