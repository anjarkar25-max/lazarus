// Legacy Migration Debt Score, the GitHub CI gate simulator and the Lazarus Verified shield.
//
// Everything here is pure and deterministic: the same findings always give the same score, the same log and the same SVG bytes.
// The inputs are SARIF results of the Legacy Risk Audit (rules LAZ001 to LAZ010): a rule id and a level. Nothing is executed.

export type DebtLevel = "error" | "warning" | "note";

/** The part of a SARIF result the score needs; the location and message make the CI log readable. */
export interface DebtFinding {
  readonly ruleId: string;
  readonly level: DebtLevel;
  readonly file?: string;
  readonly line?: number;
  readonly message?: string;
  readonly ruleName?: string;
}

export type DebtCategoryId = "bitwise-numeric" | "async-callbacks" | "security-scope" | "module-cycles";
export type DebtGrade = "A" | "B" | "C" | "D" | "F";

export interface DebtCategoryDef {
  readonly id: DebtCategoryId;
  readonly label: string;
  /** SARIF rules that belong to the category. A rule id that no category lists does not change the score. */
  readonly rules: readonly string[];
}

/**
 * Bitwise/Numeric: int32 truncation and loose-equality coercion. Async/Callbacks: error-first callbacks and Promise chains.
 * Security/Scope: var and arguments scoping, undeclared globals, prototype pollution. Module Cycles: the require graph, the prototype
 * chains of the module's classes, and files that do not parse (the structure of the project).
 */
export const DEBT_CATEGORIES: readonly DebtCategoryDef[] = [
  { id: "bitwise-numeric", label: "Bitwise/Numeric", rules: ["LAZ001", "LAZ010"] },
  { id: "async-callbacks", label: "Async/Callbacks", rules: ["LAZ002", "LAZ007"] },
  { id: "security-scope", label: "Security/Scope", rules: ["LAZ004", "LAZ008", "LAZ009"] },
  { id: "module-cycles", label: "Module Cycles", rules: ["LAZ003", "LAZ005", "LAZ006"] },
];

/** The names of LAZ001 to LAZ010 (kept in sync with the SARIF rule table of cli-audit.ts by a test). */
export const DEBT_RULE_NAMES: Readonly<Record<string, string>> = {
  LAZ001: "BitwiseTruncation",
  LAZ002: "ErrorFirstCallback",
  LAZ003: "PrototypeChain",
  LAZ004: "VarOrArgumentsHoisting",
  LAZ005: "CircularOrUnresolvableRequire",
  LAZ006: "UnparseableFile",
  LAZ007: "PromiseChain",
  LAZ008: "UndeclaredGlobalLeak",
  LAZ009: "PrototypePollutionRisk",
  LAZ010: "LooseEqualityCoercion",
};

/** Findings of these rules block a CI gate whatever their level: they are security or scope hazards. */
export const SECURITY_RULES: readonly string[] = ["LAZ008", "LAZ009"];

/** Points a finding costs by level (the weights of the audit's readiness score). */
export const LEVEL_PENALTY: Readonly<Record<DebtLevel, number>> = { error: 12, warning: 5, note: 1 };
/** The most one category can cost, so one noisy category cannot hide the others. */
export const CATEGORY_CAP = 40;

export interface DebtCategory {
  readonly id: DebtCategoryId;
  readonly label: string;
  readonly rules: readonly string[];
  readonly findings: number;
  readonly high: number;
  readonly medium: number;
  readonly info: number;
  /** Points lost, at most CATEGORY_CAP. */
  readonly penalty: number;
  /** 0 to 100, higher is healthier. */
  readonly score: number;
}

export interface DebtScore {
  /** 0 to 100. Higher means healthier: less migration debt. */
  readonly score: number;
  /** 100 - score: the debt itself. */
  readonly debtScore: number;
  readonly grade: DebtGrade;
  readonly breakdown: DebtCategory[];
  /** Findings that a category counted. */
  readonly total: number;
  readonly high: number;
  /** One line for the Scorecard. */
  readonly summary: string;
}

export function gradeFor(score: number): DebtGrade {
  return score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";
}

const clampScore = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

