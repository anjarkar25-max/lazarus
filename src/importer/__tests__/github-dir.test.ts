import type { AddressInfo } from "node:net";
import * as fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebServer } from "../../web/server.js";
import {
  GitHubDirError,
  MAX_DIR_FILES,
  MAX_DIR_FILE_BYTES,
  MAX_DIR_TOTAL_BYTES,
  assertAllowedGitHubUrl,
  importGitHubFolder,
  listingUrl,
  parseGitHubFolderUrl,
  rawFileUrl,
  statusForGitHubDir,
  type GitHubDirErrorCode,
} from "../github-dir.js";
import type { FetchLike } from "../npm.js";

// Offline only: every request goes to an injected fetch that answers from a route table and records the URLs.
const FOLDER = "https://github.com/acme/legacy-billing/tree/main/lib";
const LISTING = "https://api.github.com/repos/acme/legacy-billing/contents/lib?ref=main";
const RAW = (name: string): string => `https://raw.githubusercontent.com/acme/legacy-billing/main/lib/${name}`;
const MONEY = "function addCents(a, b) { return (a + b) | 0; }\nexports.addCents = addCents;\n";
const INVOICE = "var money = require('./money.cjs');\nfunction total(a, n) { var s = 0; for (var i = 0; i < n; i++) s = money.addCents(s, a); return s; }\nmodule.exports = { total: total };\n";

const json = (body: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
const text = (body: string, init: ResponseInit = {}): Response => new Response(body, { status: 200, ...init });
const entry = (name: string, size: number, type = "file"): Record<string, unknown> => ({
  name,
  type,
  size,
  path: `lib/${name}`,
  // Never used by the importer: it builds raw URLs itself.
  download_url: `https://evil.example/${name}`,
});

function mockFetch(routes: Record<string, () => Response | Promise<Response>>): { fetch: FetchLike; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: input, init });
    const route = routes[input];
    if (route === undefined) return new Response("", { status: 404 });
    return route();
  };
  return { fetch: fetchImpl, calls };
}

function billing(extra: Record<string, () => Response> = {}): ReturnType<typeof mockFetch> {
  return mockFetch({
    [LISTING]: () => json([entry("money.cjs", MONEY.length), entry("invoice.cjs", INVOICE.length), entry("README.md", 300), entry("test", 0, "dir"), entry("logo.png", 900)]),
    [RAW("money.cjs")]: () => text(MONEY),
    [RAW("invoice.cjs")]: () => text(INVOICE),
    ...extra,
  });
}

async function failure(promise: Promise<unknown>): Promise<GitHubDirError> {
  try {
    await promise;
  } catch (err: unknown) {
    if (err instanceof GitHubDirError) return err;
    throw err;
  }
  throw new Error("expected the import to fail");
}

