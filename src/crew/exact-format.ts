// Display helpers for exact (Object.is) outcomes. Positive zero is "+0" so it reads differently from "-0".
import type { ProbeOutcome } from "../fuzzer/types.js";
import { decodeTagged, describeValue } from "../sandbox/tagged.js";

/** One value, decoded from the tagged wire form. */
export function formatExactValue(wire: unknown, maxLength = 120): string {
  const value = decodeTagged(wire);
  if (typeof value === "number" && Object.is(value, 0)) return "+0";
  return describeValue(value, maxLength);
}

/** A probe outcome: its value, or `throws <code>` when it failed. */
export function formatOutcome(outcome: ProbeOutcome | undefined): string {
  if (outcome === undefined) return "unknown";
  if (!outcome.ok) return `throws ${outcome.errorCode ?? "ERROR"}${outcome.errorMessage ? ` (${outcome.errorMessage.slice(0, 120)})` : ""}`;
  return formatExactValue(outcome.output);
}

/** `n = -3, text = "ab"` for wire-form inputs. */
export function formatInputs(inputs: Record<string, unknown>): string {
  return Object.entries(inputs)
    .map(([k, v]) => `${k} = ${formatExactValue(v, 80)}`)
    .join(", ");
}
