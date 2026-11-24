// Fuzz-Driven TypeScript Type Alchemist.
//
// Infers TypeScript signatures from what the Exorcist actually observed: the (decoded, exact) inputs and legacy outputs
// of every fuzz run. Types are a structured value (never free text), so they can be validated when a client sends one
// back and rendered safely into resurrected.ts / types.d.ts. Observed types describe the fuzzed domain only, and the
// notes say so.
import { z } from "zod";
import type { InputSchema, ParamKind } from "../fuzzer/types.js";
import { decodeTagged } from "../sandbox/tagged.js";

export type TsType =
  | { readonly kind: "number" }
  | { readonly kind: "string" }
  | { readonly kind: "boolean" }
  | { readonly kind: "null" }
  | { readonly kind: "undefined" }
  | { readonly kind: "unknown" }
  | { readonly kind: "array"; readonly element: TsType }
  | { readonly kind: "object"; readonly fields: ReadonlyArray<{ readonly name: string; readonly type: TsType; readonly optional: boolean }> }
  | { readonly kind: "union"; readonly members: readonly TsType[] };

export interface TypeSignature {
  readonly params: ReadonlyArray<{ readonly name: string; readonly type: TsType; readonly fuzzedAs: ParamKind }>;
  readonly returns: TsType;
  /** e.g. "integer in [-1073741824, 1073741823]", "never returns NaN". */
  readonly returnNotes: string[];
  /** Number of observations the signature is based on. */
  readonly samples: number;
  /** Runs where the legacy code threw (the return type covers the others). */
  readonly throws: number;
}

export interface Observation {
  /** Wire (tagged) or plain inputs. */
  readonly inputs: Record<string, unknown>;
  readonly ok: boolean;
  /** Wire (tagged) or plain output. */
  readonly output?: unknown;
}

const MAX_DEPTH = 4;
const MAX_FIELDS = 16;
const MAX_UNION = 4;

// ---------------------------------------------------------------------------
// Value -> type, merging
// ---------------------------------------------------------------------------
const key = (t: TsType): string => renderType(t);

function typeOfValue(value: unknown, depth = 0): TsType {
  if (value === null) return { kind: "null" };
  if (value === undefined) return { kind: "undefined" };
  switch (typeof value) {
    case "number":
      return { kind: "number" };
    case "string":
      return { kind: "string" };
    case "boolean":
      return { kind: "boolean" };
    default:
  }
  if (depth >= MAX_DEPTH) return { kind: "unknown" };
  if (Array.isArray(value)) {
    const element = value.reduce<TsType | undefined>((acc, item) => mergeTypes(acc, typeOfValue(item, depth + 1)), undefined);
    return { kind: "array", element: element ?? { kind: "unknown" } };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_FIELDS) return { kind: "unknown" };
    return { kind: "object", fields: entries.map(([name, v]) => ({ name, type: typeOfValue(v, depth + 1), optional: false })) };
  }
  return { kind: "unknown" };
}

function membersOf(t: TsType): TsType[] {
  return t.kind === "union" ? [...t.members] : [t];
}

/** Least upper bound of two observed types (arrays merge elements, objects merge fields, otherwise a union). */
export function mergeTypes(a: TsType | undefined, b: TsType): TsType {
  if (a === undefined) return b;
  if (a.kind === "unknown" || b.kind === "unknown") return { kind: "unknown" };
  const members = membersOf(a);
  for (const incoming of membersOf(b)) {
    const sameKind = members.findIndex((m) => m.kind === incoming.kind && (m.kind === "array" || m.kind === "object"));
    if (sameKind >= 0) {
      const existing = members[sameKind];
      if (existing?.kind === "array" && incoming.kind === "array") {
        const element = existing.element.kind === "unknown" && incoming.element.kind !== "unknown" ? incoming.element : incoming.element.kind === "unknown" ? existing.element : mergeTypes(existing.element, incoming.element);
        members[sameKind] = { kind: "array", element };
      } else if (existing?.kind === "object" && incoming.kind === "object") {
        members[sameKind] = mergeObjects(existing, incoming);
      }
      continue;
    }
    if (!members.some((m) => key(m) === key(incoming))) members.push(incoming);
  }
  if (members.length === 1 && members[0] !== undefined) return members[0];
  return members.filter((m) => m.kind !== "null" && m.kind !== "undefined").length > MAX_UNION ? { kind: "unknown" } : { kind: "union", members: sortMembers(members) };
}

