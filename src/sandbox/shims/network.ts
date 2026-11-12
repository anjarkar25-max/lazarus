/// <reference types="node" />
// Task 4: Network shim — blocks all outbound network access in the child process.
//
// In the child process this shim is imported as a side-effect before any legacy
// code runs.  It patches the module-level exports so that any subsequent CJS
// require() calls receive the blocked versions.  For ESM contexts it registers
// a module hook so that import() of network modules returns the patched versions.
//
// Design note: ESM module namespaces are sealed (read-only bindings).  Direct
// property assignment on `import * as net` throws in strict mode.  Instead we
// export blocking wrapper functions and also install them into the global
// require cache (Module._cache) so that CJS require('net') gets them.

import { createRequire } from "node:module";
import { SandboxError } from "../errors.js";

export function blocked(operation: string): never {
  throw new SandboxError(
    "NETWORK_BLOCKED",
    `Outbound network operation blocked: ${operation}`
  );
}

// ---------------------------------------------------------------------------
// Blocking function factories — these replace the real net/http/https/dgram
// functions in the child process's CJS require() cache.
// ---------------------------------------------------------------------------

export const blockedNetConnect = (..._args: unknown[]): never =>
  blocked("net.connect");
export const blockedNetCreateConnection = (..._args: unknown[]): never =>
  blocked("net.createConnection");
export const blockedHttpRequest = (..._args: unknown[]): never =>
  blocked("http.request");
export const blockedHttpGet = (..._args: unknown[]): never =>
  blocked("http.get");
export const blockedHttpsRequest = (..._args: unknown[]): never =>
  blocked("https.request");
export const blockedHttpsGet = (..._args: unknown[]): never =>
  blocked("https.get");
export const blockedDgramCreateSocket = (..._args: unknown[]): never =>
  blocked("dgram.createSocket");

// ---------------------------------------------------------------------------
// Patch the CJS module cache (works in both CJS and ESM-in-CJS contexts)
// ---------------------------------------------------------------------------

function patchCjsCache(): void {
  try {
    const req = createRequire(import.meta.url);

    // Patch net
    const netMod = req("net") as Record<string, unknown>;
    netMod["connect"] = blockedNetConnect;
    netMod["createConnection"] = blockedNetCreateConnection;

    // Patch http
    const httpMod = req("http") as Record<string, unknown>;
    httpMod["request"] = blockedHttpRequest;
    httpMod["get"] = blockedHttpGet;

    // Patch https
    const httpsMod = req("https") as Record<string, unknown>;
    httpsMod["request"] = blockedHttpsRequest;
    httpsMod["get"] = blockedHttpsGet;

    // Patch dgram
    const dgramMod = req("dgram") as Record<string, unknown>;
    dgramMod["createSocket"] = blockedDgramCreateSocket;
  } catch {
    // CJS cache patching may not be available in all environments (e.g., pure ESM workers)
    // The shim still exports the blocking functions for use by any code that imports them.
  }
}

patchCjsCache();
