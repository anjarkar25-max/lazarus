// "Prove the Proof": mutation testing of a verified resurrection.
//
// Mutants are produced by acorn + astring from the resurrected code (parsed, never executed on the host). Each mutant
// re-creates a real-world rewrite bug. They are fuzzed in the sandbox against the legacy baseline with the exact
// Object.is Exorcist: a mutant the fuzzer tells apart is KILLED, one it cannot is SURVIVED (reported as such, even when
// that lowers the score; an equivalent mutant is indistinguishable by definition).
import type * as ESTree from "estree";
import { DifferentialFuzzer } from "../fuzzer/differential.js";
import type { FuzzReport, InputSchema } from "../fuzzer/types.js";
import { describeValue, decodeTagged } from "../sandbox/tagged.js";
import type { ProbeExecutor } from "../sandbox/types.js";
import { parseProgram, printProgram } from "./ast-modernizer.js";
import { walk } from "./ast-scope.js";
import { formatInputs, formatOutcome } from "./exact-format.js";

export type MutationOperator = "boundary-flip" | "truncation-sabotage" | "arithmetic-flip" | "guard-sabotage" | "equality-flip";

export const MAX_MUTANTS = 5;
export const DEFAULT_MUTANT_RUNS = 30;
/** Operator families, in the order they are interleaved. */
export const OPERATOR_ORDER: readonly MutationOperator[] = ["truncation-sabotage", "boundary-flip", "arithmetic-flip", "guard-sabotage", "equality-flip"];

export interface Mutant {
  readonly id: string;
  readonly operator: MutationOperator;
  /** Human label, e.g. "Math.trunc → Math.floor". */
  readonly label: string;
  readonly description: string;
  readonly code: string;
  readonly line: number;
  /** "- before\n+ after" for the first changed line. */
  readonly diffSnippet: string;
  /** The first changed line before the mutation, trimmed. */
  readonly originalLine: string;
  /** The same line after the mutation, trimmed. */
  readonly mutatedLine: string;
}

interface Site {
  readonly operator: MutationOperator;
  readonly label: string;
  /** Applies the mutation to the node with this walk index in a fresh AST. */
  readonly apply: (node: ESTree.Node) => boolean;
  readonly index: number;
  readonly line: number;
}

const BOUNDARY: Record<string, string> = { "<": "<=", "<=": "<", ">": ">=", ">=": ">" };
const EQUALITY: Record<string, string> = { "===": "!==", "!==": "===", "==": "!=", "!=": "==" };
const ARITHMETIC: Record<string, string> = { "+": "-", "-": "+", "*": "+", "/": "*" };
const COMPOUND: Record<string, string> = { "+=": "-=", "-=": "+=", "*=": "+=", "/=": "*=" };

/** `typeof x !== "undefined" ? x : undefined`: the scanner's argument guard, which is harness code, not user code. */
function isHarnessGuard(n: ESTree.Node): boolean {
  if (n.type !== "ConditionalExpression" || n.test.type !== "BinaryExpression" || n.test.operator !== "!==") return false;
  const { left, right } = n.test;
  return (
    left.type === "UnaryExpression" &&
    left.operator === "typeof" &&
    left.argument.type === "Identifier" &&
    right.type === "Literal" &&
    right.value === "undefined" &&
    n.consequent.type === "Identifier" &&
    n.consequent.name === left.argument.name &&
    n.alternate.type === "Identifier" &&
    n.alternate.name === "undefined"
  );
}
const rangeOf = (n: ESTree.Node): { start: number; end: number } => {
  const r = n as unknown as { start?: number; end?: number };
  return { start: r.start ?? -1, end: r.end ?? -1 };
};

const isStringLiteral = (n: ESTree.Node): boolean => (n.type === "Literal" && typeof n.value === "string") || n.type === "TemplateLiteral";
const isMathMember = (n: ESTree.Node, prop: string): n is ESTree.MemberExpression =>
  n.type === "MemberExpression" && !n.computed && n.object.type === "Identifier" && n.object.name === "Math" && n.property.type === "Identifier" && n.property.name === prop;
const lineOfNode = (n: ESTree.Node): number => (n as { loc?: { start: { line: number } } | null }).loc?.start.line ?? 0;

/** Replaces every own key of `target` with those of `replacement` (keeps the parent's reference intact). */
function replaceInPlace(target: ESTree.Node, replacement: ESTree.Node): void {
  const t = target as unknown as Record<string, unknown>;
  const keep = { start: t["start"], end: t["end"], loc: t["loc"] };
  for (const key of Object.keys(t)) delete t[key];
  Object.assign(t, replacement, keep);
}