export function computeDebtScore(findings: readonly DebtFinding[]): DebtScore {
  const breakdown: DebtCategory[] = DEBT_CATEGORIES.map((def) => {
    const mine = findings.filter((f) => def.rules.includes(f.ruleId));
    const high = mine.filter((f) => f.level === "error").length;
    const medium = mine.filter((f) => f.level === "warning").length;
    const info = mine.filter((f) => f.level === "note").length;
    const penalty = Math.min(CATEGORY_CAP, high * LEVEL_PENALTY.error + medium * LEVEL_PENALTY.warning + info * LEVEL_PENALTY.note);
    return { id: def.id, label: def.label, rules: def.rules, findings: mine.length, high, medium, info, penalty, score: clampScore(100 - (penalty * 100) / CATEGORY_CAP) };
  });
  const score = clampScore(100 - breakdown.reduce((n, c) => n + c.penalty, 0));
  const total = breakdown.reduce((n, c) => n + c.findings, 0);
  const high = breakdown.reduce((n, c) => n + c.high, 0);
  const worst = [...breakdown].sort((a, b) => b.penalty - a.penalty || a.label.localeCompare(b.label))[0];
  return {
    score,
    debtScore: 100 - score,
    grade: gradeFor(score),
    breakdown,
    total,
    high,
    summary: total === 0 ? "No migration debt found: 100/100, grade A." : `${score}/100, grade ${gradeFor(score)}: ${total} finding${total === 1 ? "" : "s"} (${high} high); the most debt is in ${worst?.label ?? "none"}.`,
  };
}

// ---------------------------------------------------------------------------
// CI gate simulator
// ---------------------------------------------------------------------------
export type CiLineLevel = "command" | "group" | "endgroup" | "info" | "notice" | "warning" | "error" | "result";

export interface CiLine {
  readonly level: CiLineLevel;
  readonly text: string;
}

export interface CiRun {
  readonly phase: "pre-resurrection" | "post-resurrection";
  readonly status: "PASS" | "FAIL" | "PENDING";
  /** null while the post-resurrection gate has not been produced yet. */
  readonly exitCode: 0 | 1 | null;
  /** `FAIL · exit 1 · 2 High Findings` / `PASS · exit 0 · 0 High Findings · Ed25519 Verified`. */
  readonly headline: string;
  /** Findings that block the gate: High (error) ones and the security rules LAZ008 and LAZ009. */
  readonly highFindings: number;
  readonly lines: CiLine[];
  /** The log as the GitHub Actions UI prints it. */
  readonly text: string;
}

/** What the resurrection proved, as established by a verified Ed25519 certificate (never taken on trust). */
export interface AfterVerified {
  /** Parity, the strict compile and the signature all hold. */
  readonly verified: boolean;
  readonly parity: boolean;
  readonly tscErrors: number | null;
  /** true: an Ed25519 signature verified; false: there is none or it failed; null: this artifact carries no signature (a graph). */
  readonly signed: boolean | null;
  readonly keyId?: string;
  readonly runs?: number;
  readonly seed?: number;
  /** Why verification failed, when it did. */
  readonly reason?: string;
}

export interface CiGate {
  readonly workflow: string;
  readonly before: CiRun;
  readonly after: CiRun;
  /** `FAIL → PASS`, `PASS → PASS`, `FAIL → FAIL` or `FAIL → PENDING`. */
  readonly transition: string;
}

export const CI_WORKFLOW = ".github/workflows/lazarus-parity.yml";

const isBlocking = (f: DebtFinding): boolean => f.level === "error" || SECURITY_RULES.includes(f.ruleId);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** GitHub workflow-command escaping: a message or a property value must not break the command line. */
export function escapeCommand(text: string, property = false): string {
  const base = text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return property ? base.replace(/:/g, "%3A").replace(/,/g, "%2C") : base;
}

const MAX_ANNOTATIONS = 8;

function render(lines: readonly CiLine[]): string {
  return lines
    .map((l) => {
      switch (l.level) {
        case "group":
          return `##[group]${l.text}`;
        case "endgroup":
          return "##[endgroup]";
        case "error":
          return l.text.startsWith("::") ? l.text : `##[error]${l.text}`;
        case "warning":
          return l.text.startsWith("::") ? l.text : `##[warning]${l.text}`;
        case "notice":
          return l.text.startsWith("::") ? l.text : `##[notice]${l.text}`;
        default:
          return l.text;
      }
    })
    .join("\n");
}

