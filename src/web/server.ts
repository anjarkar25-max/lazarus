import { validateAndNormalizeGitHubUrl, fetchGitHubSpecimen } from "../importer/github.js";
import { bundleToZipEntries, generateResurrectionBundle, sanitizeIdentifier } from "../exporter/bundle.js";
import { createZip } from "../exporter/zip.js";
import { generateVerifiedBundle, type TypecheckReport, type VerifiedBundle } from "../exporter/verified-bundle.js";
import { closeSharedTsVerifier, describeTypecheck } from "../crew/ts-verifier.js";
import { TRACE_TOOLS, type WireTrace } from "../crew/orchestrator.js";
import { plural } from "../text/plural.js";
import { RedTeamBodySchema, runRedTeam } from "../sandbox/redteam.js";
import { randomUUID } from "node:crypto";
import { resurrectGraph, type GraphProgress, type GraphResurrectionResult } from "../crew/graph-resurrector.js";
import { buildGraphBundle, graphBundleZip, type GraphBundle } from "../exporter/graph-bundle.js";
import { validateVirtualFiles } from "../sandbox/virtual-fs.js";
import { runMutationAudit } from "../crew/mutation-audit.js";
import { naiveRefactor } from "../crew/naive-refactor.js";
import { buildLegacyHarness, buildModernHarness, detectErrorFirst, literalExamples, stripAsyncTypes, type ErrorFirstFunction } from "../crew/async-callback.js";
import { generateAsyncVerifiedBundle } from "../exporter/async-bundle.js";
import { renderType, type TypeSignature } from "../crew/type-alchemist.js";
import { formatInputs, formatOutcome } from "../crew/exact-format.js";
import { DifferentialFuzzer } from "../fuzzer/differential.js";
import { inferSignature, parseSignature, renderSignature, widenReturn } from "../crew/type-alchemist.js";
import { scanLegacyAst } from "../sandbox/ast-scanner.js";
import { generateCertificate, renderCertificateSvg, sanitizeProvenance, type CertificateInput } from "../exporter/certificate.js";
import { readKiroDna, resolveKiroDocument, SPEC_DOCUMENTS } from "./kiro-dna.js";
import { describePaste } from "./smart-paste.js";
import { buildGitHubPrSummary } from "../exporter/pr-summary.js";
import { importNpmPackage, NpmImportError, statusFor, type FetchLike } from "../importer/npm.js";
import { GitHubDirError, importGitHubFolder, statusForGitHubDir } from "../importer/github-dir.js";
import type { ResurrectionResult } from "../crew/types.js";
import { readHeaderLevels } from "../crew/ast-modernizer.js";
import { listModuleFunctions, mergeLevels, resurrectModule } from "../crew/module-resurrection.js";
import { SandboxError } from "../sandbox/errors.js";
import { PooledProbeRunner } from "../sandbox/pool.js";
import { decodeTagged, describeValue } from "../sandbox/tagged.js";
import { areOutputsEquivalent } from "../fuzzer/differential.js";
import * as fs from "node:fs";
import * as http from "node:http";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ResurrectionOrchestrator } from "../crew/orchestrator.js";
import { toEsmModule } from "../crew/esm-export.js";
import { DeterministicModernizer } from "../crew/synthesizer.js";
import type { CodeSynthesizer, CrewEvent, ResurrectionRequest } from "../crew/types.js";
import type { InputSchema } from "../fuzzer/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = nodePath.dirname(__filename);
const publicDir = nodePath.resolve(__dirname, "../../public");

/** Warm sandbox workers make deep live fuzzing cheap; a full resurrection stays well under 3 s. */
export const DEFAULT_LIVE_FUZZ_RUNS = 100;
export const MAX_LIVE_FUZZ_RUNS = 150;

// ---------------------------------------------------------------------------
// POST /api/probe: run one custom input through legacy and resurrected code
// ---------------------------------------------------------------------------

const MAX_CODE_CHARS = 64_000;
const MAX_BODY_BYTES = 256_000;

/** Context keys become globals in the sandbox, so they must be plain identifiers (and not internals). */
const ContextKey = z.string().regex(/^(?!__lz)[A-Za-z_$][\w$]*$/, "context keys must be plain identifiers");

export const ProbeBodySchema = z
  .object({
    legacyCode: z.string().min(1, "legacyCode is required").max(MAX_CODE_CHARS),
    /** Probe this exported function of a multi-export module (name or export name). */
    functionName: z.string().min(1).max(200).optional(),
    modernCode: z.string().min(1, "modernCode is required").max(MAX_CODE_CHARS),
    context: z
      .record(ContextKey, z.unknown())
      .refine((record) => Object.keys(record).length <= 32, "context may have at most 32 keys")
      .default({}),
  })
  .strict();

export interface ProbeSide {
  ok: boolean;
  /** Human-readable value that keeps -0, NaN and undefined distinguishable. */
  display: string;
  /** The value in tagged form (see sandbox/tagged.ts), so clients can re-decode it exactly. */
  output?: unknown;
  errorCode?: string;
  errorMessage?: string;
  stdout?: string;
  stderr?: string;
  durationMs: number;
}

export interface ProbeResponse {
  legacy: ProbeSide;
  modern: ProbeSide;
  exactParity: boolean;
  /** Why the sides match or differ. */
  reason: string;
}

async function probeSide(runner: PooledProbeRunner, code: string, context: Record<string, unknown>): Promise<{ side: ProbeSide; value: unknown }> {
  const started = Date.now();
  try {
    const result = await runner.run({ code, context, encoding: "tagged" });
    const value = decodeTagged(result.output);
    return {
      value,
      side: {
        ok: true,
        display: describeValue(value),
        output: result.output,
        durationMs: result.durationMs,
        ...(result.stdout ? { stdout: result.stdout } : {}),
        ...(result.stderr ? { stderr: result.stderr } : {}),
      },
    };
  } catch (err: unknown) {
    const errorCode = err instanceof SandboxError ? err.code : "INTERNAL_ERROR";
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { value: undefined, side: { ok: false, display: `${errorCode}: ${errorMessage}`, errorCode, errorMessage, durationMs: Date.now() - started } };
  }
}

