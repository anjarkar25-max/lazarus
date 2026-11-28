// "Paste anything": what Lazarus understood from a pasted snippet, for the editor's signature pill and schema.
// Parse-only (acorn via the AST scanner). Nothing here executes the code.
import { detectErrorFirst } from "../crew/async-callback.js";
import { detectPromiseChain } from "../crew/es5-idioms.js";
import { listModuleFunctions } from "../crew/module-resurrection.js";
import type { InputSchema, ParamKind } from "../fuzzer/types.js";
import { scanLegacyAst } from "../sandbox/ast-scanner.js";

export interface SmartPasteResult {
  readonly parsed: boolean;
  readonly parseError?: string;
  /** "function" (one specimen function), "module" (several exports), "script" (free inputs), "none". */
  readonly kind: "function" | "module" | "script" | "none";
  /** Flat schema, or per-export schemas for a module. */
  readonly schema: InputSchema | Record<string, InputSchema>;
  /** e.g. `pad(str: string, len: number)`; one entry per export for a module. */
  readonly signatures: string[];
  readonly functionName?: string;
  readonly idioms: string[];
}

const TS_TYPE: Record<ParamKind, string> = { integer: "number", number: "number", string: "string", boolean: "boolean", json: "unknown" };

export function renderParams(schema: InputSchema): string {
  return Object.entries(schema)
    .map(([name, kind]) => `${name}: ${TS_TYPE[kind]}`)
    .join(", ");
}

export function describePaste(source: string): SmartPasteResult {
  const scan = scanLegacyAst(source);
  if (!scan.parsed) {
    return { parsed: false, ...(scan.parseError !== undefined ? { parseError: scan.parseError } : {}), kind: "none", schema: {}, signatures: [], idioms: scan.detectedIdioms };
  }
  // Node.js error-first callback: the callback is the calling convention, not an input to fuzz.
  const errorFirst = detectErrorFirst(source).entry;
  if (errorFirst !== undefined) {
    const scanned = scanLegacyAst(source, { functionName: errorFirst.name }).suggestedSchema;
    const schema: InputSchema = Object.fromEntries(errorFirst.params.map((p) => [p, scanned[p] ?? "string"]));
    return { parsed: true, kind: "function", schema, signatures: [`${errorFirst.name}(${renderParams(schema)}) \u2192 Promise (error-first ${errorFirst.callback})`], functionName: errorFirst.name, idioms: scan.detectedIdioms };
  }
  // A legacy `.then().catch()` Promise chain: it resolves or rejects, so it is fuzzed as an async function.
  const chain = detectPromiseChain(source).entry;
  if (chain !== undefined) {
    const scanned = scanLegacyAst(source, { functionName: chain.name }).suggestedSchema;
    const schema: InputSchema = Object.fromEntries(chain.params.map((p) => [p, scanned[p] ?? "string"]));
    return { parsed: true, kind: "function", schema, signatures: [`${chain.name}(${renderParams(schema)}) \u2192 Promise (legacy .then/.catch chain)`], functionName: chain.name, idioms: scan.detectedIdioms };
  }
  const exported = listModuleFunctions(source).functions;
  if (exported.length >= 2) {
    const schema: Record<string, InputSchema> = {};
    const signatures: string[] = [];
    for (const fn of exported) {
      const name = fn.exportedAs ?? fn.name;
      schema[name] = fn.paramKinds;
      signatures.push(`${name}(${renderParams(fn.paramKinds)})`);
    }
    return { parsed: true, kind: "module", schema, signatures, idioms: scan.detectedIdioms };
  }
  if (scan.primary !== undefined) {
    const name = scan.primary.exportedAs !== undefined && scan.primary.exportedAs !== "default" ? scan.primary.exportedAs : scan.primary.name;
    return { parsed: true, kind: "function", schema: scan.suggestedSchema, signatures: [`${name}(${renderParams(scan.suggestedSchema)})`], functionName: name, idioms: scan.detectedIdioms };
  }
  if (Object.keys(scan.suggestedSchema).length > 0) {
    return { parsed: true, kind: "script", schema: scan.suggestedSchema, signatures: [`script(${renderParams(scan.suggestedSchema)})`], idioms: scan.detectedIdioms };
  }
  return { parsed: true, kind: "none", schema: {}, signatures: [], idioms: scan.detectedIdioms };
}
