import { describe, expect, it } from "vitest";
import { PooledProbeRunner } from "../../sandbox/pool.js";
import { ProbeRunner } from "../../sandbox/runner.js";
import { createLazarusMcpServer, executeLegacyProbe, type LegacyProbeReport } from "../server.js";

describe("Lazarus MCP Server", () => {
  it("instantiates the MCP server cleanly", () => {
    const server = createLazarusMcpServer();
    expect(server).toBeDefined();
  });

  it("executes legacy code via run_legacy_probe and returns JSON result", async () => {
    const runner = new ProbeRunner();
    const res = await executeLegacyProbe(runner, {
      code: "x + y",
      context: { x: 17, y: 25 },
    });

    expect("isError" in res && res.isError).toBeFalsy();
    expect(res.content[0]?.type).toBe("text");
    const parsed = JSON.parse(res.content[0]!.text) as { output: number };
    expect(parsed.output).toBe(42);
  }, 10_000);

  it("returns returnValue, captured stdout/stderr, and metrics from the pooled worker", async () => {
    await using pool = new PooledProbeRunner();
    const res = await executeLegacyProbe(pool, {
      code: "console.log('sum is', a + b); console.warn('legacy warning'); a + b",
      context: { a: 2, b: 3 },
    });

    expect("isError" in res && res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0]!.text) as LegacyProbeReport;
    expect(parsed.returnValue).toBe(5);
    expect(parsed.stdout).toBe("sum is 5");
    expect(parsed.stderr).toBe("legacy warning");
    expect(parsed.metrics.durationMs).toBeGreaterThanOrEqual(0);
    expect(parsed.metrics.memoryUsedBytes).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it("reports the thrown message and TIMEOUT through the pooled worker", async () => {
    await using pool = new PooledProbeRunner();
    const boom = await executeLegacyProbe(pool, { code: "(() => { throw new Error('legacy boom'); })()" });
    expect(boom.isError).toBe(true);
    expect(JSON.parse(boom.content[0]!.text)).toEqual({ error: { code: "EXECUTION_ERROR", message: "legacy boom" } });

    const hang = await executeLegacyProbe(pool, { code: "while (true) {}" });
    expect(hang.isError).toBe(true);
    expect(hang.content[0]?.text).toContain("TIMEOUT");
  }, 20_000);

  it("returns structured isError payload when legacy code throws", async () => {
    const runner = new ProbeRunner();
    const res = await executeLegacyProbe(runner, {
      code: "(() => { throw new Error('legacy boom'); })()",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("EXECUTION_ERROR");
  }, 10_000);
});
