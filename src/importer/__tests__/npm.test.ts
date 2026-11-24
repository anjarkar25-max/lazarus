import { createHash } from "node:crypto";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_NPM_BYTES,
  NpmImportError,
  findExternalDependencies,
  importNpmPackage,
  parsePackageSpec,
  statusFor,
  type FetchLike,
  type NpmErrorCode,
} from "../npm.js";

const LEFT_PAD = `module.exports = leftPad;
function leftPad (str, len, ch) {
  str = String(str);
  var i = -1;
  if (!ch && ch !== 0) ch = ' ';
  len = len - str.length;
  while (++i < len) {
    str = ch + str;
  }
  return str;
}
`;

const js = (body: string, init: ResponseInit = {}): Response => new Response(body, { status: 200, headers: { "content-type": "application/javascript" }, ...init });
const status = (code: number): Response => new Response("", { status: code });
const redirect = (to: string, code = 302): Response => new Response(null, { status: code, headers: { location: to } });

/** Routes by URL; records every URL that was requested. */
function mockFetch(routes: Record<string, () => Response | Promise<Response>>): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    calls.push(input);
    const route = routes[input];
    if (route === undefined) return status(404);
    return route();
  };
  return { fetch: fetchImpl, calls };
}

const UNPKG = "https://unpkg.com/left-pad@1.3.0";
const JSDELIVR = "https://cdn.jsdelivr.net/npm/left-pad@1.3.0";

async function failure(promise: Promise<unknown>): Promise<NpmImportError> {
  try {
    await promise;
  } catch (err: unknown) {
    if (err instanceof NpmImportError) return err;
    throw err;
  }
  throw new Error("expected the import to fail");
}

describe("parsePackageSpec", () => {
  it.each([
    ["left-pad@1.3.0", "left-pad", "1.3.0"],
    ["is-number@3.0.0", "is-number", "3.0.0"],
    ["@scope/pkg@1.0.0", "@scope/pkg", "1.0.0"],
    ["@types/node@20.1.0-beta.2", "@types/node", "20.1.0-beta.2"],
    ["decamelize@1.2.0", "decamelize", "1.2.0"],
  ])("accepts %s", (spec, name, version) => {
    expect(parsePackageSpec(spec)).toEqual({ name, version, spec });
  });

  it.each([
    "",
    "left-pad",
    "left-pad@latest",
    "left-pad@^1.0.0",
    "left-pad@1",
    "left-pad@1.3",
    "../etc/passwd@1.0.0",
    "left-pad/../x@1.0.0",
    "@scope/../x@1.0.0",
    "a@1.0.0/../b",
    "https://evil.com/x@1.0.0",
    "//evil.com/x@1.0.0",
    "left-pad@1.3.0?x=1",
    "left-pad@1.3.0#frag",
    "left-pad@1.3.0;rm -rf /",
    "left-pad@1.3.0 && ls",
    "left-pad@1.3.0|cat",
    "$(id)@1.0.0",
    "`id`@1.0.0",
    "Left-Pad@1.3.0",
    ".hidden@1.0.0",
    "pkg name@1.0.0",
    "pkg\n@1.0.0",
    "@scope@1.0.0",
    `x${"a".repeat(300)}@1.0.0`,
  ])("rejects %j before any network access", (spec) => {
    const error = (() => {
      try {
        parsePackageSpec(spec);
        return undefined;
      } catch (err: unknown) {
        return err;
      }
    })();
    expect(error).toBeInstanceOf(NpmImportError);
    expect((error as NpmImportError).code).toBe("INVALID_SPEC");
  });

  it("rejects non-string input", () => {
    expect(() => parsePackageSpec({ toString: () => "left-pad@1.3.0" })).toThrow(NpmImportError);
  });

  it("never accepts a spec containing characters outside the npm alphabet (property)", () => {
    const bad = fc.stringMatching(/^[a-z0-9]{1,8}$/).chain((name) =>
      fc.constantFrom("/", "\\", "?", "#", ":", ";", "&", "|", "$", "`", " ", "\n", "%", "..", "*", "'", '"', "<", ">", "(", ")").map((c) => `${name}${c}${name}@1.0.0`)
    );
    fc.assert(
      fc.property(bad, (spec) => {
        // Only "/" is legal, and only as the scope separator of a spec that starts with "@".
        expect(() => parsePackageSpec(spec)).toThrow(NpmImportError);
      })
    );
  });
});

