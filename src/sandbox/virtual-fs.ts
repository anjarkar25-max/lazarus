// In-memory virtual CommonJS file system for sandbox probes.
//
// A probe may carry `files` (path -> source text) and an `entry` path. Inside the fresh vm context, `require()`
// resolves ONLY relative specifiers ("./", "../") against that map. There is no host fallback: `fs`, `child_process`,
// `node:*`, bare package names, absolute paths and anything that climbs out of the map all throw. The host file
// system is never read, because the module sources are plain strings that were handed over with the probe.
import { SandboxError } from "./errors.js";
import type { ProbeExecutor, ProbeParams, ProbeResult } from "./types.js";

export const MAX_VIRTUAL_FILES = 64;
export const MAX_VIRTUAL_FILE_BYTES = 64 * 1024;
export const MAX_VIRTUAL_TOTAL_BYTES = 512 * 1024;
/** Extensions tried (in order) when a specifier has none, then directory indexes. */
export const RESOLVE_SUFFIXES: readonly string[] = ["", ".js", ".cjs", "/index.js", "/index.cjs"];

/** Collapses `.` and `..` segments. Returns undefined when the path climbs above the root or is malformed. */
export function normalizeVirtualPath(path: string): string | undefined {
  if (path.includes("\0") || path.includes("\\")) return undefined;
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.length === 0 ? undefined : out.join("/");
}

export const dirnameOf = (path: string): string => {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
};

export type ResolveResult = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string };

/**
 * Host-side twin of the resolver that runs inside the sandbox. Used by the graph analyzer so both agree on
 * what a relative specifier means.
 */
export function resolveRelative(files: ReadonlySet<string>, fromFile: string, specifier: string): ResolveResult {
  if (specifier === "" || !(specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === "..")) {
    return { ok: false, reason: `only relative specifiers ("./" and "../") can be required inside the virtual module map; got "${specifier}"` };
  }
  const base = normalizeVirtualPath(`${dirnameOf(fromFile)}/${specifier}`);
  if (base === undefined) return { ok: false, reason: `"${specifier}" resolves outside the virtual module map` };
  for (const suffix of RESOLVE_SUFFIXES) {
    if (files.has(base + suffix)) return { ok: true, path: base + suffix };
  }
  return { ok: false, reason: `cannot find module "${specifier}" (from ${fromFile || "<entry>"}) in the virtual module map` };
}

/** Throws INVALID_REQUEST unless `files` and `entry` are safe to hand to the sandbox. */
export function validateVirtualFiles(files: unknown, entry: unknown): void {
  const bad = (message: string): never => {
    throw new SandboxError("INVALID_REQUEST", message);
  };
  if (typeof files !== "object" || files === null || Array.isArray(files)) return bad("params.files must be a plain object of path -> source");
  const names = Object.keys(files);
  if (names.length > MAX_VIRTUAL_FILES) bad(`params.files has ${names.length} entries; the limit is ${MAX_VIRTUAL_FILES}`);
  let total = 0;
  for (const name of names) {
    const source = (files as Record<string, unknown>)[name];
    if (typeof source !== "string") bad(`params.files["${name}"] must be a string`);
    const normalized = normalizeVirtualPath(name);
    if (normalized === undefined || normalized !== name || name === "__proto__") bad(`params.files has an unsafe or non-canonical path: "${name}"`);
    const size = Buffer.byteLength(source as string, "utf8");
    if (size > MAX_VIRTUAL_FILE_BYTES) bad(`params.files["${name}"] is ${size} bytes; the limit is ${MAX_VIRTUAL_FILE_BYTES}`);
    total += size;
  }
  if (total > MAX_VIRTUAL_TOTAL_BYTES) bad(`params.files totals ${total} bytes; the limit is ${MAX_VIRTUAL_TOTAL_BYTES}`);
  if (entry !== undefined) {
    if (typeof entry !== "string" || !Object.prototype.hasOwnProperty.call(files, entry)) bad("params.entry must name a file in params.files");
  }
}

/** Wraps an executor so every probe runs against the same virtual module map. */
export function withVirtualFiles(executor: ProbeExecutor, files: Readonly<Record<string, string>>, entry?: string): ProbeExecutor {
  return {
    ...(executor.supportsTaggedEncoding === true ? { supportsTaggedEncoding: true } : {}),
    run(params: ProbeParams): Promise<ProbeResult> {
      return executor.run({ ...params, files, ...(entry !== undefined ? { entry } : {}) });
    },
  };
}

/**
 * Source of the in-sandbox loader. It is evaluated INSIDE the fresh vm context (as part of the bootstrap), so the
 * module code, its `require` and its `module` objects all belong to the sandbox realm.
 * Defines `installVirtualRequire(g, filesJson, entry)`.
 */
export const VIRTUAL_REQUIRE_SOURCE = String.raw`
  function installVirtualRequire(g, filesJson, entry) {
    var raw = JSON.parse(filesJson);
    var files = Object.create(null);
    Object.keys(raw).forEach(function (k) { Object.defineProperty(files, k, { value: raw[k], enumerable: true }); });
    var cache = Object.create(null);
    var SUFFIXES = ["", ".js", ".cjs", "/index.js", "/index.cjs"];
    function fail(message) { throw new Error("[lazarus sandbox] " + message); }
    function dirname(p) { var i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
    function normalize(p) {
      if (p.indexOf("\0") >= 0 || p.indexOf("\\") >= 0) return null;
      var out = [];
      var parts = p.split("/");
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        if (part === "" || part === ".") continue;
        if (part === "..") { if (out.length === 0) return null; out.pop(); } else { out.push(part); }
      }
      return out.length === 0 ? null : out.join("/");
    }
    function resolve(fromDir, spec) {
      if (typeof spec !== "string" || spec === "") fail("require() needs a non-empty string specifier");
      if (!(spec.indexOf("./") === 0 || spec.indexOf("../") === 0 || spec === "." || spec === "..")) {
        fail("blocked require(" + JSON.stringify(spec) + "): only relative paths inside the virtual module map can be required (host modules such as fs, os and child_process, node: modules, packages and absolute paths are not available)");
      }
      var base = normalize(fromDir + "/" + spec);
      if (base === null) fail("blocked require(" + JSON.stringify(spec) + "): path resolves outside the virtual module map");
      for (var i = 0; i < SUFFIXES.length; i++) {
        var candidate = base + SUFFIXES[i];
        if (Object.prototype.hasOwnProperty.call(files, candidate)) return candidate;
      }
      fail("cannot find module " + JSON.stringify(spec) + " in the virtual module map");
    }
    function load(path) {
      var cached = cache[path];
      if (cached !== undefined) return cached.exports;
      var module = { exports: {}, id: path, filename: path, loaded: false };
      cache[path] = module;
      var dir = dirname(path);
      var localRequire = function require(spec) { return load(resolve(dir, spec)); };
      try {
        var factory = new Function("exports", "require", "module", "__filename", "__dirname", files[path]);
        factory.call(module.exports, module.exports, localRequire, module, path, dir);
      } catch (e) {
        delete cache[path];
        throw e;
      }
      module.loaded = true;
      return module.exports;
    }
    var baseDir = typeof entry === "string" ? dirname(entry) : "";
    Object.defineProperty(g, "require", {
      value: function require(spec) { return load(resolve(baseDir, spec)); },
      writable: true, configurable: true, enumerable: false
    });
  }
`;
