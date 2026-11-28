// "Naive AI" rewrite: the modernization a hurried LLM typically produces, applied deterministically with acorn +
// astring (no network, no API key, no randomness). It exists to be caught: the Exorcist fuzzes it against the legacy
// code exactly as it fuzzes Lazarus's own candidates, and a divergence is reported as the trap it is. When a rewrite
// happens to be safe over the fuzzed domain, that is reported too.
import type * as ESTree from "estree";
import { parseProgram, printProgram } from "./ast-modernizer.js";
import { analyze, walk } from "./ast-scope.js";
import { leakSites } from "./purity-audit.js";

export type NaiveRule = "bitor0-floor" | "bitor0-trunc" | "bitor0-dropped" | "shift-trunc" | "double-tilde-trunc" | "strict-equality" | "var-to-let" | "strict-mode";

export interface NaiveRewrite {
  readonly rule: NaiveRule;
  /** Why an LLM makes this rewrite, and what it misses. */
  readonly why: string;
  readonly before: string;
  readonly after: string;
}

export interface NaiveRefactorResult {
  readonly naiveCode: string;
  readonly rewrites: NaiveRewrite[];
  /** Set when the code could not be parsed (returned unchanged). */
  readonly parseError?: string;
}

const WHY: Record<NaiveRule, string> = {
  "bitor0-floor": "`(a / b) | 0` looks like integer division, so it becomes Math.floor, which rounds toward -Infinity instead of toward zero",
  "bitor0-trunc": "`x | 0` becomes Math.trunc, which keeps -0, NaN and values beyond 32 bits that `| 0` maps to 0 or wraps",
  "bitor0-dropped": "`| 0` on an accumulation looks redundant and is removed, so the 32-bit wrap-around is lost",
  "shift-trunc": "`x >> 0` / `x >>> 0` becomes Math.trunc, losing the int32 / uint32 conversion",
  "double-tilde-trunc": "`~~x` becomes Math.trunc, losing the int32 conversion",
  "strict-equality": "`==` becomes `===`, which stops the type coercion the legacy code relied on",
  "var-to-let": "`var` becomes `let`, which changes hoisting (temporal dead zone) and per-iteration loop bindings",
  "strict-mode": "the file is modernized to strict ES2022 (\"use strict\") without declaring the variables the legacy code leaked onto the global object, so the first assignment throws a ReferenceError",
};

type Node = ESTree.Node;
const ident = (name: string): ESTree.Identifier => ({ type: "Identifier", name });
const mathCall = (fn: "floor" | "trunc", arg: ESTree.Expression): ESTree.CallExpression => ({
  type: "CallExpression",
  callee: { type: "MemberExpression", object: ident("Math"), property: ident(fn), computed: false, optional: false },
  arguments: [arg],
  optional: false,
});
const isZero = (n: Node): boolean => n.type === "Literal" && n.value === 0;

/** `h * 31 + c`, `h + c`, `h << 5`, `h ^ c`: arithmetic that accumulates a running value. */
function isAccumulation(n: Node): boolean {
  if (n.type !== "BinaryExpression" || !["+", "*", "<<", "^", "-"].includes(n.operator)) return false;
  let hasIdentifier = false;
  walk(n, (m) => {
    if (m.type === "Identifier") hasIdentifier = true;
    return undefined;
  });
  return hasIdentifier && (n.operator !== "-" || n.left.type === "BinaryExpression");
}

/** Replaces every own key of `target` with those of `replacement` (the parent keeps its reference). */
function replaceInPlace(target: Node, replacement: Node): void {
  const t = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(t)) delete t[key];
  Object.assign(t, replacement);
}

/** Prints one expression or statement for the rewrite log. */
function show(node: Node): string {
  const program: ESTree.Program = {
    type: "Program",
    sourceType: "script",
    body: [node.type === "VariableDeclaration" ? node : { type: "ExpressionStatement", expression: node as ESTree.Expression }],
  };
  try {
    return printProgram(program, []).trim().replace(/;$/, "").replace(/\s+/g, " ");
  } catch {
    return "<unprintable>";
  }
}

export function naiveRefactor(code: string): NaiveRefactorResult {
  const parsed = parseProgram(code);
  if ("error" in parsed) return { naiveCode: code, rewrites: [], parseError: parsed.error };
  const rewrites: NaiveRewrite[] = [];
  const record = (rule: NaiveRule, node: Node, apply: () => void): void => {
    const before = show(node);
    apply();
    rewrites.push({ rule, why: WHY[rule], before, after: show(node) });
  };
  // Collect first, rewrite after: rewriting while walking would revisit the new nodes.
  const targets: Node[] = [];
  walk(parsed.ast, (n) => {
    targets.push(n);
    return undefined;
  });
  // Innermost first, so an outer rewrite's "before" text already shows its inner rewrites.
  for (const n of targets.reverse()) {
    if (n.type === "BinaryExpression" && n.left.type !== "PrivateIdentifier") {
      const left = n.left;
      if (n.operator === "|" && isZero(n.right)) {
        if (left.type === "BinaryExpression" && left.operator === "/") record("bitor0-floor", n, () => replaceInPlace(n, mathCall("floor", left)));
        else if (isAccumulation(left)) record("bitor0-dropped", n, () => replaceInPlace(n, { ...left }));
        else record("bitor0-trunc", n, () => replaceInPlace(n, mathCall("trunc", left)));
      } else if ((n.operator === ">>" || n.operator === ">>>") && isZero(n.right)) {
        record("shift-trunc", n, () => replaceInPlace(n, mathCall("trunc", left)));
      } else if (n.operator === "==" || n.operator === "!=") {
        const to: ESTree.BinaryOperator = n.operator === "==" ? "===" : "!==";
        record("strict-equality", n, () => {
          n.operator = to;
        });
      }
    } else if (n.type === "UnaryExpression" && n.operator === "~" && n.argument.type === "UnaryExpression" && n.argument.operator === "~") {
      const inner = n.argument.argument;
      record("double-tilde-trunc", n, () => replaceInPlace(n, mathCall("trunc", inner)));
    } else if (n.type === "VariableDeclaration" && n.kind === "var") {
      record("var-to-let", n, () => {
        n.kind = "let";
      });
    }
  }
  rewrites.reverse();
  // A strict-mode refactor that forgets the undeclared globals: the classic hurried ES5 -> ES2022 mistake.
  const leaks = leakSites(analyze(parsed.ast));
  const firstLeak = leaks[0];
  if (firstLeak !== undefined) {
    parsed.ast.body.unshift({ type: "ExpressionStatement", expression: { type: "Literal", value: "use strict", raw: '"use strict"' }, directive: "use strict" });
    rewrites.unshift({ rule: "strict-mode", why: WHY["strict-mode"], before: `${firstLeak.name} = ...`, after: `"use strict"; ${firstLeak.name} = ...` });
  }
  if (rewrites.length === 0) return { naiveCode: code, rewrites };
  return { naiveCode: printProgram(parsed.ast, []).trim(), rewrites };
}
