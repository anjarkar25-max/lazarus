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
import { VIRTUAL_REQUIRE_SOURCE } from "./virtual-fs.js";

/** vm-level budget. The pool's watchdog (3000 ms) is the hard outer limit. */
export const VM_TIMEOUT_MS = 2800;
/** Most virtual timers an async probe may run before it is stopped as a runaway. */
export const MAX_VIRTUAL_TIMERS = 10_000;

/**
 * Async probes only (ProbeParams.settle). Deterministic virtual timers, created inside the context so no host
 * function is ever reachable from probe code: callbacks run in (due time, insertion) order on a virtual clock, one per
 * `__lz.tick()`, and promise jobs drain after every evaluation (microtaskMode "afterEvaluate", inside the vm budget).
 */
const ASYNC_BOOTSTRAP = `(function () {
  "use strict";
  var g = globalThis;
  var queue = [];
  var seq = 0;
  var clock = 0;
  var ran = 0;
  var state = { status: "pending", value: undefined, error: undefined };
  function add(fn, ms, args, kind) {
    if (typeof fn !== "function") throw new TypeError("The \\"callback\\" argument must be of type function");
    var delay = Number(ms);
    if (!(delay >= 1) || delay !== delay) delay = kind === "timeout" ? 1 : 0;
    var id = ++seq;
    queue.push({ id: id, due: clock + Math.floor(delay), seq: id, fn: fn, args: args });
    return id;
  }
  function cancel(id) {
    for (var i = 0; i < queue.length; i++) if (queue[i].id === id) { queue.splice(i, 1); return; }
  }
  function rest(a, from) { var out = []; for (var i = from; i < a.length; i++) out.push(a[i]); return out; }
  function define(name, value) { Object.defineProperty(g, name, { value: value, writable: true, configurable: true, enumerable: false }); }
  define("setTimeout", function (fn, ms) { return add(fn, ms, rest(arguments, 2), "timeout"); });
  define("setInterval", function () { throw new Error("setInterval is not available in async probes"); });
  define("setImmediate", function (fn) { return add(fn, 0, rest(arguments, 1), "immediate"); });
  define("clearTimeout", cancel);
  define("clearImmediate", cancel);
  define("clearInterval", cancel);
  define("queueMicrotask", function (fn) { Promise.resolve().then(function () { fn(); }); });
  g.process.nextTick = function (fn) { var args = rest(arguments, 1); Promise.resolve().then(function () { fn.apply(undefined, args); }); };
  Object.defineProperty(g, "__lzt", {
    value: Object.freeze({
      watch: function (p) {
        if (p === null || (typeof p !== "object" && typeof p !== "function") || typeof p.then !== "function") {
          state.status = "resolved"; state.value = p; return;
        }
        p.then(function (v) { if (state.status === "pending") { state.status = "resolved"; state.value = v; } },
               function (e) { if (state.status === "pending") { state.status = "rejected"; state.error = e; } });
      },
      poll: function () { return state.status; },
      value: function () { return state.value; },
      error: function () { return state.error; },
      tick: function () {
        if (queue.length === 0) return "idle";
        if (++ran > ${MAX_VIRTUAL_TIMERS}) return "runaway";
        var best = 0;
        for (var i = 1; i < queue.length; i++) {
          if (queue[i].due < queue[best].due || (queue[i].due === queue[best].due && queue[i].seq < queue[best].seq)) best = i;
        }
        var t = queue.splice(best, 1)[0];
        if (t.due > clock) clock = t.due;
        t.fn.apply(undefined, t.args);
        return "ran";
      }
    }),
    writable: false, configurable: false, enumerable: false
  });
})()`;

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
${VIRTUAL_REQUIRE_SOURCE}
  var tagged = g.__lzTagged === true;
  var input = tagged ? decodeDeep(parse(g.__lzInput)) : parse(g.__lzInput);
  delete g.__lzInput;
  delete g.__lzTagged;
  Object.defineProperty(g, "console", { value: { log: log, info: log, debug: log, warn: error, error: error }, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(g, "process", { value: { env: {} }, writable: true, configurable: true, enumerable: false });
  if (g.__lzFiles !== undefined) installVirtualRequire(g, g.__lzFiles, g.__lzEntry);
  delete g.__lzFiles;
  delete g.__lzEntry;
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

/** Thrown inside settleInContext for a rejected async probe; turned into EXECUTION_ERROR by the caller. */
class AsyncRejection {
  constructor(readonly thrown: unknown) {}
}

export class VmProbeExecutor implements ProbeExecutor {
  readonly supportsTaggedEncoding = true;
  readonly supportsSettle = true;

  /**
   * Settles the probe's promise inside the context: alternately lets promise jobs drain (afterEvaluate, inside each
   * runInContext budget) and runs the next virtual timer. Only strings and context values cross the boundary.
   */
  private settleInContext(ctx: object, sandbox: Record<string, unknown>, output: unknown, budgetLeft: () => number): unknown {
    sandbox["__lzOut"] = output;
    runInContext("__lzt.watch(__lzOut)", ctx, { timeout: budgetLeft() });
    for (;;) {
      if (budgetLeft() <= 1) throw new SandboxError("TIMEOUT", `Async probe did not settle within ${VM_TIMEOUT_MS}ms`);
      const status: unknown = runInContext("__lzt.poll()", ctx, { timeout: budgetLeft() });
      if (status === "resolved") return runInContext("__lzt.value()", ctx, { timeout: budgetLeft() });
      if (status === "rejected") throw new AsyncRejection(runInContext("__lzt.error()", ctx, { timeout: budgetLeft() }));
      const tick: unknown = runInContext("__lzt.tick()", ctx, { timeout: budgetLeft() });
      if (tick === "idle") throw new SandboxError("TIMEOUT", "Async probe never settled: the callback was never called and no timer is pending");
      if (tick === "runaway") throw new SandboxError("TIMEOUT", `Async probe scheduled more than ${MAX_VIRTUAL_TIMERS} timers without settling`);
    }
  }

  async run(params: ProbeParams): Promise<ProbeResult> {
    const startedAt = Date.now();
    const heapBefore = process.memoryUsage().heapUsed;
    const budgetLeft = (): number => Math.max(1, VM_TIMEOUT_MS - (Date.now() - startedAt));

    const sandbox: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const tagged = params.encoding === "tagged";
    sandbox["__lzInput"] = JSON.stringify(params.context ?? {});
    if (tagged) sandbox["__lzTagged"] = true;
    if (params.files !== undefined) {
      sandbox["__lzFiles"] = JSON.stringify(params.files);
      if (params.entry !== undefined) sandbox["__lzEntry"] = params.entry;
    }
    const settle = params.settle === true;
    const ctx = createContext(sandbox, { codeGeneration: { strings: true, wasm: false }, ...(settle ? { microtaskMode: "afterEvaluate" as const } : {}) });

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
      if (settle) runInContext(ASYNC_BOOTSTRAP, ctx, { timeout: budgetLeft(), filename: "lazarus-async-bootstrap.js" });
      let output: unknown = runInContext(params.code, ctx, {
        timeout: settle ? budgetLeft() : VM_TIMEOUT_MS,
        filename: "legacy-probe.js",
      });
      if (settle) output = this.settleInContext(ctx, sandbox, output, budgetLeft);

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
      if (thrown instanceof SandboxError) throw thrown;
      if (ownDataString(thrown, "code") === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
        throw new SandboxError("TIMEOUT", `Probe exceeded ${VM_TIMEOUT_MS}ms execution limit`);
      }
      throw new SandboxError("EXECUTION_ERROR", describeThrown(thrown instanceof AsyncRejection ? thrown.thrown : thrown));
    }
  }
}
