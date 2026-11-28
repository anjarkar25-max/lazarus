// The fifth proof pillar: purity. Legacy ES5 code can leak an undeclared variable onto the global object, mutate the arrays and
// objects it was given, or touch built-in prototypes. Sloppy mode hides all three; strict ES2022 turns the first into a
// ReferenceError. This module finds the leaks (Acorn scope analysis, nothing is executed), decides which are safe to repair
// (used by the `global-leak-fix` Necromancer rule and the `LAZ008` audit rule), and proves in the sandbox that the resurrected code
// leaks nothing, leaves the prototypes alone and leaves every input in the same state as the legacy code does.
import { parse } from "acorn";
import * as fc from "fast-check";
import type * as ESTree from "estree";
import { buildRecordArbitrary } from "../fuzzer/differential.js";
import type { InputSchema } from "../fuzzer/types.js";
import type { ProbeExecutor } from "../sandbox/types.js";
import { analyze, lineOf, positionOf, type Analysis, type Reference } from "./ast-scope.js";
import { probeProtoPollution, scanSecurity } from "./security-exorcist.js";

// ---------------------------------------------------------------------------
// Static analysis
// ---------------------------------------------------------------------------
/** Names a snippet may assign on purpose (module wiring, the global object itself): never reported as leaks. */
const HOST_NAMES: ReadonlySet<string> = new Set(["module", "exports", "require", "window", "self", "global", "globalThis", "undefined", "NaN", "Infinity", "console", "process"]);

export interface LeakFix {
  /** The `name = expr;` statement that becomes `let name = expr;`. */
  readonly statement: ESTree.ExpressionStatement;
  readonly assignment: ESTree.AssignmentExpression;
  readonly target: ESTree.Identifier;
}
export interface LeakSite {
  readonly name: string;
  /** 1-based line of the first write. */
  readonly line: number;
  /** Number of write sites (`=`, `op=`, `++`). */
  readonly writes: number;
  /** Name of the function that leaks it, or "(anonymous)". */
  readonly functionName: string;
  /** Present when the leak can be repaired with a plain `let` declaration. */
  readonly fix?: LeakFix;
  /** Why the leak is reported but not repaired. */
  readonly keptBecause?: string;
}

const within = (inner: ESTree.Node, outer: ESTree.Node): boolean => {
  const a = positionOf(inner);
  const b = positionOf(outer);
  return a.start >= b.start && a.end <= b.end && b.start >= 0;
};

function functionNameOf(a: Analysis, node: ESTree.Node): string {
  if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression") && node.id) return node.id.name;
  const parent = a.parents.get(node);
  if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
  return "(anonymous)";
}

/**
 * Undeclared globals that functions assign, in source order. `inputs` are the schema names (context variables the sandbox
 * provides, not leaks). Programs that use the global object, `eval` or `with` report nothing: their globals are intentional or
 * unknowable.
 */