function explainMismatch(legacy: unknown, modern: unknown): string {
  if (typeof legacy === "number" && typeof modern === "number") {
    if (legacy === 0 && modern === 0) return `sign of zero differs: legacy ${describeValue(legacy)} vs modern ${describeValue(modern)}`;
    if (Number.isNaN(legacy) !== Number.isNaN(modern)) return `NaN differs: legacy ${describeValue(legacy)} vs modern ${describeValue(modern)}`;
  }
  return `values differ: legacy ${describeValue(legacy)} vs modern ${describeValue(modern)}`;
}

export function compareProbeSides(legacy: { side: ProbeSide; value: unknown }, modern: { side: ProbeSide; value: unknown }): ProbeResponse {
  let exactParity: boolean;
  let reason: string;
  if (legacy.side.ok && modern.side.ok) {
    exactParity = areOutputsEquivalent(legacy.value, modern.value);
    reason = exactParity ? "Object.is parity: both returned the same value" : explainMismatch(legacy.value, modern.value);
  } else if (!legacy.side.ok && !modern.side.ok) {
    exactParity = true;
    reason = "both implementations rejected the input";
  } else {
    exactParity = false;
    reason = legacy.side.ok
      ? `modern failed (${modern.side.errorCode}) while legacy returned ${legacy.side.display}`
      : `legacy failed (${legacy.side.errorCode}) while modern returned ${modern.side.display}`;
  }
  return { legacy: legacy.side, modern: modern.side, exactParity, reason };
}

class PayloadTooLarge extends Error {}

