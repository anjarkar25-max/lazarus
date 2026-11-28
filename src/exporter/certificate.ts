// Resurrection Certificate: a compact, deterministic proof summary for a verified resurrection.
// Pure function of its input (no clock, no randomness), so the same specimen always yields the same Markdown.
import { createHash } from "node:crypto";
import { RULE_ORDER, modernize, readHeaderLevels, type RuleId } from "../crew/ast-modernizer.js";
import { scanLegacyAst } from "../sandbox/ast-scanner.js";
import { describeTypecheck } from "../crew/ts-verifier.js";

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
  /** Result of a "Prove the Proof" mutation audit, when one was run. */
  readonly mutation?: MutationScore;
  /** Server-computed strict TypeScript check of the exported code (never a client claim). */
  readonly typecheck?: TypecheckClaim;
}

export interface TypecheckClaim {
  readonly errorCount: number;
  readonly filesChecked: number;
  readonly tsVersion: string;
}

export interface MutationScore {
  readonly killed: number;
  readonly total: number;
}

/** "5/5 mutants killed (100% proof strength)". */
export function describeMutation(score: MutationScore): string {
  const percent = score.total === 0 ? 0 : Math.round((score.killed / score.total) * 100);
  return `${score.killed}/${score.total} mutants killed (${percent}% proof strength)`;
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
  readonly mutation?: MutationScore;
  readonly typecheck?: TypecheckClaim;
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
  "global-leak-fix": "undeclared global -> let (no global leak)",
  "proto-pollution-guard": "key-copy loop guarded against __proto__ pollution",
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
  "global-leak-fix": { per: 3, cap: 9 },
  "proto-pollution-guard": { per: 4, cap: 8 },
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
  const tc = input.typecheck;
  const typecheck =
    tc !== undefined && Number.isInteger(tc.errorCount) && tc.errorCount >= 0 && Number.isInteger(tc.filesChecked) && tc.filesChecked >= 0 && /^[\w.+-]{1,40}$/.test(tc.tsVersion)
      ? { errorCount: tc.errorCount, filesChecked: tc.filesChecked, tsVersion: tc.tsVersion }
      : undefined;
  const mutation =
    input.mutation !== undefined && Number.isInteger(input.mutation.killed) && Number.isInteger(input.mutation.total) && input.mutation.total > 0 && input.mutation.killed >= 0 && input.mutation.killed <= input.mutation.total
      ? { killed: input.mutation.killed, total: input.mutation.total }
      : undefined;

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
    ...(mutation !== undefined ? [`| Proof strength (mutation audit) | ${describeMutation(mutation)} |`] : []),
    ...(typecheck !== undefined ? [`| TypeScript strict check | ${describeTypecheck(typecheck)} |`] : []),
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
    ...(mutation !== undefined ? { mutation } : {}),
    ...(typecheck !== undefined ? { typecheck } : {}),
    markdown,
  };
}

