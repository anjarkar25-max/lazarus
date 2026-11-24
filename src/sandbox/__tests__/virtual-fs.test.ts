import * as fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { SandboxError } from "../errors.js";
import { PooledProbeRunner } from "../pool.js";
import { MAX_VIRTUAL_FILES, MAX_VIRTUAL_FILE_BYTES, normalizeVirtualPath, resolveRelative, validateVirtualFiles, withVirtualFiles } from "../virtual-fs.js";
import { isProbeParams } from "../validate.js";
import { VmProbeExecutor } from "../vm-executor.js";

const exec = new VmProbeExecutor();

async function failure(promise: Promise<unknown>): Promise<SandboxError> {
  try {
    await promise;
  } catch (err: unknown) {
    if (err instanceof SandboxError) return err;
    throw err;
  }
  throw new Error("expected the probe to fail");
}

const FILES = {
  "index.cjs": "var math = require('./lib/math.cjs'); var fmt = require('./lib/fmt'); module.exports = function (a, b) { return fmt.show(math.add(a, b)); };",
  "lib/math.cjs": "var base = require('../base.js'); exports.add = function (a, b) { return base.id(a) + base.id(b); };",
  "lib/fmt.js": "exports.show = function (n) { return '<' + n + '>'; };",
  "base.js": "exports.id = function (x) { return x; };",
};

describe("virtual CommonJS loader", () => {
  it("resolves nested relative modules, ../ hops, and extension/index lookups", async () => {
    const res = await exec.run({ code: "require('./index.cjs')(a, b)", context: { a: 2, b: 3 }, files: FILES, entry: "index.cjs" });
    expect(res.output).toBe("<5>");
    const index = await exec.run({ code: "require('./lib/fmt').show(1) + require('./lib/math').add(1, 2)", files: FILES, entry: "index.cjs" });
    expect(index.output).toBe("<1>3");
    const dir = await exec.run({ code: "require('./pkg').v", files: { "pkg/index.js": "exports.v = 7;" } });
    expect(dir.output).toBe(7);
  });

  it("resolves relative to the entry's directory", async () => {
    const res = await exec.run({ code: "require('./util').v", files: { "src/main.js": "", "src/util.js": "exports.v = 'nested';" }, entry: "src/main.js" });
    expect(res.output).toBe("nested");
  });

  it("caches modules: one instance per file, shared by every requirer", async () => {
    const files = { "counter.js": "var n = 0; exports.next = function () { return ++n; };", "a.js": "module.exports = require('./counter.js');", "b.js": "module.exports = require('./counter.js');" };
    const res = await exec.run({ code: "[require('./a.js').next(), require('./b.js').next(), require('./counter.js') === require('./a.js')].join()", files });
    expect(res.output).toBe("1,2,true");
  });

  it("gives every probe a fresh module cache (no state across probes)", async () => {
    const files = { "counter.js": "var n = 0; exports.next = function () { return ++n; };" };
    const first = await exec.run({ code: "require('./counter.js').next()", files });
    const second = await exec.run({ code: "require('./counter.js').next()", files });
    expect([first.output, second.output]).toEqual([1, 1]);
  });

  it("handles circular requires with partial exports instead of crashing", async () => {
    const files = {
      "a.js": "exports.early = 'a-early'; var b = require('./b.js'); exports.fromB = b.sawA; exports.late = 'a-late';",
      "b.js": "var a = require('./a.js'); exports.sawA = a.early + '|' + String(a.late);",
    };
    const res = await exec.run({ code: "var a = require('./a.js'); [a.early, a.fromB, a.late].join()", files });
    expect(res.output).toBe("a-early,a-early|undefined,a-late");
  });

  it("does not cache a module that threw, and reports the error", async () => {
    const files = { "bad.js": "throw new Error('boom from bad.js');" };
    const err = await failure(exec.run({ code: "require('./bad.js')", files }));
    expect(err.code).toBe("EXECUTION_ERROR");
    expect(err.message).toContain("boom from bad.js");
  });

  describe("blocked requires", () => {
    it.each(["fs", "os", "child_process", "node:fs", "path", "http", "lodash", "/etc/passwd", "C:/Windows/win.ini", "", "fs/promises"])("blocks require(%j) from probe code", async (spec) => {
      const err = await failure(exec.run({ code: `require(${JSON.stringify(spec)})`, files: FILES, entry: "index.cjs" }));
      expect(err.code).toBe("EXECUTION_ERROR");
      expect(err.message).toContain("[lazarus sandbox]");
    });

    it.each(["../../etc/passwd", "../outside.js", "./../../x", "./a/../../b", "./lib/../../../etc/hosts", ".\\..\\x"])("blocks traversal %j", async (spec) => {
      const err = await failure(exec.run({ code: `require(${JSON.stringify(spec)})`, files: FILES, entry: "index.cjs" }));
      expect(err.code).toBe("EXECUTION_ERROR");
      expect(err.message).toMatch(/outside the virtual module map|only relative paths|cannot find/);
    });

    it("blocks host modules requested from inside a virtual module too", async () => {
      const files = { "evil.js": "module.exports = require('child_process').execSync('echo pwned');" };
      const err = await failure(exec.run({ code: "require('./evil.js')", files }));
      expect(err.message).toContain("blocked require(\"child_process\")");
    });

    it("rejects non-string specifiers and missing files", async () => {
      expect((await failure(exec.run({ code: "require(42)", files: FILES }))).code).toBe("EXECUTION_ERROR");
      expect((await failure(exec.run({ code: "require('./nope.cjs')", files: FILES }))).message).toContain("cannot find module");
    });

    it("exposes no host realm through the loader's functions", async () => {
      const code = "var p = require.constructor('return process')(); [typeof p.exit, typeof p.mainModule, typeof p.binding].join()";
      const res = await exec.run({ code, files: FILES });
      expect(res.output).toBe("undefined,undefined,undefined");
    });

    it("never reads the host file system: a real path that exists on disk is still not found", async () => {
      const err = await failure(exec.run({ code: "require('./package.json')", files: FILES }));
      expect(err.message).toContain("cannot find module");
    });
  });

  it("has no require at all without a virtual file map", async () => {
    const res = await exec.run({ code: "typeof require" });
    expect(res.output).toBe("undefined");
  });

  it("works through the pooled worker (JSON-RPC) and keeps probes independent", async () => {
    await using pool = new PooledProbeRunner();
    const a = await pool.run({ code: "require('./index.cjs')(a, b)", context: { a: 4, b: 5 }, files: FILES, entry: "index.cjs" });
    expect(a.output).toBe("<9>");
    const blocked = await failure(pool.run({ code: "require('fs')", files: FILES }));
    expect(blocked.code).toBe("EXECUTION_ERROR");
    expect((await pool.run({ code: "typeof require" })).output).toBe("undefined");
    const wrapped = withVirtualFiles(pool, FILES, "index.cjs");
    expect(wrapped.supportsTaggedEncoding).toBe(true);
    expect((await wrapped.run({ code: "require('./lib/fmt.js').show(0)", encoding: "tagged" })).output).toBe("<0>");
  }, 20_000);
});

