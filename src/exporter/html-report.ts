// RESURRECTION_REPORT.html: one self-contained page that summarizes a resurrection for a reviewer who has no Lazarus Studio and
// maybe no network. Dark theme, inline CSS, no script, no font, no link, no image, no URL that a browser would load; a
// Content-Security-Policy meta blocks everything else as defense in depth. Every piece of text comes from the run and goes
// through `esc()`, so code under test can never inject markup. A pillar that the run did not measure says so.
import type { PurityProof } from "../crew/purity-audit.js";
import { diffLines, type DiffLine } from "../web/line-diff.js";

export const REPORT_FILE = "RESURRECTION_REPORT.html";
export const REPORT_VERSION = "V18";

export interface ReportMutant {
  readonly operator: string;
  readonly status: "killed" | "survived";
  readonly originalLine?: string | undefined;
  readonly mutatedLine?: string | undefined;
  readonly killerInput?: string | undefined;
  readonly legacyOutput?: string | undefined;
  readonly mutantOutput?: string | undefined;
  readonly divergence?: string | undefined;
}
export interface ReportRuleBlame {
  readonly rule: string;
  readonly status: "applied" | "rolled-back";
  readonly reason: string;
}
export interface ReportCausal {
  /** Rules the Necromancer applied or the Exorcist rolled back, as in Rule Blame X-Ray. */
  readonly rules: readonly ReportRuleBlame[];
  /** The counterexample behind a self-healing rollback. */
  readonly counterexample?: { readonly input: string; readonly legacyOutput: string; readonly modernOutput: string };
  /** Shrink trace: how fast-check minimized the failing input. */
  readonly shrink?: { readonly steps: number; readonly from: string; readonly to: string };
}
export interface ReportPerf {
  readonly ratio: number;
  readonly legacyMedianUs: number;
  readonly resurrectedMedianUs: number;
  readonly verdict: string;
}
export interface ReportSignature {
  readonly keyId: string;
  readonly legacySha256: string;
  readonly resurrectedSha256: string;
  readonly signatureB64: string;
  readonly issuedAt: string;
  readonly algorithm?: string;
}
export interface ReportTypecheck {
  readonly passed: boolean;
  readonly errorCount: number;
  readonly filesChecked: number;
  readonly tsVersion?: string;
  readonly diagnostics?: ReadonlyArray<{ readonly file: string; readonly line: number; readonly code: number; readonly message: string }>;
}
export interface ReportInput {
  readonly name: string;
  /** `single` file, `async` (callback or Promise chain) or `project` (stitched multi-file graph). */
  readonly kind?: "single" | "async" | "project";
  readonly legacyCode: string;
  readonly modernCode: string;
  readonly fuzz: { readonly runs: number; readonly attempts: number; readonly healed?: boolean; readonly exact?: boolean; readonly seed?: number };
  readonly typecheck?: ReportTypecheck;
  readonly purity?: PurityProof;
  readonly mutation?: { readonly killed: number; readonly total: number; readonly mutants?: readonly ReportMutant[] };
  readonly signature?: ReportSignature;
  readonly perf?: ReportPerf | { readonly skipped: string };
  readonly causal?: ReportCausal;
  /** Whole-project reports: one row per file. */
  readonly projectFiles?: ReadonlyArray<{ readonly path: string; readonly output: string; readonly attempts: number; readonly runs: number; readonly rolledBack: readonly string[] }>;
  readonly cycles?: ReadonlyArray<readonly string[]>;
  /** The files of the bundle, for the contents list. */
  readonly files?: readonly string[];
}

