// One classifier for every front end (Web Studio, CLI, MCP server, benchmark): which resurrection pass does this source need?
//   error-first   Node.js `fn(a, cb)` with `cb(err)` / `cb(null, value)`  -> async/await (async-callback.ts)
//   promise-chain `return X.then(h).catch(c)`                             -> async/await (es5-idioms.ts)
//   sync          everything else                                         -> the AST modernizer + differential fuzzer
// Parse-only (acorn). Nothing here executes the source.
import { detectErrorFirst, type ErrorFirstFunction, type ErrorFirstRequest, type ErrorFirstResult } from "./async-callback.js";
import { detectPromiseChain } from "./es5-idioms.js";
import type { ResurrectionOrchestrator } from "./orchestrator.js";

export type AsyncKind = "error-first" | "promise-chain";
export type SpecimenKind = AsyncKind | "sync";

export interface SpecimenClass {
  readonly kind: SpecimenKind;
  /** The async entry function (absent for `sync`). */
  readonly entry?: ErrorFirstFunction;
}

/** An error-first callback wins over a Promise chain (a function cannot be both); anything else is synchronous. */
export function classifySpecimen(source: string, entryName?: string): SpecimenClass {
  const options = entryName !== undefined ? { entryName } : {};
  const errorFirst = detectErrorFirst(source, options).entry;
  if (errorFirst !== undefined) return { kind: "error-first", entry: errorFirst };
  const chain = detectPromiseChain(source, options).entry;
  if (chain !== undefined) return { kind: "promise-chain", entry: chain };
  return { kind: "sync" };
}

/** Runs the async pass that matches `kind`; both fuzz both settlements in the pooled sandbox. */
export function resurrectAsyncSpecimen(orchestrator: ResurrectionOrchestrator, kind: AsyncKind, request: ErrorFirstRequest): Promise<ErrorFirstResult> {
  return kind === "promise-chain" ? orchestrator.resurrectPromiseChain(request) : orchestrator.resurrectErrorFirst(request);
}
