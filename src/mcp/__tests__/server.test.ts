import { describe, expect, it } from "vitest";
import { ProbeRunner } from "../../sandbox/runner.js";
import { createLazarusMcpServer, executeLegacyProbe } from "../server.js";

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

  it("returns structured isError payload when legacy code throws", async () => {
    const runner = new ProbeRunner();
    const res = await executeLegacyProbe(runner, {
      code: "(() => { throw new Error('legacy boom'); })()",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("EXECUTION_ERROR");
  }, 10_000);
});