export function leakSites(a: Analysis, inputs: readonly string[] = []): LeakSite[] {
  if (a.hasEval || a.hasWith || a.usesGlobalObject) return [];
  const skip = new Set(inputs);
  const byName = new Map<string, Reference[]>();
  for (const r of a.references) {
    if (r.binding !== null) continue;
    byName.set(r.id.name, [...(byName.get(r.id.name) ?? []), r]);
  }
  const sites: LeakSite[] = [];
  for (const [name, refs] of byName) {
    if (HOST_NAMES.has(name) || skip.has(name)) continue;
    const writes = refs.filter((r) => r.write);
    const inFunctions = writes.filter((r) => r.scope.fn.kind === "function");
    // A script-level assignment is an intentional global; so is a name the program also assigns at the top level.
    if (inFunctions.length === 0 || writes.some((r) => r.scope.fn.kind === "program")) continue;
    const ordered = [...refs].sort((x, y) => positionOf(x.id).start - positionOf(y.id).start);
    const first = ordered[0];
    const firstWrite = inFunctions.sort((x, y) => positionOf(x.id).start - positionOf(y.id).start)[0];
    if (first === undefined || firstWrite === undefined) continue;
    const owner = firstWrite.scope.fn;
    const base = { name, line: lineOf(firstWrite.id), writes: writes.length, functionName: functionNameOf(a, owner.node) };
    if (!refs.every((r) => within(r.id, owner.node))) {
      sites.push({ ...base, keptBecause: "the name is also used outside the function that assigns it, so it may be shared global state" });
      continue;
    }
    const assignment = a.parents.get(first.id);
    const statement = assignment === undefined || assignment === null ? undefined : a.parents.get(assignment);
    const ownerNode = owner.node;
    const ownerBody = ownerNode.type === "FunctionDeclaration" || ownerNode.type === "FunctionExpression" || ownerNode.type === "ArrowFunctionExpression" ? ownerNode.body : undefined;
    const plain =
      first === firstWrite &&
      !first.read &&
      assignment?.type === "AssignmentExpression" &&
      assignment.operator === "=" &&
      assignment.left === first.id &&
      statement?.type === "ExpressionStatement" &&
      ownerBody?.type === "BlockStatement" &&
      a.parents.get(statement) === ownerBody;
    if (!plain || assignment?.type !== "AssignmentExpression" || statement?.type !== "ExpressionStatement") {
      sites.push({ ...base, keptBecause: "its first use is not a plain `name = value;` statement at the top of the function body" });
      continue;
    }
    if (refs.some((r) => r !== first && within(r.id, assignment.right))) {
      sites.push({ ...base, keptBecause: "the assigned value reads the name itself" });
      continue;
    }
    sites.push({ ...base, fix: { statement, assignment, target: first.id } });
  }
  return sites.sort((x, y) => x.line - y.line || x.name.localeCompare(y.name));
}

export interface LeakScan {
  readonly parsed: boolean;
  readonly leaks: LeakSite[];
}
const parseScript = (source: string): ESTree.Program | undefined => {
  try {
    return parse(source, { ecmaVersion: "latest", sourceType: "script", locations: true, allowReturnOutsideFunction: true, allowHashBang: true }) as unknown as ESTree.Program;
  } catch {
    return undefined;
  }
};
/** Leaks in a parsed program (the audit reuses the AST it already has). */
export function detectGlobalLeaksInProgram(program: ESTree.Program, inputs: readonly string[] = []): LeakSite[] {
  return leakSites(analyze(program), inputs);
}
/** Leaks in source text. `parsed` is false when the text is not valid script syntax. */
export function detectGlobalLeaks(source: string, options: { readonly inputs?: readonly string[] } = {}): LeakScan {
  const program = parseScript(source);
  if (program === undefined) return { parsed: false, leaks: [] };
  return { parsed: true, leaks: detectGlobalLeaksInProgram(program, options.inputs ?? []) };
}

// ---------------------------------------------------------------------------
// Dynamic proof, run in the sandbox
// ---------------------------------------------------------------------------
export interface PurityProof {
  /** Undeclared identifiers the legacy code assigns (AST), plus any new global the legacy run actually created. */
  readonly globalLeaksDetected: string[];
  /** The resurrected code runs under "use strict" with no ReferenceError for a leaked name, adds no global, and has no leak of its own. */
  readonly globalLeaksEliminated: boolean;
  /** Object.prototype, Array.prototype, Function.prototype and String.prototype keys are the same after both runs. */
  readonly prototypeSafe: boolean;
  /** Every input has the same deep (Object.is) state after the legacy call and after the resurrected call. */
  readonly inputMutationParity: boolean;
  /** Information: the legacy code changed at least one of its inputs. */
  readonly legacyMutatesInput: boolean;
  /** New globals the legacy run created at runtime (declared top-level names excluded). */
  readonly legacyLeakedGlobals: string[];
  /** Sandboxed samples behind the proof. */
  readonly samples: number;
  /** V19: the live exploit probe `JSON.parse('{"__proto__":{"polluted":true}}')` left `({}).polluted === undefined` on the resurrected code. Absent when the legacy code has no unguarded key-copy loop. */
  readonly protoPollutionBlocked?: boolean;
  /** All pillars hold. */
  readonly proven: boolean;
  /** One short line per finding, for the Studio and the report. */
  readonly details: string[];
}

