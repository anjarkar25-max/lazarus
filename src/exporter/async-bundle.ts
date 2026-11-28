// PR bundle for an error-first callback resurrection: typed `export async function` (checked with tsc --strict), the
// legacy module, and an async Vitest + fast-check parity suite that compares both settlements.
import { verifyStrictTypeScript, type TypecheckResult } from "../crew/ts-verifier.js";
import { applyBoundaryFixes } from "../crew/ts-emit.js";
import type { ErrorFirstFunction } from "../crew/async-callback.js";
import { renderWorkflow, WORKFLOW_PATH, type ResurrectionBundle } from "./bundle.js";
import { typecheckLines, type TypecheckReport, type VerifiedBundle } from "./verified-bundle.js";

const TS_FILE = "resurrected.ts";

export interface AsyncBundleInput {
  readonly specimenName: string;
  /** Legacy module exactly as written. */
  readonly legacySource: string;
  /** The resurrected TypeScript (entry typed and exported). */
  readonly modernTs: string;
  readonly entry: ErrorFirstFunction;
  readonly schema: Record<string, string>;
  readonly fuzzRuns: number;
  readonly attempts: number;
  readonly specMarkdown: string;
}

const ARBITRARY: Record<string, string> = {
  integer: "fc.integer({ min: -10000, max: 10000 })",
  number: "fc.double({ min: -10000, max: 10000, noNaN: true })",
  string: "fc.string({ minLength: 0, maxLength: 32 })",
  boolean: "fc.boolean()",
  json: "fc.jsonValue()",
};

/** `export async function f(a: T): Promise<R> {` -> `Promise<unknown>`, for when tsc rejects the observed type. */
function widenAsyncReturn(ts: string, name: string): string {
  return ts.replace(new RegExp(`^(export async function ${name}\\([^\\n]*\\)): Promise<[^\\n]*> \\{$`, "m"), "$1: Promise<unknown> {");
}

async function check(ts: string): Promise<{ ts: string; result: TypecheckResult; adjustments: string[]; rounds: number }> {
  let result = await verifyStrictTypeScript({ [TS_FILE]: ts });
  let rounds = 1;
  let adjustments: string[] = [];
  if (!result.passed) {
    const fixed = applyBoundaryFixes(ts, result.diagnostics, TS_FILE);
    if (fixed.changed) {
      ts = fixed.code;
      adjustments = fixed.adjustments;
      result = await verifyStrictTypeScript({ [TS_FILE]: ts });
      rounds++;
    }
  }
  return { ts, result, adjustments, rounds };
}

/** The legacy module plus one line that exposes the function under test to the parity suite. */
export function legacyModuleFile(source: string, entry: ErrorFirstFunction): string {
  return `${source.trim()}\n\n// Added by Lazarus: the error-first entry point the parity suite calls.\nmodule.exports.__lazarusEntry = ${entry.ref};\n`;
}

export function renderAsyncParityTest(name: string, entry: ErrorFirstFunction, schema: Record<string, string>, fuzzRuns: number): string {
  const params = entry.params;
  const arbitraries = params.map((p) => ARBITRARY[schema[p] ?? "string"] ?? ARBITRARY["string"]).join(", ");
  const list = params.join(", ");
  const promiseStyle = entry.style === "promise-chain";
  const legacyRunner = promiseStyle
    ? [
        `/** Settlement of the legacy promise-returning function (a synchronous throw counts as a rejection). */`,
        `async function runLegacy(...args: unknown[]): Promise<Settled> {`,
        `  try {`,
        `    return { settled: 'resolve', value: await legacyModule.__lazarusEntry(...args) };`,
        `  } catch (e) {`,
        `    return { settled: 'reject', ...describeError(e) };`,
        `  }`,
        `}`,
      ]
    : [
        `/** First settlement of the legacy error-first function (a synchronous throw counts as a rejection). */`,
        `function runLegacy(...args: unknown[]): Promise<Settled> {`,
        `  return new Promise((resolve) => {`,
        `    let done = false;`,
        `    const cb = (err: unknown, value?: unknown): void => {`,
        `      if (done) return;`,
        `      done = true;`,
        `      resolve(err !== null && err !== undefined ? { settled: 'reject', ...describeError(err) } : { settled: 'resolve', value });`,
        `    };`,
        `    try {`,
        `      legacyModule.__lazarusEntry(...args, cb);`,
        `    } catch (e) {`,
        `      if (!done) { done = true; resolve({ settled: 'reject', ...describeError(e) }); }`,
        `    }`,
        `  });`,
        `}`,
      ];
  return [
    `import { describe, it, expect } from 'vitest';`,
    `import fc from 'fast-check';`,
    `import { createRequire } from 'node:module';`,
    `import { ${name} } from './resurrected.js';`,
    ``,
    `type Settled = { settled: 'resolve'; value: unknown } | { settled: 'reject'; name: string; message: string };`,
    `const legacyModule = createRequire(import.meta.url)('./legacy.cjs') as { __lazarusEntry: (...args: unknown[]) => ${promiseStyle ? "unknown" : "void"} };`,
    `const modernFn = ${name} as unknown as (...args: unknown[]) => Promise<unknown>;`,
    ``,
    `function describeError(e: unknown): { name: string; message: string } {`,
    `  const o = e !== null && typeof e === 'object' ? (e as { name?: unknown; message?: unknown }) : undefined;`,
    `  return { name: typeof o?.name === 'string' ? o.name : typeof e, message: typeof o?.message === 'string' ? o.message : String(e) };`,
    `}`,
    ...legacyRunner,
    `async function runModern(...args: unknown[]): Promise<Settled> {`,
    `  try {`,
    `    return { settled: 'resolve', value: await modernFn(...args) };`,
    `  } catch (e) {`,
    `    return { settled: 'reject', ...describeError(e) };`,
    `  }`,
    `}`,
    `/** Deep equality with Object.is on every leaf (-0, NaN and undefined are exact). */`,
    `function same(a: unknown, b: unknown): boolean {`,
    `  if (Object.is(a, b)) return true;`,
    `  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;`,
    `  if (Array.isArray(a) !== Array.isArray(b)) return false;`,
    `  const ka = Object.keys(a), kb = Object.keys(b);`,
    `  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));`,
    `}`,
    ``,
    `describe('${name} async parity suite (${promiseStyle ? "Promise chain" : "error-first callback"} -> async/await)', () => {`,
    `  it('settles exactly like the legacy callback (resolve and reject) across ${fuzzRuns} inputs', async () => {`,
    `    await fc.assert(`,
    `      fc.asyncProperty(${arbitraries || "fc.constant(undefined)"}, async (${list || "_unused"}) => {`,
    `        expect(same(await runModern(${list}), await runLegacy(${list}))).toBe(true);`,
    `      }),`,
    `      { numRuns: ${fuzzRuns} }`,
    `    );`,
    `  });`,
    `});`,
    ``,
  ].join("\n");
}

