// POST /api/audit-sarif: the Legacy Risk Audit as SARIF 2.1.0, for the Studio's Risk Explorer.
//
// No rule logic lives here: the audit is `auditSources` and the log is `renderSarif`, both from cli-audit.ts (the same code
// `lazarus audit --sarif` runs). This module only chooses the input, and derives the explorer's views from the SARIF results.
// Legacy code is parsed with acorn and never executed.
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { z } from "zod";
import { SARIF_RULES, auditSources, readAuditSources, renderSarif, type SarifLevel, type SarifLog } from "../cli-audit.js";

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
  })
  .strict()
  .refine((b) => (b.code === undefined) !== (b.example === undefined), "give exactly one of `code` or `example`");
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
  };
}