/** Every mutation site of the program, in source order, grouped by operator. */
function collectSites(ast: ESTree.Program): Site[] {
  const sites: Site[] = [];
  const harness: Array<{ start: number; end: number }> = [];
  walk(ast, (n) => {
    if (isHarnessGuard(n)) harness.push(rangeOf(n));
    return undefined;
  });
  const inHarness = (n: ESTree.Node): boolean => {
    const r = rangeOf(n);
    return harness.some((h) => r.start >= h.start && r.end <= h.end);
  };
  let index = 0;
  walk(ast, (n) => {
    const i = index++;
    const line = lineOfNode(n);
    // Indices are counted for every node (the apply pass walks a fresh AST the same way); only registration is skipped.
    if (inHarness(n)) return undefined;
    if (n.type === "AssignmentExpression" && COMPOUND[n.operator] !== undefined) {
      const to = COMPOUND[n.operator] as ESTree.AssignmentOperator;
      sites.push({ operator: "arithmetic-flip", label: `${n.operator} → ${to}`, index: i, line, apply: (m) => m.type === "AssignmentExpression" && ((m.operator = to), true) });
    }
    if (n.type === "BinaryExpression") {
      const op = n.operator;
      const boundary = BOUNDARY[op];
      if (boundary !== undefined) {
        sites.push({ operator: "boundary-flip", label: `${op} → ${boundary}`, index: i, line, apply: (m) => m.type === "BinaryExpression" && ((m.operator = boundary as ESTree.BinaryOperator), true) });
      }
      const equality = EQUALITY[op];
      if (equality !== undefined) {
        sites.push({ operator: "equality-flip", label: `${op} → ${equality}`, index: i, line, apply: (m) => m.type === "BinaryExpression" && ((m.operator = equality as ESTree.BinaryOperator), true) });
      }
      const arithmetic = ARITHMETIC[op];
      // `+` with a string literal operand is concatenation, not arithmetic.
      if (arithmetic !== undefined && !(op === "+" && (isStringLiteral(n.left) || isStringLiteral(n.right)))) {
        sites.push({ operator: "arithmetic-flip", label: `${op} → ${arithmetic}`, index: i, line, apply: (m) => m.type === "BinaryExpression" && ((m.operator = arithmetic as ESTree.BinaryOperator), true) });
      }
      if (op === "|" && n.right.type === "Literal" && n.right.value === 0 && n.left.type !== "PrivateIdentifier") {
        sites.push({
          operator: "truncation-sabotage",
          label: "strip | 0",
          index: i,
          line,
          apply: (m) => {
            if (m.type !== "BinaryExpression" || m.left.type === "PrivateIdentifier") return false;
            replaceInPlace(m, { ...m.left });
            return true;
          },
        });
      }
    } else if (n.type === "CallExpression" && isMathMember(n.callee, "trunc")) {
      sites.push({
        operator: "truncation-sabotage",
        label: "Math.trunc → Math.floor",
        index: i,
        line,
        apply: (m) => {
          if (m.type !== "CallExpression" || m.callee.type !== "MemberExpression" || m.callee.property.type !== "Identifier") return false;
          m.callee.property.name = "floor";
          return true;
        },
      });
    } else if (n.type === "IfStatement" || n.type === "ConditionalExpression") {
      sites.push({
        operator: "guard-sabotage",
        label: n.type === "IfStatement" ? "if (cond) → if (!cond)" : "cond ? a : b → !cond ? a : b",
        index: i,
        line,
        apply: (m) => {
          if (m.type !== "IfStatement" && m.type !== "ConditionalExpression") return false;
          m.test = { type: "UnaryExpression", operator: "!", prefix: true, argument: m.test };
          return true;
        },
      });
    } else if (n.type === "Literal" && typeof n.value === "number" && Number.isInteger(n.value) && Math.abs(n.value) < 1e6) {
      const from = n.value;
      sites.push({
        operator: "guard-sabotage",
        label: `constant ${from} → ${from + 1}`,
        index: i,
        line,
        apply: (m) => {
          if (m.type !== "Literal" || typeof m.value !== "number") return false;
          m.value = from + 1;
          m.raw = String(from + 1);
          return true;
        },
      });
    }
    return undefined;
  });
  return sites;
}

/** Normalizes printed code so formatting-only differences never count as a mutation. */
const canonical = (code: string): string => code.replace(/\s+/g, " ").trim();