/** XML-escapes text and drops characters XML 1.0 forbids. */
export function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}\u2026` : text);

/**
 * Self-contained SVG badge of a certificate: no scripts, no external references, deterministic. It shows only what
 * the certificate contains ("not audited" / "not checked" otherwise).
 */
export function renderCertificateSvg(cert: Certificate, options: { readonly name: string }): string {
  const tc = cert.typecheck;
  const tsc = tc === undefined ? "not checked" : describeTypecheck(tc).replace(/ \(.*\)$/, "");
  const tscOk = tc !== undefined && tc.errorCount === 0;
  const mutation = cert.mutation === undefined ? "not audited" : describeMutation(cert.mutation);
  const mutationOk = cert.mutation !== undefined && cert.mutation.killed === cert.mutation.total;
  const debtColor = cert.debtScore >= 50 ? "#ef4444" : cert.debtScore >= 20 ? "#f59e0b" : "#10b981";
  const debtWidth = Math.round((Math.max(0, Math.min(100, cert.debtScore)) / 100) * 300);
  const rows: Array<[string, string, string]> = [
    ["SPECIMEN", clip(options.name, 48), "#e2e8f0"],
    ["SHA-256", `${cert.shortDigest} \u00b7 ${cert.id}`, "#c4b5fd"],
    ["PARITY PROOF", `exact Object.is \u00b7 ${cert.parity.runs} fuzz run${cert.parity.runs === 1 ? "" : "s"}${cert.parity.mode === "JSON-level" ? " (JSON-level)" : ""}`, "#10b981"],
    ["SELF-HEALING", cert.parity.selfHealed ? `healed in ${cert.parity.attempts} attempts` : "first draft held", "#e2e8f0"],
    ["MUTATION AUDIT", mutation, mutationOk ? "#10b981" : cert.mutation === undefined ? "#94a3b8" : "#f59e0b"],
    ["TYPESCRIPT", tsc, tscOk ? "#10b981" : tc === undefined ? "#94a3b8" : "#ef4444"],
  ];
  const rowSvg = rows
    .map(([label, value, color], i) => {
      const y = 150 + i * 34;
      return [
        `  <text x="48" y="${y}" class="k">${escapeXml(label)}</text>`,
        `  <text x="220" y="${y}" class="v" fill="${color}">${escapeXml(value)}</text>`,
        `  <line x1="48" y1="${y + 12}" x2="712" y2="${y + 12}" stroke="#1e293b" stroke-width="1"/>`,
      ].join("\n");
    })
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="420" viewBox="0 0 760 420" role="img" aria-labelledby="t d">`,
    `  <title id="t">Lazarus Resurrection Certificate ${escapeXml(cert.id)}</title>`,
    `  <desc id="d">${escapeXml(`${options.name}: ${cert.parity.runs} exact Object.is fuzz runs; ${tsc}; ${mutation}; legacy debt ${cert.debtScore}/100.`)}</desc>`,
    `  <defs>`,
    `    <linearGradient id="frame" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#10b981"/></linearGradient>`,
    `    <radialGradient id="glow" cx="0.5" cy="0" r="0.9"><stop offset="0" stop-color="#111b33"/><stop offset="1" stop-color="#090d16"/></radialGradient>`,
    `    <style>.h{font:700 13px ui-monospace,Menlo,Consolas,monospace;letter-spacing:4px}.k{font:700 11px ui-monospace,Menlo,Consolas,monospace;letter-spacing:2px;fill:#64748b}.v{font:600 15px ui-monospace,Menlo,Consolas,monospace}.s{font:11px ui-monospace,Menlo,Consolas,monospace;fill:#64748b}</style>`,
    `  </defs>`,
    `  <rect x="0" y="0" width="760" height="420" rx="18" fill="url(#glow)"/>`,
    `  <rect x="8" y="8" width="744" height="404" rx="14" fill="none" stroke="url(#frame)" stroke-width="2"/>`,
    `  <rect x="18" y="18" width="724" height="384" rx="10" fill="none" stroke="#1e293b" stroke-width="1" stroke-dasharray="4 6"/>`,
    `  <text x="48" y="62" class="h" fill="#10b981">\u271D LAZARUS \u00b7 RESURRECTION CERTIFICATE</text>`,
    `  <text x="48" y="88" class="s">${escapeXml(clip(cert.provenanceLine.replace(/\`/g, ""), 80))}</text>`,
    `  <g transform="translate(640 78)">`,
    `    <circle r="40" fill="none" stroke="#10b981" stroke-width="2"/>`,
    `    <circle r="33" fill="none" stroke="#10b981" stroke-width="1" stroke-dasharray="2 4"/>`,
    `    <text y="-4" text-anchor="middle" class="k" fill="#10b981" style="fill:#10b981">PARITY</text>`,
    `    <text y="14" text-anchor="middle" class="k" style="fill:#10b981">PROVEN</text>`,
    `  </g>`,
    `  <text x="48" y="118" class="k">LEGACY DEBT</text>`,
    `  <rect x="220" y="108" width="300" height="10" rx="5" fill="#1e293b"/>`,
    `  <rect x="220" y="108" width="${debtWidth}" height="10" rx="5" fill="${debtColor}"/>`,
    `  <text x="532" y="118" class="v" fill="${debtColor}">${cert.debtScore}/100 ${escapeXml(cert.debtGrade)}</text>`,
    rowSvg,
    `  <text x="48" y="392" class="s">Verified by differential fuzzing in an isolated sandbox \u00b7 parity over the fuzzed input domain</text>`,
    `</svg>`,
    ``,
  ].join("\n");
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
