import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MutationAuditResult } from "../../crew/mutation-audit.js";
import { createWebServer } from "../server.js";

const HALVE = { legacyCode: "var half = (n / 2) | 0; half;", modernCode: "const half = Math.trunc(n / 2) || 0;\nhalf;", schema: { n: "integer" } };

describe("POST /api/mutation-audit", () => {
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

  const post = async (body: unknown, raw = false): Promise<{ status: number; json: Record<string, unknown>; ms: number }> => {
    const started = Date.now();
    const res = await fetch(`${baseUrl}/api/mutation-audit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw ? String(body) : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown>, ms: Date.now() - started };
  };

  it("refuses a concurrent audit with 429 BUSY while one is running", async () => {
    // First request on a cold server: the audit includes spawning both workers, so the two requests overlap.
    const [a, b] = await Promise.all([post({ ...HALVE, seed: 1 }), post({ ...HALVE, seed: 2 })]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
    const busy = a.status === 429 ? a : b;
    expect(busy.json).toMatchObject({ code: "BUSY" });
  }, 20_000);

  it("audits a verified resurrection end to end in under 3 seconds", async () => {
    const { status, json, ms } = await post({ ...HALVE, seed: 1337 });
    expect(status).toBe(200);
    expect(ms).toBeLessThan(3000);
    const result = json as unknown as MutationAuditResult;
    expect(result).toMatchObject({ baselineVerified: true, totalMutants: 4, killed: 4, survived: 0, killRatePercent: 100 });
    expect(result.elapsedMs).toBeLessThan(2000);
    for (const m of result.mutants) {
      expect(m.status).toBe("KILLED");
      expect(typeof m.killingCounterexample?.display).toBe("string");
      expect(m.diffSnippet).toContain("+ ");
    }
  }, 20_000);

  it("runs the legacy side as the extracted specimen (CommonJS module) and reports honest survivors", async () => {
    const legacyCode = "module.exports = function quantizeClamp(n) {\n  var clamped = n < -100 ? -100 : (n > 100 ? 100 : n);\n  return (clamped / 3) | 0;\n};";
    const modernCode = "(function (n) {\n  const clamped = n < -100 ? -100 : n > 100 ? 100 : n;\n  return Math.trunc(clamped / 3) || 0;\n})(typeof n !== \"undefined\" ? n : undefined);";
    const { status, json } = await post({ legacyCode, modernCode, schema: { n: "integer" }, seed: 3 });
    expect(status).toBe(200);
    const result = json as unknown as MutationAuditResult;
    expect(result.baselineVerified).toBe(true);
    expect(result.survived).toBe(2);
    expect(result.killRatePercent).toBe(60);
  }, 20_000);

  it.each([
    [{}],
    [{ ...HALVE, schema: { n: "not-a-kind" } }],
    [{ ...HALVE, schema: { "n; process.exit()": "integer" } }],
    [{ ...HALVE, modernCode: "" }],
    [{ ...HALVE, legacyCode: "x".repeat(64_001) }],
    [{ ...HALVE, extra: true }],
    [{ ...HALVE, seed: 1.5 }],
    [{ ...HALVE, schema: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, "integer"])) }],
  ])("rejects %j with 400", async (body) => {
    const { status, json } = await post(body);
    expect(status).toBe(400);
    expect(String(json.error)).toContain("Invalid audit request");
  });

  it("rejects malformed JSON with 400", async () => {
    expect((await post("{nope", true)).status).toBe(400);
  });

  it("serves the mutation card, the button and the signature pill", async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    expect(html).toContain("Prove the Proof &mdash; Live Mutation Audit");
    expect(html).toContain("ATTACK MY OWN PROOF (RUN MUTATION AUDIT)");
    expect(html).toContain('id="sigPill"');
    // The card sits right below the Resurrection Certificate.
    expect(html.indexOf('id="mutCard"')).toBeGreaterThan(html.indexOf('id="certCard"'));
    expect(html.indexOf('id="sigPill"')).toBeLessThan(html.indexOf('id="modernOut"'));
  });
});

describe("/api/resurrect and /api/export-bundle carry the types and the kill score", () => {
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

  it("returns an inferred signature, and the export annotates resurrected.ts, adds types.d.ts and the proof-strength row", async () => {
    const res = await fetch(`${baseUrl}/api/resurrect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "legacy-int-halve", legacyCode: "var half = (n / 2) | 0; half;", schema: { n: "integer" }, fuzzRuns: 60, seed: 1337 }),
    });
    const frames = (await res.text()).split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as { kind: string; result?: Record<string, unknown> });
    const result = frames.find((f) => f.kind === "result")?.result;
    expect(result?.success).toBe(true);
    expect(result?.typeSignatureText).toBe("legacy_int_halve(n: number): number");
    expect(result?.observations).toBeUndefined();

    const exportRes = await fetch(`${baseUrl}/api/export-bundle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specimenName: "legacy_int_halve",
        legacyCode: "var half = (n / 2) | 0; half;",
        modernCode: result?.modernCode,
        specMarkdown: "# s",
        fuzzRuns: 60,
        schema: { n: "integer" },
        typeSignature: result?.typeSignature,
        mutationAudit: { killed: 4, total: 4 },
      }),
    });
    const bundle = (await exportRes.json()) as { files: Record<string, string> };
    expect(bundle.files["resurrected.ts"]).toContain("export function legacy_int_halve(n: number): number {");
    expect(bundle.files["types.d.ts"]).toContain("export declare function legacy_int_halve(n: number): number;");
    expect(bundle.files["SPEC.md"]).toContain("| Proof strength (mutation audit) | 4/4 mutants killed (100% proof strength) |");
  }, 30_000);

  it("ignores a tampered signature and an impossible kill score", async () => {
    const res = await fetch(`${baseUrl}/api/export-bundle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specimenName: "half",
        legacyCode: "(n / 2) | 0",
        modernCode: "Math.trunc(n / 2) || 0",
        schema: { n: "integer" },
        typeSignature: { params: [{ name: "n", type: { kind: "number" }, fuzzedAs: "integer" }], returns: { kind: "number; process.exit(1)" }, returnNotes: [], samples: 1, throws: 0 },
        mutationAudit: { killed: 9, total: 4 },
      }),
    });
    const bundle = (await res.json()) as { files: Record<string, string> };
    expect(bundle.files["resurrected.ts"]).toContain("export function half(n: number): unknown {");
    expect(bundle.files["types.d.ts"]).toBeUndefined();
    expect(bundle.files["SPEC.md"]).not.toContain("Proof strength");
  });
});