describe("resolveRelative (host twin of the loader)", () => {
  const known = new Set(Object.keys(FILES));
  it("matches the in-sandbox rules", () => {
    expect(resolveRelative(known, "index.cjs", "./lib/math.cjs")).toEqual({ ok: true, path: "lib/math.cjs" });
    expect(resolveRelative(known, "index.cjs", "./lib/fmt")).toEqual({ ok: true, path: "lib/fmt.js" });
    expect(resolveRelative(known, "lib/math.cjs", "../base")).toEqual({ ok: true, path: "base.js" });
    for (const spec of ["fs", "/abs", "../../x", "./missing", ""]) expect(resolveRelative(known, "index.cjs", spec).ok).toBe(false);
  });
});

describe("request validation", () => {
  it("normalizes paths and refuses anything that escapes", () => {
    expect(normalizeVirtualPath("a/./b/../c.js")).toBe("a/c.js");
    for (const bad of ["..", "../a", "a/../../b", "a\\b", "x\0y", "", "."]) expect(normalizeVirtualPath(bad)).toBeUndefined();
  });

  it("accepts a well-formed map and rejects unsafe ones", () => {
    expect(() => validateVirtualFiles(FILES, "index.cjs")).not.toThrow();
    const reject = (files: unknown, entry?: unknown): void => expect(() => validateVirtualFiles(files, entry)).toThrow(SandboxError);
    reject(null);
    reject([]);
    reject({ "../x.js": "1" });
    reject({ "/abs.js": "1" });
    reject({ "a//b.js": "1" });
    reject({ "a.js": 5 });
    reject({ "a.js": "x".repeat(MAX_VIRTUAL_FILE_BYTES + 1) });
    reject(Object.fromEntries(Array.from({ length: MAX_VIRTUAL_FILES + 1 }, (_, i) => [`f${i}.js`, "1"])));
    reject({ "a.js": "1" }, "missing.js");
    reject({ "a.js": "1" }, 5);
  });

  it("is enforced on probe params (JSON-RPC validation)", () => {
    expect(isProbeParams({ code: "1", files: FILES, entry: "index.cjs" })).toBe(true);
    expect(() => isProbeParams({ code: "1", files: { "../x": "1" } })).toThrow(SandboxError);
    expect(() => isProbeParams({ code: "1", entry: "index.cjs" })).toThrow(SandboxError);
  });

  it("never lets any file name escape the map (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("..", ".", "a", "b", "", "c.js"), { minLength: 1, maxLength: 6 }), (parts) => {
        const normalized = normalizeVirtualPath(parts.join("/"));
        if (normalized !== undefined) {
          expect(normalized.split("/").some((p) => p === ".." || p === "." || p === "")).toBe(false);
        }
      })
    );
  });
});

afterAll(() => undefined);