function readJsonUnknown(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      raw += chunk.toString("utf8");
      if (raw.length > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(new PayloadTooLarge("Payload too large"));
      }
    });
    req.on("end", () => {
      if (tooLarge) return;
      try {
        resolve(raw ? (JSON.parse(raw) as unknown) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

interface ResurrectBody {
  name?: string;
  legacyCode?: string;
  /** Flat `{ param: kind }`, or nested `{ functionName: { param: kind } }` for multi-export modules. */
  schema?: InputSchema | Record<string, InputSchema>;
  /** Where the specimen came from (preset, GitHub, npm...); shown on the Resurrection Certificate. */
  provenance?: unknown;
  fuzzRuns?: number;
  seed?: number;
  simulateBuggyFirstDraft?: boolean;
}

function readJsonBody(req: http.IncomingMessage): Promise<ResurrectBody> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > 256_000) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? (JSON.parse(raw) as ResurrectBody) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** `{ fn: { param: kind } }` rather than `{ param: kind }`. */
function isNestedSchema(schema: unknown): schema is Record<string, InputSchema> {
  return isPlainObject(schema) && Object.keys(schema).length > 0 && Object.values(schema).every(isPlainObject);
}
function flatSchemaOf(schema: InputSchema | Record<string, InputSchema>, preferred?: string): InputSchema {
  if (!isNestedSchema(schema)) return schema as InputSchema;
  return (preferred !== undefined ? schema[preferred] : undefined) ?? Object.values(schema)[0] ?? {};
}
/** Body of /api/export-bundle and /api/export-zip (also used by /api/resurrect to report the strict check). */
export type ExportRequest = {
  specimenName?: string;
  legacyCode?: string;
  modernCode?: string;
  specMarkdown?: string;
  fuzzRuns?: number;
  healed?: boolean;
  schema?: Record<string, string> | Record<string, Record<string, string>>;
  functions?: Array<{ name?: string; schema?: Record<string, string>; modernCode?: string }>;
  provenance?: unknown;
  attempts?: number;
  typeSignature?: unknown;
  mutationAudit?: unknown;
};
/**
 * Builds the PR bundle and verifies its TypeScript with the real compiler under --strict. The certificate and SPEC.md
 * carry that server-computed result; any client-supplied claim about it is ignored.
 */
/** The error-first entry when `legacyCode` is a callback module and `modernCode` its resurrected async TypeScript. */
export function asyncEntryOf(legacyCode: string, modernCode: string, name?: string): ErrorFirstFunction | undefined {
  const entry = detectErrorFirst(legacyCode, name !== undefined ? { entryName: name } : {}).entry;
  return entry !== undefined && stripAsyncTypes(modernCode, entry) !== undefined ? entry : undefined;
}
export async function buildExportBundle(parsed: ExportRequest & { legacyCode: string; modernCode: string }): Promise<VerifiedBundle & { prSummary: string; certificateSvg: string }> {
  const typeSignature = parsed.typeSignature === undefined ? undefined : parseSignature(parsed.typeSignature);
  const checkedScore = parsed.mutationAudit === undefined ? undefined : MutationScoreSchema.safeParse(parsed.mutationAudit);
  const mutationScore = checkedScore?.success === true ? checkedScore.data : undefined;
  const asyncEntry = asyncEntryOf(parsed.legacyCode, parsed.modernCode, parsed.specimenName);
  if (asyncEntry !== undefined) {
    const flat = parsed.schema === undefined ? {} : flatSchemaOf(parsed.schema as InputSchema, asyncEntry.name);
    const schema = Object.fromEntries(asyncEntry.params.map((p) => [p, flat[p] ?? "string"]));
    const asyncCertificate = (typecheck: TypecheckReport): CertificateInput => ({
      provenance: sanitizeProvenance(parsed.provenance),
      legacySource: parsed.legacyCode,
      modernCode: parsed.modernCode,
      fuzz: { totalRuns: parsed.fuzzRuns ?? DEFAULT_LIVE_FUZZ_RUNS, exact: true },
      attempts: typeof parsed.attempts === "number" && parsed.attempts >= 1 ? Math.floor(parsed.attempts) : 1,
      esmComplete: false,
      ...(mutationScore !== undefined ? { mutation: mutationScore } : {}),
      typecheck,
    });
    const verified = await generateAsyncVerifiedBundle(
      {
        specimenName: asyncEntry.name,
        legacySource: parsed.legacyCode,
        modernTs: parsed.modernCode,
        entry: asyncEntry,
        schema,
        fuzzRuns: parsed.fuzzRuns ?? DEFAULT_LIVE_FUZZ_RUNS,
        attempts: typeof parsed.attempts === "number" && parsed.attempts >= 1 ? Math.floor(parsed.attempts) : 1,
        specMarkdown: parsed.specMarkdown ?? "# Synthesized Kiro Specification",
      },
      (typecheck) => generateCertificate(asyncCertificate(typecheck)).markdown
    );
    const name = sanitizeIdentifier(asyncEntry.name);
    return {
      ...verified,
      prSummary: buildGitHubPrSummary({ ...asyncCertificate(verified.typecheck), name }),
      certificateSvg: renderCertificateSvg(generateCertificate(asyncCertificate(verified.typecheck)), { name }),
    };
  }
  const fnEntries = (parsed.functions ?? []).filter(
    (f): f is { name: string; schema?: Record<string, string>; modernCode: string } =>
      typeof f.name === "string" && f.name.length > 0 && typeof f.modernCode === "string" && f.modernCode.length > 0
  );
  // Rollbacks recorded in the candidates' `// ast-rules:` headers must reach the ESM file too.
  const headerLevels = fnEntries.length > 0 ? mergeLevels(fnEntries.map((f) => f.modernCode)) : readHeaderLevels(parsed.modernCode);
  const esm = toEsmModule(parsed.legacyCode, headerLevels === undefined ? {} : { levels: headerLevels });
  const scan = scanLegacyAst(parsed.legacyCode);
  const requestedSchema = parsed.schema === undefined ? undefined : flatSchemaOf(parsed.schema as InputSchema, scan.primary?.exportedAs);
  const schema = requestedSchema ?? (Object.keys(scan.suggestedSchema).length > 0 ? scan.suggestedSchema : undefined);
  const certificateInput = (typecheck: TypecheckReport): CertificateInput => ({
    provenance: sanitizeProvenance(parsed.provenance),
    legacySource: parsed.legacyCode,
    modernCode: parsed.modernCode,
    fuzz: { totalRuns: parsed.fuzzRuns ?? DEFAULT_LIVE_FUZZ_RUNS, exact: true },
    attempts: typeof parsed.attempts === "number" && parsed.attempts >= 1 ? Math.floor(parsed.attempts) : parsed.healed ? 2 : 1,
    esmComplete: esm.complete,
    ...(mutationScore !== undefined ? { mutation: mutationScore } : {}),
    typecheck,
  });
  const moduleFunctions = fnEntries.map((f) => {
    const scanned = scanLegacyAst(parsed.legacyCode ?? "", { functionName: f.name });
    return {
      name: f.name,
      schema: f.schema ?? scanned.suggestedSchema,
      legacyCode: scanned.primaryExpression,
      modernCode: f.modernCode,
    };
  });
  const verified = await generateVerifiedBundle(
    {
      specimenName: parsed.specimenName ?? "resurrectedSpecimen",
      // The parity oracle runs the extracted expression; the diff shows the file as written.
      legacyCode: scan.primaryExpression,
      legacySource: parsed.legacyCode,
      modernCode: parsed.modernCode,
      specMarkdown: parsed.specMarkdown ?? "# Synthesized Kiro Specification",
      fuzzRuns: parsed.fuzzRuns ?? DEFAULT_LIVE_FUZZ_RUNS,
      healed: Boolean(parsed.healed),
      ...(schema ? { schema } : {}),
      ...(esm.complete ? { esmModule: { code: esm.code, exports: esm.exports } } : {}),
      ...(moduleFunctions.length > 0 ? { functions: moduleFunctions } : {}),
      ...(typeSignature !== undefined && moduleFunctions.length === 0 ? { typeSignature } : {}),
    },
    (typecheck) => generateCertificate(certificateInput(typecheck)).markdown
  );
  const name = sanitizeIdentifier(parsed.specimenName ?? "resurrectedSpecimen");
  return {
    ...verified,
    prSummary: buildGitHubPrSummary({ ...certificateInput(verified.typecheck), name }),
    certificateSvg: renderCertificateSvg(generateCertificate(certificateInput(verified.typecheck)), { name }),
  };
}
export interface WebServerOptions {
  /** `fetch` used by POST /api/import/npm. Tests inject a mock so they never touch the network. */
  npmFetch?: FetchLike;
  /** `fetch` used by POST /api/import/github-dir (api.github.com + raw.githubusercontent.com). Injected by tests. */
  githubFetch?: FetchLike;
}
const NpmImportBody = z.object({ packageSpec: z.string().max(300) }).strict();
const GitHubDirBody = z.object({ url: z.string().max(500) }).strict();
const KindSchema = z.enum(["integer", "number", "string", "boolean", "json"]);
const GraphSchemaArg = z.record(z.string().regex(/^[A-Za-z_$][\w$]*$/), KindSchema);
export const GraphBodySchema = z
  .object({
    name: z.string().max(80).optional(),
    files: z.record(z.string().min(1).max(200), z.string().max(64_000)),
    entry: z.string().max(200).optional(),
    /** Schemas for the entry module's exports: { exportName: { param: kind } } ("default" for module.exports = fn). */
    schemas: z.record(z.string().max(100), GraphSchemaArg).optional(),
    fileRuns: z.number().int().min(5).max(200).optional(),
    graphRuns: z.number().int().min(5).max(MAX_LIVE_FUZZ_RUNS).optional(),
    seed: z.number().int().optional(),
  })
  .strict();
const GraphZipBody = z.object({ bundleId: z.string().uuid() }).strict();
const ScanBody = z.object({ legacyCode: z.string().max(MAX_CODE_CHARS) }).strict();
/** Repository root: the anchor of `public/`, so `.kiro/` is found the same way locally and on Render. */
const repoRoot = nodePath.resolve(__dirname, "../..");
export const MutationAuditBodySchema = z
  .object({
    legacyCode: z.string().min(1).max(MAX_CODE_CHARS),
    modernCode: z.string().min(1).max(MAX_CODE_CHARS),
    schema: z.record(z.string().regex(/^[A-Za-z_$][\w$]*$/), KindSchema).refine((s) => Object.keys(s).length <= 16, "at most 16 parameters"),
    seed: z.number().int().optional(),
  })
  .strict();
/** Body of POST /api/compare-naive. `schema` defaults to the scanner's suggested schema. */
export const CompareNaiveBodySchema = z
  .object({
    legacyCode: z.string().min(1).max(MAX_CODE_CHARS),
    schema: z.record(z.string().regex(/^[A-Za-z_$][\w$]*$/), KindSchema).refine((s) => Object.keys(s).length <= 16, "at most 16 parameters").optional(),
    seed: z.number().int().optional(),
  })
  .strict();
export const COMPARE_NAIVE_RUNS = 100;
/** Verified test count shown on the Studio's badge (read once from the served page). */
function badgeTestCount(publicDirectory: string): number | null {
  try {
    const m = /id="badgeTests">(\d+) Verified Tests</.exec(fs.readFileSync(nodePath.join(publicDirectory, "index.html"), "utf8"));
    return m?.[1] !== undefined ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
const MutationScoreSchema = z.object({ killed: z.number().int().min(0), total: z.number().int().min(1).max(50) }).strict().refine((m) => m.killed <= m.total);
/** Bundles of recent successful graph resurrections, so the zip button never has to trust client-sent code. */
const GRAPH_BUNDLE_CACHE = 16;
/** What the browser needs to render the result (no bundle file bodies). */
function summarizeGraph(result: GraphResurrectionResult, bundleId: string | undefined): Record<string, unknown> {
  return {
    success: result.success,
    name: result.name,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(bundleId !== undefined ? { bundleId } : {}),
    durationMs: result.durationMs,
    order: result.graph.order,
    entry: result.graph.entry,
    edges: result.graph.edges,
    files: result.files.map((f) => ({
      path: f.path,
      esmPath: f.esmPath,
      esmCode: f.esmCode,
      tsPath: f.tsPath,
      tsCode: f.tsCode,
      exports: f.esmExports,
      attempts: f.attempts,
      healed: f.healed,
      rolledBack: f.rolledBack,
      fuzzRuns: f.fuzzRuns,
      success: f.success,
    })),
    ...(result.typecheck !== undefined ? { typecheck: result.typecheck } : {}),
    parity:
      result.parity === undefined
        ? undefined
        : {
            passed: result.parity.passed,
            exact: result.parity.exact,
            totalRuns: result.parity.totalRuns,
            functions: result.parity.functions.map((fn) => ({ exportedAs: fn.exportedAs, schema: fn.schema, passed: fn.passed, totalRuns: fn.totalRuns, ...(fn.counterexample !== undefined ? { reason: fn.counterexample.reason } : {}) })),
          },
  };
}
export function createWebServer(options: WebServerOptions = {}): http.Server {
  // Two warm sandbox workers for interactive probing. Created on first use, closed with the server.
  let probeLegacy: PooledProbeRunner | undefined;
  let probeModern: PooledProbeRunner | undefined;
  // Dedicated worker for the Red-Team card, so attacks never touch probe or resurrection pools.
  let redTeamPool: PooledProbeRunner | undefined;
  let redTeamBusy = false;
  const graphBundles = new Map<string, GraphBundle>();
  // Dedicated workers for the mutation auditor, one audit at a time (like the red-team card).
  let auditLegacy: PooledProbeRunner | undefined;
  let auditModern: PooledProbeRunner | undefined;
  let auditBusy = false;
  // Dedicated workers for the Naive AI trap comparison, one comparison at a time.
  let naiveLegacy: PooledProbeRunner | undefined;
  let naiveModern: PooledProbeRunner | undefined;
  let naiveBusy = false;
  const serverStarted = Date.now();
  let healthTests: number | null | undefined;
  const probePools = (): { legacy: PooledProbeRunner; modern: PooledProbeRunner } => {
    probeLegacy ??= new PooledProbeRunner();
    probeModern ??= new PooledProbeRunner();
    return { legacy: probeLegacy, modern: probeModern };
  };

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    if (method === "GET" && url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "lazarus-operating-table" }));
      return;
    }

    if (method === "GET" && url.split("?")[0] === "/api/health") {
      // Lightweight liveness probe for the Studio's cold-start guard (never touches the sandbox).
      healthTests ??= badgeTestCount(publicDir);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, uptimeSec: Math.round((Date.now() - serverStarted) / 1000), tests: healthTests, specs: readKiroDna(repoRoot).specCount }));
      return;
    }
    if (method === "GET" && (url === "/" || url === "/index.html")) {
      const indexPath = nodePath.join(publicDir, "index.html");
      if (!fs.existsSync(indexPath)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("index.html not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }

    if (method === "POST" && url === "/api/resurrect") {
      let body: ResurrectBody;
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }

      if (!body.legacyCode || typeof body.legacyCode !== "string" || !body.schema || typeof body.schema !== "object") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "legacyCode and schema are required" }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });

      const defaultModernizer = new DeterministicModernizer();
      const synthesizer: CodeSynthesizer = body.simulateBuggyFirstDraft
        ? {
            async synthesize(ctx) {
              if (ctx.attempt === 1) {
                return (
                  "// Attempt 1: Naive modernization using Math.floor\n" +
                  ctx.legacyCode.replace(/\(([^()]+)\)\s*\|\s*0\b/g, "Math.floor($1)")
                );
              }
              return defaultModernizer.synthesize(ctx);
            },
          }
        : defaultModernizer;

      const orchestrator = new ResurrectionOrchestrator({ synthesizer });

      /** Wire traces measured by the server itself (streamed now, and appended to the result's events). */
      const serverTraces: CrewEvent[] = [];
      const sendTrace = (agent: CrewEvent["agent"], trace: WireTrace): void => {
        const event: CrewEvent = { timestamp: new Date().toISOString(), agent, type: "mcp_trace", message: `${trace.tool} \u00b7 ${trace.durationMs} ms \u00b7 ${trace.summary}`, payload: { ...trace } };
        serverTraces.push(event);
        res.write(`data: ${JSON.stringify({ kind: "event", event })}\n\n`);
      };
      const scanStarted = performance.now();
      const scan = scanLegacyAst(body.legacyCode);
      sendTrace("archaeologist", {
        tool: TRACE_TOOLS.astScan,
        durationMs: Math.round((performance.now() - scanStarted) * 100) / 100,
        poolReused: null,
        summary: scan.parsed
          ? `specimen extracted: ${scan.primary !== undefined ? `function ${scan.primary.name}` : "script expression"}; ${plural(scan.detectedIdioms.length, "legacy idiom")}`
          : `parse failed: ${scan.parseError ?? "syntax error"}`,
      });
      /** Trace of the strict tsc check behind a verified bundle (timing and process reuse from the verifier). */
      const traceTypecheck = (tc: TypecheckReport): void =>
        sendTrace("exorcist", {
          tool: TRACE_TOOLS.tscStrict,
          durationMs: tc.elapsedMs,
          poolReused: tc.reusedProcess,
          summary: `${describeTypecheck(tc)} via ${tc.engine}${tc.rounds > 1 ? `, ${plural(tc.rounds, "compiler run")}` : ""}`,
        });
      const request: ResurrectionRequest = {
        name: body.name && body.name.trim() ? body.name.trim() : "legacy-specimen",
        legacyCode: scan.primaryExpression,
        schema: flatSchemaOf(body.schema, scan.primary?.exportedAs),
        fuzzRuns:
          typeof body.fuzzRuns === "number"
            ? Math.min(Math.max(body.fuzzRuns, 5), MAX_LIVE_FUZZ_RUNS)
            : DEFAULT_LIVE_FUZZ_RUNS,
        ...(typeof body.seed === "number" ? { seed: body.seed } : {}),
        maxHealingAttempts: 3,
        exact: true,
        collectObservations: true,
        onEvent: (event: CrewEvent) => {
          res.write(`data: ${JSON.stringify({ kind: "event", event })}\n\n`);
        },
      };

      const legacySource = body.legacyCode;
      const provenance = sanitizeProvenance(body.provenance);
      /** The certificate exists only for a verified resurrection. */
      const certificateFor = (r: ResurrectionResult, esmComplete: boolean, typecheck?: TypecheckReport): { certificate?: ReturnType<typeof generateCertificate> } =>
        r.success
          ? {
              certificate: generateCertificate({
                provenance,
                legacySource,
                modernCode: r.modernCode,
                fuzz: { totalRuns: r.fuzzReport.totalRuns, exact: r.fuzzReport.exact === true, ...(r.fuzzReport.boundaryRuns !== undefined ? { boundaryRuns: r.fuzzReport.boundaryRuns } : {}) },
                attempts: r.attempts,
                esmComplete,
                ...(typecheck !== undefined ? { typecheck } : {}),
              }),
            }
          : {};
      try {
        const errorFirst = detectErrorFirst(body.legacyCode, { entryName: request.name }).entry;
        if (errorFirst !== undefined) {
          // Additive async pass: Node.js error-first callback -> async/await, both settlements fuzzed in the sandbox.
          const flat = flatSchemaOf(body.schema, errorFirst.name);
          const scanned = scanLegacyAst(body.legacyCode, { functionName: errorFirst.name }).suggestedSchema;
          const schema: InputSchema = Object.fromEntries(errorFirst.params.map((p) => [p, flat[p] ?? scanned[p] ?? "string"]));
          const resurrected = await orchestrator.resurrectErrorFirst({
            name: request.name,
            source: body.legacyCode,
            schema,
            ...(request.fuzzRuns !== undefined ? { fuzzRuns: request.fuzzRuns } : {}),
            ...(request.seed !== undefined ? { seed: request.seed } : {}),
            ...(request.onEvent !== undefined ? { onEvent: request.onEvent } : {}),
          });
          const verified = resurrected.success
            ? await buildExportBundle({ specimenName: errorFirst.name, legacyCode: body.legacyCode, modernCode: resurrected.modernCode, fuzzRuns: resurrected.fuzzReport.totalRuns, attempts: resurrected.attempts, schema })
            : undefined;
          if (verified !== undefined) traceTypecheck(verified.typecheck);
          const sig: TypeSignature | undefined = resurrected.typeSignature;
          const returns = sig === undefined ? "unknown" : verified?.typecheck.widenedReturn === true ? "unknown" : renderType(sig.returns);
          const result = {
            ...resurrected,
            events: [...serverTraces.slice(0, 1), ...resurrected.events, ...serverTraces.slice(1)],
            ...certificateFor(resurrected, false, verified?.typecheck),
            ...(verified !== undefined ? { typecheck: verified.typecheck } : {}),
            ...(sig !== undefined ? { typeSignature: sig, typeSignatureText: `${errorFirst.name}(${sig.params.map((p) => `${p.name}: ${renderType(p.type)}`).join(", ")}): Promise<${returns}>` } : {}),
          };
          res.write(`data: ${JSON.stringify({ kind: "result", result })}\n\n`);
          return;
        }
        const moduleFunctions = listModuleFunctions(body.legacyCode).functions;
        if (moduleFunctions.length >= 2) {
          // Multi-export CommonJS: one resurrection per function, merged into one result.
          const nested = isNestedSchema(body.schema) ? body.schema : undefined;
          const flat = nested === undefined ? (body.schema as InputSchema) : undefined;
          const schemas: Record<string, InputSchema> = {};
          for (const fn of moduleFunctions) {
            const key = fn.exportedAs ?? fn.name;
            const own = nested?.[key];
            const picked = Object.fromEntries(Object.entries(flat ?? {}).filter(([param]) => fn.paramNames.includes(param)));
            schemas[key] = own ?? (Object.keys(picked).length > 0 ? picked : fn.paramKinds);
          }
          const merged = await resurrectModule(body.legacyCode, {
            name: request.name,
            orchestrator,
            ...(request.fuzzRuns !== undefined ? { fuzzRuns: request.fuzzRuns } : {}),
            ...(request.seed !== undefined ? { seed: request.seed } : {}),
            maxHealingAttempts: 3,
            schemas,
            onEvent: request.onEvent ?? (() => undefined),
          });
          const { functions, skipped, esm, levels: _levels, ...aggregate } = merged;
          // The same strict check the export runs, so the live result and the PR bundle agree.
          const verified = merged.success
            ? await buildExportBundle({
                specimenName: sanitizeIdentifier(request.name),
                legacyCode: body.legacyCode,
                modernCode: merged.modernCode,
                fuzzRuns: merged.fuzzReport.totalRuns,
                attempts: merged.attempts,
                functions: functions.map((f) => ({ name: f.exportedAs, schema: f.schema, modernCode: f.modernCode })),
              })
            : undefined;
          if (verified !== undefined) traceTypecheck(verified.typecheck);
          const result = {
            ...aggregate,
            events: [...serverTraces.slice(0, 1), ...aggregate.events, ...serverTraces.slice(1)],
            ...certificateFor(merged, esm.complete, verified?.typecheck),
            ...(verified !== undefined ? { typecheck: verified.typecheck } : {}),
            module: {
              functions: functions.map((f) => ({
                name: f.name,
                exportedAs: f.exportedAs,
                schema: f.schema,
                success: f.success,
                attempts: f.attempts,
                modernCode: f.modernCode,
                events: f.events,
              })),
              skipped,
              esm: { complete: esm.complete, exports: esm.exports, notes: esm.notes },
            },
          };
          res.write(`data: ${JSON.stringify({ kind: "result", result })}\n\n`);
        } else {
          const { observations, ...resurrected } = await orchestrator.resurrect(request);
          // Type Alchemist: types observed during the passing fuzz run (fuzzed domain only).
          const observed = resurrected.success && observations !== undefined && observations.length > 0 ? inferSignature(observations, request.schema) : undefined;
          const verified = resurrected.success
            ? await buildExportBundle({
                specimenName: sanitizeIdentifier(request.name),
                legacyCode: body.legacyCode,
                modernCode: resurrected.modernCode,
                fuzzRuns: resurrected.fuzzReport.totalRuns,
                attempts: resurrected.attempts,
                healed: resurrected.attempts > 1,
                schema: request.schema,
                ...(observed !== undefined ? { typeSignature: observed } : {}),
              })
            : undefined;
          // If tsc rejected the observed return type, the exported (and displayed) signature is the widened one.
          const typeSignature = observed !== undefined && verified?.typecheck.widenedReturn === true ? widenReturn(observed) : observed;
          if (verified !== undefined) traceTypecheck(verified.typecheck);
          const result = {
            ...resurrected,
            events: [...serverTraces.slice(0, 1), ...resurrected.events, ...serverTraces.slice(1)],
            ...certificateFor(resurrected, toEsmModule(body.legacyCode).complete, verified?.typecheck),
            ...(verified !== undefined ? { typecheck: verified.typecheck } : {}),
            ...(typeSignature !== undefined ? { typeSignature, typeSignatureText: renderSignature(typeSignature, sanitizeIdentifier(request.name)) } : {}),
          };
          res.write(`data: ${JSON.stringify({ kind: "result", result })}\n\n`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        res.write(`data: ${JSON.stringify({ kind: "error", message })}\n\n`);
      } finally {
        res.end();
      }
      return;
    }

    const routePath = req.url?.split("?")[0];

    if (req.method === "POST" && routePath === "/api/import-github") {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
      }
      try {
        const parsed = JSON.parse(raw || "{}") as { url?: string };
        if (!parsed.url) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing GitHub URL" }));
          return;
        }
        const imported = await fetchGitHubSpecimen(parsed.url);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(imported));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    if (req.method === "POST" && (routePath === "/api/export-bundle" || routePath === "/api/export-zip")) {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
      }
      try {
        const parsed = JSON.parse(raw || "{}") as ExportRequest;
        if (!parsed.legacyCode || !parsed.modernCode) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "legacyCode and modernCode are required" }));
          return;
        }
        const { bundle, typecheck, prSummary, certificateSvg } = await buildExportBundle({ ...parsed, legacyCode: parsed.legacyCode, modernCode: parsed.modernCode });
        if (routePath === "/api/export-zip") {
          const archive = createZip(bundleToZipEntries(bundle));
          res.writeHead(200, {
            "Content-Type": "application/zip",
            "Content-Disposition": "attachment; filename=\"lazarus-pr-bundle.zip\"",
            "Content-Length": archive.length,
            "Cache-Control": "no-store",
          });
          res.end(archive);
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...bundle, typecheck, prSummary, certificateSvg }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    if (req.method === "POST" && routePath === "/api/import/npm") {
      const fail = (status: number, payload: Record<string, unknown>): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      let rawBody: unknown;
      try {
        rawBody = await readJsonUnknown(req);
      } catch (err: unknown) {
        const tooLarge = err instanceof PayloadTooLarge;
        fail(tooLarge ? 413 : 400, { error: tooLarge ? "Payload too large" : "Invalid JSON body", code: tooLarge ? "TOO_LARGE" : "INVALID_SPEC" });
        return;
      }
      const checked = NpmImportBody.safeParse(rawBody);
      if (!checked.success) {
        fail(400, { error: "Body must be exactly { packageSpec: string }", code: "INVALID_SPEC" });
        return;
      }
      try {
        const imported = await importNpmPackage(checked.data.packageSpec, options.npmFetch === undefined ? {} : { fetch: options.npmFetch });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(imported));
      } catch (err: unknown) {
        if (err instanceof NpmImportError) {
          fail(statusFor(err.code), { error: err.message, code: err.code, ...(err.details !== undefined ? { details: err.details } : {}) });
        } else {
          fail(500, { error: "Unexpected importer failure", code: "UPSTREAM_ERROR" });
        }
      }
      return;
    }
    if (req.method === "POST" && routePath === "/api/import/github-dir") {
      const fail = (status: number, payload: Record<string, unknown>): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      let rawBody: unknown;
      try {
        rawBody = await readJsonUnknown(req);
      } catch (err: unknown) {
        const tooLarge = err instanceof PayloadTooLarge;
        fail(tooLarge ? 413 : 400, { error: tooLarge ? "Payload too large" : "Invalid JSON body", code: tooLarge ? "TOO_LARGE" : "INVALID_URL" });
        return;
      }
      const checked = GitHubDirBody.safeParse(rawBody);
      if (!checked.success) {
        fail(400, { error: "Body must be exactly { url: string }", code: "INVALID_URL" });
        return;
      }
      try {
        const imported = await importGitHubFolder(checked.data.url, options.githubFetch === undefined ? {} : { fetch: options.githubFetch });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(imported));
      } catch (err: unknown) {
        if (err instanceof GitHubDirError) {
          fail(statusForGitHubDir(err.code), { error: err.message, code: err.code, ...(err.details !== undefined ? { details: err.details } : {}) });
        } else {
          fail(500, { error: "Unexpected importer failure", code: "UPSTREAM_ERROR" });
        }
      }
      return;
    }
    if (req.method === "POST" && routePath === "/api/resurrect-graph") {
      let rawBody: unknown;
      try {
        rawBody = await readJsonUnknown(req);
      } catch (err: unknown) {
        res.writeHead(err instanceof PayloadTooLarge ? 413 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof PayloadTooLarge ? "Payload too large" : "Invalid JSON body" }));
        return;
      }
      const checked = GraphBodySchema.safeParse(rawBody);
      let problem: string | undefined = checked.success ? undefined : checked.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
      if (checked.success) {
        try {
          validateVirtualFiles(checked.data.files, checked.data.entry);
          if (Object.keys(checked.data.files).length === 0) problem = "files must contain at least one .js or .cjs file";
        } catch (err: unknown) {
          problem = err instanceof Error ? err.message : String(err);
        }
      }
      if (!checked.success || problem !== undefined) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Invalid project: ${problem ?? "malformed body"}` }));
        return;
      }
      const body = checked.data;
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
      const send = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      try {
        const result = await resurrectGraph(body.files, {
          name: sanitizeIdentifier(body.name ?? "legacy-project"),
          ...(body.entry !== undefined ? { entry: body.entry } : {}),
          ...(body.schemas !== undefined ? { schemas: body.schemas } : {}),
          fileRuns: body.fileRuns ?? 60,
          graphRuns: body.graphRuns ?? DEFAULT_LIVE_FUZZ_RUNS,
          ...(body.seed !== undefined ? { seed: body.seed } : {}),
          onProgress: (event: GraphProgress) => {
            if (event.kind === "graph") {
              const g = event.graph;
              send({ kind: "graph", graph: { files: g.files, edges: g.edges, order: g.order, entry: g.entry, depth: g.depth, esmPaths: g.esmPaths, cycles: g.cycles, problems: g.problems } });
            } else {
              send(event);
            }
          },
        });
        let bundleId: string | undefined;
        if (result.success) {
          bundleId = randomUUID();
          graphBundles.set(bundleId, buildGraphBundle(result, { runs: body.graphRuns ?? DEFAULT_LIVE_FUZZ_RUNS }));
          while (graphBundles.size > GRAPH_BUNDLE_CACHE) {
            const oldest = graphBundles.keys().next().value;
            if (oldest === undefined) break;
            graphBundles.delete(oldest);
          }
        }
        send({ kind: "result", result: summarizeGraph(result, bundleId) });
      } catch (err: unknown) {
        send({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        res.end();
      }
      return;
    }
    if (req.method === "POST" && routePath === "/api/export-graph-zip") {
      let rawBody: unknown;
      try {
        rawBody = await readJsonUnknown(req);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }
      const checked = GraphZipBody.safeParse(rawBody);
      const bundle = checked.success ? graphBundles.get(checked.data.bundleId) : undefined;
      if (bundle === undefined) {
        res.writeHead(checked.success ? 404 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: checked.success ? "Unknown or expired bundleId; resurrect the project again" : "Body must be { bundleId: uuid }" }));
        return;
      }
      const archive = graphBundleZip(bundle);
      const fileName = `lazarus-${sanitizeIdentifier(bundle.name).replace(/[^\w-]/g, "_")}-project.zip`;
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": archive.length,
        "Cache-Control": "no-store",
      });
      res.end(archive);
      return;
    }
    if (req.method === "GET" && routePath === "/api/kiro-dna") {
      const reply = (status: number, payload: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(payload));
      };
      const query = new URL(req.url ?? "/", "http://localhost").searchParams;
      const spec = query.get("spec");
      const doc = query.get("doc") ?? "requirements";
      if (spec === null) {
        reply(200, readKiroDna(repoRoot));
        return;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(spec) || spec.includes("..") || !(SPEC_DOCUMENTS as readonly string[]).includes(doc)) {
        reply(400, { error: `spec must be a spec folder name and doc one of ${SPEC_DOCUMENTS.join(", ")}` });
        return;
      }
      const text = resolveKiroDocument(repoRoot, spec, doc);
      if (text === undefined) {
        reply(404, { error: `no ${doc}.md for spec "${spec}"` });
        return;
      }
      reply(200, { spec, doc, text });
      return;
    }
    if (req.method === "POST" && routePath === "/api/scan") {
      let rawBody: unknown;
      try {
        rawBody = await readJsonUnknown(req);
      } catch (err: unknown) {
        res.writeHead(err instanceof PayloadTooLarge ? 413 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof PayloadTooLarge ? "Payload too large" : "Invalid JSON body" }));
        return;
      }
      const checked = ScanBody.safeParse(rawBody);
      if (!checked.success) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Body must be { legacyCode: string } (at most 64000 characters)" }));
        return;
      }
      // Parse only: the pasted code is never executed here.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(describePaste(checked.data.legacyCode)));
      return;
    }
    if (req.method === "POST" && routePath === "/api/mutation-audit") {
      const reply = (status: number, payload: Record<string, unknown>): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      let rawBody: unknown;
      try {
        rawBody = await readJsonUnknown(req);
      } catch (err: unknown) {
        reply(err instanceof PayloadTooLarge ? 413 : 400, { error: err instanceof PayloadTooLarge ? "Payload too large" : "Invalid JSON body" });
        return;
      }
      const checked = MutationAuditBodySchema.safeParse(rawBody);
      if (!checked.success) {
        reply(400, { error: `Invalid audit request: ${checked.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` });
        return;
      }
      if (auditBusy) {
        reply(429, { error: "A mutation audit is already running", code: "BUSY" });
        return;
      }
      auditBusy = true;
      try {
        auditLegacy ??= new PooledProbeRunner();
        auditModern ??= new PooledProbeRunner();
        const body = checked.data;
        const asyncEntry = asyncEntryOf(body.legacyCode, body.modernCode);
        const asyncJs = asyncEntry !== undefined ? stripAsyncTypes(body.modernCode, asyncEntry) : undefined;
        const result =
          asyncEntry !== undefined && asyncJs !== undefined
            ? await runMutationAudit({
                // Error-first module: the legacy settle harness against the async module (and its mutants), settled in the sandbox.
                legacyCode: buildLegacyHarness(body.legacyCode, asyncEntry),
                modernCode: asyncJs,
                schema: Object.fromEntries(asyncEntry.params.map((p) => [p, body.schema[p] ?? "string"])),
                executors: { legacy: auditLegacy, modern: auditModern },
                asyncHarness: {
                  wrap: (code) => buildModernHarness(code, asyncEntry.name, asyncEntry.params),
                  // The same literal dictionary the resurrection fuzzed with, so validation branches are reached.
                  examples: literalExamples(body.legacyCode, Object.fromEntries(asyncEntry.params.map((p) => [p, body.schema[p] ?? "string"]))),
                },
                ...(body.seed !== undefined ? { seed: body.seed } : {}),
              })
            : await runMutationAudit({
                // The oracle runs exactly what /api/resurrect ran: the extracted specimen expression.
                legacyCode: scanLegacyAst(body.legacyCode).primaryExpression,
                modernCode: body.modernCode,
                schema: body.schema,
                executors: { legacy: auditLegacy, modern: auditModern },
                ...(body.seed !== undefined ? { seed: body.seed } : {}),
              });
        reply(200, { ...result });
      } catch (err: unknown) {
        reply(500, { error: err instanceof Error ? err.message : "Mutation audit failed", code: "INTERNAL_ERROR" });
      } finally {
        auditBusy = false;
      }
      return;
    }
    if (req.method === "POST" && routePath === "/api/compare-naive") {
      const reply = (status: number, payload: Record<string, unknown>): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      let rawBody: unknown;
      try {
        rawBody = await readJsonUnknown(req);
      } catch (err: unknown) {
        reply(err instanceof PayloadTooLarge ? 413 : 400, { error: err instanceof PayloadTooLarge ? "Payload too large" : "Invalid JSON body" });
        return;
      }
      const checked = CompareNaiveBodySchema.safeParse(rawBody);
      if (!checked.success) {
        reply(400, { error: `Invalid comparison request: ${checked.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` });
        return;
      }
      // Parse only: the legacy code runs exclusively inside the sandbox workers below.
      const scan = scanLegacyAst(checked.data.legacyCode);
      const schema = checked.data.schema ?? scan.suggestedSchema;
      if (Object.keys(schema).length === 0) {
        reply(422, { error: "No input to fuzz: give a schema or a specimen with parameters", code: "NO_SCHEMA" });
        return;
      }
      const legacy = scan.primaryExpression;
      const naive = naiveRefactor(legacy);
      if (naive.parseError !== undefined) {
        reply(422, { error: `The specimen does not parse: ${naive.parseError}`, code: "PARSE_ERROR" });
        return;
      }
      if (naive.rewrites.length === 0) {
        reply(200, { naiveCode: naive.naiveCode, rewrites: [], passed: true, totalRuns: 0, schema, note: "No naive-trap pattern (| 0, >> 0, ~~, ==, var) in this specimen: a typical LLM rewrite would leave it as is, so there is nothing to compare." });
        return;
      }
      if (naiveBusy) {
        reply(429, { error: "A naive comparison is already running", code: "BUSY" });
        return;
      }
      naiveBusy = true;
      try {
        naiveLegacy ??= new PooledProbeRunner();
        naiveModern ??= new PooledProbeRunner();
        const fuzzer = new DifferentialFuzzer({ legacy: naiveLegacy, modern: naiveModern });
        const report = await fuzzer.fuzz(legacy, naive.naiveCode, schema, { numRuns: COMPARE_NAIVE_RUNS, exact: true, boundary: true, seed: checked.data.seed ?? 1337 });
        const cx = report.counterexample;
        reply(200, {
          naiveCode: naive.naiveCode,
          rewrites: naive.rewrites,
          passed: report.passed,
          totalRuns: report.totalRuns,
          schema,
          ...(report.passed || cx === undefined
            ? { note: `The naive rewrite matched the legacy code on all ${report.totalRuns} exact Object.is runs: no trap for this specimen over the fuzzed domain.` }
            : { counterexample: { input: formatInputs(cx.inputs), inputs: cx.inputs, legacyOutput: formatOutcome(cx.legacy), naiveOutput: formatOutcome(cx.modern), reason: cx.reason } }),
        });
      } catch (err: unknown) {
        reply(500, { error: err instanceof Error ? err.message : "Naive comparison failed", code: "INTERNAL_ERROR" });
      } finally {
        naiveBusy = false;
      }
      return;
    }
    if (req.method === "POST" && routePath === "/api/redteam") {
      const reply = (status: number, payload: Record<string, unknown>): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      let rawBody: unknown;
      try {
        rawBody = await readJsonUnknown(req);
      } catch (err: unknown) {
        reply(err instanceof PayloadTooLarge ? 413 : 400, { error: err instanceof PayloadTooLarge ? "Payload too large" : "Invalid JSON body" });
        return;
      }
      const checked = RedTeamBodySchema.safeParse(rawBody);
      if (!checked.success) {
        reply(400, { error: "attack must be one of: infinite-loop, process-exit, heap-bomb, prototype-escape" });
        return;
      }
      // One attack at a time, so this endpoint cannot be used to stack heap bombs.
      if (redTeamBusy) {
        reply(429, { error: "Another red-team attack is still running", code: "BUSY" });
        return;
      }
      redTeamBusy = true;
      try {
        redTeamPool ??= new PooledProbeRunner();
        reply(200, { ...(await runRedTeam(redTeamPool, checked.data.attack)) });
      } catch (err: unknown) {
        reply(500, { error: err instanceof Error ? err.message : "Red-team run failed", code: "INTERNAL_ERROR" });
      } finally {
        redTeamBusy = false;
      }
      return;
    }
    if (req.method === "POST" && routePath === "/api/probe") {
      let raw: unknown;
      try {
        raw = await readJsonUnknown(req);
      } catch (err: unknown) {
        const tooLarge = err instanceof PayloadTooLarge;
        res.writeHead(tooLarge ? 413 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: tooLarge ? "Payload too large" : "Invalid JSON body" }));
        return;
      }
      const parsed = ProbeBodySchema.safeParse(raw);
      if (!parsed.success) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Invalid probe payload",
            issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
          })
        );
        return;
      }
      const { legacyCode, modernCode, context, functionName } = parsed.data;
      const pools = probePools();
      // Legacy runs exactly what /api/resurrect ran: the extracted specimen expression.
      const legacyRunnable = scanLegacyAst(legacyCode, functionName === undefined ? {} : { functionName }).primaryExpression;
      const [legacy, modern] = await Promise.all([
        probeSide(pools.legacy, legacyRunnable, context),
        probeSide(pools.modern, modernCode, context),
      ]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(compareProbeSides(legacy, modern)));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.on("close", () => {
    void Promise.all([probeLegacy?.close(), probeModern?.close(), redTeamPool?.close(), auditLegacy?.close(), auditModern?.close(), naiveLegacy?.close(), naiveModern?.close(), closeSharedTsVerifier()]);
  });
  return server;
}

const isMain =
  process.argv[1] !== undefined &&
  nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  const server = createWebServer();
  server.listen(port, () => {
    console.log(`Lazarus Operating Table listening on http://localhost:${port}`);
  });
}


