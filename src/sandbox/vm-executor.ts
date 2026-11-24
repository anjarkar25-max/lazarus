/// <reference types="node" />
// In-process probe executor used inside the pooled worker. Every call builds a brand-new
// node:vm context, so state from one probe can never reach the next.
//
// node:vm is not a security boundary by itself. The boundary is the worker process (256 MB
// heap, network/fs shims, watchdog + kill in PooledProbeRunner). This file removes the cheap
// escapes: the sandbox object has a null prototype, and nothing from the host realm is ever
// handed to probe code (inputs are parsed and console is created inside the context).

import { createContext, runInContext } from "node:vm";
import { types } from "node:util";
import { SandboxError } from "./errors.js";
import type { ProbeExecutor, ProbeParams, ProbeResult } from "./types.js";

/** vm-level budget. The pool's watchdog (3000 ms) is the hard outer limit. */
export const VM_TIMEOUT_MS = 2800;

const BOOTSTRAP = `(function () {
  "use strict";
  var g = globalThis;
  var stringify = JSON.stringify.bind(JSON);
  var parse = JSON.parse.bind(JSON);
  var out = [];
  var err = [];
  var size = 0;
  var MAX = 65536;
  function fmt(a) {
    if (typeof a === "string") return a;
    try { var s = stringify(a); return s === undefined ? String(a) : s; }
    catch (e1) { try { return String(a); } catch (e2) { return "[unprintable]"; } }
  }
  function sink(buf) {
    return function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(fmt(arguments[i]));
      var line = parts.join(" ");
      if (size < MAX) { size += line.length + 1; buf.push(line); }
    };
  }
  var log = sink(out);
  var error = sink(err);
  var TAG = "$lazarus";
  function mark(kind) { var o = {}; o[TAG] = kind; return o; }
  // Own recursive decoder (not a JSON.parse reviver): a reviver returning undefined deletes the property,
  // which would turn a tagged undefined input into a missing global (ReferenceError) instead of a value.
  function decodeDeep(v) {
    if (v !== null && typeof v === "object") {
      if (Array.isArray(v)) {
        var arr = [];
        for (var a = 0; a < v.length; a++) arr.push(decodeDeep(v[a]));
        return arr;
      }
      var ks = Object.keys(v);
      if (ks.length === 1 && ks[0] === TAG) {
        switch (v[TAG]) {
          case "NaN": return NaN;
          case "Infinity": return Infinity;
          case "-Infinity": return -Infinity;
          case "-0": return -0;
          case "undefined": return undefined;
        }
      }
      var out = {};
      for (var b = 0; b < ks.length; b++) {
        Object.defineProperty(out, ks[b], { value: decodeDeep(v[ks[b]]), writable: true, configurable: true, enumerable: true });
      }
      return out;
    }
    return v;
  }
  function replace(k, v) {
    if (typeof v === "number") {
      if (v !== v) return mark("NaN");
      if (v === Infinity) return mark("Infinity");
      if (v === -Infinity) return mark("-Infinity");
      if (v === 0 && 1 / v < 0) return mark("-0");
    } else if (v === undefined) {
      return mark("undefined");
    }
    return v;
  }
  var tagged = g.__lzTagged === true;
  var input = tagged ? decodeDeep(parse(g.__lzInput)) : parse(g.__lzInput);
  delete g.__lzInput;
  delete g.__lzTagged;
  Object.defineProperty(g, "console", { value: { log: log, info: log, debug: log, warn: error, error: error }, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(g, "process", { value: { env: {} }, writable: true, configurable: true, enumerable: false });
  var keys = Object.keys(input);
  for (var i = 0; i < keys.length; i++) {
    Object.defineProperty(g, keys[i], { value: input[keys[i]], writable: true, configurable: true, enumerable: true });
  }
  Object.defineProperty(g, "__lz", {
    value: Object.freeze({
      stringify: stringify,
      stringifyTagged: function (v) { return stringify(v, replace); },
      drain: function () { return stringify({ stdout: out.join("\\n"), stderr: err.join("\\n") }); },
      describe: function (e) {
        try {
          if (e && typeof e === "object" && typeof e.message === "string") return e.message;
          return fmt(e);
        } catch (x) { return "[unprintable thrown value]"; }
      }
    }),
    writable: false, configurable: false, enumerable: false
  });
})()`;

/** Read an own data property without ever invoking user code (no getters, no proxy traps). */
function ownDataString(value: unknown, key: string): string | undefined {
  if (!types.isNativeError(value)) return undefined;
  const desc = Object.getOwnPropertyDescriptor(value, key);
  return desc !== undefined && typeof desc.value === "string" ? desc.value : undefined;
}

export class VmProbeExecutor implements ProbeExecutor {
  readonly supportsTaggedEncoding = true;

  async run(params: ProbeParams): Promise<ProbeResult> {
    const startedAt = Date.now();
    const heapBefore = process.memoryUsage().heapUsed;
    const budgetLeft = (): number => Math.max(1, VM_TIMEOUT_MS - (Date.now() - startedAt));

    const sandbox: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const tagged = params.encoding === "tagged";
    sandbox["__lzInput"] = JSON.stringify(params.context ?? {});
    if (tagged) sandbox["__lzTagged"] = true;
    const ctx = createContext(sandbox, { codeGeneration: { strings: true, wasm: false } });

    const describeThrown = (thrown: unknown): string => {
      // Host-realm native errors (compile errors, vm timeout) are safe to read directly.
      const own = ownDataString(thrown, "message");
      if (own !== undefined && ownDataString(thrown, "code") !== undefined) return own;
      sandbox["__lzErr"] = thrown;
      try {
        const text: unknown = runInContext("__lz.describe(__lzErr)", ctx, { timeout: 200 });
        return typeof text === "string" ? text : "Probe threw a value";
      } catch {
        return "Probe threw a value that could not be described";
      }
    };

    try {
      runInContext(BOOTSTRAP, ctx, { timeout: VM_TIMEOUT_MS, filename: "lazarus-bootstrap.js" });
      const output: unknown = runInContext(params.code, ctx, {
        timeout: VM_TIMEOUT_MS,
        filename: "legacy-probe.js",
      });

      sandbox["__lzOut"] = output;
      const json: unknown = runInContext(tagged ? "__lz.stringifyTagged(__lzOut)" : "__lz.stringify(__lzOut)", ctx, {
        timeout: budgetLeft(),
      });
      const drained: unknown = runInContext("__lz.drain()", ctx, { timeout: budgetLeft() });

      let stdout = "";
      let stderr = "";
      if (typeof drained === "string") {
        const parsed: unknown = JSON.parse(drained);
        if (typeof parsed === "object" && parsed !== null) {
          const rec = parsed as Record<string, unknown>;
          stdout = typeof rec["stdout"] === "string" ? rec["stdout"] : "";
          stderr = typeof rec["stderr"] === "string" ? rec["stderr"] : "";
        }
      }

      return {
        output: typeof json === "string" ? (JSON.parse(json) as unknown) : undefined,
        durationMs: Date.now() - startedAt,
        memoryUsedBytes: Math.max(0, process.memoryUsage().heapUsed - heapBefore),
        stdout,
        stderr,
      };
    } catch (thrown: unknown) {
      if (ownDataString(thrown, "code") === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
        throw new SandboxError("TIMEOUT", `Probe exceeded ${VM_TIMEOUT_MS}ms execution limit`);
      }
      throw new SandboxError("EXECUTION_ERROR", describeThrown(thrown));
    }
  }
}