function annotation(f: DebtFinding): string {
  const name = f.ruleName ?? DEBT_RULE_NAMES[f.ruleId] ?? f.ruleId;
  const props = [f.file !== undefined ? `file=${escapeCommand(f.file, true)}` : "", f.line !== undefined && f.line > 0 ? `line=${f.line}` : "", `title=${escapeCommand(`${f.ruleId} ${name}`, true)}`].filter((p) => p !== "").join(",");
  const message = (f.message ?? name).replace(/\s+/g, " ").slice(0, 200);
  return `::${f.level === "error" ? "error" : f.level === "warning" ? "warning" : "notice"} ${props}::${escapeCommand(message)}`;
}

function preRun(findings: readonly DebtFinding[]): CiRun {
  const counted = [...findings].sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0) || a.ruleId.localeCompare(b.ruleId));
  const blocking = counted.filter(isBlocking);
  const ids = [...new Set(blocking.map((f) => f.ruleId))].sort();
  const lines: CiLine[] = [
    { level: "group", text: "Run actions/checkout@v4" },
    { level: "info", text: "Syncing repository: legacy specimen at HEAD" },
    { level: "endgroup", text: "" },
    { level: "group", text: "Run npm run audit -- . --sarif --out lazarus.sarif" },
    { level: "command", text: "> lazarus audit . --sarif --out lazarus.sarif" },
    { level: "info", text: `Legacy Risk Audit (SARIF 2.1.0): ${plural(counted.length, "finding")}, ${plural(blocking.length, "blocking finding")}` },
    { level: "endgroup", text: "" },
  ];
  for (const f of blocking.slice(0, MAX_ANNOTATIONS)) lines.push({ level: f.level === "error" ? "error" : "warning", text: annotation(f) });
  if (blocking.length > MAX_ANNOTATIONS) lines.push({ level: "warning", text: `... and ${blocking.length - MAX_ANNOTATIONS} more blocking finding${blocking.length - MAX_ANNOTATIONS === 1 ? "" : "s"}` });
  if (blocking.length > 0) {
    lines.push({ level: "error", text: `Lazarus gate: ${plural(blocking.length, "High finding")} (${ids.join(", ")}). Resurrect the code to clear them.` });
    lines.push({ level: "error", text: "Process completed with exit code 1." });
    return { phase: "pre-resurrection", status: "FAIL", exitCode: 1, headline: `FAIL \u00b7 exit 1 \u00b7 ${plural(blocking.length, "High Finding")}`, highFindings: blocking.length, lines, text: render(lines) };
  }
  lines.push({ level: "result", text: `\u2713 Lazarus gate: 0 High findings (${plural(counted.length, "lower-severity finding")}). Process completed with exit code 0.` });
  return { phase: "pre-resurrection", status: "PASS", exitCode: 0, headline: "PASS \u00b7 exit 0 \u00b7 0 High Findings", highFindings: 0, lines, text: render(lines) };
}

function postRun(after: AfterVerified | null | undefined, blockedBefore: number): CiRun {
  if (after === null || after === undefined) {
    const lines: CiLine[] = [{ level: "info", text: "No resurrection has been verified for this code yet. Run RESURRECT SPECIMEN, then audit again to see the post-resurrection gate." }];
    return { phase: "post-resurrection", status: "PENDING", exitCode: null, headline: "PENDING \u00b7 run RESURRECT SPECIMEN", highFindings: blockedBefore, lines, text: render(lines) };
  }
  const lines: CiLine[] = [
    { level: "group", text: "Run npx lazarus resurrect . && npm test" },
    { level: "command", text: "> lazarus resurrect --exact --tsc-strict" },
    { level: "info", text: `Differential fuzzing: ${after.parity ? "exact Object.is parity" : "PARITY FAILED"}${after.runs !== undefined ? ` over ${plural(after.runs, "run")}` : ""}${after.seed !== undefined ? `, seed ${after.seed}` : ""}` },
    { level: "info", text: `tsc --strict: ${after.tscErrors === null ? "not measured" : plural(after.tscErrors, "error")}` },
    { level: "info", text: after.signed === true ? `Ed25519 certificate verified${after.keyId !== undefined ? ` (key ${after.keyId})` : ""}` : after.signed === null ? "Whole-graph parity verified (this artifact carries no signature)" : "Ed25519 certificate NOT verified" },
    { level: "endgroup", text: "" },
  ];
  if (after.verified) {
    lines.push({ level: "result", text: `\u2713 Lazarus gate: 0 High findings unproven${blockedBefore > 0 ? ` (${plural(blockedBefore, "blocking finding")} resolved or covered by the exact parity proof)` : ""}. Process completed with exit code 0.` });
    const proof = after.signed === true ? "Ed25519 Verified" : "Whole-Graph Parity Verified";
    return { phase: "post-resurrection", status: "PASS", exitCode: 0, headline: `PASS \u00b7 exit 0 \u00b7 0 High Findings \u00b7 ${proof}`, highFindings: 0, lines, text: render(lines) };
  }
  lines.push({ level: "error", text: `Lazarus gate: the resurrection is not verified${after.reason !== undefined ? ` (${after.reason})` : ""}.` });
  lines.push({ level: "error", text: "Process completed with exit code 1." });
  return { phase: "post-resurrection", status: "FAIL", exitCode: 1, headline: `FAIL \u00b7 exit 1 \u00b7 Not Verified${after.reason !== undefined ? ` \u00b7 ${after.reason}` : ""}`, highFindings: blockedBefore, lines, text: render(lines) };
}

