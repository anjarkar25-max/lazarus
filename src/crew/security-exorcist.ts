// Security Exorcist (V19): prototype pollution and loose-equality hazards in legacy ES5.
//
// Static side (Acorn AST, nothing is executed): `for (k in src) { dst[k] = src[k]; }` key-copy loops without a guard for
// `__proto__` / `constructor` / `prototype` (the `proto-pollution-guard` Necromancer rule repairs them; the `LAZ009` audit rule
// reports them), and every `==` / `!=` (the `LAZ010` audit rule).
// Dynamic side (sandbox): a live exploit probe feeds JSON.parse('{"__proto__":{"polluted":true}}') to the code and reads
// `({}).polluted`. Each probe runs in a fresh vm context, so a polluted Object.prototype never outlives the probe.
import { generate } from "astring";
import { parse } from "acorn";
import type * as ESTree from "estree";
import type { InputSchema, ParamKind } from "../fuzzer/types.js";
import type { ProbeExecutor } from "../sandbox/types.js";
import { analyze, lineOf, walk, type Analysis } from "./ast-scope.js";

/** Keys that reach a prototype when used as a property name in `dst[key] = value`. */
export const POLLUTING_KEYS = ["__proto__", "constructor", "prototype"] as const;
/** The payload of the live exploit probe. */
export const EXPLOIT_PAYLOAD = '{"__proto__":{"polluted":true}}';

// ---------------------------------------------------------------------------
// Static analysis
// ---------------------------------------------------------------------------
export interface PollutionSite {
  readonly loop: ESTree.ForInStatement;
  /** 1-based line of the `for` statement. */
  readonly line: number;
  /** The loop variable (`k` in `for (var k in src)`). */
  readonly key: string;
  /** Text of the object that is iterated, as far as it is a plain reference. */
  readonly sourceText: string;
  /** Present when the loop can be guarded by inserting one statement. */
  readonly fixable: boolean;
  /** Why the loop is reported but not repaired. */
  readonly keptBecause?: string;
}

/** `src`, `this.src`, `a.b.c`: evaluating it twice cannot change behavior. */
function plainReference(node: ESTree.Node): boolean {
  if (node.type === "Identifier" || node.type === "ThisExpression") return true;
  return node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier" && node.object.type !== "Super" && plainReference(node.object);
}

function loopKeyOf(left: ESTree.ForInStatement["left"]): string | undefined {
  if (left.type === "Identifier") return left.name;
  if (left.type === "VariableDeclaration" && left.declarations.length === 1) {
    const id = left.declarations[0]?.id;
    return id?.type === "Identifier" ? id.name : undefined;
  }
  return undefined;
}

const isKeyIndex = (node: ESTree.Node, key: string): boolean =>
  node.type === "MemberExpression" && node.computed && node.property.type === "Identifier" && node.property.name === key;

/** Unguarded key-copy loops, in source order. */
export function findProtoPollutionSites(a: Analysis): PollutionSite[] {
  const sites: PollutionSite[] = [];
  walk(a.program, (n) => {
    if (n.type !== "ForInStatement") return;
    const key = loopKeyOf(n.left);
    if (key === undefined) return;
    let copies = false;
    let guarded = false;
    walk(n.body, (m) => {
      if (m.type === "Literal" && m.value === "__proto__") guarded = true;
      if (m.type === "AssignmentExpression" && m.operator === "=" && isKeyIndex(m.left, key)) {
        walk(m.right, (r) => {
          if (isKeyIndex(r, key)) copies = true;
        });
      }
    });
    if (!copies || guarded) return;
    const plain = plainReference(n.right);
    sites.push({
      loop: n,
      line: lineOf(n),
      key,
      sourceText: plain ? generate(n.right) : "(expression)",
      fixable: plain,
      ...(plain ? {} : { keptBecause: "the iterated object is not a plain reference, so it cannot be named twice without changing evaluation" }),
    });
  });
  return sites.sort((x, y) => x.line - y.line);
}

/**
 * `if (!Object.prototype.hasOwnProperty.call(src, k) || k === "__proto__" || k === "constructor" || k === "prototype") continue;`
 * built from fresh AST nodes (the printer needs no source positions).
 */
export function buildProtoGuard(sourceRef: ESTree.Expression, key: string): ESTree.IfStatement {
  const ident = (name: string): ESTree.Identifier => ({ type: "Identifier", name });
  const member = (object: ESTree.Expression, property: string): ESTree.MemberExpression => ({ type: "MemberExpression", object, property: ident(property), computed: false, optional: false });
  const own: ESTree.CallExpression = {
    type: "CallExpression",
    callee: member(member(member(ident("Object"), "prototype"), "hasOwnProperty"), "call"),
    arguments: [sourceRef, ident(key)],
    optional: false,
  };
  let test: ESTree.Expression = { type: "UnaryExpression", operator: "!", prefix: true, argument: own };
  for (const bad of POLLUTING_KEYS) {
    test = { type: "LogicalExpression", operator: "||", left: test, right: { type: "BinaryExpression", operator: "===", left: ident(key), right: { type: "Literal", value: bad, raw: JSON.stringify(bad) } } };
  }
  return { type: "IfStatement", test, consequent: { type: "ContinueStatement", label: null }, alternate: null };
}

export interface LooseEqualitySite {
  readonly line: number;
  readonly operator: "==" | "!=";
  readonly text: string;
}

