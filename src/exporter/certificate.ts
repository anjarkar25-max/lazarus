// Resurrection Certificate: a compact, deterministic proof summary for a verified resurrection.
// Pure function of its input (no clock, no randomness), so the same specimen always yields the same Markdown.
import { createHash } from "node:crypto";
import { RULE_ORDER, modernize, readHeaderLevels, type RuleId } from "../crew/ast-modernizer.js";
import { scanLegacyAst } from "../sandbox/ast-scanner.js";

export type ProvenanceKind = "preset" | "github" | "npm" | "paste" | "file";

export interface Provenance {
  readonly kind: ProvenanceKind;
  /** Preset name, GitHub URL, npm package name, file name. */
  readonly label: string;
  readonly version?: string;
  readonly cdnHost?: string;
  readonly url?: string;
  readonly byteLength?: number;
}

export interface CertificateInput {
  readonly provenance: Provenance;
  /** The specimen exactly as the developer wrote it. */
  readonly legacySource: string;
  /** The candidate that passed (its `// ast-rules:` header says which rules were active). */
  readonly modernCode: string;
  readonly fuzz: { readonly totalRuns: number; readonly exact: boolean; readonly boundaryRuns?: number; readonly seed?: number };
  readonly attempts: number;
  /** The legacy module converts to a complete ES module. */
  readonly esmComplete?: boolean;
}

export type DebtGrade = "clean" | "low" | "moderate" | "severe";

export interface Certificate {
  readonly id: string;
  readonly provenance: Provenance;
  readonly provenanceLine: string;
  readonly sha256: string;
  readonly shortDigest: string;
  readonly debtScore: number;
  readonly debtGrade: DebtGrade;
  /** Legacy idioms found in the source. */
  readonly idioms: string[];
  /** Human-readable rewrites that are present in the resurrected code. */
  readonly modernized: string[];
  /** Rewrites the Exorcist rolled back to keep exact parity. */
  readonly rolledBack: string[];
  readonly parity: {
    readonly mode: "exact Object.is (tagged)" | "JSON-level";
    readonly runs: number;
    readonly boundaryRuns: number;
    readonly attempts: number;
    readonly selfHealed: boolean;
  };
  readonly markdown: string;
}

const RULE_LABEL: Record<RuleId, string> = {
  "var-scoping": "var → const/let",
  "prototype-class": "prototype → class",
  "arguments-rest": "arguments → rest parameters",
  "apply-spread": ".apply() → spread",
  "function-arrow": "function → arrow",
  "bitor0-trunc": "| 0 → Math.trunc(x) || 0",
  "loose-equality": "== → === (proven types)",
};

/** Debt points per rewrite site and the cap per rule. */
const WEIGHTS: Record<RuleId, { per: number; cap: number }> = {
  "var-scoping": { per: 1, cap: 10 },
  "prototype-class": { per: 8, cap: 24 },
  "arguments-rest": { per: 4, cap: 12 },
  "apply-spread": { per: 3, cap: 9 },
  "function-arrow": { per: 1, cap: 5 },
  "bitor0-trunc": { per: 3, cap: 15 },
  "loose-equality": { per: 2, cap: 10 },
};
const COMMONJS_POINTS = 5;
const FLAGGED_POINTS = 2;
const FLAGGED_CAP = 10;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

export function gradeFor(score: number): DebtGrade {
  if (score === 0) return "clean";
  if (score < 20) return "low";
  if (score < 50) return "moderate";
  return "severe";
}

export function describeProvenance(p: Provenance): string {
  switch (p.kind) {
    case "npm":
      return `npm \`${p.label}${p.version !== undefined ? `@${p.version}` : ""}\`${p.cdnHost !== undefined ? ` via ${p.cdnHost}` : ""}${p.byteLength !== undefined ? ` (${p.byteLength} bytes)` : ""}`;
    case "github":
      return `GitHub ${p.url ?? p.label}`;
    case "preset":
      return `Operating Table preset \`${p.label}\``;
    case "file":
      return `file \`${p.label}\``;
    case "paste":
      return "pasted specimen";
  }
}