function mergeObjects(a: Extract<TsType, { kind: "object" }>, b: Extract<TsType, { kind: "object" }>): TsType {
  const names = [...new Set([...a.fields.map((f) => f.name), ...b.fields.map((f) => f.name)])];
  if (names.length > MAX_FIELDS) return { kind: "unknown" };
  return {
    kind: "object",
    fields: names.map((name) => {
      const x = a.fields.find((f) => f.name === name);
      const y = b.fields.find((f) => f.name === name);
      if (x !== undefined && y !== undefined) return { name, type: mergeTypes(x.type, y.type), optional: x.optional || y.optional };
      const only = x ?? y;
      return { name, type: only?.type ?? { kind: "unknown" }, optional: true };
    }),
  };
}

const ORDER = ["number", "string", "boolean", "object", "array", "unknown", "null", "undefined"];
function sortMembers(members: TsType[]): TsType[] {
  return [...members].sort((x, y) => ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind) || key(x).localeCompare(key(y)));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const IDENT = /^[A-Za-z_$][\w$]*$/;

export function renderType(t: TsType): string {
  switch (t.kind) {
    case "number":
    case "string":
    case "boolean":
    case "null":
    case "undefined":
    case "unknown":
      return t.kind;
    case "array": {
      const inner = renderType(t.element);
      return t.element.kind === "union" ? `(${inner})[]` : `${inner}[]`;
    }
    case "object":
      return t.fields.length === 0
        ? "Record<string, never>"
        : `{ ${t.fields.map((f) => `${IDENT.test(f.name) ? f.name : JSON.stringify(f.name)}${f.optional ? "?" : ""}: ${renderType(f.type)}`).join("; ")} }`;
    case "union":
      return t.members.map(renderType).join(" | ");
  }
}

const PARAM_FROM_KIND: Record<Exclude<ParamKind, "json">, TsType> = {
  integer: { kind: "number" },
  number: { kind: "number" },
  string: { kind: "string" },
  boolean: { kind: "boolean" },
};

/** Notes about the numbers/strings a function returned (always over the observed runs). */
function returnNotesFor(values: readonly unknown[]): string[] {
  const numbers = values.filter((v): v is number => typeof v === "number");
  const notes: string[] = [];
  if (numbers.length > 0) {
    const finite = numbers.filter((n) => Number.isFinite(n));
    const allIntegers = finite.length === numbers.length && finite.every((n) => Number.isInteger(n));
    if (finite.length > 0) {
      const min = Math.min(...finite);
      const max = Math.max(...finite);
      const show = (n: number): string => (Object.is(n, -0) ? "0" : String(n));
      notes.push(`${allIntegers ? "integer" : "number"} in [${show(min)}, ${show(max)}]`);
      if (allIntegers && min >= -2147483648 && max <= 2147483647) notes.push("fits in a signed 32-bit integer");
    }
    notes.push(numbers.some((n) => Number.isNaN(n)) ? "may return NaN" : "never returns NaN");
    if (numbers.some((n) => !Number.isFinite(n) && !Number.isNaN(n))) notes.push("may return Infinity");
    if (numbers.some((n) => Object.is(n, -0))) notes.push("may return -0");
  }
  const strings = values.filter((v): v is string => typeof v === "string");
  if (strings.length > 0) {
    const lengths = strings.map((s) => s.length);
    notes.push(`string length in [${Math.min(...lengths)}, ${Math.max(...lengths)}]`);
  }
  return notes;
}

/** Signature from fuzz observations. `schema` supplies parameter order and the fuzzed kinds. */
export interface InferOptions {
  /**
   * "schema" (default): parameters get the type of their fuzz kind (observed types only for `json`).
   * "observed": parameters get the union of the values they were actually called with (multi-file graphs, where a
   * module is called by its dependents with values the per-file fuzz schema never produced).
   */
  readonly paramsFrom?: "schema" | "observed";
}

export function inferSignature(observations: readonly Observation[], schema: InputSchema, options: InferOptions = {}): TypeSignature {
  const decoded = observations.map((o) => ({ inputs: decodeTagged(o.inputs) as Record<string, unknown>, ok: o.ok, output: o.ok ? decodeTagged(o.output) : undefined }));
  const params = Object.entries(schema).map(([name, fuzzedAs]) => {
    if (options.paramsFrom === "observed") {
      const seen = decoded.filter((o) => Object.prototype.hasOwnProperty.call(o.inputs, name));
      const observed = seen.reduce<TsType | undefined>((acc, o) => mergeTypes(acc, typeOfValue(o.inputs[name])), undefined);
      if (observed !== undefined) return { name, type: observed, fuzzedAs };
    }
    if (fuzzedAs !== "json") return { name, type: PARAM_FROM_KIND[fuzzedAs], fuzzedAs };
    const observed = decoded.reduce<TsType | undefined>((acc, o) => mergeTypes(acc, typeOfValue(o.inputs[name])), undefined);
    return { name, type: observed ?? { kind: "unknown" }, fuzzedAs };
  });
  const succeeded = decoded.filter((o) => o.ok);
  const returns = succeeded.reduce<TsType | undefined>((acc, o) => mergeTypes(acc, typeOfValue(o.output)), undefined) ?? { kind: "unknown" };
  return {
    params,
    returns,
    returnNotes: returnNotesFor(succeeded.map((o) => o.output)),
    samples: decoded.length,
    throws: decoded.length - succeeded.length,
  };
}