describe("importNpmPackage", () => {
  it("fetches the entry file from unpkg and extracts metadata with the AST scanner", async () => {
    const { fetch, calls } = mockFetch({ [UNPKG]: () => js(LEFT_PAD) });
    const result = await importNpmPackage("left-pad@1.3.0", { fetch });
    expect(calls).toEqual([UNPKG]);
    expect(result).toMatchObject({ packageName: "left-pad", version: "1.3.0", spec: "left-pad@1.3.0", cdnHost: "unpkg.com", url: UNPKG, functionName: "leftPad" });
    expect(result.byteLength).toBe(Buffer.byteLength(LEFT_PAD));
    expect(result.sha256).toBe(createHash("sha256").update(LEFT_PAD).digest("hex"));
    expect(result.source).toBe(LEFT_PAD);
    expect(result.detectedIdioms).toEqual(expect.arrayContaining(["ES5 var declaration", "CommonJS export"]));
    expect(Object.keys(result.suggestedSchema)).toEqual(["str", "len", "ch"]);
    expect(result.extractedExpression).toContain("leftPad");
  });

  it("supports scoped packages", async () => {
    const url = "https://unpkg.com/@scope/pkg@1.0.0";
    const { fetch, calls } = mockFetch({ [url]: () => js("module.exports = function (n) { return n | 0; };") });
    const result = await importNpmPackage("@scope/pkg@1.0.0", { fetch });
    expect(calls).toEqual([url]);
    expect(result.packageName).toBe("@scope/pkg");
    expect(result.detectedIdioms).toContain("32-bit bitwise truncation (| 0)");
  });

  it("follows a redirect inside the allowlist, one hop at a time with redirect: manual", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const target = "https://unpkg.com/left-pad@1.3.0/index.js";
    const fetchImpl: FetchLike = async (input, init) => {
      seen.push(init);
      return input === UNPKG ? redirect("/left-pad@1.3.0/index.js") : js(LEFT_PAD);
    };
    const result = await importNpmPackage("left-pad@1.3.0", { fetch: fetchImpl });
    expect(result.url).toBe(target);
    expect(seen.every((init) => init?.redirect === "manual")).toBe(true);
  });

  it("can follow a redirect from unpkg to jsDelivr (both allowlisted)", async () => {
    const { fetch } = mockFetch({ [UNPKG]: () => redirect(JSDELIVR), [JSDELIVR]: () => js(LEFT_PAD) });
    const result = await importNpmPackage("left-pad@1.3.0", { fetch });
    expect(result.cdnHost).toBe("cdn.jsdelivr.net");
  });

  describe("SSRF and hostile redirects", () => {
    it.each([
      ["plain HTTP", "http://unpkg.com/left-pad@1.3.0/index.js"],
      ["foreign host", "https://evil.example/left-pad.js"],
      ["cloud metadata", "https://169.254.169.254/latest/meta-data/"],
      ["localhost", "https://localhost/x.js"],
      ["look-alike suffix", "https://unpkg.com.evil.example/x.js"],
      ["look-alike prefix", "https://evilunpkg.com/x.js"],
      ["credentials in URL", "https://user:pass@unpkg.com/x.js"],
      ["custom port", "https://unpkg.com:8443/x.js"],
      ["file scheme", "file:///etc/passwd"],
      ["path traversal", "https://unpkg.com/left-pad@1.3.0/../../etc/passwd"],
    ])("never follows a redirect to %s", async (_label, location) => {
      const { fetch, calls } = mockFetch({ [UNPKG]: () => redirect(location), [JSDELIVR]: () => redirect(location) });
      const error = await failure(importNpmPackage("left-pad@1.3.0", { fetch }));
      expect(error.code).toBe("REDIRECT_REJECTED");
      expect(statusFor(error.code)).toBe(502);
      expect(calls).toEqual([UNPKG, JSDELIVR]);
    });

    it("stops redirect loops after 3 hops", async () => {
      const fetchImpl: FetchLike = async () => redirect("https://unpkg.com/loop");
      const error = await failure(importNpmPackage("left-pad@1.3.0", { fetch: fetchImpl }));
      expect(error.code).toBe("REDIRECT_REJECTED");
    });

    it("falls back to jsDelivr when unpkg tries to redirect somewhere hostile", async () => {
      const { fetch } = mockFetch({ [UNPKG]: () => redirect("https://evil.example/x.js"), [JSDELIVR]: () => js(LEFT_PAD) });
      const result = await importNpmPackage("left-pad@1.3.0", { fetch });
      expect(result.cdnHost).toBe("cdn.jsdelivr.net");
    });
  });

  describe("32 KB cap", () => {
    it("rejects a declared Content-Length over the cap without reading the body, and does not fall back", async () => {
      const { fetch, calls } = mockFetch({ [UNPKG]: () => js(LEFT_PAD, { headers: { "content-length": String(MAX_NPM_BYTES + 1) } }) });
      const error = await failure(importNpmPackage("left-pad@1.3.0", { fetch }));
      expect(error.code).toBe("TOO_LARGE");
      expect(statusFor(error.code)).toBe(413);
      expect(calls).toEqual([UNPKG]);
    });

    it("rejects an oversized body that has no Content-Length (streaming)", async () => {
      const big = `var a = 1;\n${"// pad\n".repeat(6000)}`;
      expect(Buffer.byteLength(big)).toBeGreaterThan(MAX_NPM_BYTES);
      const { fetch } = mockFetch({ [UNPKG]: () => js(big) });
      expect((await failure(importNpmPackage("left-pad@1.3.0", { fetch }))).code).toBe("TOO_LARGE");
    });

    it("stops reading once the cap is passed", async () => {
      let pulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(8 * 1024).fill(120));
        },
      });
      const { fetch } = mockFetch({ [UNPKG]: () => new Response(stream, { status: 200 }) });
      expect((await failure(importNpmPackage("left-pad@1.3.0", { fetch }))).code).toBe("TOO_LARGE");
      expect(pulled).toBeLessThan(10);
    });

    it("accepts a file of exactly 32 KB", async () => {
      const filler = "x".repeat(MAX_NPM_BYTES - "module.exports = function (n) { return n; }; //".length);
      const source = `module.exports = function (n) { return n; }; //${filler}`;
      expect(Buffer.byteLength(source)).toBe(MAX_NPM_BYTES);
      const { fetch } = mockFetch({ [UNPKG]: () => js(source) });
      expect((await importNpmPackage("left-pad@1.3.0", { fetch })).byteLength).toBe(MAX_NPM_BYTES);
    });
  });

  describe("CDN fallback", () => {
    it("falls back to jsDelivr when unpkg returns 404", async () => {
      const { fetch, calls } = mockFetch({ [JSDELIVR]: () => js(LEFT_PAD) });
      const result = await importNpmPackage("left-pad@1.3.0", { fetch });
      expect(calls).toEqual([UNPKG, JSDELIVR]);
      expect(result.cdnHost).toBe("cdn.jsdelivr.net");
      expect(result.url).toBe(JSDELIVR);
    });

    it.each([
      ["a 503", () => status(503)],
      ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
    ])("falls back to jsDelivr after %s from unpkg", async (_label, first) => {
      const { fetch } = mockFetch({ [UNPKG]: first, [JSDELIVR]: () => js(LEFT_PAD) });
      expect((await importNpmPackage("left-pad@1.3.0", { fetch })).cdnHost).toBe("cdn.jsdelivr.net");
    });

    it("falls back when unpkg hangs past the timeout, and the hung request is aborted", async () => {
      let aborted = false;
      const fetchImpl: FetchLike = (input, init) => {
        if (input === UNPKG) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        }
        return Promise.resolve(js(LEFT_PAD));
      };
      const result = await importNpmPackage("left-pad@1.3.0", { fetch: fetchImpl, timeoutMs: 40 });
      expect(result.cdnHost).toBe("cdn.jsdelivr.net");
      expect(aborted).toBe(true);
    });

    it("reports TIMEOUT when every CDN hangs, even if the mock ignores the abort signal", async () => {
      const fetchImpl: FetchLike = () => new Promise<Response>(() => undefined);
      const error = await failure(importNpmPackage("left-pad@1.3.0", { fetch: fetchImpl, timeoutMs: 30 }));
      expect(error.code).toBe("TIMEOUT");
      expect(statusFor(error.code)).toBe(504);
    });

    it("reports NOT_FOUND only when both CDNs say the package is missing", async () => {
      const { fetch } = mockFetch({});
      const error = await failure(importNpmPackage("left-pad@1.3.0", { fetch }));
      expect(error.code).toBe("NOT_FOUND");
      expect(error.message).toContain("does not exist");
      expect(statusFor(error.code)).toBe(404);
    });

    it("reports UPSTREAM_ERROR when one CDN is missing and the other is down", async () => {
      const { fetch } = mockFetch({ [JSDELIVR]: () => status(500) });
      expect((await failure(importNpmPackage("left-pad@1.3.0", { fetch }))).code).toBe("UPSTREAM_ERROR");
    });
  });

  describe("sources that cannot run in the sandbox", () => {
    it("refuses a package that require()s another package, and says which", async () => {
      const source = "var typeOf = require('kind-of');\nmodule.exports = function isNumber(num) { return typeOf(num) === 'number'; };";
      const { fetch } = mockFetch({ [UNPKG]: () => js(source) });
      const error = await failure(importNpmPackage("left-pad@1.3.0", { fetch }));
      expect(error.code).toBe("HAS_DEPENDENCIES");
      expect(error.details?.dependencies).toEqual(["kind-of"]);
      expect(error.message).toContain("kind-of");
      expect(statusFor(error.code)).toBe(422);
    });

    it("never falls back to the other CDN for a dependency problem", async () => {
      const { fetch, calls } = mockFetch({ [UNPKG]: () => js("module.exports = require('x');") });
      await failure(importNpmPackage("left-pad@1.3.0", { fetch }));
      expect(calls).toEqual([UNPKG]);
    });

    it.each([
      ["relative require", "var h = require('./helper');", ["./helper"]],
      ["dynamic require", "var n = 'x'; var m = require(n);", ["<dynamic>"]],
      ["nested require", "function f(){ return require('fs').readFileSync; }", ["fs"]],
      ["several", "var a = require('a'), b = require(\"b\"), a2 = require('a');", ["a", "b"]],
      ["ES import", "import x from 'dep';\nexport default x;", ["dep"]],
    ])("detects %s", (_label, source, expected) => {
      expect(findExternalDependencies(source)).toEqual(expected);
    });

    it("does not flag a locally declared require or a mere mention", () => {
      expect(findExternalDependencies("function require(x) { return x; }\nmodule.exports = require(1);")).toEqual([]);
      expect(findExternalDependencies("var has = typeof require === 'function';\nmodule.exports = has;")).toEqual([]);
      expect(findExternalDependencies("var o = { require: 1 }; module.exports = o.require;")).toEqual([]);
    });

    it("rejects empty and unparsable entry files honestly", async () => {
      const empty = await failure(importNpmPackage("left-pad@1.3.0", { fetch: mockFetch({ [UNPKG]: () => js("  \n") }).fetch }));
      expect(empty.code).toBe("EMPTY");
      const broken = await failure(importNpmPackage("left-pad@1.3.0", { fetch: mockFetch({ [UNPKG]: () => js("function ( {") }).fetch }));
      expect(broken.code).toBe("PARSE_ERROR");
    });
  });

  it("validates the spec before touching the network", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return js(LEFT_PAD);
    };
    expect((await failure(importNpmPackage("../../etc/passwd@1.0.0", { fetch: fetchImpl }))).code).toBe("INVALID_SPEC");
    expect(called).toBe(false);
  });

  it("maps every error code to an HTTP status", () => {
    const codes: NpmErrorCode[] = ["INVALID_SPEC", "NOT_FOUND", "TOO_LARGE", "TIMEOUT", "UPSTREAM_ERROR", "REDIRECT_REJECTED", "HAS_DEPENDENCIES", "PARSE_ERROR", "EMPTY"];
    expect(codes.map(statusFor)).toEqual([400, 404, 413, 504, 502, 502, 422, 422, 422]);
  });
});