const SERIALIZER = `function ser(v, depth, seen) {
    var t = typeof v;
    if (t === "number") return Object.is(v, -0) ? "n:-0" : "n:" + String(v);
    if (t === "string") return "s:" + JSON.stringify(v);
    if (t === "boolean") return "b:" + v;
    if (t === "undefined") return "u";
    if (t === "bigint") return "i:" + String(v);
    if (t === "symbol") return "y";
    if (t === "function") return "f";
    if (v === null) return "null";
    if (depth > 12) return "~deep";
    if (seen.indexOf(v) >= 0) return "~cycle";
    seen.push(v);
    var out;
    if (Array.isArray(v)) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(ser(v[i], depth + 1, seen));
      out = "[" + a.join(",") + "]";
    } else {
      var ks = Object.keys(v), parts = [];
      for (var j = 0; j < ks.length; j++) parts.push(JSON.stringify(ks[j]) + ":" + ser(v[ks[j]], depth + 1, seen));
      out = "{" + parts.join(",") + "}";
    }
    seen.pop();
    return out;
  }`;

/** A probe program: runs `code` with indirect eval in the probe's own global scope and reports only strings and booleans. */
export function buildPurityProbe(code: string, inputKeys: readonly string[], strict: boolean): string {
  const source = `${strict ? '"use strict";\n' : ""}${code}`;
  return `(function () {
  var g = globalThis;
  ${SERIALIZER}
  var keys = ${JSON.stringify(inputKeys)};
  var names0 = Object.getOwnPropertyNames(g);
  function protoSig() {
    var enumerable = [];
    for (var k in {}) enumerable.push(k);
    for (var m in []) enumerable.push("[]." + m);
    return [Object.getOwnPropertyNames(Object.prototype).sort().join("|"), Object.getOwnPropertyNames(Array.prototype).sort().join("|"), Object.getOwnPropertyNames(Function.prototype).sort().join("|"), Object.getOwnPropertyNames(String.prototype).sort().join("|"), enumerable.join("|")].join("#");
  }
  var p0 = protoSig();
  var before = keys.map(function (k) { return ser(g[k], 0, []); });
  var threw = null;
  try { (0, eval)(${JSON.stringify(source)}); } catch (e) { threw = (e && e.name ? e.name + ": " : "") + (e && e.message !== undefined ? String(e.message) : String(e)); }
  var after = keys.map(function (k) { return ser(g[k], 0, []); });
  var added = Object.getOwnPropertyNames(g).filter(function (n) { return names0.indexOf(n) < 0; });
  return { before: before, after: after, added: added, threw: threw, protoSafe: protoSig() === p0 };
})()`;
}

interface Observation {
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly added: readonly string[];
  readonly threw: string | null;
  readonly protoSafe: boolean;
}
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
function readObservation(v: unknown): Observation | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (!isStrings(o["before"]) || !isStrings(o["after"]) || !isStrings(o["added"]) || typeof o["protoSafe"] !== "boolean") return undefined;
  if (o["threw"] !== null && typeof o["threw"] !== "string") return undefined;
  return { before: o["before"], after: o["after"], added: o["added"], threw: o["threw"], protoSafe: o["protoSafe"] };
}

/** Names the program declares at its top level (they become globals in a sloppy eval but are not leaks). */
function topLevelNames(source: string): Set<string> {
  const program = parseScript(source);
  return program === undefined ? new Set() : new Set(analyze(program).scopes[0]?.bindings.keys() ?? []);
}

export interface PurityAuditInput {
  readonly legacyCode: string;
  readonly modernCode: string;
  readonly schema: InputSchema;
  readonly executor: ProbeExecutor;
  readonly seed?: number;
  readonly samples?: number;
}

export const DEFAULT_PURITY_SAMPLES = 6;

/**
 * Runs the legacy and the resurrected code on fuzzed inputs in the sandbox and builds the proof. Resolves with undefined when the
 * sandbox cannot answer (a timeout, a crashed worker): the Studio then reports the pillar as not measured, never as passed.
 */
