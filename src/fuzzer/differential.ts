import * as fc from "fast-check";
import { SandboxError } from "../sandbox/errors.js";
import { ProbeRunner } from "../sandbox/runner.js";
import type {
  CounterexampleReport,
  FuzzOptions,
  FuzzReport,
  FuzzTrace,
  InputSchema,
  ParamKind,
  ProbeOutcome,
} from "./types.js";

function arbitraryForKind(kind: ParamKind): fc.Arbitrary<unknown> {
  switch (kind) {
    case "integer":
      return fc.integer({ min: -1_000_000, max: 1_000_000 });
    case "number":
      return fc.oneof(
        fc.constant(-0),
        fc.constant(0),
        fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true })
      );
    case "string":
      return fc.string({ minLength: 0, maxLength: 64 });
    case "boolean":
      return fc.boolean();
    case "json":
      return fc.jsonValue();
  }
}

export function buildRecordArbitrary(schema: InputSchema): fc.Arbitrary<Record<string, unknown>> {
  const shape: Record<string, fc.Arbitrary<unknown>> = {};
  for (const [key, kind] of Object.entries(schema)) {
    shape[key] = arbitraryForKind(kind);
  }
  return fc.record(shape);
}

export function areOutputsEquivalent(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== typeof b || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, idx) => areOutputsEquivalent(item, b[idx]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const recA = a as Record<string, unknown>;
    const recB = b as Record<string, unknown>;
    const keysA = Object.keys(recA);
    const keysB = Object.keys(recB);
    if (keysA.length !== keysB.length) {
      return false;
    }
    return keysA.every(
      (k) => Object.prototype.hasOwnProperty.call(recB, k) && areOutputsEquivalent(recA[k], recB[k])
    );
  }
  return false;
}

function compareOutcomes(legacy: ProbeOutcome, modern: ProbeOutcome): { matched: boolean; reason: string } {
  if (legacy.ok && modern.ok) {
    if (areOutputsEquivalent(legacy.output, modern.output)) {
      return { matched: true, reason: "Outputs match" };
    }
    return {
      matched: false,
      reason: `Output mismatch: legacy=${formatValue(legacy.output)} vs modern=${formatValue(modern.output)}`,
    };
  }
  if (!legacy.ok && !modern.ok) {
    return { matched: true, reason: "Both implementations rejected input" };
  }
  if (legacy.ok && !modern.ok) {
    return {
      matched: false,
      reason: `Modern threw ${modern.errorCode ?? "ERROR"} (${modern.errorMessage ?? "unknown"}) while legacy returned ${formatValue(legacy.output)}`,
    };
  }
  return {
    matched: false,
    reason: `Legacy threw ${legacy.errorCode ?? "ERROR"} (${legacy.errorMessage ?? "unknown"}) while modern returned ${formatValue(modern.output)}`,
  };
}

function formatValue(val: unknown): string {
  if (typeof val === "number" && Object.is(val, -0)) {
    return "-0";
  }
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

export class DifferentialFuzzer {
  private readonly runner: ProbeRunner;

  constructor(runner: ProbeRunner = new ProbeRunner()) {
    this.runner = runner;
  }

  private async runSingle(code: string, context: Record<string, unknown>): Promise<ProbeOutcome> {
    const start = Date.now();
    try {
      const res = await this.runner.run({ code, context });
      return {
        ok: true,
        output: res.output,
        durationMs: res.durationMs,
      };
    } catch (err: unknown) {
      const errorCode = err instanceof SandboxError ? err.code : "INTERNAL_ERROR";
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        errorCode,
        errorMessage,
        durationMs: Date.now() - start,
      };
    }
  }

  async fuzz(
    legacyCode: string,
    modernCode: string,
    schema: InputSchema,
    options: FuzzOptions = {}
  ): Promise<FuzzReport> {
    const startedAt = Date.now();
    const numRuns = options.numRuns ?? 25;
    const maxTraces = options.maxTraces ?? 15;
    const traces: FuzzTrace[] = [];
    const failuresByKey = new Map<string, CounterexampleReport>();

    const recordArb = buildRecordArbitrary(schema);

    const property = fc.asyncProperty(recordArb, async (inputs) => {
      const [legacy, modern] = await Promise.all([
        this.runSingle(legacyCode, inputs),
        this.runSingle(modernCode, inputs),
      ]);

      const { matched, reason } = compareOutcomes(legacy, modern);

      if (traces.length < maxTraces) {
        traces.push({ inputs, legacy, modern, matched });
      }

      if (!matched) {
        const key = JSON.stringify(inputs);
        failuresByKey.set(key, { inputs, legacy, modern, reason });
      }

      return matched;
    });

    const details = await fc.check(property, {
      numRuns,
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
    });

    const durationMs = Date.now() - startedAt;

    if (!details.failed) {
      return {
        passed: true,
        totalRuns: details.numRuns,
        durationMs,
        seed: details.seed,
        traces,
      };
    }

    const shrunkInputs = details.counterexample?.[0] ?? {};
    const shrunkKey = JSON.stringify(shrunkInputs);
    const fallbackFailure = Array.from(failuresByKey.values()).at(-1);
    const counterexample: CounterexampleReport = failuresByKey.get(shrunkKey) ??
      fallbackFailure ?? {
        inputs: shrunkInputs,
        legacy: { ok: false, durationMs: 0 },
        modern: { ok: false, durationMs: 0 },
        reason: "Behavioral divergence detected",
      };

    return {
      passed: false,
      totalRuns: details.numRuns,
      durationMs,
      seed: details.seed,
      traces,
      counterexample,
    };
  }
}