/** The same signature with the return type widened to `unknown` (used when tsc rejects the observed return type). */
export function widenReturn(sig: TypeSignature): TypeSignature {
  return { ...sig, returns: { kind: "unknown" } };
}
/** `(n: number) => number`, for the UI pill. */
export function renderSignature(sig: TypeSignature, name: string): string {
  return `${name}(${sig.params.map((p) => `${p.name}: ${renderType(p.type)}`).join(", ")}): ${renderType(sig.returns)}`;
}

/** Text that is safe inside a JSDoc block comment (no comment terminator, one line). */
const docSafe = (text: string): string => text.replace(/\*\//g, "* /").replace(/[\r\n]+/g, " ").slice(0, 200);

export function renderJsDoc(sig: TypeSignature, header: readonly string[] = []): string {
  const lines = [...header.map((h) => ` * ${docSafe(h)}`)];
  if (header.length > 0) lines.push(" *");
  for (const p of sig.params) {
    const fromKind = p.fuzzedAs === "json" ? undefined : renderType(PARAM_FROM_KIND[p.fuzzedAs]);
    const observed = renderType(p.type);
    lines.push(` * @param ${p.name} ${docSafe(fromKind === observed ? `fuzzed as ${p.fuzzedAs}` : `observed as ${observed} (fuzzed as ${p.fuzzedAs})`)}`);
  }
  const notes = [...sig.returnNotes, ...(sig.throws > 0 ? [`throws for ${sig.throws} of ${sig.samples} observed inputs`] : [])];
  lines.push(` * @returns ${docSafe(notes.length > 0 ? notes.join("; ") : renderType(sig.returns))}`);
  lines.push(` * @remarks ${docSafe(`Types inferred by the Lazarus Type Alchemist from ${sig.samples} exact fuzz observations (fuzzed domain only).`)}`);
  return ["/**", ...lines, " */"].join("\n");
}

/** `types.d.ts` content for one exported function. */
export function renderDeclaration(sig: TypeSignature, name: string): string {
  return [
    "// Generated by the Lazarus Type Alchemist from observed fuzz inputs and outputs.",
    renderJsDoc(sig),
    `export declare function ${name}(${sig.params.map((p) => `${p.name}: ${renderType(p.type)}`).join(", ")}): ${renderType(sig.returns)};`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Validation of client-sent signatures (export-bundle)
// ---------------------------------------------------------------------------
const TsTypeSchema: z.ZodType<TsType> = z.lazy(() =>
  z.union([
    z.object({ kind: z.enum(["number", "string", "boolean", "null", "undefined", "unknown"]) }).strict(),
    z.object({ kind: z.literal("array"), element: TsTypeSchema }).strict(),
    z
      .object({
        kind: z.literal("object"),
        fields: z.array(z.object({ name: z.string().max(100), type: TsTypeSchema, optional: z.boolean() }).strict()).max(MAX_FIELDS),
      })
      .strict(),
    z.object({ kind: z.literal("union"), members: z.array(TsTypeSchema).min(2).max(MAX_UNION + 2) }).strict(),
  ])
) as z.ZodType<TsType>;

export const TypeSignatureSchema = z
  .object({
    params: z.array(z.object({ name: z.string().regex(IDENT), type: TsTypeSchema, fuzzedAs: z.enum(["integer", "number", "string", "boolean", "json"]) }).strict()).max(32),
    returns: TsTypeSchema,
    returnNotes: z.array(z.string().max(120)).max(8),
    samples: z.number().int().min(0),
    throws: z.number().int().min(0),
  })
  .strict();

function depthOf(t: TsType): number {
  switch (t.kind) {
    case "array":
      return 1 + depthOf(t.element);
    case "object":
      return 1 + Math.max(0, ...t.fields.map((f) => depthOf(f.type)));
    case "union":
      return Math.max(...t.members.map(depthOf));
    default:
      return 0;
  }
}

/** A client-sent signature, or undefined if it is malformed or deeper than the alchemist ever produces. */
export function parseSignature(value: unknown): TypeSignature | undefined {
  const checked = TypeSignatureSchema.safeParse(value);
  if (!checked.success) return undefined;
  const sig = checked.data as TypeSignature;
  const types = [sig.returns, ...sig.params.map((p) => p.type)];
  return types.every((t) => depthOf(t) <= MAX_DEPTH + 1) ? sig : undefined;
}
