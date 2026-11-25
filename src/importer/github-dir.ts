// Live importer for one GitHub folder of legacy CommonJS files (Tab 2, Multi-File Stitch Graph).
//
// The folder URL is validated segment by segment. Every outbound URL is built here from those segments and is
// checked against a two-host allowlist (api.github.com for the listing, raw.githubusercontent.com for file bodies)
// before it is fetched. Redirects are followed only to those hosts (at most 3), one deadline covers the whole import, and the listing is read one
// level deep. Files are size-capped and only PARSED (by the graph analyzer); they are never executed here.
import { z } from "zod";
import { analyzeGraph, type GraphEdge } from "../crew/graph-resurrector.js";
import type { FetchLike } from "./npm.js";

export const MAX_DIR_FILES = 8;
export const MAX_DIR_FILE_BYTES = 32 * 1024;
export const MAX_DIR_TOTAL_BYTES = 128 * 1024;
export const GITHUB_DIR_TIMEOUT_MS = 5000;
const MAX_PATH_SEGMENTS = 8;
const MAX_LISTING_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const API_HOST = "api.github.com";
const RAW_HOST = "raw.githubusercontent.com";
const ALLOWED_HOSTS: ReadonlySet<string> = new Set([API_HOST, RAW_HOST]);

export type GitHubDirErrorCode =
  | "INVALID_URL"
  | "NOT_FOUND"
  | "NOT_A_DIRECTORY"
  | "NO_JS_FILES"
  | "TOO_MANY_FILES"
  | "FILE_TOO_LARGE"
  | "TOO_LARGE"
  | "RATE_LIMITED"
  | "FORBIDDEN"
  | "TIMEOUT"
  | "UPSTREAM_ERROR"
  | "REDIRECT_REJECTED";

export class GitHubDirError extends Error {
  constructor(
    readonly code: GitHubDirErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "GitHubDirError";
  }
}

