// Secure live importer for legacy npm packages. The package entry file is fetched from an allowlisted CDN,
// size-capped and PARSED (never executed) so it can be handed to the sandbox pipeline. Anything that cannot
// run in the isolated sandbox (external require()/import) is reported honestly instead of being faked.
import { createHash } from "node:crypto";
import { z } from "zod";
import { analyze, walk } from "../crew/ast-scope.js";
import { parseProgram } from "../crew/ast-modernizer.js";
import { scanLegacyAst } from "../sandbox/ast-scanner.js";
import { findClassic, sha256Of, type GraveyardClassic } from "../crew/graveyard-classics.js";

export const MAX_NPM_BYTES = 32 * 1024;
export const NPM_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;

export type NpmErrorCode =
  | "INVALID_SPEC"
  | "NOT_FOUND"
  | "TOO_LARGE"
  | "TIMEOUT"
  | "UPSTREAM_ERROR"
  | "REDIRECT_REJECTED"
  | "HAS_DEPENDENCIES"
  | "PARSE_ERROR"
  | "EMPTY";

export class NpmImportError extends Error {
  constructor(
    readonly code: NpmErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "NpmImportError";
  }
}

/** HTTP status for each error code. */
export function statusFor(code: NpmErrorCode): number {
  switch (code) {
    case "INVALID_SPEC":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "TOO_LARGE":
      return 413;
    case "HAS_DEPENDENCIES":
    case "PARSE_ERROR":
    case "EMPTY":
      return 422;
    case "TIMEOUT":
      return 504;
    case "UPSTREAM_ERROR":
    case "REDIRECT_REJECTED":
      return 502;
  }
}

// ---------------------------------------------------------------------------
// Spec validation
// ---------------------------------------------------------------------------
const NAME_PART = "[a-z0-9][a-z0-9._~-]*";
const SPEC_REGEX = new RegExp(`^(?:@${NAME_PART}/)?${NAME_PART}@\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$`);

export const PackageSpecSchema = z
  .string()
  .min(3, "packageSpec is required")
  .max(246, "packageSpec is too long")
  .refine((s) => !s.includes(".."), "path traversal (..) is not allowed")
  .refine((s) => SPEC_REGEX.test(s), "expected name@x.y.z or @scope/name@x.y.z (exact version, lower-case npm name)");

export interface ParsedSpec {
  readonly name: string;
  readonly version: string;
  readonly spec: string;
}