/** HTML-escapes text for element content and quoted attribute values. */
export function esc(value: unknown): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}\u2026` : text);
const num = (n: number, digits = 2): string => (Number.isFinite(n) ? n.toFixed(digits) : "n/a");

const CSS = `
:root { color-scheme: dark; --bg: #090d16; --panel: #111827; --line: #1f2937; --text: #e5e7eb; --muted: #94a3b8; --ok: #10b981; --bad: #ef4444; --kiro: #8b5cf6; --warn: #f59e0b; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.55 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 28px 20px 60px; }
h1 { margin: 0; font-size: 22px; letter-spacing: 1px; }
h1 small { display: block; margin-top: 4px; color: var(--muted); font-size: 12px; letter-spacing: 0; font-weight: 400; }
h2 { margin: 30px 0 10px; font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--kiro); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
.pillar { border-left: 4px solid var(--muted); }
.pillar.ok { border-left-color: var(--ok); } .pillar.bad { border-left-color: var(--bad); } .pillar.warn { border-left-color: var(--warn); }
.pillar h3 { margin: 0 0 4px; font-size: 11px; letter-spacing: 1.4px; text-transform: uppercase; color: var(--muted); }
.pillar .v { font-size: 16px; font-weight: 700; }
.pillar.ok .v { color: var(--ok); } .pillar.bad .v { color: var(--bad); } .pillar.warn .v { color: var(--warn); }
.pillar p { margin: 6px 0 0; font-size: 12px; color: var(--muted); word-break: break-word; }
.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--ok); color: var(--ok); font-size: 12px; font-weight: 700; margin: 6px 6px 0 0; }
.badge.bad { border-color: var(--bad); color: var(--bad); }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 600; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; }
code, pre, .mono { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px; }
td.k { color: var(--ok); font-weight: 700; } td.s { color: var(--bad); font-weight: 700; }
.diff { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.diff .head { background: var(--panel); padding: 6px 10px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--line); }
.cell { display: flex; gap: 8px; min-width: 0; padding: 0 8px; border-bottom: 1px solid rgba(31, 41, 55, 0.5); }
.cell i { flex: none; width: 3ch; text-align: right; color: #475569; font-style: normal; user-select: none; }
.cell span { white-space: pre-wrap; word-break: break-word; min-width: 0; }
.cell.del { background: rgba(239, 68, 68, 0.14); } .cell.add { background: rgba(16, 185, 129, 0.13); } .cell.blank { background: #0b1020; }
.note { color: var(--muted); font-size: 12px; }
ul { margin: 6px 0 0; padding-left: 18px; } li { margin: 2px 0; }
footer { margin-top: 36px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); padding-top: 12px; }
@media (max-width: 760px) { .diff { grid-template-columns: 1fr; } }
@media print { body { background: #fff; color: #111; } .card, .diff { border-color: #bbb; } }
`;

type Tone = "ok" | "bad" | "warn" | "none";
const pillar = (title: string, value: string, tone: Tone, detail: string): string =>
  `<div class="card pillar ${tone === "none" ? "" : tone}"><h3>${esc(title)}</h3><div class="v">${esc(value)}</div><p>${esc(detail)}</p></div>`;

function scorecard(i: ReportInput): string {
  const cards: string[] = [];
  cards.push(
    pillar(
      "1 \u00b7 Object.is parity",
      "PROVEN",
      "ok",
      `${i.fuzz.runs} ${i.fuzz.exact === false ? "JSON-level" : "exact"} fuzz runs, ${i.fuzz.attempts} attempt${i.fuzz.attempts === 1 ? "" : "s"}${i.fuzz.healed === true || i.fuzz.attempts > 1 ? ", self-healed" : ""}. Over the inputs fuzzed, not all inputs.${i.fuzz.seed !== undefined ? ` Proof seed ${i.fuzz.seed}: pass it to fast-check to replay exactly these runs.` : ""}`
    )
  );
  const p = i.purity;
  cards.push(
    p === undefined
      ? pillar("2 \u00b7 Purity / no global leaks", "not measured", "none", "The purity audit applies to synchronous snippets and was not part of this run.")
      : pillar(
          "2 \u00b7 Purity / no global leaks",
          p.proven ? "PROVEN" : "NOT PROVEN",
          p.proven ? "ok" : "bad",
          `${p.globalLeaksDetected.length > 0 ? `leaks fixed: ${p.globalLeaksDetected.join(", ")}` : "no global leak"}; prototypes ${p.prototypeSafe ? "untouched" : "CHANGED"}; inputs ${p.inputMutationParity ? "identical" : "DIFFER"}${p.legacyMutatesInput ? " (the legacy code mutates them)" : ""}${p.protoPollutionBlocked === undefined ? "" : p.protoPollutionBlocked ? "; Proto-Pollution Blocked" : "; PROTO-POLLUTION NOT BLOCKED"}. ${p.samples} sandboxed samples.`
        )
  );
  const m = i.mutation;
  cards.push(
    m === undefined || m.total === 0
      ? pillar("3 \u00b7 Mutant kill rate", "not measured", "none", "No mutation audit result was attached to this export.")
      : pillar("3 \u00b7 Mutant kill rate", `${m.killed}/${m.total} killed`, m.killed === m.total ? "ok" : "warn", `${Math.round((m.killed / m.total) * 100)}% of the injected rewrite bugs were caught by the Exorcist.`)
  );
  const s = i.signature;
  cards.push(
    s === undefined
      ? pillar("4 \u00b7 Ed25519 signature & digest", "not signed", "none", i.kind === "project" ? "Whole-project bundles carry no single-file certificate." : "No signature was attached.")
      : pillar("4 \u00b7 Ed25519 signature & digest", "SIGNED", "ok", `key ${s.keyId} \u00b7 SHA-256 of resurrected.ts ${s.resurrectedSha256.slice(0, 16)}\u2026 \u00b7 issued ${s.issuedAt}. Verify offline with certificate.json.`)
  );
  const f = i.perf;
  cards.push(
    f === undefined
      ? pillar("5 \u00b7 Performance parity", "not measured", "none", "No micro-benchmark was attached to this export.")
      : "skipped" in f
        ? pillar("5 \u00b7 Performance parity", "skipped", "none", f.skipped)
        : pillar("5 \u00b7 Performance parity", `${num(f.ratio)}x ${f.verdict}`, f.verdict === "slower" ? "warn" : "ok", `${num(f.resurrectedMedianUs)} \u00b5s resurrected vs ${num(f.legacyMedianUs)} \u00b5s legacy per call (ratio above 1: resurrected is faster).`)
  );
  const t = i.typecheck;
  cards.push(
    t === undefined
      ? pillar("Compiler", "not measured", "none", "tsc was not run for this export.")
      : pillar("Compiler \u00b7 tsc --strict", `${t.errorCount} error${t.errorCount === 1 ? "" : "s"}`, t.errorCount === 0 ? "ok" : "bad", `${t.filesChecked} file${t.filesChecked === 1 ? "" : "s"} checked${t.tsVersion !== undefined ? ` with TypeScript ${t.tsVersion}` : ""}.`)
  );
  return `<div class="grid">${cards.join("")}</div>`;
}

/** Pairs a unified line diff into side-by-side rows: a deleted run and the added run after it share rows. */
export function sideBySide(lines: readonly DiffLine[]): Array<{ left?: DiffLine; right?: DiffLine }> {
  const rows: Array<{ left?: DiffLine; right?: DiffLine }> = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.kind === "same") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]?.kind === "del") dels.push(lines[i++] as DiffLine);
    while (i < lines.length && lines[i]?.kind === "add") adds.push(lines[i++] as DiffLine);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const left = dels[k];
      const right = adds[k];
      rows.push({ ...(left !== undefined ? { left } : {}), ...(right !== undefined ? { right } : {}) });
    }
  }
  return rows;
}

const MAX_DIFF_ROWS = 600;
function diffTable(legacy: string, modern: string): string {
  const rows = sideBySide(diffLines(legacy.trimEnd(), modern.trimEnd()));
  const shown = rows.slice(0, MAX_DIFF_ROWS);
  const cell = (line: DiffLine | undefined, side: "left" | "right"): string => {
    if (line === undefined) return `<div class="cell blank"><i></i><span></span></div>`;
    const cls = line.kind === "same" ? "" : side === "left" ? " del" : " add";
    const n = side === "left" ? line.oldLine : line.newLine;
    return `<div class="cell${cls}"><i>${n ?? ""}</i><span class="mono">${esc(line.text)}</span></div>`;
  };
  const left = shown.map((r) => cell(r.left, "left")).join("");
  const right = shown.map((r) => cell(r.right, "right")).join("");
  const more = rows.length > shown.length ? `<p class="note">${rows.length - shown.length} more row(s) are in resurrection.patch.</p>` : "";
  return `<div class="diff"><div class="head">Legacy (ES5 / CommonJS)</div><div class="head">Resurrected (ES2022 / TypeScript)</div><div>${left}</div><div>${right}</div></div>${more}`;
}

function causalSection(c: ReportCausal | undefined): string {
  if (c === undefined) return `<p class="note">No rule blame or shrink trace was attached to this export.</p>`;
  const rules =
    c.rules.length === 0
      ? `<p class="note">No AST rule rewrote this specimen.</p>`
      : `<table><tr><th>Rule</th><th>Status</th><th>What happened</th></tr>${c.rules.map((r) => `<tr><td class="mono">${esc(r.rule)}</td><td class="${r.status === "applied" ? "k" : "s"}">${esc(r.status === "applied" ? "applied" : "rolled back")}</td><td>${esc(clip(r.reason, 240))}</td></tr>`).join("")}</table>`;
  const cx =
    c.counterexample === undefined
      ? ""
      : `<p><b>Counterexample that caused a rollback:</b> <code>${esc(clip(c.counterexample.input, 160))}</code> \u2192 legacy <code>${esc(clip(c.counterexample.legacyOutput, 80))}</code>, candidate <code>${esc(clip(c.counterexample.modernOutput, 80))}</code></p>`;
  const sh = c.shrink === undefined ? "" : `<p><b>Shrink trace:</b> ${c.shrink.steps} step${c.shrink.steps === 1 ? "" : "s"}, from <code>${esc(clip(c.shrink.from, 100))}</code> to the minimal <code>${esc(clip(c.shrink.to, 100))}</code></p>`;
  return rules + cx + sh;
}

function mutantTable(m: ReportInput["mutation"]): string {
  if (m === undefined || m.mutants === undefined || m.mutants.length === 0) return `<p class="note">${m === undefined ? "No mutation audit was attached to this export." : "The mutation audit result carried no per-mutant detail."}</p>`;
  const rows = m.mutants
    .map(
      (x) =>
        `<tr><td class="mono">${esc(x.operator)}</td><td class="${x.status === "killed" ? "k" : "s"}">${esc(x.status.toUpperCase())}</td><td class="mono">${esc(clip(`${x.originalLine ?? ""} \u2192 ${x.mutatedLine ?? ""}`, 140))}</td><td class="mono">${esc(clip(x.killerInput ?? "-", 100))}</td><td class="mono">${esc(clip(`${x.legacyOutput ?? "-"} vs ${x.mutantOutput ?? "-"}`, 100))}</td><td>${esc(clip(x.divergence ?? "-", 160))}</td></tr>`
    )
    .join("");
  return `<table><tr><th>Operator</th><th>Result</th><th>Injected change</th><th>Killer input</th><th>Legacy vs mutant</th><th>Divergence</th></tr>${rows}</table>`;
}

function typecheckSection(t: ReportTypecheck | undefined): string {
  if (t === undefined) return `<p class="note">tsc was not run for this export.</p>`;
  const head = `<span class="badge${t.errorCount === 0 ? "" : " bad"}">tsc --strict: ${t.errorCount} error${t.errorCount === 1 ? "" : "s"}</span>`;
  const diags = (t.diagnostics ?? []).slice(0, 10).map((d) => `<li class="mono">${esc(`${d.file}:${d.line} TS${d.code} ${clip(d.message, 200)}`)}</li>`).join("");
  return `${head}<span class="note">${t.filesChecked} file${t.filesChecked === 1 ? "" : "s"} checked with the installed TypeScript${t.tsVersion !== undefined ? ` ${esc(t.tsVersion)}` : ""}, strict mode, nothing suppressed.</span>${diags === "" ? "" : `<ul>${diags}</ul>`}`;
}

function projectSection(i: ReportInput): string {
  if (i.projectFiles === undefined) return "";
  const rows = i.projectFiles.map((f) => `<tr><td class="mono">${esc(f.path)}</td><td class="mono">${esc(f.output)}</td><td>${f.attempts}</td><td>${f.runs}</td><td>${f.rolledBack.length === 0 ? "none" : esc(f.rolledBack.join(", "))}</td></tr>`).join("");
  const cycles = (i.cycles ?? []).map((c) => `<li class="mono">${esc(c.join(" \u2194 "))}</li>`).join("");
  return `<h2>Files</h2><div class="card"><table><tr><th>Legacy file</th><th>Resurrected</th><th>Attempts</th><th>Fuzz runs</th><th>Rules rolled back</th></tr>${rows}</table>${cycles === "" ? "" : `<p><b>Require cycles resolved with live bindings:</b></p><ul>${cycles}</ul>`}</div>`;
}

/** The complete, self-contained report. Pure and deterministic for a given input. */
export function renderResurrectionReport(input: ReportInput): string {
  const title = `Resurrection Report: ${input.name}`;
  const files = input.files === undefined || input.files.length === 0 ? "" : `<h2>Bundle contents</h2><div class="card"><ul>${input.files.map((f) => `<li class="mono">${esc(f)}</li>`).join("")}</ul></div>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>${esc(title)}<small>Lazarus ${REPORT_VERSION} \u00b7 ${esc(input.kind === "project" ? "whole-project stitch" : input.kind === "async" ? "async/await conversion" : "single-file resurrection")} \u00b7 works offline: no script, no font, no link</small></h1>
<h2>5-Pillar Proof Scorecard</h2>
${scorecard(input)}
<h2>Legacy vs. resurrected</h2>
${diffTable(input.legacyCode, input.modernCode)}
${projectSection(input)}
<h2>Causal rollback &amp; shrink trace</h2>
<div class="card">${causalSection(input.causal)}</div>
<h2>Mutant Autopsy</h2>
<div class="card">${mutantTable(input.mutation)}</div>
<h2>Compiler proof</h2>
<div class="card">${typecheckSection(input.typecheck)}</div>
${files}
<footer>Parity is verified over the fuzz runs that were made, with exact <code>Object.is</code> comparison (-0, NaN, undefined); it is not a proof for all inputs. The Ed25519 signature shows the files were not changed after signing; with the public demo key it does not show who signed them. Check it with <code>lazarus verify</code> or the Studio's Verify Bundle drawer.</footer>
</main>
</body>
</html>
`;
}
