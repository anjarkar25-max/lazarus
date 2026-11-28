// POST /api/audit-sarif: the Legacy Risk Audit as SARIF 2.1.0, for the Studio's Risk Explorer.
//
// No rule logic lives here: the audit is `auditSources` and the log is `renderSarif`, both from cli-audit.ts (the same code
// `lazarus audit --sarif` runs). This module only chooses the input, and derives the explorer's views from the SARIF results.
// Legacy code is parsed with acorn and never executed.
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { z } from "zod";
import { SARIF_RULES, auditSources, readAuditSources, renderSarif, type SarifLevel, type SarifLog } from "../cli-audit.js";
import { computeDebtScore, simulateCiGate, type AfterVerified, type CiGate, type DebtFinding, type DebtScore } from "../crew/debt-score.js";
import { verifyCertificate } from "../exporter/cert-crypto.js";
import { sha256Hex } from "../exporter/certificate.js";

export const AUDIT_SARIF_MAX_CODE_CHARS = 64_000;
/** The file name pasted code is audited under (it appears in SARIF `uri`s). */
export const PASTED_FILE = "specimen.js";

export const AuditSarifBodySchema = z
  .object({
    /** Pasted legacy JavaScript. */
    code: z.string().min(1, "code must not be empty").max(AUDIT_SARIF_MAX_CODE_CHARS).optional(),
    /** A directory name under examples/ (checked against the real listing). */
    example: z.string().min(1).max(100).optional(),
    /** Also report loose-equality comparisons (LAZ010). Off by default so every existing report stays identical. */
    security: z.boolean().optional(),
    /**
     * The Ed25519 certificate of a resurrection of `code` and the code it signs. The server verifies the signature and ties it to `code`; the
     * post-resurrection CI gate is built from what it proves, never from a client claim.
     */
    verification: z
      .object({
        payload: z.record(z.string(), z.unknown()),
        signatureB64: z.string().min(1).max(200),
        publicKeyPem: z.string().min(1).max(2000),
        resurrectedCode: z.string().max(AUDIT_SARIF_MAX_CODE_CHARS),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((b) => (b.code === undefined) !== (b.example === undefined), "give exactly one of `code` or `example`")
  .refine((b) => b.verification === undefined || b.code !== undefined, "`verification` goes with `code`");
export type AuditSarifBody = z.infer<typeof AuditSarifBodySchema>;

export class AuditSarifError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404
  ) {
    super(message);
    this.name = "AuditSarifError";
  }
}

export type FindingSeverity = "high" | "medium" | "info";
const SEVERITY_OF: Record<SarifLevel, FindingSeverity> = { error: "high", warning: "medium", note: "info" };

export interface SarifFindingView {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly level: SarifLevel;
  readonly severity: FindingSeverity;
  /** The SARIF `uri` (repository-relative). */
  readonly uri: string;
  readonly line: number;
  readonly message: string;
  /** Fix guidance: the rule's help text. */
  readonly fix: string;
  /** Up to three source lines around the finding; `startLine` is the line of `lines[0]`. */
  readonly snippet: { readonly startLine: number; readonly lines: string[] };
}

export interface RuleCount {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly level: SarifLevel;
  readonly count: number;
}

export interface AuditSarifResult {
  readonly source: { readonly kind: "code" | "example"; readonly name: string };
  readonly sarif: SarifLog;
  readonly summary: {
    readonly directory: string;
    readonly files: number;
    readonly readiness: number;
    readonly grade: string;
    readonly totals: { readonly high: number; readonly medium: number; readonly info: number };
    readonly total: number;
    /** Every rule, zero counts included, in rule-id order. */
    readonly byRule: RuleCount[];
    readonly entry: string | null;
    readonly cycles: string[][];
  };
  readonly findings: SarifFindingView[];
  /** Legacy Migration Debt Score (0 to 100, higher is healthier) with its 4-category breakdown (additive). */
  readonly debtScore: DebtScore;
  /** The GitHub Actions gate before and after the resurrection (additive). The after side is PENDING without a verified certificate. */
  readonly ciGate: CiGate;
}

/** The debt score and the CI gate of a set of files (the Tab 2 graph): the same audit, rules and weights as the Risk Explorer. */
export function debtOfSources(files: Readonly<Record<string, string>>, directory: string, after: AfterVerified | undefined): { readonly debtScore: DebtScore; readonly ciGate: CiGate } {
  const log = renderSarif(auditSources(new Map(Object.entries(files)), [], directory));
  const run = log.runs[0];
  const findings: DebtFinding[] = (run?.results ?? []).map((r) => {
    const rule = run?.tool.driver.rules[r.ruleIndex];
    const location = r.locations[0]?.physicalLocation;
    return { ruleId: r.ruleId, level: r.level, file: location?.artifactLocation.uri ?? "", line: location?.region.startLine ?? 1, message: r.message.text.split(". Fix: ")[0] ?? r.message.text, ruleName: rule?.name ?? r.ruleId };
  });
  return { debtScore: computeDebtScore(findings), ciGate: simulateCiGate(findings, after) };
}

/** SARIF findings as the debt score reads them. */
export function toDebtFindings(findings: readonly SarifFindingView[]): DebtFinding[] {
  return findings.map((f) => ({ ruleId: f.ruleId, level: f.level, file: f.uri, line: f.line, message: f.message, ruleName: f.ruleName }));
}

/** What a certificate proves about `code`: its Ed25519 signature verifies, it names this exact code, and it records parity and a strict compile. */
export function afterVerifiedFrom(code: string, v: NonNullable<AuditSarifBody["verification"]>): AfterVerified {
  const verdict = verifyCertificate({ payload: v.payload, signatureB64: v.signatureB64, publicKeyPem: v.publicKeyPem, resurrectedCode: v.resurrectedCode });
  const payload = v.payload;
  const summary = typeof payload["paritySummary"] === "string" ? payload["paritySummary"] : "";
  const tsc = typeof payload["tscStrictErrors"] === "number" ? payload["tscStrictErrors"] : null;
  const names = payload["legacySha256"] === sha256Hex(code);
  const parity = /^exact Object\.is parity/.test(summary);
  const runs = /(\d+) fuzz runs/.exec(summary)?.[1];
  const seed = typeof payload["proofSeed"] === "number" ? payload["proofSeed"] : undefined;
  const reason = !verdict.valid ? "signature does not verify" : !names ? "the certificate is for different code" : !parity ? "no exact parity recorded" : tsc !== 0 ? "tsc --strict is not clean" : undefined;
  return {
    verified: reason === undefined,
    parity: verdict.valid && names && parity,
    tscErrors: verdict.valid ? tsc : null,
    signed: verdict.valid,
    keyId: verdict.keyId,
    ...(runs !== undefined ? { runs: Number(runs) } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

const clip = (text: string, max = 200): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/** Directory names under `examples/`, from the real listing. */
export function listExamples(examplesDir: string): string[] {
  try {
    return fs
      .readdirSync(examplesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export function runAuditSarif(body: AuditSarifBody, examplesDir: string): AuditSarifResult {
  let sources: ReadonlyMap<string, string>;
  let skipped: Array<{ file: string; reason: string }> = [];
  let directory: string;
  let source: AuditSarifResult["source"];
  if (body.code !== undefined) {
    sources = new Map([[PASTED_FILE, body.code]]);
    directory = ".";
    source = { kind: "code", name: PASTED_FILE };
  } else {
    const name = body.example ?? "";
    const known = listExamples(examplesDir);
    if (!known.includes(name)) throw new AuditSarifError(`unknown example "${name.slice(0, 60)}"; choose one of: ${known.join(", ") || "none"}`, 404);
    const read = readAuditSources(nodePath.join(examplesDir, name));
    sources = read.sources;
    skipped = read.skipped;
    directory = `examples/${name}`;
    source = { kind: "example", name };
  }
  const report = auditSources(sources, skipped, directory, body.security === true ? { security: true } : {});
  const sarif = renderSarif(report);
  const run = sarif.runs[0];
  const rules = run?.tool.driver.rules ?? SARIF_RULES;
  const prefix = directory === "." ? "" : `${directory}/`;

  const findings: SarifFindingView[] = (run?.results ?? []).map((result) => {
    const rule = rules[result.ruleIndex] ?? rules.find((r) => r.id === result.ruleId);
    const location = result.locations[0]?.physicalLocation;
    const uri = location?.artifactLocation.uri ?? "";
    const line = location?.region.startLine ?? 1;
    const fix = rule?.help.text ?? "";
    const message = result.message.text.endsWith(`. Fix: ${fix}`) ? result.message.text.slice(0, -`. Fix: ${fix}`.length) : result.message.text;
    const text = sources.get(prefix !== "" && uri.startsWith(prefix) ? uri.slice(prefix.length) : uri) ?? "";
    const all = text.split(/\r?\n/);
    const start = Math.max(1, line - 1);
    const end = Math.min(all.length, line + 1);
    return {
      ruleId: result.ruleId,
      ruleName: rule?.name ?? result.ruleId,
      level: result.level,
      severity: SEVERITY_OF[result.level],
      uri,
      line,
      message,
      fix,
      snippet: { startLine: start, lines: all.slice(start - 1, end).map((l) => clip(l)) },
    };
  });

  const byRule: RuleCount[] = rules.map((rule) => ({ id: rule.id, name: rule.name, title: rule.shortDescription.text, level: rule.defaultConfiguration.level, count: findings.filter((f) => f.ruleId === rule.id).length }));
  const debtFindings = toDebtFindings(findings);
  const after = body.verification !== undefined && body.code !== undefined ? afterVerifiedFrom(body.code, body.verification) : undefined;
  return {
    source,
    sarif,
    summary: {
      directory: report.directory,
      files: report.totals.files,
      readiness: report.readiness,
      grade: report.grade,
      totals: { high: report.totals.high, medium: report.totals.medium, info: report.totals.info },
      total: findings.length,
      byRule,
      entry: report.graph.entry,
      cycles: report.graph.cycles,
    },
    findings,
    debtScore: computeDebtScore(debtFindings),
    ciGate: simulateCiGate(debtFindings, after),
  };
}
