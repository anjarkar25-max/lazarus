// Tagged values: JSON cannot represent -0, NaN, Infinity or undefined, but Object.is can tell them apart.
// A probe run with `encoding: "tagged"` exchanges these values as `{"$lazarus": "<kind>"}` markers,
// so the browser, the JSON-RPC layer and the vm all see exactly the same value.

export const TAG_KEY = "$lazarus";

const KINDS = ["NaN", "Infinity", "-Infinity", "-0", "undefined"] as const;
export type TaggedKind = (typeof KINDS)[number];

export interface Tagged {
  readonly "$lazarus": TaggedKind;
}

export function tag(kind: TaggedKind): Tagged {
  return { "$lazarus": kind };
}

export function isTagged(value: unknown): value is Tagged {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const kind = (value as Record<string, unknown>)[TAG_KEY];
  return keys.length === 1 && keys[0] === TAG_KEY && typeof kind === "string" && (KINDS as readonly string[]).includes(kind);
}

/** Markers back to real values (deep). Safe for `__proto__` keys: copies use own data properties. */
export function decodeTagged(value: unknown): unknown {
  if (isTagged(value)) {
    switch (value.$lazarus) {
      case "NaN":
        return Number.NaN;
      case "Infinity":
        return Number.POSITIVE_INFINITY;
      case "-Infinity":
        return Number.NEGATIVE_INFINITY;
      case "-0":
        return -0;
      case "undefined":
        return undefined;
    }
  }
  if (Array.isArray(value)) return value.map(decodeTagged);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeTagged(v)]));
  }
  return value;
}

/** Real values to markers (deep): the inverse of decodeTagged for everything JSON cannot carry. */
export function encodeTagged(value: unknown): unknown {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return tag("NaN");
    if (value === Number.POSITIVE_INFINITY) return tag("Infinity");
    if (value === Number.NEGATIVE_INFINITY) return tag("-Infinity");
    if (Object.is(value, -0)) return tag("-0");
    return value;
  }
  if (value === undefined) return tag("undefined");
  if (Array.isArray(value)) return value.map(encodeTagged);
  if (typeof value === "object" && value !== null && !isTagged(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeTagged(v)]));
  }
  return value;
}

/** Display form that keeps the distinctions Object.is cares about (`-0`, `NaN`, `undefined`). */
export function describeValue(value: unknown, maxLength = 400): string {
  const render = (v: unknown): string => {
    if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
    if (v === undefined) return "undefined";
    if (typeof v === "string") return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(render).join(", ")}]`;
    if (typeof v === "object" && v !== null) {
      const entries = Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${render(x)}`);
      return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
    }
    return String(v);
  };
  const text = render(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}