export function statusForGitHubDir(code: GitHubDirErrorCode): number {
  switch (code) {
    case "INVALID_URL":
      return 400;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "TOO_MANY_FILES":
    case "FILE_TOO_LARGE":
    case "TOO_LARGE":
      return 413;
    case "NOT_A_DIRECTORY":
    case "NO_JS_FILES":
      return 422;
    case "RATE_LIMITED":
      return 429;
    case "TIMEOUT":
      return 504;
    case "UPSTREAM_ERROR":
    case "REDIRECT_REJECTED":
      return 502;
  }
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
const JS_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.c?js$/i;

export interface GitHubFolder {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  /** Folder path inside the repository, "" for the repository root. */
  readonly path: string;
}

const FolderUrlSchema = z.string().trim().min(1, "url is required").max(500, "url is too long");

const invalid = (message: string): never => {
  throw new GitHubDirError("INVALID_URL", message);
};

/** Parses `https://github.com/{owner}/{repo}/tree/{branch}/{path}`; throws INVALID_URL with the reason. */
export function parseGitHubFolderUrl(raw: unknown): GitHubFolder {
  const checked = FolderUrlSchema.safeParse(raw);
  if (!checked.success) return invalid(checked.error.issues.map((i) => i.message).join("; "));
  // URL parsing silently decodes and collapses "%2e%2e" and ".." segments, so the raw text is checked first.
  const rawPath = checked.data.split(/[?#]/)[0] ?? "";
  if (rawPath.includes("%")) invalid("percent-encoded characters are not allowed in the folder path");
  if (/\/\.{1,2}(\/|$)/.test(rawPath)) invalid('"." and ".." segments are not allowed in the folder path');
  let url: URL;
  try {
    url = new URL(checked.data);
  } catch {
    return invalid("not a valid URL");
  }
  if (url.protocol !== "https:") invalid("only https:// GitHub folder URLs are allowed");
  if (url.username !== "" || url.password !== "") invalid("URLs with credentials are not allowed");
  if (url.port !== "") invalid("URLs with a custom port are not allowed");
  if (url.hostname.toLowerCase() !== "github.com") invalid(`host must be github.com (got ${url.hostname})`);
  // Encoded characters could hide separators or dots from the segment checks below.
  if (url.pathname.includes("%")) invalid("percent-encoded characters are not allowed in the folder path");
  const parts = url.pathname.split("/").filter((p) => p !== "");
  if (parts.length < 4 || parts[2] !== "tree") invalid("expected https://github.com/{owner}/{repo}/tree/{branch}/{path}");
  const [owner = "", repo = "", , branch = "", ...pathParts] = parts;
  if (!OWNER.test(owner)) invalid(`invalid GitHub owner "${owner}"`);
  const repoName = repo.replace(/\.git$/i, "");
  if (!SEGMENT.test(repoName) || repoName === "." || repoName === "..") invalid(`invalid repository name "${repo}"`);
  if (!SEGMENT.test(branch) || branch === "." || branch === "..") invalid(`invalid branch "${branch}" (branch names containing "/" are not supported)`);
  if (pathParts.length > MAX_PATH_SEGMENTS) invalid(`folder path is deeper than ${MAX_PATH_SEGMENTS} levels`);
  for (const p of pathParts) {
    if (!SEGMENT.test(p) || p === "." || p === "..") invalid(`invalid folder path segment "${p}"`);
  }
  return { owner, repo: repoName, branch, path: pathParts.join("/") };
}

const encodePath = (path: string): string => path.split("/").filter((p) => p !== "").map(encodeURIComponent).join("/");

export function listingUrl(f: GitHubFolder): URL {
  const base = `https://${API_HOST}/repos/${encodeURIComponent(f.owner)}/${encodeURIComponent(f.repo)}/contents`;
  const url = new URL(f.path === "" ? base : `${base}/${encodePath(f.path)}`);
  url.searchParams.set("ref", f.branch);
  return url;
}

export function rawFileUrl(f: GitHubFolder, name: string): URL {
  const dir = f.path === "" ? "" : `${encodePath(f.path)}/`;
  return new URL(`https://${RAW_HOST}/${encodeURIComponent(f.owner)}/${encodeURIComponent(f.repo)}/${encodeURIComponent(f.branch)}/${dir}${encodeURIComponent(name)}`);
}

/** Refuses anything but https to the two allowlisted GitHub hosts. */
export function assertAllowedGitHubUrl(url: URL): void {
  if (url.protocol !== "https:") throw new GitHubDirError("REDIRECT_REJECTED", `blocked non-HTTPS URL (${url.protocol})`);
  if (url.username !== "" || url.password !== "") throw new GitHubDirError("REDIRECT_REJECTED", "blocked URL with credentials");
  if (url.port !== "") throw new GitHubDirError("REDIRECT_REJECTED", "blocked URL with a custom port");
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new GitHubDirError("REDIRECT_REJECTED", `blocked host ${url.hostname}; only ${[...ALLOWED_HOSTS].join(" and ")} are allowed`);
  }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------
const ListingEntrySchema = z.object({
  name: z.string().min(1).max(255),
  type: z.string().max(20),
  size: z.number().int().min(0),
});
const ListingSchema = z.array(z.unknown()).max(1000);

export interface GitHubDirOptions {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

export interface GitHubDirImport {
  readonly files: Record<string, string>;
  readonly entry: string | undefined;
  /** `owner/repo`. */
  readonly repo: string;
  readonly branch: string;
  readonly path: string;
  readonly totalBytes: number;
  readonly edges: Array<Pick<GraphEdge, "from" | "to">>;
  /** Listing entries that were not imported, with the reason. */
  readonly skipped: Array<{ readonly name: string; readonly reason: string }>;
  readonly sourceUrl: string;
}

const isRedirect = (status: number): boolean => status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

async function readCapped(response: Response, limit: number, onTooLarge: (seen: number) => GitHubDirError): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw onTooLarge(declared);
  }
  if (response.body === null) {
    const text = await response.text();
    const size = Buffer.byteLength(text, "utf8");
    if (size > limit) throw onTooLarge(size);
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw onTooLarge(total);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function failFromStatus(response: Response, what: string): Promise<never> {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = Number(response.headers.get("x-ratelimit-reset") ?? "");
  const retryAfter = response.headers.get("retry-after");
  let body = "";
  try {
    body = await readCapped(response, 4096, () => new GitHubDirError("UPSTREAM_ERROR", "error body too large"));
  } catch {
    body = "";
  }
  const details: Record<string, unknown> = { status: response.status };
  if (Number.isFinite(reset) && reset > 0) details["resetAt"] = new Date(reset * 1000).toISOString();
  if (retryAfter !== null) details["retryAfterSeconds"] = Number(retryAfter);
  if (response.status === 429 || (response.status === 403 && (remaining === "0" || /rate limit/i.test(body)))) {
    const when = typeof details["resetAt"] === "string" ? ` It resets at ${details["resetAt"]}.` : "";
    throw new GitHubDirError("RATE_LIMITED", `GitHub rate limit reached while reading ${what} (HTTP ${response.status}).${when}`, details);
  }
  if (response.status === 404) throw new GitHubDirError("NOT_FOUND", `${what} was not found on GitHub (HTTP 404); check the owner, repository, branch and path`, details);
  if (response.status === 403 || response.status === 401) throw new GitHubDirError("FORBIDDEN", `GitHub refused access to ${what} (HTTP ${response.status}); only public repositories can be imported`, details);
  throw new GitHubDirError("UPSTREAM_ERROR", `GitHub answered HTTP ${response.status} for ${what}`, details);
}

/** Imports the `.js`/`.cjs` files of one public GitHub folder (non-recursive). */
export async function importGitHubFolder(rawUrl: unknown, options: GitHubDirOptions = {}): Promise<GitHubDirImport> {
  const folder = parseGitHubFolderUrl(rawUrl);
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? GITHUB_DIR_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeoutError = (): GitHubDirError => new GitHubDirError("TIMEOUT", `GitHub did not answer within ${timeoutMs} ms`);
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError());
    }, timeoutMs);
  });

  /** Fetches with `redirect: "manual"`; each redirect target is validated against the allowlist before it is followed. */
  const get = async (start: URL, accept: string, what: string): Promise<Response> => {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      assertAllowedGitHubUrl(url);
      let response: Response;
      try {
        response = await fetchImpl(url.toString(), {
          signal: controller.signal,
          redirect: "manual",
          headers: { Accept: accept, "User-Agent": "lazarus-repo-intake" },
        });
      } catch (err: unknown) {
        if (err instanceof GitHubDirError) throw err;
        if (controller.signal.aborted) throw timeoutError();
        throw new GitHubDirError("UPSTREAM_ERROR", `GitHub is unreachable while reading ${what}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!isRedirect(response.status)) {
        if (!response.ok) return failFromStatus(response, what);
        return response;
      }
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (location === null) throw new GitHubDirError("UPSTREAM_ERROR", `GitHub redirected ${what} without a Location header`);
      // URL parsing would silently collapse ".." segments, so the raw value is checked first.
      if (/(^|[/\\])(\.|%2e){2}([/\\?#]|$)/i.test(location)) throw new GitHubDirError("REDIRECT_REJECTED", `blocked path traversal in a redirect for ${what}`);
      try {
        url = new URL(location, url);
      } catch {
        throw new GitHubDirError("REDIRECT_REJECTED", `GitHub redirected ${what} to an invalid URL`);
      }
    }
    throw new GitHubDirError("REDIRECT_REJECTED", `more than ${MAX_REDIRECTS} redirects while reading ${what}`);
  };

  const work = async (): Promise<GitHubDirImport> => {
    const where = `${folder.owner}/${folder.repo}@${folder.branch}${folder.path === "" ? "" : `/${folder.path}`}`;
    const listingResponse = await get(listingUrl(folder), "application/vnd.github+json", `the folder ${where}`);
    const listingText = await readCapped(listingResponse, MAX_LISTING_BYTES, (n) => new GitHubDirError("UPSTREAM_ERROR", `the folder listing is too large (${n} bytes)`));
    let listingJson: unknown;
    try {
      listingJson = JSON.parse(listingText);
    } catch {
      throw new GitHubDirError("UPSTREAM_ERROR", "GitHub returned a folder listing that is not JSON");
    }
    if (listingJson !== null && typeof listingJson === "object" && !Array.isArray(listingJson)) {
      throw new GitHubDirError("NOT_A_DIRECTORY", `${where} is a file, not a folder; use the single-file GitHub importer in Tab 1`);
    }
    const listing = ListingSchema.safeParse(listingJson);
    if (!listing.success) throw new GitHubDirError("UPSTREAM_ERROR", "GitHub returned an unexpected folder listing");

    const skipped: Array<{ name: string; reason: string }> = [];
    const candidates: Array<{ name: string; size: number }> = [];
    for (const item of listing.data) {
      const entry = ListingEntrySchema.safeParse(item);
      if (!entry.success) {
        skipped.push({ name: "?", reason: "unrecognized listing entry" });
        continue;
      }
      const { name, type, size } = entry.data;
      if (type !== "file") {
        skipped.push({ name, reason: type === "dir" ? "sub-folder (the import is one level deep)" : `not a regular file (${type})` });
      } else if (!/\.c?js$/i.test(name)) {
        skipped.push({ name, reason: "not a .js or .cjs file" });
      } else if (!JS_NAME.test(name)) {
        skipped.push({ name, reason: "unsafe file name" });
      } else {
        candidates.push({ name, size });
      }
    }
    candidates.sort((a, b) => a.name.localeCompare(b.name));
    if (candidates.length === 0) {
      throw new GitHubDirError("NO_JS_FILES", `${where} contains no .js or .cjs files at its top level`, { skipped: skipped.length });
    }
    if (candidates.length > MAX_DIR_FILES) {
      throw new GitHubDirError("TOO_MANY_FILES", `${where} has ${candidates.length} JavaScript files; the limit is ${MAX_DIR_FILES}. Point the URL at a smaller folder.`, { count: candidates.length, limit: MAX_DIR_FILES });
    }
    const big = candidates.find((c) => c.size > MAX_DIR_FILE_BYTES);
    if (big !== undefined) {
      throw new GitHubDirError("FILE_TOO_LARGE", `${big.name} is ${big.size} bytes; the per-file limit is ${MAX_DIR_FILE_BYTES}`, { file: big.name, size: big.size, limit: MAX_DIR_FILE_BYTES });
    }
    const listed = candidates.reduce((sum, c) => sum + c.size, 0);
    if (listed > MAX_DIR_TOTAL_BYTES) {
      throw new GitHubDirError("TOO_LARGE", `the folder's JavaScript files total ${listed} bytes; the limit is ${MAX_DIR_TOTAL_BYTES}`, { totalBytes: listed, limit: MAX_DIR_TOTAL_BYTES });
    }

    const sources = await Promise.all(
      candidates.map(async (c) => {
        const response = await get(rawFileUrl(folder, c.name), "text/plain", c.name);
        const source = await readCapped(response, MAX_DIR_FILE_BYTES, (n) =>
          new GitHubDirError("FILE_TOO_LARGE", `${c.name} exceeds the ${MAX_DIR_FILE_BYTES} byte per-file limit (read ${n}+ bytes)`, { file: c.name, limit: MAX_DIR_FILE_BYTES })
        );
        return [c.name, source] as const;
      })
    );
    const files: Record<string, string> = {};
    let totalBytes = 0;
    for (const [name, source] of sources) {
      files[name] = source;
      totalBytes += Buffer.byteLength(source, "utf8");
    }
    if (totalBytes > MAX_DIR_TOTAL_BYTES) {
      throw new GitHubDirError("TOO_LARGE", `the folder's JavaScript files total ${totalBytes} bytes; the limit is ${MAX_DIR_TOTAL_BYTES}`, { totalBytes, limit: MAX_DIR_TOTAL_BYTES });
    }
    const graph = analyzeGraph(files);
    return {
      files,
      entry: graph.entry,
      repo: `${folder.owner}/${folder.repo}`,
      branch: folder.branch,
      path: folder.path,
      totalBytes,
      edges: graph.edges.map((e) => ({ from: e.from, to: e.to })),
      skipped,
      sourceUrl: `https://github.com/${folder.owner}/${folder.repo}/tree/${folder.branch}${folder.path === "" ? "" : `/${folder.path}`}`,
    };
  };

  try {
    return await Promise.race([work(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