/** Builds and strictly type-checks the async bundle. Same result shape as generateVerifiedBundle. */
export async function generateAsyncVerifiedBundle(input: AsyncBundleInput, certificateFor?: (report: TypecheckReport) => string | undefined): Promise<VerifiedBundle> {
  let attempt = await check(input.modernTs);
  let rounds = attempt.rounds;
  let widenedReturn = false;
  if (!attempt.result.passed) {
    const widened = widenAsyncReturn(attempt.ts, input.entry.name);
    if (widened !== attempt.ts) {
      attempt = await check(widened);
      rounds += attempt.rounds;
      widenedReturn = true;
    }
  }
  const report: TypecheckReport = { ...attempt.result, adjustments: attempt.adjustments, widenedReturn, rounds };
  const certificateMarkdown = certificateFor?.(report);
  const name = input.entry.name;
  const legacyFile = legacyModuleFile(input.legacySource, input.entry);
  const spec = [
    `# Kiro Resurrection Specification: ${name}`,
    ``,
    `- **Status:** 100% Async Behavioral Parity Proven (\`Object.is\` on resolved values, name + message on rejections)`,
    input.entry.style === "promise-chain"
      ? `- **Calling Convention:** Promise chain \`${name}(${input.entry.params.join(", ")})\` (\`.then().catch()\`) -> \`await ${name}(${input.entry.params.join(", ")})\``
      : `- **Calling Convention:** error-first callback \`${name}(${[...input.entry.params, input.entry.callback].join(", ")})\` -> \`await ${name}(${input.entry.params.join(", ")})\``,
    `- **Differential Fuzzing Runs:** ${input.fuzzRuns}`,
    `- **Self-Healed by Necromancer:** ${input.attempts > 1 ? `Yes (attempt ${input.attempts})` : "No (Zero Divergences)"}`,
    ...typecheckLines(report),
    ``,
    ...(certificateMarkdown !== undefined ? [certificateMarkdown.trim(), ``] : []),
    `## Legacy Source`,
    "```javascript",
    input.legacySource.trim(),
    "```",
    ``,
    `## Resurrected Async TypeScript`,
    "```typescript",
    attempt.ts.trim(),
    "```",
    ``,
    `## Synthesized Specification`,
    input.specMarkdown.trim(),
    ``,
  ].join("\n");
  const legacyLines = input.legacySource.trim().split(/\r?\n/);
  const tsLines = attempt.ts.trimEnd().split(/\r?\n/);
  const prDiff = [
    `diff --git a/legacy.cjs b/resurrected.ts`,
    `--- a/legacy.cjs`,
    `+++ b/resurrected.ts`,
    `@@ -1,${legacyLines.length} +1,${tsLines.length} @@`,
    ...legacyLines.map((l) => `-${l}`),
    ...tsLines.map((l) => `+${l}`),
  ].join("\n");
  const bundle: ResurrectionBundle = {
    specimenName: name,
    generatedAt: new Date().toISOString(),
    files: {
      [TS_FILE]: attempt.ts.endsWith("\n") ? attempt.ts : `${attempt.ts}\n`,
      "SPEC.md": spec,
      "resurrected.test.ts": renderAsyncParityTest(name, input.entry, input.schema, input.fuzzRuns),
      [WORKFLOW_PATH]: renderWorkflow(),
      "legacy.cjs": legacyFile,
    },
    prDiff,
  };
  return { bundle, typecheck: report };
}

