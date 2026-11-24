// Whole-project PR bundle for a resurrected multi-file graph: ES2022 modules under src/, the original CommonJS
// files under legacy/ (the parity oracle), a Vitest + fast-check whole-graph suite, SPEC.md, a unified multi-file
// patch and the GitHub Actions workflow. Every value here is plain text; nothing is executed.
import type { GraphResurrectionResult } from "../crew/graph-resurrector.js";
import type { ParamKind } from "../fuzzer/types.js";
import { renderWorkflow, sanitizeIdentifier, WORKFLOW_PATH } from "./bundle.js";
import { createZip } from "./zip.js";
import { plural } from "../text/plural.js";
import { describeTypecheck, strictTsconfig } from "../crew/ts-verifier.js";

export interface GraphBundle {
  readonly name: string;
  /** Archive path -> content. */
  readonly files: Record<string, string>;
  readonly patch: string;
}

const ARBITRARY: Record<ParamKind, string> = {
  integer: "fc.integer({ min: -100000, max: 100000 })",
  number: "fc.double({ min: -10000, max: 10000, noNaN: true })",
  string: "fc.string({ maxLength: 32 })",
  boolean: "fc.boolean()",
  json: "fc.jsonValue()",
};

function unifiedFileDiff(from: string, to: string, before: string, after: string): string {
  const a = before.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const b = after.replace(/\r\n/g, "\n").trimEnd().split("\n");
  return [`diff --git a/${from} b/${to}`, `--- a/${from}`, `+++ b/${to}`, `@@ -1,${a.length} +1,${b.length} @@`, ...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)].join("\n");
}

function renderTest(result: GraphResurrectionResult, runs: number): string {
  const entry = result.graph.entry ?? "";
  const esmEntry = result.graph.esmPaths[entry] ?? entry;
  const entryFile = result.files.find((f) => f.path === entry);
  const probes = entryFile?.probes ?? [];
  const lines = [
    `import { describe, it, expect } from 'vitest';`,
    `import fc from 'fast-check';`,
    `import { createRequire } from 'node:module';`,
    `import * as modern from './src/${esmEntry}';`,
    ``,
    `// The original CommonJS graph is the oracle; the resurrected ES module graph must match it exactly.`,
    `const legacy: Record<string, unknown> = createRequire(import.meta.url)('./legacy/${entry}');`,
    `const modernExports = modern as Record<string, unknown>;`,
    ``,
    `function same(a: unknown, b: unknown): boolean {`,
    `  if (Object.is(a, b)) return true;`,
    `  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;`,
    `  if (Array.isArray(a) !== Array.isArray(b)) return false;`,
    `  const ka = Object.keys(a);`,
    `  const kb = Object.keys(b);`,
    `  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));`,
    `}`,
    ``,
    `function outcome(fn: unknown, args: unknown[]): { ok: boolean; value?: unknown } {`,
    `  if (typeof fn !== 'function') throw new Error('export is not a function');`,
    `  try {`,
    `    return { ok: true, value: fn(...args) };`,
    `  } catch {`,
    `    return { ok: false };`,
    `  }`,
    `}`,
    ``,
    `describe('${sanitizeIdentifier(result.name)} whole-graph parity (CommonJS graph vs ES module graph)', () => {`,
  ];
  for (const probe of probes) {
    const params = Object.entries(probe.schema);
    const legacyFn = probe.exportedAs === "default" ? "legacy" : `legacy[${JSON.stringify(probe.exportedAs)}]`;
    const modernFn = `modernExports[${JSON.stringify(probe.exportedAs)}]`;
    const names = params.map(([n]) => sanitizeIdentifier(n));
    lines.push(
      `  it('${probe.exportedAs} matches the CommonJS graph across ${runs} inputs', () => {`,
      `    fc.assert(`,
      `      fc.property(${params.length > 0 ? `${params.map(([, k]) => ARBITRARY[k] ?? ARBITRARY.json).join(", ")}, ` : ""}(${names.join(", ")}) => {`,
      `        const a = outcome(${modernFn}, [${names.join(", ")}]);`,
      `        const b = outcome(${legacyFn}, [${names.join(", ")}]);`,
      `        expect(a.ok).toBe(b.ok);`,
      `        if (a.ok) expect(same(a.value, b.value)).toBe(true);`,
      `      }),`,
      `      { numRuns: ${runs} }`,
      `    );`,
      `  });`
    );
  }
  lines.push(`});`, ``);
  return lines.join("\n");
}

