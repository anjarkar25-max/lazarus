// Single-file PR bundle with real strict TypeScript verification.
//
// The generated `resurrected.ts` (and `types.d.ts`) are type-checked with the installed compiler under --strict:
//   1. as generated (Type Alchemist annotations when a signature is given);
//   2. if strict mode rejects legacy internals it cannot type (TS7006 / TS7034 / class-field TS2339), those members are
//      declared `any` at the migration boundary and the result is checked again;
//   3. if errors remain and the return type came from observation, it is widened to `unknown` and checked once more.
// Whatever the final check says is reported, including errors. Nothing is suppressed.
import { applyBoundaryFixes } from "../crew/ts-emit.js";
import { describeTypecheck, verifyStrictTypeScript, type TypecheckResult } from "../crew/ts-verifier.js";
import { widenReturn } from "../crew/type-alchemist.js";
import { generateResurrectionBundle, type ResurrectionBundle, type ResurrectionBundleInput } from "./bundle.js";

export interface TypecheckReport extends TypecheckResult {
  /** Members declared `any` at the migration boundary (empty when none were needed). */
  readonly adjustments: string[];
  /** The observed return type was widened to `unknown` because tsc rejected it. */
  readonly widenedReturn: boolean;
  /** Number of compiler runs. */
  readonly rounds: number;
}

export interface VerifiedBundle {
  readonly bundle: ResurrectionBundle;
  readonly typecheck: TypecheckReport;
}

const TS_FILE = "resurrected.ts";
const DTS_FILE = "types.d.ts";

const tsFilesOf = (bundle: ResurrectionBundle, ts: string): Record<string, string> => ({
  [TS_FILE]: ts,
  ...(bundle.files[DTS_FILE] !== undefined ? { [DTS_FILE]: bundle.files[DTS_FILE] } : {}),
});

/** SPEC.md status lines for a verification report. */
export function typecheckLines(report: TypecheckReport): string[] {
  const lines = [`- **TypeScript Strict Check:** ${describeTypecheck(report)}${report.passed ? "" : ` (first: ${firstError(report)})`}`];
  if (report.adjustments.length > 0) lines.push(`- **Migration boundary (declared \`any\`):** ${report.adjustments.join("; ")}`);
  if (report.widenedReturn) lines.push("- **Return type:** widened to `unknown` (the observed return type did not type-check)");
  return lines;
}

const firstError = (r: TypecheckResult): string => {
  const d = r.diagnostics[0];
  return d === undefined ? "unknown error" : `${d.file}:${d.line}:${d.column} TS${d.code} ${d.message}`.replace(/`/g, "'").slice(0, 200);
};

async function verifyTs(bundle: ResurrectionBundle): Promise<{ ts: string; result: TypecheckResult; adjustments: string[]; rounds: number }> {
  let ts = bundle.files[TS_FILE];
  let result = await verifyStrictTypeScript(tsFilesOf(bundle, ts));
  let rounds = 1;
  let adjustments: string[] = [];
  if (!result.passed) {
    const fixed = applyBoundaryFixes(ts, result.diagnostics, TS_FILE);
    if (fixed.changed) {
      ts = fixed.code;
      adjustments = fixed.adjustments;
      result = await verifyStrictTypeScript(tsFilesOf(bundle, ts));
      rounds++;
    }
  }
  return { ts, result, adjustments, rounds };
}

/**
 * Builds the bundle, verifies it, and rebuilds it once more so SPEC.md (and the certificate produced by
 * `certificateFor`) carry the final, server-computed result.
 */
export async function generateVerifiedBundle(
  input: ResurrectionBundleInput,
  certificateFor?: (report: TypecheckReport) => string | undefined
): Promise<VerifiedBundle> {
  let effective = input;
  let bundle = generateResurrectionBundle(effective);
  let attempt = await verifyTs(bundle);
  let rounds = attempt.rounds;
  let widenedReturn = false;
  if (!attempt.result.passed && input.typeSignature !== undefined && input.typeSignature.returns.kind !== "unknown") {
    effective = { ...input, typeSignature: widenReturn(input.typeSignature) };
    bundle = generateResurrectionBundle(effective);
    attempt = await verifyTs(bundle);
    rounds += attempt.rounds;
    widenedReturn = true;
  }
  const report: TypecheckReport = { ...attempt.result, adjustments: attempt.adjustments, widenedReturn, rounds };
  const certificateMarkdown = certificateFor?.(report);
  const final = generateResurrectionBundle({
    ...effective,
    typecheckLines: typecheckLines(report),
    ...(certificateMarkdown !== undefined ? { certificateMarkdown } : {}),
  });
  const files = { ...final.files, [TS_FILE]: attempt.ts };
  // Without an ESM file the PR diff targets resurrected.ts, so it must show the final (verified) text.
  const prDiff =
    attempt.ts !== final.files[TS_FILE] && final.prDiff.startsWith("diff --git a/legacy.cjs b/resurrected.ts")
      ? tsDiff((input.legacySource ?? input.legacyCode).trim(), attempt.ts)
      : final.prDiff;
  return { bundle: { ...final, files, prDiff }, typecheck: report };
}

function tsDiff(legacy: string, ts: string): string {
  const legacyLines = legacy.split(/\r?\n/);
  const tsLines = ts.trimEnd().split(/\r?\n/);
  return [
    `diff --git a/legacy.cjs b/resurrected.ts`,
    `--- a/legacy.cjs`,
    `+++ b/resurrected.ts`,
    `@@ -1,${legacyLines.length} +1,${tsLines.length} @@`,
    ...legacyLines.map((line) => `-${line}`),
    ...tsLines.map((line) => `+${line}`),
  ].join("\n");
}