function firstDiff(before: string, after: string): { line: number; snippet: string; originalLine: string; mutatedLine: string } {
  const a = before.split("\n");
  const b = after.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      const originalLine = (a[i] ?? "").trim();
      const mutatedLine = (b[i] ?? "").trim();
      return { line: i + 1, snippet: `- ${originalLine}\n+ ${mutatedLine}`, originalLine, mutatedLine };
    }
  }
  return { line: 0, snippet: "", originalLine: "", mutatedLine: "" };
}

const DESCRIPTIONS: Record<MutationOperator, string> = {
  "boundary-flip": "Boundary flip: an off-by-one comparison, the classic loop/clamp rewrite bug",
  "truncation-sabotage": "Truncation sabotage: rounding toward -Infinity, or no 32-bit truncation at all",
  "arithmetic-flip": "Arithmetic flip: the wrong operator on a numeric expression",
  "guard-sabotage": "Guard sabotage: an inverted branch condition or an off-by-one constant",
  "equality-flip": "Equality flip: an inverted (strict) equality check",
};

/**
 * Up to `max` distinct mutants. Operators are interleaved (one site of each family per round) so a small budget still
 * covers different bug classes. A mutant is emitted only if its printed AST differs from the original and from every
 * mutant already emitted.
 */
export function generateMutants(code: string, max = MAX_MUTANTS): Mutant[] {
  const parsed = parseProgram(code);
  if ("error" in parsed) return [];
  const original = printProgram(parsed.ast, []);
  const seen = new Set([canonical(original)]);
  const sites = collectSites(parsed.ast);
  const queues = OPERATOR_ORDER.map((op) => sites.filter((s) => s.operator === op));
  const mutants: Mutant[] = [];
  while (mutants.length < max && queues.some((q) => q.length > 0)) {
    for (const queue of queues) {
      if (mutants.length >= max) break;
      const site = queue.shift();
      if (site === undefined) continue;
      const fresh = parseProgram(code);
      if ("error" in fresh) continue;
      let target: ESTree.Node | undefined;
      let index = 0;
      walk(fresh.ast, (n) => {
        if (index++ === site.index) target = n;
        return undefined;
      });
      if (target === undefined || !site.apply(target)) continue;
      let printed: string;
      try {
        printed = printProgram(fresh.ast, []);
      } catch {
        continue;
      }
      const key = canonical(printed);
      if (seen.has(key) || "error" in parseProgram(printed)) continue;
      seen.add(key);
      const diff = firstDiff(original, printed);
      mutants.push({
        id: `M${mutants.length + 1}`,
        operator: site.operator,
        label: site.label,
        description: DESCRIPTIONS[site.operator],
        code: printed,
        line: diff.line,
        diffSnippet: diff.snippet,
        originalLine: diff.originalLine,
        mutatedLine: diff.mutatedLine,
      });
    }
  }
  return mutants;
}

export interface MutantResult {
  readonly id: string;
  readonly operator: MutationOperator;
  readonly label: string;
  readonly description: string;
  readonly diffSnippet: string;
  readonly status: "KILLED" | "SURVIVED";
  /** Inputs (wire form) and reason of the first input that told the mutant apart from the legacy baseline. */
  readonly killingCounterexample: { readonly inputs: Record<string, unknown>; readonly display: string; readonly reason: string } | null;
  readonly runs: number;
  readonly elapsedMs: number;
  /** Everything the Mutant Autopsy Inspector shows: the injected fault, the killer input and the exact divergence. */
  readonly autopsy: MutantAutopsy;
}

/** Where a killer input came from: the boundary corpus (already minimal), a fast-check shrink, or the first failure. */
export type KillerSource = "boundary-corpus" | "shrunk" | "first-failure";

export interface MutantAutopsy {
  readonly id: string;
  /** Human-readable operator, e.g. "Math.trunc → Math.floor" or "strip | 0". */
  readonly operator: string;
  readonly status: "killed" | "survived";
  readonly originalLine: string;
  readonly mutatedLine: string;
  /** The input that told the mutant apart from the legacy code; null for a survivor. */
  readonly killerInput: { readonly display: string; readonly inputs: Record<string, unknown>; readonly source: KillerSource } | null;
  /** Legacy and mutant outcomes for the killer input ("+0", "-0", "NaN", "throws TIMEOUT"...); null for a survivor. */
  readonly legacyOutput: string | null;
  readonly mutantOutput: string | null;
  /** The Exorcist's reason for the divergence; null for a survivor. */
  readonly divergence: string | null;
}

export interface MutationAuditResult {
  readonly totalMutants: number;
  readonly killed: number;
  readonly survived: number;
  /** killed / total, rounded; 0 when no mutant could be generated. */
  readonly killRatePercent: number;
  readonly elapsedMs: number;
  readonly runsPerMutant: number;
  /** The unmutated candidate matched the legacy code over the same budget (otherwise no mutant is judged). */
  readonly baselineVerified: boolean;
  readonly mutants: MutantResult[];
  readonly note?: string;
}

