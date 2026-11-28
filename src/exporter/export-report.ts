// Builds the input of RESURRECTION_REPORT.html for a single-file or async export: everything the server measured itself
// (compiler result, purity proof, rule blame, signature) plus the optional, validated summaries the Studio session sends
// (mutation autopsy, performance parity, rollback counterexample). Client numbers are clamped and typed by zod; nothing a run
// did not produce is invented.
import { z } from "zod";
import { auditPurity, type PurityProof } from "../crew/purity-audit.js";
import { computeRuleBlame } from "../crew/rule-blame.js";
import type { InputSchema } from "../fuzzer/types.js";
import { PooledProbeRunner } from "../sandbox/pool.js";
import { scanLegacyAst } from "../sandbox/ast-scanner.js";
import type { SignatureBlock } from "./cert-crypto.js";
import { renderResurrectionReport, type ReportCausal, type ReportInput, type ReportMutant, type ReportPerf } from "./html-report.js";
import type { TypecheckReport } from "./verified-bundle.js";

const text = (max: number): z.ZodString => z.string().max(max);
const finite = z.number().finite();

export const PerfSummarySchema = z.union([
  z.object({ ratio: finite, legacyMedianUs: finite.min(0), resurrectedMedianUs: finite.min(0), verdict: z.enum(["faster", "parity", "slower"]) }).strict(),
  z.object({ skipped: text(300) }).strict(),
]);
export const MutantSummarySchema = z
  .object({
    operator: text(80),
    status: z.enum(["killed", "survived"]),
    originalLine: text(200).optional(),
    mutatedLine: text(200).optional(),
    killerInput: text(200).optional(),
    legacyOutput: text(120).optional(),
    mutantOutput: text(120).optional(),
    divergence: text(300).optional(),
  })
  .strict();
export const CausalSummarySchema = z
  .object({
    counterexample: z.object({ input: text(300), legacyOutput: text(120), modernOutput: text(120) }).strict().optional(),
    shrink: z.object({ steps: z.number().int().min(0).max(10_000), from: text(300), to: text(300) }).strict().optional(),
  })
  .strict();

export interface ReportExtras {
  readonly perf?: ReportPerf | { readonly skipped: string };
  readonly mutants?: readonly ReportMutant[];
  readonly causal?: { readonly counterexample?: NonNullable<ReportCausal["counterexample"]> | undefined; readonly shrink?: NonNullable<ReportCausal["shrink"]> | undefined };
}
/** The optional summaries of an export request; anything malformed is ignored, like the mutation score. */
export function parseReportExtras(body: { readonly perfParity?: unknown; readonly mutants?: unknown; readonly causal?: unknown }): ReportExtras {
  const perf = body.perfParity === undefined ? undefined : PerfSummarySchema.safeParse(body.perfParity);
  const mutants = body.mutants === undefined ? undefined : z.array(MutantSummarySchema).max(10).safeParse(body.mutants);
  const causal = body.causal === undefined ? undefined : CausalSummarySchema.safeParse(body.causal);
  return {
    ...(perf?.success === true ? { perf: perf.data } : {}),
    ...(mutants?.success === true ? { mutants: mutants.data } : {}),
    ...(causal?.success === true ? { causal: causal.data } : {}),
  };
}

export interface ExportReportArgs {
  readonly name: string;
  readonly legacyCode: string;
  /** The code exactly as the Studio posted it (an expression for a snippet): what the sandbox ran. */
  readonly postedModernCode: string;
  /** The verified `resurrected.ts` of the bundle. */
  readonly resurrectedTs: string;
  readonly fuzzRuns: number;
  /** The proof seed of the run (V19), when the Studio sent one. */
  readonly seed?: number;
  readonly attempts: number;
  readonly healed: boolean;
  readonly typecheck: TypecheckReport;
  readonly mutation?: { readonly killed: number; readonly total: number };
  readonly signature: SignatureBlock;
  readonly schema?: InputSchema;
  /** `async` for an error-first callback or Promise chain, `module` for several exported functions, else a snippet or one function. */
  readonly shape: "snippet" | "async" | "module";
  readonly extras: ReportExtras;
  readonly files: readonly string[];
}

/** Purity runs on a snippet's oracle expression in a short-lived sandbox pool; it is skipped (not faked) for the other shapes. */
async function purityOf(args: ExportReportArgs, oracle: string): Promise<PurityProof | undefined> {
  if (args.shape !== "snippet" || args.schema === undefined || Object.keys(args.schema).length === 0) return undefined;
  try {
    await using pool = new PooledProbeRunner();
    return await auditPurity({ legacyCode: oracle, modernCode: args.postedModernCode, schema: args.schema, executor: pool });
  } catch {
    return undefined;
  }
}

export async function buildExportReport(args: ExportReportArgs): Promise<string> {
  const oracle = scanLegacyAst(args.legacyCode).primaryExpression;
  const purity = await purityOf(args, oracle);
  const blame = args.shape === "snippet" ? computeRuleBlame(oracle, args.postedModernCode, []) : [];
  const causal: ReportCausal = {
    rules: blame.map((b) => ({ rule: b.rule, status: b.status, reason: b.reason })),
    ...(args.extras.causal?.counterexample !== undefined ? { counterexample: args.extras.causal.counterexample } : {}),
    ...(args.extras.causal?.shrink !== undefined ? { shrink: args.extras.causal.shrink } : {}),
  };
  const perf = args.extras.perf ?? (args.shape === "async" ? { skipped: "Async specimens settle on the sandbox's virtual timers; Performance Parity covers synchronous specimens." } : undefined);
  const input: ReportInput = {
    name: args.name,
    kind: args.shape === "async" ? "async" : "single",
    legacyCode: args.legacyCode,
    modernCode: args.resurrectedTs,
    fuzz: { runs: args.fuzzRuns, attempts: args.attempts, healed: args.healed, exact: true, ...(args.seed !== undefined ? { seed: args.seed } : {}) },
    typecheck: {
      passed: args.typecheck.passed,
      errorCount: args.typecheck.errorCount,
      filesChecked: args.typecheck.filesChecked,
      tsVersion: args.typecheck.tsVersion,
      diagnostics: args.typecheck.diagnostics.map((d) => ({ file: d.file, line: d.line, code: d.code, message: d.message })),
    },
    ...(purity !== undefined ? { purity } : {}),
    ...(args.mutation !== undefined ? { mutation: { killed: args.mutation.killed, total: args.mutation.total, ...(args.extras.mutants !== undefined ? { mutants: args.extras.mutants } : {}) } } : {}),
    signature: {
      keyId: args.signature.keyId,
      legacySha256: args.signature.payload.legacySha256,
      resurrectedSha256: args.signature.payload.resurrectedSha256,
      signatureB64: args.signature.signatureB64,
      issuedAt: args.signature.payload.issuedAt,
    },
    ...(perf !== undefined ? { perf } : {}),
    causal,
    files: args.files,
  };
  return renderResurrectionReport(input);
}