/** Every `==` and `!=`, in source order. */
export function findLooseEqualitySites(program: ESTree.Program): LooseEqualitySite[] {
  const sites: LooseEqualitySite[] = [];
  walk(program, (n) => {
    if (n.type === "BinaryExpression" && (n.operator === "==" || n.operator === "!=")) {
      const text = generate(n).replace(/\s+/g, " ").trim();
      sites.push({ line: lineOf(n), operator: n.operator, text: text.length > 80 ? `${text.slice(0, 77)}...` : text });
    }
  });
  return sites.sort((x, y) => x.line - y.line);
}

const parseScript = (source: string): ESTree.Program | undefined => {
  try {
    return parse(source, { ecmaVersion: "latest", sourceType: "script", locations: true, allowReturnOutsideFunction: true, allowHashBang: true }) as unknown as ESTree.Program;
  } catch {
    return undefined;
  }
};

export interface SecurityScan {
  readonly parsed: boolean;
  readonly pollution: PollutionSite[];
  readonly looseEquality: LooseEqualitySite[];
}

/** Both analyses on source text. `parsed` is false when the text is not valid script syntax. */
export function scanSecurity(source: string): SecurityScan {
  const program = parseScript(source);
  if (program === undefined) return { parsed: false, pollution: [], looseEquality: [] };
  return { parsed: true, pollution: findProtoPollutionSites(analyze(program)), looseEquality: findLooseEqualitySites(program) };
}

// ---------------------------------------------------------------------------
// Dynamic exploit probe (sandbox)
// ---------------------------------------------------------------------------
/**
 * A probe program: sets the `json` inputs (the last one receives the exploit payload, the others a fresh `{}` the payload is merged into),
 * runs `code` with indirect eval in the probe's own global scope, and reports only booleans and a short error text.
 */
export function buildExploitProbe(code: string, jsonKeys: readonly string[]): string {
  return `(function () {
  var g = globalThis;
  var keys = ${JSON.stringify(jsonKeys)};
  for (var i = 0; i < keys.length; i++) {
    g[keys[i]] = i === keys.length - 1 ? JSON.parse(${JSON.stringify(EXPLOIT_PAYLOAD)}) : {};
  }
  var threw = null;
  try { (0, eval)(${JSON.stringify(code)}); } catch (e) { threw = (e && e.name ? e.name + ": " : "") + (e && e.message !== undefined ? String(e.message) : String(e)); }
  var polluted = ({}).polluted !== undefined;
  var leaked = polluted && ({}).polluted === true;
  try { delete Object.prototype.polluted; } catch (e2) { /* the context is thrown away after the probe */ }
  return { polluted: polluted, leaked: leaked, clean: ({}).polluted === undefined, threw: threw };
})()`;
}

export interface ExploitOutcome {
  readonly polluted: boolean;
  readonly threw: string | null;
}
function readOutcome(value: unknown): ExploitOutcome | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o["polluted"] !== "boolean") return undefined;
  if (o["threw"] !== null && typeof o["threw"] !== "string") return undefined;
  return { polluted: o["polluted"], threw: o["threw"] };
}

const NEUTRAL: Readonly<Record<ParamKind, unknown>> = { integer: 1, number: 1, string: "a", boolean: true, json: null };

export interface ProtoExploitProof {
  /** The exploit ran: the schema has at least one json input and the sandbox answered. */
  readonly attempted: boolean;
  /** `({}).polluted === undefined` after the resurrected code ran on the payload. */
  readonly blocked: boolean;
  /** `({}).polluted` became defined after the legacy code ran on the same payload (the specimen was exploitable). */
  readonly legacyExploitable: boolean;
  readonly detail: string;
}

/** Runs the payload through the legacy and the resurrected code. Resolves with undefined when the sandbox cannot answer. */
export async function probeProtoPollution(input: {
  readonly legacyCode: string;
  readonly modernCode: string;
  readonly schema: InputSchema;
  readonly executor: ProbeExecutor;
}): Promise<ProtoExploitProof | undefined> {
  const jsonKeys = Object.entries(input.schema).filter(([, kind]) => kind === "json").map(([name]) => name);
  if (jsonKeys.length === 0) return { attempted: false, blocked: false, legacyExploitable: false, detail: "no json input to carry the exploit payload" };
  const context = Object.fromEntries(Object.entries(input.schema).filter(([, kind]) => kind !== "json").map(([name, kind]) => [name, NEUTRAL[kind]]));
  try {
    const run = async (code: string): Promise<ExploitOutcome | undefined> => readOutcome((await input.executor.run({ code: buildExploitProbe(code, jsonKeys), context })).output);
    const legacy = await run(input.legacyCode);
    const modern = await run(input.modernCode);
    if (legacy === undefined || modern === undefined) return undefined;
    const blocked = !modern.polluted;
    return {
      attempted: true,
      blocked,
      legacyExploitable: legacy.polluted,
      detail: blocked
        ? `Proto-Pollution Blocked: JSON.parse('${EXPLOIT_PAYLOAD}') left ({}).polluted === undefined on the resurrected code${legacy.polluted ? " (the legacy code set it to true)" : ""}`
        : "Proto-Pollution NOT blocked: the exploit payload polluted Object.prototype on the resurrected code",
    };
  } catch {
    return undefined;
  }
}