describe("parseGitHubFolderUrl", () => {
  it("accepts a folder URL and the repository root", () => {
    expect(parseGitHubFolderUrl(FOLDER)).toEqual({ owner: "acme", repo: "legacy-billing", branch: "main", path: "lib" });
    expect(parseGitHubFolderUrl("https://github.com/acme/legacy-billing/tree/v1.2.0/src/legacy/money/")).toEqual({ owner: "acme", repo: "legacy-billing", branch: "v1.2.0", path: "src/legacy/money" });
    expect(parseGitHubFolderUrl("https://github.com/acme/legacy-billing/tree/main")).toMatchObject({ path: "" });
    // Query strings and fragments are ignored.
    expect(parseGitHubFolderUrl(`${FOLDER}?tab=readme#top`)).toMatchObject({ path: "lib" });
  });

  it.each([
    ["", "required"],
    ["not a url", "valid URL"],
    ["http://github.com/acme/legacy-billing/tree/main/lib", "https"],
    ["https://user:pw@github.com/acme/legacy-billing/tree/main/lib", "credentials"],
    ["https://github.com:8443/acme/legacy-billing/tree/main/lib", "port"],
    ["https://gitlab.com/acme/legacy-billing/tree/main/lib", "github.com"],
    ["https://github.com.evil.example/acme/legacy-billing/tree/main/lib", "github.com"],
    ["https://api.github.com/repos/acme/legacy-billing/contents/lib", "github.com"],
    ["https://raw.githubusercontent.com/acme/legacy-billing/main/lib/a.js", "github.com"],
    ["https://127.0.0.1/acme/legacy-billing/tree/main/lib", "github.com"],
    ["https://github.com/acme/legacy-billing/blob/main/lib/a.js", "tree"],
    ["https://github.com/acme/legacy-billing", "tree"],
    ["https://github.com/acme/legacy-billing/tree/main/%2e%2e/secrets", "percent-encoded"],
    ["https://github.com/acme/legacy-billing/tree/main/lib%2F..%2F..", "percent-encoded"],
    ["https://github.com/acme/legacy-billing/tree/main/lib/../../../other-repo", "segments"],
    ["https://github.com/acme/legacy-billing/tree/main/./lib", "segments"],
    ["https://github.com/-acme/legacy-billing/tree/main/lib", "owner"],
    ["https://github.com/acme/legacy billing/tree/main/lib", "percent-encoded"],
    ["https://github.com/acme/legacy-billing/tree/main/a/b/c/d/e/f/g/h/i", "deeper"],
    ["https://github.com/acme/legacy-billing/tree/ma~in/lib", "branch"],
  ])("rejects %j (%s)", (raw, reason) => {
    let error: unknown;
    try {
      parseGitHubFolderUrl(raw);
    } catch (err: unknown) {
      error = err;
    }
    expect(error).toBeInstanceOf(GitHubDirError);
    expect((error as GitHubDirError).code).toBe("INVALID_URL");
    expect((error as GitHubDirError).message).toContain(reason);
  });

  it("rejects non-strings", () => {
    for (const raw of [undefined, null, 42, { url: FOLDER }]) expect(() => parseGitHubFolderUrl(raw)).toThrow(GitHubDirError);
  });

  it("only ever builds URLs on the two allowlisted hosts (property)", () => {
    const seg = fc.stringMatching(/^[A-Za-z0-9._-]{1,12}$/).filter((s) => s !== "." && s !== "..");
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9]{1,10}$/), seg, seg, fc.array(seg, { maxLength: 4 }), seg, (owner, repo, ref, path, name) => {
        const folder = parseGitHubFolderUrl(`https://github.com/${owner}/${repo}/tree/${ref}/${path.join("/")}`);
        const listing = listingUrl(folder);
        const raw = rawFileUrl(folder, `${name}.js`);
        expect(listing.hostname).toBe("api.github.com");
        expect(raw.hostname).toBe("raw.githubusercontent.com");
        expect(listing.pathname.startsWith(`/repos/${owner}/`)).toBe(true);
        expect(raw.pathname.startsWith(`/${owner}/`)).toBe(true);
        assertAllowedGitHubUrl(listing);
        assertAllowedGitHubUrl(raw);
      })
    );
  });

  it("assertAllowedGitHubUrl blocks everything else", () => {
    for (const u of ["http://api.github.com/x", "https://evil.example/x", "https://api.github.com:444/x", "https://a:b@raw.githubusercontent.com/x", "https://169.254.169.254/latest/meta-data"]) {
      expect(() => assertAllowedGitHubUrl(new URL(u)), u).toThrow(GitHubDirError);
    }
  });
});