export function generateCertificate(input: CertificateInput): Certificate {
  const sha256 = sha256Hex(input.legacySource);
  const shortDigest = sha256.slice(0, 12);
  const scan = scanLegacyAst(input.legacySource);
  const base = modernize(input.legacySource);
  const header = readHeaderLevels(input.modernCode);

  const counts = new Map<RuleId, number>();
  for (const item of base.applied) counts.set(item.rule, (counts.get(item.rule) ?? 0) + 1);

  let score = 0;
  for (const rule of RULE_ORDER) {
    const w = WEIGHTS[rule];
    score += Math.min(w.cap, (counts.get(rule) ?? 0) * w.per);
  }
  score += Math.min(FLAGGED_CAP, base.flagged.length * FLAGGED_POINTS);
  const hasCommonJs = scan.detectedIdioms.includes("CommonJS export");
  if (hasCommonJs) score += COMMONJS_POINTS;
  const debtScore = Math.min(100, score);

  const modernized: string[] = [];
  const rolledBack: string[] = [];
  for (const rule of RULE_ORDER) {
    if ((counts.get(rule) ?? 0) === 0) continue;
    const off = header !== undefined && header[rule] >= 1;
    (off ? rolledBack : modernized).push(RULE_LABEL[rule]);
  }
  if (hasCommonJs && input.esmComplete === true) modernized.push("CommonJS → ESM named exports");

  const selfHealed = input.attempts > 1;
  const parity = {
    mode: input.fuzz.exact ? ("exact Object.is (tagged)" as const) : ("JSON-level" as const),
    runs: input.fuzz.totalRuns,
    boundaryRuns: input.fuzz.boundaryRuns ?? 0,
    attempts: input.attempts,
    selfHealed,
  };
  const provenanceLine = describeProvenance(input.provenance);
  const id = `LZ-${shortDigest.toUpperCase()}`;
  const debtGrade = gradeFor(debtScore);

  const markdown = [
    `## Resurrection Certificate ${id}`,
    ``,
    `| Field | Value |`,
    `| --- | --- |`,
    `| Provenance | ${provenanceLine} |`,
    `| Legacy SHA-256 | \`${sha256}\` (short \`${shortDigest}\`) |`,
    `| Legacy Debt Score | **${debtScore}/100** (${debtGrade}) |`,
    `| Idioms found | ${scan.detectedIdioms.length > 0 ? scan.detectedIdioms.join("; ") : "none"} |`,
    `| Modernized | ${modernized.length > 0 ? modernized.join("; ") : "nothing needed rewriting"} |`,
    `| Rolled back by Exorcist | ${rolledBack.length > 0 ? rolledBack.join("; ") : "none"} |`,
    `| Parity proof | ${parity.mode}, ${parity.runs} fuzz runs${parity.boundaryRuns > 0 ? ` (${parity.boundaryRuns} boundary)` : ""} |`,
    `| Attempts | ${parity.attempts}${selfHealed ? " (self-healed)" : " (first draft held)"} |`,
    ``,
    `_Verified by differential fuzzing in an isolated sandbox. Parity is proven over the fuzzed input domain, not for all inputs._`,
    ``,
  ].join("\n");

  return {
    id,
    provenance: input.provenance,
    provenanceLine,
    sha256,
    shortDigest,
    debtScore,
    debtGrade,
    idioms: scan.detectedIdioms,
    modernized,
    rolledBack,
    parity,
    markdown,
  };
}

/** Provenance from untrusted JSON (request bodies). Unknown or malformed values fall back to `paste`. */
export function sanitizeProvenance(value: unknown): Provenance {
  if (typeof value !== "object" || value === null) return { kind: "paste", label: "pasted specimen" };
  const v = value as Record<string, unknown>;
  const kinds: readonly ProvenanceKind[] = ["preset", "github", "npm", "paste", "file"];
  const kind = kinds.find((k) => k === v.kind) ?? "paste";
  const text = (x: unknown, max: number): string | undefined => (typeof x === "string" && x.length > 0 ? x.slice(0, max).replace(/[\r\n`|]/g, " ") : undefined);
  const label = text(v.label, 200) ?? "pasted specimen";
  const version = text(v.version, 64);
  const cdnHost = text(v.cdnHost, 100);
  const url = text(v.url, 300);
  const byteLength = typeof v.byteLength === "number" && Number.isFinite(v.byteLength) && v.byteLength >= 0 ? Math.floor(v.byteLength) : undefined;
  return {
    kind,
    label,
    ...(version !== undefined ? { version } : {}),
    ...(cdnHost !== undefined ? { cdnHost } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(byteLength !== undefined ? { byteLength } : {}),
  };
}