export function parsePackageSpec(raw: unknown): ParsedSpec {
  const checked = PackageSpecSchema.safeParse(raw);
  if (!checked.success) {
    throw new NpmImportError("INVALID_SPEC", checked.error.issues.map((i) => i.message).join("; "));
  }
  const spec = checked.data;
  const at = spec.lastIndexOf("@");
  const name = spec.slice(0, at);
  if (name.length > 214 || /^[._]/.test(name.replace(/^@[^/]*\//, ""))) {
    throw new NpmImportError("INVALID_SPEC", "invalid npm package name");
  }
  return { name, version: spec.slice(at + 1), spec };
}

// ---------------------------------------------------------------------------
// Allowlisted CDNs
// ---------------------------------------------------------------------------
interface Cdn {
  readonly host: string;
  readonly url: (p: ParsedSpec) => string;
}

export const CDNS: readonly Cdn[] = [
  { host: "unpkg.com", url: (p) => `https://unpkg.com/${p.name}@${p.version}` },
  { host: "cdn.jsdelivr.net", url: (p) => `https://cdn.jsdelivr.net/npm/${p.name}@${p.version}` },
];
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(CDNS.map((c) => c.host));

export function assertAllowedUrl(url: URL): void {
  if (url.protocol !== "https:") throw new NpmImportError("REDIRECT_REJECTED", `blocked non-HTTPS URL (${url.protocol})`);
  if (url.username !== "" || url.password !== "") throw new NpmImportError("REDIRECT_REJECTED", "blocked URL with credentials");
  if (url.port !== "") throw new NpmImportError("REDIRECT_REJECTED", "blocked URL with a custom port");
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new NpmImportError("REDIRECT_REJECTED", `blocked host ${url.hostname}; only ${[...ALLOWED_HOSTS].join(", ")} are allowed`);
  }
  if (/(^|\/)\.\.(\/|$)/.test(decodeURIComponent(url.pathname))) throw new NpmImportError("REDIRECT_REJECTED", "blocked path traversal");
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Where a package comes from. `live` (the default, and what every existing caller gets) fetches the CDN only. `snapshot` serves a curated
 * npm Graveyard Classic from the snapshot that ships with Lazarus, with no network at all. `auto` tries the live CDN first and, when the
 * package is a curated classic and the CDN times out, rate-limits, fails, or serves something the sandbox cannot run, falls back to the
 * snapshot (the result says so). A package that is not a classic behaves exactly like `live` in every mode but `snapshot`, which refuses it.
 */
export type NpmSource = "live" | "snapshot" | "auto";

export interface ImportOptions {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly source?: NpmSource;
}

interface Fetched {
  readonly source: string;
  readonly url: string;
  readonly host: string;
  readonly byteLength: number;
}

const isRedirect = (status: number): boolean => status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

/** Reads at most `MAX_NPM_BYTES`; throws TOO_LARGE as soon as the stream passes the cap. */
async function readCapped(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_NPM_BYTES) {
    throw new NpmImportError("TOO_LARGE", `package entry file is ${declared} bytes; the limit is ${MAX_NPM_BYTES}`, { byteLength: declared, limit: MAX_NPM_BYTES });
  }
  const tooLarge = (seen: number): NpmImportError =>
    new NpmImportError("TOO_LARGE", `package entry file exceeds the ${MAX_NPM_BYTES} byte limit (read ${seen}+ bytes)`, { limit: MAX_NPM_BYTES });
  if (response.body === null) {
    const text = await response.text();
    const size = Buffer.byteLength(text, "utf8");
    if (size > MAX_NPM_BYTES) throw tooLarge(size);
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new NpmImportError("TIMEOUT", "timed out while reading the package");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_NPM_BYTES) throw tooLarge(total);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchFromCdn(fetchImpl: FetchLike, cdn: Cdn, spec: ParsedSpec, timeoutMs: number): Promise<Fetched> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new NpmImportError("TIMEOUT", `${cdn.host} did not answer within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  const work = async (): Promise<Fetched> => {
    let current = new URL(cdn.url(spec));
    assertAllowedUrl(current);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let response: Response;
      try {
        response = await fetchImpl(current.toString(), { signal: controller.signal, redirect: "manual", headers: { Accept: "application/javascript, text/plain, */*" } });
      } catch (err: unknown) {
        if (err instanceof NpmImportError) throw err;
        if (controller.signal.aborted) throw new NpmImportError("TIMEOUT", `${cdn.host} did not answer within ${timeoutMs} ms`);
        throw new NpmImportError("UPSTREAM_ERROR", `${cdn.host} is unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (location === null) throw new NpmImportError("UPSTREAM_ERROR", `${cdn.host} sent a redirect without a Location`);
        // URL parsing would silently normalize ".." away, so the raw value is checked first.
        if (/(^|[/\\])(\.|%2e){2}([/\\?#]|$)/i.test(location)) throw new NpmImportError("REDIRECT_REJECTED", "blocked path traversal in redirect");
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new NpmImportError("REDIRECT_REJECTED", "redirect target is not a valid URL");
        }
        assertAllowedUrl(next);
        current = next;
        continue;
      }
      if (response.status === 404 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        throw new NpmImportError("NOT_FOUND", `${spec.spec} was not found on ${cdn.host} (HTTP ${response.status})`);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new NpmImportError("UPSTREAM_ERROR", `${cdn.host} answered HTTP ${response.status}`);
      }
      const source = await readCapped(response, controller.signal);
      return { source, url: current.toString(), host: current.hostname.toLowerCase(), byteLength: Buffer.byteLength(source, "utf8") };
    }
    throw new NpmImportError("REDIRECT_REJECTED", `more than ${MAX_REDIRECTS} redirects`);
  };
  try {
    return await Promise.race([work(), timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

// ---------------------------------------------------------------------------
// Dependencies the sandbox cannot satisfy
// ---------------------------------------------------------------------------
export function findExternalDependencies(source: string): string[] {
  const parsed = parseProgram(source.trim());
  if ("error" in parsed) throw new NpmImportError("PARSE_ERROR", `the package entry file could not be parsed: ${parsed.error}`);
  const a = analyze(parsed.ast);
  const found = new Set<string>();
  walk(parsed.ast, (n) => {
    if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "require" && a.refByNode.get(n.callee)?.binding === null) {
      const arg = n.arguments[0];
      found.add(arg !== undefined && arg.type === "Literal" && typeof arg.value === "string" ? arg.value : "<dynamic>");
    } else if (n.type === "ImportDeclaration" && typeof n.source.value === "string") {
      found.add(n.source.value);
    } else if (n.type === "ImportExpression") {
      found.add("<dynamic import>");
    }
    return undefined;
  });
  return [...found];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export interface NpmImportResult {
  readonly packageName: string;
  readonly version: string;
  readonly spec: string;
  readonly cdnHost: string;
  readonly url: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly source: string;
  readonly extractedExpression: string;
  readonly detectedIdioms: string[];
  readonly suggestedSchema: Record<string, string>;
  readonly functionName?: string;
  readonly functions: Array<{ name: string; exportedAs?: string; paramNames: string[] }>;
  /** Where the source came from; absent for a plain live import (the shape every earlier caller sees). */
  readonly origin?: "live-cdn" | "curated-snapshot";
  /** SPDX license, for a curated classic. */
  readonly license?: string;
  /** Curated metadata of a classic (author, links, summary, legacy traps, deviations from the published file). */
  readonly classic?: { readonly author: string; readonly homepage: string; readonly repository: string; readonly summary: string; readonly traps: readonly string[]; readonly modifications: readonly string[] };
  /** Why a live import fell back to the curated snapshot. */
  readonly fallback?: { readonly code: NpmErrorCode; readonly message: string };
}

/** CDN host name shown for a curated snapshot. */
export const CURATED_HOST = "lazarus-curated";

function classicMeta(c: GraveyardClassic): NonNullable<NpmImportResult["classic"]> {
  return { author: c.author, homepage: c.homepage, repository: c.repository, summary: c.summary, traps: c.traps, modifications: c.modifications };
}

/** The import result of a curated classic, built from the snapshot that ships with Lazarus. */
export function importClassicSnapshot(classic: GraveyardClassic, fallback?: { code: NpmErrorCode; message: string }): NpmImportResult {
  const scan = scanLegacyAst(classic.source);
  return {
    packageName: classic.name,
    version: classic.version,
    spec: classic.spec,
    cdnHost: CURATED_HOST,
    url: classic.homepage,
    byteLength: Buffer.byteLength(classic.source, "utf8"),
    sha256: sha256Of(classic.source),
    source: classic.source,
    extractedExpression: scan.primaryExpression,
    detectedIdioms: scan.detectedIdioms,
    suggestedSchema: classic.schema,
    ...(scan.primary !== undefined ? { functionName: scan.primary.name } : {}),
    functions: scan.functions.map((f) => ({ name: f.name, ...(f.exportedAs !== undefined ? { exportedAs: f.exportedAs } : {}), paramNames: f.paramNames })),
    origin: "curated-snapshot",
    license: classic.license,
    classic: classicMeta(classic),
    ...(fallback !== undefined ? { fallback } : {}),
  };
}

export async function importNpmPackage(rawSpec: unknown, options: ImportOptions = {}): Promise<NpmImportResult> {
  const spec = parsePackageSpec(rawSpec);
  const classic = findClassic(spec.spec);
  const mode = options.source ?? "live";
  if (mode === "snapshot") {
    if (classic === undefined) throw new NpmImportError("NOT_FOUND", `${spec.spec} is not one of the curated npm Graveyard Classics`);
    return importClassicSnapshot(classic);
  }
  if (mode === "auto" && classic !== undefined) {
    try {
      const live = await importLive(spec, options);
      return { ...live, origin: "live-cdn", license: classic.license, classic: classicMeta(classic) };
    } catch (err: unknown) {
      if (!(err instanceof NpmImportError)) throw err;
      return importClassicSnapshot(classic, { code: err.code, message: err.message });
    }
  }
  return importLive(spec, options);
}

async function importLive(spec: ParsedSpec, options: ImportOptions): Promise<NpmImportResult> {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? NPM_TIMEOUT_MS;
  const failures: NpmImportError[] = [];
  let fetched: Fetched | undefined;
  for (const cdn of CDNS) {
    try {
      fetched = await fetchFromCdn(fetchImpl, cdn, spec, timeoutMs);
      break;
    } catch (err: unknown) {
      if (!(err instanceof NpmImportError)) throw err;
      // The same file is behind both CDNs, so a size violation is final.
      if (err.code === "TOO_LARGE") throw err;
      failures.push(err);
    }
  }
  if (fetched === undefined) {
    const allMissing = failures.every((f) => f.code === "NOT_FOUND");
    const chosen = allMissing ? failures[0] : (failures.find((f) => f.code !== "NOT_FOUND") ?? failures[0]);
    const summary = failures.map((f) => f.message).join(" | ");
    throw new NpmImportError(chosen?.code ?? "UPSTREAM_ERROR", allMissing ? `${spec.spec} does not exist on unpkg or jsDelivr` : summary, { attempts: failures.map((f) => ({ code: f.code, message: f.message })) });
  }
  if (fetched.source.trim().length === 0) throw new NpmImportError("EMPTY", `${spec.spec} entry file is empty`);
  const dependencies = findExternalDependencies(fetched.source);
  if (dependencies.length > 0) {
    throw new NpmImportError(
      "HAS_DEPENDENCIES",
      `${spec.spec} depends on ${dependencies.map((d) => `"${d}"`).join(", ")}, which cannot be loaded inside the isolated sandbox (no module loading, no network). It was not imported.`,
      { dependencies, cdnHost: fetched.host, byteLength: fetched.byteLength }
    );
  }
  const scan = scanLegacyAst(fetched.source);
  if (!scan.parsed) throw new NpmImportError("PARSE_ERROR", `the package entry file could not be parsed: ${scan.parseError ?? "syntax error"}`);
  return {
    packageName: spec.name,
    version: spec.version,
    spec: spec.spec,
    cdnHost: fetched.host,
    url: fetched.url,
    byteLength: fetched.byteLength,
    sha256: createHash("sha256").update(fetched.source, "utf8").digest("hex"),
    source: fetched.source,
    extractedExpression: scan.primaryExpression,
    detectedIdioms: scan.detectedIdioms,
    suggestedSchema: scan.suggestedSchema,
    ...(scan.primary !== undefined ? { functionName: scan.primary.name } : {}),
    functions: scan.functions.map((f) => ({ name: f.name, ...(f.exportedAs !== undefined ? { exportedAs: f.exportedAs } : {}), paramNames: f.paramNames })),
  };
}