/** The same GitHub Actions gate before and after the resurrection. `afterVerified` comes from a verified certificate, or is absent. */
export function simulateCiGate(beforeFindings: readonly DebtFinding[], afterVerified?: AfterVerified | null): CiGate {
  const before = preRun(beforeFindings);
  const after = postRun(afterVerified, before.highFindings);
  return { workflow: CI_WORKFLOW, before, after, transition: `${before.status} \u2192 ${after.status}` };
}

// ---------------------------------------------------------------------------
// Verified shield (self-contained SVG)
// ---------------------------------------------------------------------------
export interface BadgeInput {
  readonly label?: string;
  /** Percent of exact Object.is parity, 0 to 100. */
  readonly parity: number;
  readonly tscErrors: number;
  readonly seed?: number;
}

export const DEFAULT_BADGE_LABEL = "Lazarus Verified";

/** Text that is safe inside SVG text and attributes: control characters dropped, the five XML specials escaped. */
export function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const whole = (n: number, fallback: number): number => (Number.isFinite(n) ? Math.trunc(n) : fallback);

export interface BadgeParts {
  readonly label: string;
  readonly message: string;
  readonly color: string;
}

/** The two halves of the shield after validation (what a client-side twin must reproduce). */
export function badgeParts(input: BadgeInput): BadgeParts {
  const label = (input.label ?? DEFAULT_BADGE_LABEL).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "").trim().slice(0, 32) || DEFAULT_BADGE_LABEL;
  const parity = Math.max(0, Math.min(100, whole(input.parity, 0)));
  const errors = Math.max(0, whole(input.tscErrors, 0));
  const color = parity === 100 && errors === 0 ? "#059669" : parity === 100 ? "#d97706" : "#dc2626";
  return { label, message: `${parity}% Parity \u00b7 tsc ${errors}`, color };
}

const textWidth = (text: string): number => Math.round(text.length * 6.4 + 14);

/** A flat shield: `Lazarus Verified | 100% Parity · tsc 0`. No script, no link, no external resource; every text is escaped. */
export function renderVerifiedBadgeSvg(input: BadgeInput): string {
  const { label, message, color } = badgeParts(input);
  const seed = input.seed !== undefined && Number.isInteger(input.seed) ? ` \u00b7 seed ${input.seed}` : "";
  const left = textWidth(label);
  const right = textWidth(message);
  const width = left + right;
  const title = escapeXml(`${label}: ${message}${seed}`);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" viewBox="0 0 ${width} 20" role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
    `<rect width="${left}" height="20" fill="#111827"/>`,
    `<rect x="${left}" width="${right}" height="20" fill="${color}"/>`,
    `<g fill="#ffffff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">`,
    `<text x="${Math.round(left / 2)}" y="14">${escapeXml(label)}</text>`,
    `<text x="${left + Math.round(right / 2)}" y="14">${escapeXml(message)}</text>`,
    `</g>`,
    `</svg>`,
    ``,
  ].join("\n");
}