export interface AuditInput {
  /** Runnable legacy expression (the oracle). */
  readonly legacyCode: string;
  /** The verified resurrected code. */
  readonly modernCode: string;
  readonly schema: InputSchema;
  readonly executors: { readonly legacy: ProbeExecutor; readonly modern: ProbeExecutor };
  readonly runsPerMutant?: number;
  readonly seed?: number;
  readonly maxMutants?: number;
}

const displayInputs = (inputs: Record<string, unknown>): string =>
  Object.entries(inputs)
    .map(([k, v]) => `${k} = ${describeValue(decodeTagged(v), 80)}`)
    .join(", ");

export async function runMutationAudit(input: AuditInput): Promise<MutationAuditResult> {
  const started = Date.now();
  const runs = Math.max(10, Math.min(input.runsPerMutant ?? DEFAULT_MUTANT_RUNS, 60));
  const fuzzer = new DifferentialFuzzer(input.executors);
  // Boundary corpus first (half the budget), random boundary-biased runs after, no shrinking: kills are fast and
  // every counterexample is a concrete, readable boundary input whenever one works.
  const options = { numRuns: runs, exact: true, boundary: true, shrink: false, ...(input.seed !== undefined ? { seed: input.seed } : {}) } as const;
  const baseline = await fuzzer.fuzz(input.legacyCode, input.modernCode, input.schema, options);
  const summary = (mutants: MutantResult[], baselineVerified: boolean, note?: string): MutationAuditResult => {
    const killed = mutants.filter((m) => m.status === "KILLED").length;
    return {
      totalMutants: mutants.length,
      killed,
      survived: mutants.length - killed,
      killRatePercent: mutants.length === 0 ? 0 : Math.round((killed / mutants.length) * 100),
      elapsedMs: Date.now() - started,
      runsPerMutant: runs,
      baselineVerified,
      mutants,
      ...(note !== undefined ? { note } : {}),
    };
  };
  if (!baseline.passed) {
    return summary([], false, `the resurrected code itself diverges from the legacy code (${baseline.counterexample?.reason ?? "divergence"}); resurrect it again before auditing the proof`);
  }
  const mutants = generateMutants(input.modernCode, input.maxMutants ?? MAX_MUTANTS);
  const results: MutantResult[] = [];
  for (const mutant of mutants) {
    const t = Date.now();
    const report: FuzzReport = await fuzzer.fuzz(input.legacyCode, mutant.code, input.schema, options);
    const cx = report.counterexample;
    // The audit stops at the first failure. A boundary-corpus kill is already minimal; a random-phase kill is replayed
    // with shrinking (same seed) so the autopsy shows the smallest input fast-check can find.
    let killer = cx;
    let source: KillerSource = "first-failure";
    if (!report.passed && cx !== undefined) {
      if (report.boundaryRuns !== undefined && report.boundaryRuns === report.totalRuns) {
        source = "boundary-corpus";
      } else {
        const replay = await fuzzer.fuzz(input.legacyCode, mutant.code, input.schema, { ...options, shrink: true, seed: report.seed });
        if (!replay.passed && replay.counterexample !== undefined) {
          killer = replay.counterexample;
          source = "shrunk";
        }
      }
    }
    const k = report.passed ? undefined : killer;
    const autopsy: MutantAutopsy = {
      id: mutant.id,
      operator: mutant.label,
      status: report.passed ? "survived" : "killed",
      originalLine: mutant.originalLine,
      mutatedLine: mutant.mutatedLine,
      killerInput: k !== undefined ? { display: formatInputs(k.inputs), inputs: k.inputs, source } : null,
      legacyOutput: k !== undefined ? formatOutcome(k.legacy) : null,
      mutantOutput: k !== undefined ? formatOutcome(k.modern) : null,
      divergence: k !== undefined ? k.reason : null,
    };
    results.push({
      id: mutant.id,
      operator: mutant.operator,
      label: mutant.label,
      description: mutant.description,
      diffSnippet: mutant.diffSnippet,
      status: report.passed ? "SURVIVED" : "KILLED",
      killingCounterexample: report.passed || cx === undefined ? null : { inputs: cx.inputs, display: displayInputs(cx.inputs), reason: cx.reason },
      runs: report.totalRuns,
      elapsedMs: Date.now() - t,
      autopsy,
    });
  }
  return summary(results, true, mutants.length === 0 ? "no mutation site was found in the resurrected code" : undefined);
}