function renderSpec(result: GraphResurrectionResult): string {
  const parity = result.parity;
  const tc = result.typecheck;
  const first = tc?.diagnostics[0];
  const firstError = first === undefined ? "unknown error" : `${first.file}:${first.line}:${first.column} TS${first.code} ${first.message}`.replace(/`/g, "'").slice(0, 200);
  const outputByLegacy = new Map(result.files.map((f) => [f.path, outputPath(f)]));
  const entryOutput = outputByLegacy.get(result.graph.entry ?? "") ?? "";
  const lines = [
    `# Kiro Resurrection Specification: ${result.name} (multi-file graph)`,
    ``,
    `- **Status:** ${result.success ? "Whole-graph behavioral parity proven (exact \`Object.is\`)" : "NOT resurrected"}`,
    `- **Entry module:** \`${result.graph.entry ?? "none"}\` -> \`src/${entryOutput}\``,
    `- **Resurrection order (leaves first):** ${result.graph.order.map((f) => `\`${f}\``).join(" -> ")}`,
    `- **Whole-graph fuzz runs:** ${parity?.totalRuns ?? 0} across ${plural(parity?.functions.length ?? 0, "entry export")}`,
    ...(tc !== undefined ? [`- **TypeScript Strict Check:** ${describeTypecheck(tc)}${tc.passed ? "" : ` (first: ${firstError})`}`] : []),
    ...(tc !== undefined && tc.adjustments.length > 0 ? [`- **Migration boundary (declared \`any\`):** ${tc.adjustments.join("; ")}`] : []),
    ``,
    `## Dependency graph`,
    ``,
    ...result.graph.edges.map((e) => `- \`${e.from}\` requires \`${e.to}\` (\`${e.specifier}\`) -> \`import ... from\` \`src/${outputByLegacy.get(e.to) ?? e.to}\``),
    ...(result.graph.edges.length === 0 ? ["- (no internal dependencies)"] : []),
    ``,
    `## Files`,
    ``,
    `| Legacy | Resurrected | Exports | Attempts | Fuzz runs | Rolled back |`,
    `| --- | --- | --- | --- | --- | --- |`,
    ...result.files.map((f) => `| \`${f.path}\` | \`src/${outputPath(f)}\` | ${f.esmExports.join(", ") || "none"} | ${f.attempts}${f.healed ? " (self-healed)" : ""} | ${f.fuzzRuns} | ${f.rolledBack.join(", ") || "none"} |`),
    ``,
    `## Whole-graph parity`,
    ``,
    ...(parity?.functions ?? []).map((fn) => `- \`${fn.exportedAs}\` (${Object.entries(fn.schema).map(([k, v]) => `${k}: ${v}`).join(", ")}): ${fn.passed ? "parity" : "DIVERGES"} over ${fn.totalRuns} runs`),
    ``,
    `Parity is proven by differential fuzzing over the fuzzed input domain, not for all inputs. Imports are hoisted in ES`,
    `modules, so top-level side effects of a dependency run before the importing module's body (they ran at the require`,
    `call in CommonJS); the whole-graph check exercises the entry exports after both graphs have loaded.`,
    ``,
  ];
  return lines.join("\n");
}

/** `money.ts` for a typed module, the ES module path otherwise. */
const outputPath = (f: GraphResurrectionResult["files"][number]): string => (f.tsCode !== "" ? f.tsPath : f.esmPath);

export function buildGraphBundle(result: GraphResurrectionResult, options: { readonly runs?: number } = {}): GraphBundle {
  const runs = options.runs ?? 100;
  const files: Record<string, string> = {};
  for (const f of result.files) {
    files[`src/${outputPath(f)}`] = `${(f.tsCode || f.esmCode).trimEnd()}\n`;
    files[`legacy/${f.path}`] = `${f.legacyCode.replace(/\r\n/g, "\n").trimEnd()}\n`;
  }
  // `.js` files are ES modules under src/ and CommonJS under legacy/, whatever the root package says.
  files["src/package.json"] = `${JSON.stringify({ type: "module" }, null, 2)}\n`;
  files["legacy/package.json"] = `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`;
  files["package.json"] = `${JSON.stringify(
    {
      name: sanitizeIdentifier(result.name).toLowerCase().replace(/_/g, "-"),
      private: true,
      type: "module",
      scripts: { test: "vitest run" },
      devDependencies: { "fast-check": "^4.10.2", vitest: "^5.1.0" },
    },
    null,
    2
  )}\n`;
  // `npx tsc --noEmit` in the unzipped project checks the typed modules under the same strict settings.
  files["tsconfig.json"] = strictTsconfig(["src/**/*.ts"]);
  files["resurrected.test.ts"] = renderTest(result, runs);
  files["SPEC.md"] = renderSpec(result);
  files[WORKFLOW_PATH] = renderWorkflow();
  const patch = result.files.map((f) => unifiedFileDiff(f.path, `src/${outputPath(f)}`, f.legacyCode, f.tsCode || f.esmCode)).join("\n");
  files["resurrection.patch"] = `${patch}\n`;
  return { name: result.name, files, patch };
}

export function graphBundleZip(bundle: GraphBundle): Buffer {
  return createZip(Object.entries(bundle.files).map(([name, data]) => ({ name, data })));
}
