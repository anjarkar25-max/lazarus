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

