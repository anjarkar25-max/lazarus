// Task 7.7: Unit tests for RpcRouter.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { RpcRouter, type RouterDeps } from "../router.js";
import { SandboxError } from "../errors.js";
import { ProbeRunner } from "../runner.js";
import type { ProbeResult } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRouter(overrides: {
  mockRunner?: ProbeRunner;
  exitFn?: (code: number) => void;
} = {}): {
  router: RpcRouter;
  input: PassThrough;
  output: PassThrough;
  lines: string[];
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];

  output.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    for (const line of text.split("\n")) {
      if (line.trim().length > 0) lines.push(line.trim());
    }
  });

  const deps: RouterDeps = {
    input,
    output,
    exit: overrides.exitFn ?? ((_c) => {}),
  };
  if (overrides.mockRunner !== undefined) {
    deps.runner = overrides.mockRunner;
  }
  const router = new RpcRouter(deps);

  return { router, input, output, lines };
}

function sendLine(input: PassThrough, obj: unknown): Promise<void> {
  return new Promise((resolve) => {
    input.write(JSON.stringify(obj) + "\n", "utf8", () => resolve());
  });
}

function waitForLine(lines: string[]): Promise<string> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (lines.length > 0) {
        resolve(lines.shift()!);
      } else {
        setTimeout(check, 5);
      }
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RpcRouter", () => {
  it("non-JSON input → parse error with code -32700", async () => {
    const { input, lines } = createRouter();
    input.write("not json\n");
    const raw = await waitForLine(lines);
    const resp = JSON.parse(raw) as { error: { code: number } };
    expect(resp.error.code).toBe(-32700);
  });

  it("valid JSON but unknown method → INVALID_REQUEST response", async () => {
    const { input, lines } = createRouter();
    await sendLine(input, {
      jsonrpc: "2.0",
      id: 1,
      method: "sandbox.hack",
      params: {},
    });
    const raw = await waitForLine(lines);
    const resp = JSON.parse(raw) as { error: { code: number } };
    expect(resp.error.code).toBe(-32600); // INVALID_REQUEST
  });

  it("sandbox.ping → { pong: true }", async () => {
    const { input, lines } = createRouter();
    await sendLine(input, {
      jsonrpc: "2.0",
      id: 10,
      method: "sandbox.ping",
      params: {},
    });
    const raw = await waitForLine(lines);
    const resp = JSON.parse(raw) as { result: { pong: boolean }; id: number };
    expect(resp.result.pong).toBe(true);
    expect(resp.id).toBe(10);
  });

  it("sandbox.probe delegates to ProbeRunner and returns result", async () => {
    const fakeResult: ProbeResult = {
      output: 42,
      durationMs: 10,
      memoryUsedBytes: 1024,
    };
    const mockRunner = {
      run: vi.fn().mockResolvedValue(fakeResult),
    } as unknown as ProbeRunner;

    const { input, lines } = createRouter({ mockRunner });
    await sendLine(input, {
      jsonrpc: "2.0",
      id: 20,
      method: "sandbox.probe",
      params: { code: "1 + 1" },
    });

    const raw = await waitForLine(lines);
    const resp = JSON.parse(raw) as {
      result: ProbeResult;
      id: number;
    };
    expect(resp.result.output).toBe(42);
    expect(resp.id).toBe(20);
    expect(mockRunner.run).toHaveBeenCalledOnce();
  });

  it("sandbox.probe returns error when runner rejects", async () => {
    const mockRunner = {
      run: vi.fn().mockRejectedValue(
        new SandboxError("TIMEOUT", "took too long")
      ),
    } as unknown as ProbeRunner;

    const { input, lines } = createRouter({ mockRunner });
    await sendLine(input, {
      jsonrpc: "2.0",
      id: 30,
      method: "sandbox.probe",
      params: { code: "while(true){}" },
    });

    const raw = await waitForLine(lines);
    const resp = JSON.parse(raw) as { error: { code: number; data: { sandboxCode: string } }; id: number };
    expect(resp.error.code).toBe(-32001); // TIMEOUT
    expect(resp.id).toBe(30);
  });

  it("sandbox.shutdown → acknowledges and calls exit", async () => {
    const exitFn = vi.fn();
    const { input, lines } = createRouter({ exitFn });
    await sendLine(input, {
      jsonrpc: "2.0",
      id: 99,
      method: "sandbox.shutdown",
      params: {},
    });

    const raw = await waitForLine(lines);
    const resp = JSON.parse(raw) as {
      result: { acknowledged: boolean };
      id: number;
    };
    expect(resp.result.acknowledged).toBe(true);
    expect(resp.id).toBe(99);
    // exit should have been called with 0
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it("every input line produces exactly one output line", async () => {
    const { input, lines } = createRouter();
    // Send 3 pings
    for (let i = 0; i < 3; i++) {
      await sendLine(input, {
        jsonrpc: "2.0",
        id: i,
        method: "sandbox.ping",
        params: {},
      });
    }
    // Wait for all 3 lines
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      results.push(await waitForLine(lines));
    }
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(() => JSON.parse(r)).not.toThrow();
    }
  });
});