describe("importGitHubFolder (injected fetch)", () => {
  it("imports the top-level .js/.cjs files into a virtual file map with the analyzer's entry", async () => {
    const m = billing();
    const result = await importGitHubFolder(FOLDER, { fetch: m.fetch });
    expect(result.files).toEqual({ "invoice.cjs": INVOICE, "money.cjs": MONEY });
    expect(result.entry).toBe("invoice.cjs");
    expect(result).toMatchObject({ repo: "acme/legacy-billing", branch: "main", path: "lib", totalBytes: MONEY.length + INVOICE.length, sourceUrl: FOLDER });
    expect(result.edges).toEqual([{ from: "invoice.cjs", to: "money.cjs" }]);
    expect(result.skipped.map((s) => s.name).sort()).toEqual(["README.md", "logo.png", "test"]);
    expect(result.skipped.find((s) => s.name === "test")?.reason).toContain("one level deep");
    // Exactly one listing call and one raw call per file; GitHub's download_url is never followed.
    expect(m.calls.map((c) => c.url).sort()).toEqual([LISTING, RAW("invoice.cjs"), RAW("money.cjs")].sort());
    for (const c of m.calls) {
      expect(c.init?.redirect).toBe("manual");
      expect(c.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("encodes the repository root listing without a path", async () => {
    const m = mockFetch({
      "https://api.github.com/repos/acme/one/contents?ref=dev": () => json([entry("index.js", 20)]),
      "https://raw.githubusercontent.com/acme/one/dev/index.js": () => text("module.exports = 1;\n"),
    });
    const result = await importGitHubFolder("https://github.com/acme/one/tree/dev", { fetch: m.fetch });
    expect(Object.keys(result.files)).toEqual(["index.js"]);
    expect(result.entry).toBe("index.js");
  });

  it("never calls fetch for an invalid or non-GitHub URL", async () => {
    const m = billing();
    for (const raw of ["https://evil.example/acme/legacy-billing/tree/main/lib", "http://localhost:3000/api/kiro-dna", "file:///etc/passwd"]) {
      expect((await failure(importGitHubFolder(raw, { fetch: m.fetch }))).code).toBe("INVALID_URL");
    }
    expect(m.calls).toEqual([]);
  });

  it.each([
    ["http://169.254.169.254/latest/meta-data", "non-HTTPS"],
    ["https://evil.example/money.cjs", "blocked host"],
    ["https://raw.githubusercontent.com:8443/acme/legacy-billing/main/lib/money.cjs", "custom port"],
    ["https://raw.githubusercontent.com/acme/legacy-billing/main/lib/../../../etc/passwd", "path traversal"],
    ["/acme/legacy-billing/main/lib/%2e%2e/%2e%2e/x", "path traversal"],
  ])("validates a redirect to %s before following it (%s)", async (location, reason) => {
    const m = billing({ [RAW("money.cjs")]: () => new Response(null, { status: 302, headers: { location } }) });
    const err = await failure(importGitHubFolder(FOLDER, { fetch: m.fetch }));
    expect(err.code).toBe("REDIRECT_REJECTED");
    expect(err.message).toContain(reason);
    expect(m.calls.some((c) => c.url.includes("169.254") || c.url.includes("evil") || c.url.includes("8443") || c.url.includes("passwd"))).toBe(false);
  });

  it("follows a redirect that stays on the allowlisted hosts (a renamed repository)", async () => {
    const moved = "https://api.github.com/repositories/42/contents/lib?ref=main";
    const m = billing({
      [LISTING]: () => new Response(null, { status: 301, headers: { location: moved } }),
      [moved]: () => json([entry("money.cjs", MONEY.length)]),
    });
    const result = await importGitHubFolder(FOLDER, { fetch: m.fetch });
    expect(Object.keys(result.files)).toEqual(["money.cjs"]);
    expect(m.calls.map((c) => c.url)).toEqual([LISTING, moved, RAW("money.cjs")]);
  });

  it("stops after 3 redirects", async () => {
    const hop = (n: number): string => `https://api.github.com/repositories/${n}/contents/lib?ref=main`;
    const m = mockFetch({
      [LISTING]: () => new Response(null, { status: 302, headers: { location: hop(1) } }),
      [hop(1)]: () => new Response(null, { status: 302, headers: { location: hop(2) } }),
      [hop(2)]: () => new Response(null, { status: 302, headers: { location: hop(3) } }),
      [hop(3)]: () => new Response(null, { status: 302, headers: { location: hop(4) } }),
    });
    const err = await failure(importGitHubFolder(FOLDER, { fetch: m.fetch }));
    expect(err.code).toBe("REDIRECT_REJECTED");
    expect(err.message).toContain("more than 3 redirects");
    expect(m.calls).toHaveLength(4);
  });

  /** Imports a folder whose files are given inline (names and sources). */
  async function importFiles(files: Record<string, string>): Promise<string | undefined> {
    const routes: Record<string, () => Response> = { [LISTING]: () => json(Object.entries(files).map(([n, src]) => entry(n, Buffer.byteLength(src)))) };
    for (const [n, src] of Object.entries(files)) routes[RAW(n)] = () => text(src);
    return (await importGitHubFolder(FOLDER, { fetch: mockFetch(routes).fetch })).entry;
  }

  it("infers the entry module: a root that requires other files in the map", async () => {
    // index.js requires nothing, so the file that stitches the others together wins.
    expect(await importFiles({ "index.js": "module.exports = 1;", "app.cjs": "var a = require('./util.cjs'); module.exports = a;", "util.cjs": "module.exports = 2;" })).toBe("app.cjs");
    // Among linked roots: index/main first, then the widest reach.
    expect(await importFiles({ "main.cjs": "require('./a.cjs');", "z.cjs": "require('./a.cjs'); require('./b.cjs');", "a.cjs": "", "b.cjs": "" })).toBe("main.cjs");
    expect(await importFiles({ "small.cjs": "require('./a.cjs');", "wide.cjs": "require('./a.cjs'); require('./b.cjs');", "a.cjs": "", "b.cjs": "" })).toBe("wide.cjs");
    // Files that are only required never become the entry.
    expect(await importFiles({ "lib.cjs": "module.exports = 1;", "run.cjs": "module.exports = require('./lib.cjs');" })).toBe("run.cjs");
  });

  it("falls back to index.cjs, then index.js, then the first file when no file requires another", async () => {
    expect(await importFiles({ "a.js": "1;", "index.js": "2;", "index.cjs": "3;" })).toBe("index.cjs");
    expect(await importFiles({ "a.js": "1;", "index.js": "2;" })).toBe("index.js");
    expect(await importFiles({ "b.js": "1;", "a.js": "2;" })).toBe("a.js");
    // External requires are not edges inside the map.
    expect(await importFiles({ "cli.js": "var fs = require('fs');", "index.js": "module.exports = 1;" })).toBe("index.js");
  });

  it(`enforces the ${MAX_DIR_FILES}-file cap before fetching any file`, async () => {
    const names = Array.from({ length: MAX_DIR_FILES + 1 }, (_, i) => `m${i}.js`);
    const m = mockFetch({ [LISTING]: () => json(names.map((n) => entry(n, 10))) });
    const err = await failure(importGitHubFolder(FOLDER, { fetch: m.fetch }));
    expect(err.code).toBe("TOO_MANY_FILES");
    expect(err.details).toMatchObject({ count: MAX_DIR_FILES + 1, limit: MAX_DIR_FILES });
    expect(m.calls).toHaveLength(1);
  });

  it("accepts exactly the file-count cap", async () => {
    const names = Array.from({ length: MAX_DIR_FILES }, (_, i) => `m${i}.js`);
    const routes: Record<string, () => Response> = { [LISTING]: () => json(names.map((n) => entry(n, 14))) };
    for (const n of names) routes[RAW(n)] = () => text("exports.x = 1;");
    const result = await importGitHubFolder(FOLDER, { fetch: mockFetch(routes).fetch });
    expect(Object.keys(result.files)).toHaveLength(MAX_DIR_FILES);
  });

  it("enforces the per-file cap on the listed size and while reading the body", async () => {
    const listed = mockFetch({ [LISTING]: () => json([entry("big.js", MAX_DIR_FILE_BYTES + 1)]) });
    const a = await failure(importGitHubFolder(FOLDER, { fetch: listed.fetch }));
    expect(a.code).toBe("FILE_TOO_LARGE");
    expect(listed.calls).toHaveLength(1);
    // The listing understates the size: the streamed body is cut off at the cap.
    const lying = mockFetch({ [LISTING]: () => json([entry("big.js", 10)]), [RAW("big.js")]: () => text("x".repeat(MAX_DIR_FILE_BYTES + 1)) });
    const b = await failure(importGitHubFolder(FOLDER, { fetch: lying.fetch }));
    expect(b.code).toBe("FILE_TOO_LARGE");
    expect(b.details).toMatchObject({ file: "big.js" });
  });

  it("enforces the total byte cap", async () => {
    const size = MAX_DIR_FILE_BYTES;
    const names = ["a.js", "b.js", "c.js", "d.js", "e.js"];
    expect(size * names.length).toBeGreaterThan(MAX_DIR_TOTAL_BYTES);
    const m = mockFetch({ [LISTING]: () => json(names.map((n) => entry(n, size))) });
    const err = await failure(importGitHubFolder(FOLDER, { fetch: m.fetch }));
    expect(err.code).toBe("TOO_LARGE");
    expect(err.details).toMatchObject({ totalBytes: size * names.length, limit: MAX_DIR_TOTAL_BYTES });
    expect(m.calls).toHaveLength(1);
  });

  it("reports a folder without JavaScript, and a URL that names a file", async () => {
    const none = mockFetch({ [LISTING]: () => json([entry("README.md", 10), entry("src", 0, "dir")]) });
    expect((await failure(importGitHubFolder(FOLDER, { fetch: none.fetch }))).code).toBe("NO_JS_FILES");
    const file = mockFetch({ [LISTING]: () => json({ name: "lib", type: "file", size: 10 }) });
    expect((await failure(importGitHubFolder(FOLDER, { fetch: file.fetch }))).code).toBe("NOT_A_DIRECTORY");
  });

  it("skips unsafe names from the listing instead of fetching them", async () => {
    const m = billing({ [LISTING]: () => json([entry("money.cjs", MONEY.length), entry("..%2f..%2fetc.js", 5), entry(".hidden.js", 5), entry("a b.js", 5)]) });
    const result = await importGitHubFolder(FOLDER, { fetch: m.fetch });
    expect(Object.keys(result.files)).toEqual(["money.cjs"]);
    expect(result.skipped.map((s) => s.reason)).toEqual(["unsafe file name", "unsafe file name", "unsafe file name"]);
    expect(m.calls).toHaveLength(2);
  });

  it.each([
    [new Response('{"message":"API rate limit exceeded for 1.2.3.4."}', { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" } }), "RATE_LIMITED"],
    [new Response('{"message":"You have exceeded a secondary rate limit."}', { status: 403 }), "RATE_LIMITED"],
    [new Response("", { status: 429, headers: { "retry-after": "60" } }), "RATE_LIMITED"],
    [new Response('{"message":"Not Found"}', { status: 404 }), "NOT_FOUND"],
    [new Response('{"message":"Repository access blocked"}', { status: 403, headers: { "x-ratelimit-remaining": "42" } }), "FORBIDDEN"],
    [new Response("", { status: 500 }), "UPSTREAM_ERROR"],
    [new Response("<html>not json</html>", { status: 200 }), "UPSTREAM_ERROR"],
  ] as const)("maps listing response #%# to %s", async (response, code) => {
    const m = mockFetch({ [LISTING]: () => response.clone() });
    const err = await failure(importGitHubFolder(FOLDER, { fetch: m.fetch }));
    expect(err.code).toBe(code);
  });

  it("puts the reset time on a rate-limit error and maps it to HTTP 429", async () => {
    const m = mockFetch({ [LISTING]: () => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" } }) });
    const err = await failure(importGitHubFolder(FOLDER, { fetch: m.fetch }));
    expect(err.details).toMatchObject({ status: 403, resetAt: "2030-01-01T00:00:00.000Z" });
    expect(err.message).toContain("2030-01-01T00:00:00.000Z");
    expect(statusForGitHubDir(err.code)).toBe(429);
  });

  it("rate limits on a raw file fail the whole import (no partial graph)", async () => {
    const m = billing({ [RAW("invoice.cjs")]: () => new Response("", { status: 429 }) });
    expect((await failure(importGitHubFolder(FOLDER, { fetch: m.fetch }))).code).toBe("RATE_LIMITED");
  });

  it("times out with one deadline even when fetch ignores the abort signal", async () => {
    const m = mockFetch({ [LISTING]: () => new Promise<Response>(() => undefined) });
    const started = Date.now();
    const err = await failure(importGitHubFolder(FOLDER, { fetch: m.fetch, timeoutMs: 50 }));
    expect(err.code).toBe("TIMEOUT");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(m.calls[0]?.init?.signal?.aborted).toBe(true);
  });

  it("reports a network failure as UPSTREAM_ERROR", async () => {
    const failing: FetchLike = async () => {
      throw new TypeError("getaddrinfo ENOTFOUND api.github.com");
    };
    const err = await failure(importGitHubFolder(FOLDER, { fetch: failing }));
    expect(err.code).toBe("UPSTREAM_ERROR");
    expect(err.message).toContain("ENOTFOUND");
  });

  it("maps every error code to an HTTP status", () => {
    const codes: GitHubDirErrorCode[] = ["INVALID_URL", "NOT_FOUND", "NOT_A_DIRECTORY", "NO_JS_FILES", "TOO_MANY_FILES", "FILE_TOO_LARGE", "TOO_LARGE", "RATE_LIMITED", "FORBIDDEN", "TIMEOUT", "UPSTREAM_ERROR", "REDIRECT_REJECTED"];
    expect(codes.map(statusForGitHubDir)).toEqual([400, 404, 422, 422, 413, 413, 413, 429, 403, 504, 502, 502]);
  });
});

describe("POST /api/import/github-dir", () => {
  let routes: Record<string, () => Response> = {};
  const calls: string[] = [];
  const server = createWebServer({
    githubFetch: async (input) => {
      calls.push(input);
      const route = routes[input];
      return route === undefined ? new Response("", { status: 404 }) : route();
    },
  });
  let baseUrl = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
  const post = (body: unknown): Promise<Response> => fetch(`${baseUrl}/api/import/github-dir`, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("returns the file map ready for Tab 2", async () => {
    routes = {
      [LISTING]: () => json([entry("money.cjs", MONEY.length), entry("invoice.cjs", INVOICE.length)]),
      [RAW("money.cjs")]: () => text(MONEY),
      [RAW("invoice.cjs")]: () => text(INVOICE),
    };
    const res = await post({ url: FOLDER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: Record<string, string>; entry: string; repo: string; path: string; totalBytes: number };
    expect(body).toMatchObject({ entry: "invoice.cjs", repo: "acme/legacy-billing", path: "lib", totalBytes: MONEY.length + INVOICE.length });
    expect(Object.keys(body.files).sort()).toEqual(["invoice.cjs", "money.cjs"]);
  });

  it("answers structured errors with honest statuses", async () => {
    routes = { [LISTING]: () => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }) };
    const limited = await post({ url: FOLDER });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED", details: { status: 403 } });
    const before = calls.length;
    const ssrf = await post({ url: "https://169.254.169.254/latest/tree/main/x" });
    expect(ssrf.status).toBe(400);
    expect(await ssrf.json()).toMatchObject({ code: "INVALID_URL" });
    expect(calls.length).toBe(before);
  });

  it("accepts exactly { url: string }", async () => {
    for (const body of [{}, { url: 5 }, { url: FOLDER, extra: true }, [FOLDER], "not json"]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("INVALID_URL");
    }
  });
});