export async function auditPurity(input: PurityAuditInput): Promise<PurityProof | undefined> {
  const keys = Object.keys(input.schema);
  const count = input.samples ?? DEFAULT_PURITY_SAMPLES;
  const inputs = fc.sample(buildRecordArbitrary(input.schema), { numRuns: count, ...(input.seed !== undefined ? { seed: input.seed } : {}) });
  const encoding = input.executor.supportsTaggedEncoding === true ? ({ encoding: "tagged" } as const) : {};
  const legacyProbe = buildPurityProbe(input.legacyCode, keys, false);
  const modernSloppy = buildPurityProbe(input.modernCode, keys, false);
  const modernStrict = buildPurityProbe(input.modernCode, keys, true);
  const legacyScan = detectGlobalLeaks(input.legacyCode, { inputs: keys });
  const modernScan = detectGlobalLeaks(input.modernCode, { inputs: keys });
  const legacyDeclared = topLevelNames(input.legacyCode);
  const modernDeclared = topLevelNames(input.modernCode);
  const leakNames = legacyScan.leaks.map((l) => l.name);

  const legacyLeaked = new Set<string>();
  let protoSafe = true;
  let mutationParity = true;
  let legacyMutates = false;
  let eliminated = modernScan.leaks.length === 0;
  const details: string[] = [];
  const strictNotes = new Set<string>();
  try {
    for (const context of inputs) {
      const run = async (code: string): Promise<Observation | undefined> => readObservation((await input.executor.run({ code, context, ...encoding })).output);
      const legacy = await run(legacyProbe);
      const sloppy = await run(modernSloppy);
      const strict = await run(modernStrict);
      if (legacy === undefined || sloppy === undefined || strict === undefined) return undefined;
      for (const name of legacy.added) if (!legacyDeclared.has(name)) legacyLeaked.add(name);
      protoSafe = protoSafe && legacy.protoSafe && sloppy.protoSafe && strict.protoSafe;
      if (legacy.after.join("\u0000") !== sloppy.after.join("\u0000")) mutationParity = false;
      if (legacy.before.join("\u0000") !== legacy.after.join("\u0000")) legacyMutates = true;
      const modernAdded = sloppy.added.filter((n) => !modernDeclared.has(n));
      if (modernAdded.length > 0) eliminated = false;
      if (strict.threw !== null) {
        const referenceError = /^ReferenceError: ([^ ]+) is not defined/.exec(strict.threw);
        if (referenceError !== null && (leakNames.includes(referenceError[1] ?? "") || legacyLeaked.has(referenceError[1] ?? ""))) eliminated = false;
        else if (referenceError === null) strictNotes.add(strict.threw);
      }
    }
  } catch {
    return undefined;
  }
  const detected = [...new Set([...leakNames, ...legacyLeaked])].sort();
  if (detected.length > 0) details.push(`legacy leaks ${detected.join(", ")} onto the global object`);
  else details.push("the legacy code leaks no global");
  details.push(eliminated ? (detected.length > 0 ? "the resurrected code runs under \"use strict\" with every leak declared" : "the resurrected code adds no global") : "the resurrected code still leaks or fails under \"use strict\"");
  details.push(legacyMutates ? (mutationParity ? "the legacy code mutates its input, and the resurrected code leaves it in the identical state" : "the resurrected code leaves its inputs in a different state than the legacy code") : mutationParity ? "neither version changes its inputs" : "the inputs differ after the calls");
  details.push(protoSafe ? "Object.prototype, Array.prototype, Function.prototype and String.prototype are untouched" : "a built-in prototype changed during a run");
  for (const note of strictNotes) details.push(`strict-mode run threw: ${note}`.slice(0, 160));
  // V19: only specimens with an unguarded key-copy loop are exploit-probed.
  let exploit: Awaited<ReturnType<typeof probeProtoPollution>>;
  if (scanSecurity(input.legacyCode).pollution.length > 0) {
    exploit = await probeProtoPollution({ legacyCode: input.legacyCode, modernCode: input.modernCode, schema: input.schema, executor: input.executor });
    if (exploit === undefined) return undefined;
    if (exploit.attempted) details.push(exploit.detail);
  }
  const protoOk = exploit === undefined || !exploit.attempted || exploit.blocked;
  return {
    globalLeaksDetected: detected,
    globalLeaksEliminated: eliminated,
    prototypeSafe: protoSafe,
    inputMutationParity: mutationParity,
    legacyMutatesInput: legacyMutates,
    legacyLeakedGlobals: [...legacyLeaked].sort(),
    samples: inputs.length,
    ...(exploit !== undefined && exploit.attempted ? { protoPollutionBlocked: exploit.blocked } : {}),
    proven: eliminated && protoSafe && mutationParity && protoOk,
    details,
  };
}
