// Rule Blame X-Ray: for every AST rule that rewrote, or was rolled back in, a resurrection, where it acted and why.
//
// Deterministic and cheap: it re-runs the (parse-and-print only) modernizer at the levels recorded in the final candidate's
// `// ast-rules:` header, and at the default levels for the rules that were rolled back. Nothing is executed.
import type { CounterexampleReport } from "../fuzzer/types.js";
import { formatInputs, formatOutcome } from "./exact-format.js";
import { RULE_ORDER, defaultLevels, modernize, readHeaderLevels, type AppliedRewrite, type RuleId } from "./ast-modernizer.js";

export type BlameRule = RuleId | "callback-async" | "promise-async";

export interface BlameCounterexample {
  /** 1-based attempt whose fuzz run found it. */
  readonly attempt: number;
  readonly input: string;
  readonly legacyOutput: string;
  readonly modernOutput: string;
}

export interface RuleBlameEntry {
  readonly rule: BlameRule;
  readonly status: "applied" | "rolled-back";
  /** 1-based lines of the legacy source (as written) the rule acted on. */
  readonly legacyLines: number[];
  /** 1-based lines of the resurrected code (as shown, header comments included). Empty when not locatable. */
  readonly resurrectedLines: number[];
  /** Number of sites. */
  readonly sites: number;
  /** One sentence: what the rule changed, or why the Exorcist rolled it back. */
  readonly reason: string;
  /** For a rollback: the counterexample that caught it. */
  readonly counterexample?: BlameCounterexample;
}

const WHAT: Record<RuleId, string> = {
  "var-scoping": "`var` became block-scoped `let`/`const`",
  "prototype-class": "an ES5 constructor and its prototype members became a `class`",
  "arguments-rest": "`arguments` became a rest parameter",
  "apply-spread": "`.apply()` became a spread call",
  "function-arrow": "a function expression became an arrow function",
  "bitor0-trunc": "`x | 0` became `Math.trunc(x) || 0`",
  "loose-equality": "`==` became `===` where both operand types are provably equal",
};

const clip = (text: string, max = 70): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};
const unique = (n: readonly number[]): number[] => [...new Set(n.filter((x) => x > 0))].sort((a, b) => a - b);
const countLines = (text: string): number => (text.match(/\n/g) ?? []).length;

/** `counterexample` wire-form pieces as the Studio shows them elsewhere. */
export function describeCounterexample(attempt: number, cx: CounterexampleReport): BlameCounterexample {
  return { attempt, input: formatInputs(cx.inputs), legacyOutput: formatOutcome(cx.legacy), modernOutput: formatOutcome(cx.modern) };
}

/** Rule names a refine note says were rolled back, and the attempt it belongs to: `// ast-refine: attempt 2 blamed r; rolled back a (x -> y), b (...)`. */
function refineNotes(code: string): Array<{ attempt: number; blamed: string | undefined; rolledBack: string[] }> {
  const notes: Array<{ attempt: number; blamed: string | undefined; rolledBack: string[] }> = [];
  for (const m of code.matchAll(/^\/\/ ast-refine: attempt (\d+) blamed (\S+); rolled back ([^;]+);/gm)) {
    notes.push({ attempt: Number(m[1]), blamed: m[2] === "none" ? undefined : m[2], rolledBack: [...(m[3] ?? "").matchAll(/([a-z0-9-]+) \(/g)].map((x) => x[1] ?? "") });
  }
  return notes;
}

/**
 * @param counterexamples the counterexamples the Exorcist found, in order (the n-th one ended attempt n)
 */
export function computeRuleBlame(legacyCode: string, modernCode: string, counterexamples: readonly CounterexampleReport[] = []): RuleBlameEntry[] {
  const levels = readHeaderLevels(modernCode);
  if (levels === undefined) return [];
  const final = modernize(legacyCode, { levels });
  if (!final.parsed) return [];
  const original = modernize(legacyCode, { levels: defaultLevels() });

  // Where the printed code starts inside the candidate text (header comments come first).
  const at = modernCode.indexOf(final.code);
  const offset = at < 0 ? undefined : countLines(modernCode.slice(0, at));
  const modernLines = modernCode.split("\n");
  const notes = refineNotes(modernCode);

  const entries: RuleBlameEntry[] = [];
  for (const rule of RULE_ORDER) {
    const kept: Array<{ rewrite: AppliedRewrite; line: number }> = final.applied.flatMap((rewrite, i) => (rewrite.rule === rule ? [{ rewrite, line: final.resultLines?.[i] ?? 0 }] : []));
    const wanted = original.applied.filter((a) => a.rule === rule);
    if (kept.length > 0) {
      const first = kept[0]?.rewrite as AppliedRewrite;
      const limited = wanted.length > kept.length;
      entries.push({
        rule,
        status: "applied",
        legacyLines: unique(kept.map((k) => k.rewrite.line)),
        resurrectedLines: offset === undefined ? [] : unique(kept.map((k) => (k.line > 0 ? k.line + offset : 0))),
        sites: kept.length,
        reason: `${WHAT[rule][0]?.toUpperCase() ?? ""}${WHAT[rule].slice(1)}${kept.length > 1 ? ` at ${kept.length} sites` : ""} (\`${clip(first.before, 40)}\` -> \`${clip(first.after, 40)}\`)${limited ? `; ${wanted.length - kept.length} riskier site(s) were rolled back` : ""}; the Exorcist found no divergence.`,
      });
      continue;
    }
    if (levels[rule] >= 1 && wanted.length > 0) {
      // Rolled back: find the counterexample behind it. The refine note of attempt k answers the counterexample of attempt k - 1.
      const note = notes.find((n) => n.rolledBack.includes(rule));
      const attempt = note !== undefined ? note.attempt - 1 : 1;
      const cx = counterexamples[attempt - 1] ?? counterexamples[0];
      const link = cx === undefined ? undefined : describeCounterexample(counterexamples[attempt - 1] !== undefined ? attempt : 1, cx);
      const blamed = note?.blamed === rule;
      const snippets = wanted.map((w) => clip(w.before, 40).replace(/\.\.\.$/, ""));
      const located = modernLines.flatMap((text, i) => (snippets.some((s) => s.length > 3 && text.includes(s)) ? [i + 1] : []));
      entries.push({
        rule,
        status: "rolled-back",
        legacyLines: unique(wanted.map((w) => w.line)),
        resurrectedLines: unique(located),
        sites: wanted.length,
        reason:
          link !== undefined
            ? `Rolled back: ${WHAT[rule]} was ${blamed ? "blamed for" : "undone while repairing"} the counterexample ${clip(link.input, 50)} (legacy ${clip(link.legacyOutput, 30)}, rewrite ${clip(link.modernOutput, 30)}), so the legacy form is kept.`
            : `Rolled back: ${WHAT[rule]} did not keep exact parity, so the legacy form is kept.`,
        ...(link !== undefined ? { counterexample: link } : {}),
      });
    }
  }
  return entries;
}

/** The async passes' single-rule entry: `callback-async` (error-first) or `promise-async`. */
export function asyncBlame(rule: "callback-async" | "promise-async", args: { applied: boolean; line: number; reason: string; counterexample?: BlameCounterexample }): RuleBlameEntry {
  return { rule, status: args.applied ? "applied" : "rolled-back", legacyLines: args.line > 0 ? [args.line] : [], resurrectedLines: [], sites: 1, reason: args.reason, ...(args.counterexample !== undefined ? { counterexample: args.counterexample } : {}) };
}
