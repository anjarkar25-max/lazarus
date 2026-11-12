// Task 9.6: Integration tests for SandboxClient ↔ sandbox host.
// These tests actually spawn the host process, so they are slower.

import { describe, expect, it, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import * as nodePath from "node:path";
import * as fsSync from "node:fs";
import { SandboxClient } from "../client.js";
import { SandboxError } from "../errors.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = nodePath.dirname(__filename);

const DEFAULT_HOST_PATH = __filename.endsWith(".ts")
  ? nodePath.join(__dirname, "..", "host.ts")
  : nodePath.join(__dirname, "..", "host.js");

describe("SandboxClient integration", () => {
  let client: SandboxClient | null = null;

  afterEach(async () => {
    if (client !== null) {
      try {
        await client.shutdown();
      } catch {
        // already shut down
      }
      client = null;
    }
  });

  it("spawn → ping → probe → shutdown lifecycle", async () => {
    client = new SandboxClient(DEFAULT_HOST_PATH);
    await client.spawn();

    const result = await client.probe({ code: "6 * 7" });
    expect(result.output).toBe(42);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.memoryUsedBytes).toBeGreaterThanOrEqual(0);

    await client.shutdown();
    client = null;
  }, 15_000);

  it("probe with a timing-out script rejects with TIMEOUT", async () => {
    client = new SandboxClient(DEFAULT_HOST_PATH);
    await client.spawn();

    await expect(
      client.probe({
        code: `const e = Date.now() + 5000; while(Date.now() < e) {}`,
      })
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SandboxError && e.code === "TIMEOUT"
    );
  }, 20_000);

  it("await using tears down the client on scope exit", async () => {
    let innerClient: SandboxClient;

    {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional disposal
      await using c = new SandboxClient(DEFAULT_HOST_PATH);
      innerClient = c;
      await c.spawn();
      const result = await c.probe({ code: "1 + 1" });
      expect(result.output).toBe(2);
      // c is disposed at end of block
    }

    // After disposal the child should be killed
    await new Promise((r) => setTimeout(r, 100));
    expect(innerClient._child).toBeNull();
  }, 15_000);
});
