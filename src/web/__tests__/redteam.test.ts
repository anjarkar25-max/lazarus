import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readZip } from "../../exporter/zip.js";
import { RED_TEAM_ATTACKS, type RedTeamResult } from "../../sandbox/redteam.js";
import { createWebServer } from "../server.js";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (!isRunning(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe("POST /api/redteam", () => {
  const server = createWebServer();
  let baseUrl = "";
  const workerPids = new Set<number>();
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    // Closing the server must tear the dedicated sandbox worker down.
    for (const pid of workerPids) expect(await waitUntilGone(pid)).toBe(true);
  }, 20_000);

  async function attack(body: unknown, raw = false): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}/api/redteam`, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw ? String(body) : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }
  async function run(name: string): Promise<RedTeamResult> {
    const { status, json } = await attack({ attack: name });
    expect(status).toBe(200);
    const result = json as unknown as RedTeamResult;
    if (typeof result.pidAfter === "number") workerPids.add(result.pidAfter);
    if (typeof result.pidBefore === "number") workerPids.add(result.pidBefore);
    return result;
  }

  it("offers exactly the four whitelisted attacks", () => {
    expect([...RED_TEAM_ATTACKS]).toEqual(["infinite-loop", "process-exit", "heap-bomb", "prototype-escape"]);
  });

  it("infinite-loop: contained as TIMEOUT within the 3 s budget, worker respawned, canary = 2", async () => {
    const r = await run("infinite-loop");
    expect(r).toMatchObject({ attack: "infinite-loop", contained: true, matchesExpected: true, canaryResult: 2, recovered: true, respawned: true });
    expect(r.outcome).toMatchObject({ ok: false, errorCode: "TIMEOUT" });
    expect(r.elapsedMs).toBeGreaterThan(1000);
    expect(r.elapsedMs).toBeLessThan(4500);
    expect(r.pidAfter).not.toBe(r.pidBefore);
  }, 30_000);

  it("process-exit: contained as EXECUTION_ERROR, the same worker keeps serving, canary = 2", async () => {
    const r = await run("process-exit");
    expect(r).toMatchObject({ contained: true, matchesExpected: true, canaryResult: 2, recovered: true, respawned: false });
    expect(r.outcome).toMatchObject({ ok: false, errorCode: "EXECUTION_ERROR" });
    expect(r.pidAfter).toBe(r.pidBefore);
  }, 30_000);

  it("heap-bomb: contained as MEMORY_EXCEEDED (or the watchdog TIMEOUT), worker respawned, canary = 2", async () => {
    const r = await run("heap-bomb");
    expect(r.contained).toBe(true);
    expect(["MEMORY_EXCEEDED", "TIMEOUT"]).toContain(r.outcome.errorCode);
    expect(r).toMatchObject({ canaryResult: 2, recovered: true, respawned: true });
    expect(r.pidAfter).not.toBe(r.pidBefore);
  }, 45_000);

  it("prototype-escape: no host capability is reachable, no error needed, canary = 2", async () => {
    const r = await run("prototype-escape");
    expect(r).toMatchObject({ contained: true, matchesExpected: true, canaryResult: 2, recovered: true });
    expect(r.outcome).toMatchObject({ ok: true, output: "NO_HOST_ACCESS" });
  }, 30_000);

  it("leaves a healthy worker behind after every attack (same pool, repeated)", async () => {
    const first = await run("process-exit");
    const second = await run("prototype-escape");
    expect(first.recovered && second.recovered).toBe(true);
    expect(isRunning(second.pidAfter ?? -1)).toBe(true);
  }, 30_000);

  it.each([
    [{ attack: "rm -rf /" }],
    [{ attack: "constructor" }],
    [{ attack: "" }],
    [{ attack: 5 }],
    [{ attack: ["infinite-loop"] }],
    [{ code: "while(true){}" }],
    [{}],
    [{ attack: "infinite-loop", code: "process.exit(1)" }],
    [[]],
    [null],
  ])("rejects %j with 400 and runs nothing", async (body) => {
    const { status, json } = await attack(body);
    expect(status).toBe(400);
    expect(typeof json.error).toBe("string");
  });

  it("rejects malformed JSON with 400", async () => {
    expect((await attack("{nope", true)).status).toBe(400);
  });

  it("refuses a second attack while one is running (429 BUSY)", async () => {
    const slow = attack({ attack: "infinite-loop" });
    await new Promise((r) => setTimeout(r, 300));
    const second = await attack({ attack: "process-exit" });
    expect(second.status).toBe(429);
    expect(second.json.code).toBe("BUSY");
    const first = await slow;
    expect(first.status).toBe(200);
    const result = first.json as unknown as RedTeamResult;
    if (typeof result.pidAfter === "number") workerPids.add(result.pidAfter);
    expect(result.recovered).toBe(true);
  }, 30_000);
});

describe("POST /api/export-zip", () => {
  const server = createWebServer();
  let baseUrl = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  const body = { specimenName: "halve", legacyCode: "module.exports = function halve(n) { return (n / 2) | 0; };", modernCode: "Math.trunc(n / 2) || 0", specMarkdown: "# s ✓", fuzzRuns: 50, schema: { n: "integer" } };

  it("returns an application/zip attachment with every bundle file and the workflow", async () => {
    const res = await fetch(`${baseUrl}/api/export-zip`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="lazarus-pr-bundle.zip"');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(200);
    expect(Number(res.headers.get("content-length"))).toBe(bytes.length);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const files = readZip(bytes);
    const names = files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining([".github/workflows/lazarus-parity.yml", "resurrected.ts", "resurrected.test.ts", "SPEC.md", "resurrection.patch", "resurrected.mjs"]));
    expect(files.find((f) => f.name === ".github/workflows/lazarus-parity.yml")?.data.toString("utf8")).toContain("npx vitest run resurrected.test.ts");
    expect(files.find((f) => f.name === "SPEC.md")?.data.toString("utf8")).toContain("Resurrection Certificate");
  });

  it("matches the JSON bundle of /api/export-bundle file for file", async () => {
    const json = (await (await fetch(`${baseUrl}/api/export-bundle`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()) as { files: Record<string, string>; prDiff: string };
    const zip = readZip(Buffer.from(await (await fetch(`${baseUrl}/api/export-zip`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).arrayBuffer()));
    expect(json.files[".github/workflows/lazarus-parity.yml"]).toBeDefined();
    for (const [name, content] of Object.entries(json.files)) {
      if (name === "SPEC.md") continue; // carries the same certificate; compared by presence above
      expect(zip.find((f) => f.name === name)?.data.toString("utf8")).toBe(content);
    }
  });

  it("answers invalid bundle requests with the JSON error shape (400)", async () => {
    const res = await fetch(`${baseUrl}/api/export-zip`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ legacyCode: "x" }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("required");
  });

  it("serves the UI pieces: zip button, workflow tab, scroll-into-view and the Red-Team card", async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    expect(html).toContain("Download .zip PR Archive");
    expect(html).toContain('data-tab=".github/workflows/lazarus-parity.yml"');
    expect(html).toContain('scrollIntoView({ behavior: "smooth", block: "start" })');
    expect(html).toContain("Red-Team the Sandbox");
    for (const name of RED_TEAM_ATTACKS) expect(html).toContain(`data-attack="${name}"`);
  });
});
