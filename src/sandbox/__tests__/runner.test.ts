// Task 6.6: Unit tests for ProbeRunner — timeout, memory, clean exit, cleanup.

import { describe, expect, it, afterEach } from "vitest";
import { ProbeRunner } from "../runner.js";
import { SandboxError } from "../errors.js";
import { fileURLToPath } from "node:url";
import * as nodePath from "node:path";
import * as fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = nodePath.dirname(__filename);

// Resolve the shims directory (compiled .js files in the same relative location)
const shimsDir = nodePath.join(__dirname, "..", "shims");

function runner(): ProbeRunner {
  return new ProbeRunner(shimsDir);
}

describe("ProbeRunner", () => {
  it("resolves ProbeResult for a well-behaved script", async () => {
    const r = runner();
    const result = await r.run({ code: "1 + 1" });
    expect(result).toMatchObject({
      output: 2,
      durationMs: expect.any(Number),
      memoryUsedBytes: expect.any(Number),
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(3000);
  }, 10_000);

  it("resolves with string output", async () => {
    const r = runner();
    const result = await r.run({ code: "'hello world'" });
    expect(result.output).toBe("hello world");
  }, 10_000);

  it("passes context values into the execution environment", async () => {
    const r = runner();
    const result = await r.run({
      code: "x + y",
      context: { x: 10, y: 32 },
    });
    expect(result.output).toBe(42);
  }, 10_000);

  it("rejects with TIMEOUT when code sleeps beyond the limit", async () => {
    const r = runner();
    await expect(
      r.run({
        // Busy-loop for 5 seconds (well beyond the 3s limit)
        code: `
          const end = Date.now() + 5000;
          while (Date.now() < end) {}
          'done'
        `,
      })
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof SandboxError && e.code === "TIMEOUT"
    );
  }, 15_000);

  it("rejects with EXECUTION_ERROR when code calls process.exit(1)", async () => {
    const r = runner();
    await expect(
      r.run({ code: "process.exit(1)" })
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof SandboxError && e.code === "EXECUTION_ERROR"
    );
  }, 10_000);

  it("rejects with EXECUTION_ERROR when code throws", async () => {
    const r = runner();
    await expect(
      r.run({ code: "throw new Error('intentional')" })
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof SandboxError && e.code === "EXECUTION_ERROR"
    );
  }, 10_000);
});
