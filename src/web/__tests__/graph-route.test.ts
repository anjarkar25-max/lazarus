import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readZip } from "../../exporter/zip.js";
import { createWebServer } from "../server.js";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../../..");
const readProject = (dir: string): Record<string, string> => {
  const files: Record<string, string> = {};
  for (const f of fs.readdirSync(nodePath.join(root, "examples", dir)).sort()) files[f] = fs.readFileSync(nodePath.join(root, "examples", dir, f), "utf8");
  return files;
};
const INVOICE = readProject("legacy-invoice-engine");
const TEXT = readProject("legacy-text-pipeline");

interface Frame {
  kind: string;
  [key: string]: unknown;
}

describe("POST /api/resurrect-graph", () => {
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

  async function stream(body: unknown): Promise<{ status: number; type: string | null; frames: Frame[]; firstFrameMs: number; totalMs: number }> {
    const started = Date.now();
    const res = await fetch(`${baseUrl}/api/resurrect-graph`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const frames: Frame[] = [];
    let firstFrameMs = -1;
    if (res.body === null) return { status: res.status, type: res.headers.get("content-type"), frames, firstFrameMs, totalMs: Date.now() - started };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (firstFrameMs < 0) firstFrameMs = Date.now() - started;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) if (part.startsWith("data: ")) frames.push(JSON.parse(part.slice(6)) as Frame);
    }
    return { status: res.status, type: res.headers.get("content-type"), frames, firstFrameMs, totalMs: Date.now() - started };
  }

  let bundleId = "";

  it("streams graph, node transitions and logs over SSE, then a result with a bundleId", async () => {
    const { status, type, frames, firstFrameMs, totalMs } = await stream({ name: "legacy-invoice-engine", files: INVOICE, seed: 1337, fileRuns: 60, graphRuns: 50 });
    expect(status).toBe(200);
    expect(type).toContain("text/event-stream");
    expect(frames[0]?.kind).toBe("graph");
    const graph = frames[0]?.graph as { order: string[]; entry: string; edges: unknown[]; depth: Record<string, number> };
    expect(graph.order).toEqual(["money.cjs", "tax.cjs", "invoice.cjs"]);
    expect(graph.entry).toBe("invoice.cjs");
    expect(graph.edges).toHaveLength(3);
    // The stream is live: the first frame arrives well before the run finishes.
    expect(firstFrameMs).toBeLessThan(totalMs);

    const transitions = frames.filter((f) => f.kind === "node").map((f) => `${String(f.file)}:${String(f.state)}`);
    expect(transitions).toContain("money.cjs:probing");
    expect(transitions).toContain("money.cjs:healing");
    expect(transitions.filter((t) => t.endsWith(":resurrected"))).toEqual(["money.cjs:resurrected", "tax.cjs:resurrected", "invoice.cjs:resurrected"]);
    expect(transitions.indexOf("money.cjs:probing")).toBeLessThan(transitions.indexOf("money.cjs:healing"));
    expect(frames.some((f) => f.kind === "log" && String(f.message).includes("Whole-graph parity proven"))).toBe(true);

    const result = frames.at(-1);
    expect(result?.kind).toBe("result");
    const r = result?.result as { success: boolean; bundleId: string; parity: { passed: boolean; exact: boolean; totalRuns: number }; files: Array<{ path: string; esmPath: string; esmCode: string; healed: boolean }> };
    expect(r.success).toBe(true);
    expect(r.parity).toMatchObject({ passed: true, exact: true, totalRuns: 50 });
    expect(r.files.map((f) => f.esmPath)).toEqual(["money.js", "tax.js", "invoice.js"]);
    expect(r.files[0]?.healed).toBe(true);
    expect(r.bundleId).toMatch(/^[0-9a-f-]{36}$/);
    bundleId = r.bundleId;
  }, 60_000);

  it("serves the whole project as a zip for that bundleId", async () => {
    const res = await fetch(`${baseUrl}/api/export-graph-zip`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bundleId }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="lazarus-legacy_invoice_engine-project.zip"');
    const names = readZip(Buffer.from(await res.arrayBuffer())).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["src/money.js", "src/tax.js", "src/invoice.js", "legacy/money.cjs", "resurrected.test.ts", "SPEC.md", "resurrection.patch", ".github/workflows/lazarus-parity.yml"]));
  });

  it("returns 404 for an unknown bundleId and 400 for a malformed one", async () => {
    const post = (body: unknown): Promise<Response> => fetch(`${baseUrl}/api/export-graph-zip`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ bundleId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await post({ bundleId: "../../etc/passwd" })).status).toBe(400);
    expect((await post({ files: INVOICE })).status).toBe(400);
  });

  it("resurrects the text pipeline with per-export schemas", async () => {
    const { frames } = await stream({ name: "legacy-text-pipeline", files: TEXT, schemas: { default: { title: "string", width: "integer" } }, fileRuns: 30, graphRuns: 40, seed: 4 });
    const r = frames.at(-1)?.result as { success: boolean; parity: { functions: Array<{ exportedAs: string; schema: Record<string, string> }> } };
    expect(r.success).toBe(true);
    expect(r.parity.functions[0]).toMatchObject({ exportedAs: "default", schema: { title: "string", width: "integer" } });
  }, 60_000);

  it("streams an honest failure for a graph that needs host modules", async () => {
    const { status, frames } = await stream({ files: { "a.cjs": "var cp = require('child_process');\nexports.a = function (n) { return n; };" } });
    expect(status).toBe(200);
    const graph = frames[0]?.graph as { problems: Array<{ kind: string }> };
    expect(graph.problems.map((p) => p.kind)).toEqual(["external-require"]);
    const r = frames.at(-1)?.result as { success: boolean; error: string; bundleId?: string };
    expect(r.success).toBe(false);
    expect(r.error).toContain('requires "child_process"');
    expect(r.bundleId).toBeUndefined();
  });

  it.each([
    [{}],
    [{ files: "x" }],
    [{ files: { "../escape.cjs": "1" } }],
    [{ files: { "/abs.cjs": "1" } }],
    [{ files: { "a.cjs": 5 } }],
    [{ files: { "a.cjs": "1" }, entry: "missing.cjs" }],
    [{ files: {} }],
    [{ files: { "a.cjs": "1" }, fileRuns: 100000 }],
    [{ files: { "a.cjs": "1" }, schemas: { f: { n: "not-a-kind" } } }],
    [{ files: { "a.cjs": "1" }, extra: true }],
  ])("rejects %j with 400", async (body) => {
    const res = await fetch(`${baseUrl}/api/resurrect-graph`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("Invalid project");
  });

  it("serves the Multi-File Project panel with both curated projects, identical to the examples", async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    expect(html).toContain("Multi-File Project (Stitch Graph)");
    expect(html).toContain("Resurrect Project Graph");
    expect(html).toContain("Download Whole-Project .zip");
    expect(html).toContain('id="graphSvg"');
    for (const [, source] of [...Object.entries(INVOICE), ...Object.entries(TEXT)]) {
      // The presets embed each file as a JSON string literal.
      expect(html).toContain(JSON.stringify(source.replace(/\r\n/g, "\n")).slice(1, -1));
    }
  });
});
