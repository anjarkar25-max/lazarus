// Strict TypeScript verifier for generated code.
//
// Primary engine: the installed TypeScript 7 compiler API (`typescript/unstable/async`) with a virtual file system
// overlay. The generated files live under a virtual root that never exists on disk; lib files fall through to the real
// (read-only) installation. One warm native compiler process is reused across checks and closed when idle.
// Fallback engine: an isolated temp directory checked with the `tsc` CLI (`--noEmit --strict`), always removed.
//
// The checked code is only type-checked. Nothing here executes it.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as nodePath from "node:path";
import { plural } from "../text/plural.js";

export interface TsDiagnostic {
  /** Path relative to the checked file map ("" for project-wide diagnostics). */
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
  /** TypeScript error code, e.g. 2322. */
  readonly code: number;
  readonly message: string;
}

export interface TypecheckResult {
  readonly passed: boolean;
  readonly errorCount: number;
  readonly diagnostics: TsDiagnostic[];
  readonly elapsedMs: number;
  readonly engine: "typescript-api" | "tsc-cli";
  readonly tsVersion: string;
  readonly filesChecked: number;
  /** The check ran on an already-warm compiler process (always false for the CLI engine). */
  readonly reusedProcess: boolean;
}

/** The settings every verification uses (also written to exported projects as tsconfig.json). */
export const STRICT_COMPILER_OPTIONS = {
  strict: true,
  noImplicitAny: true,
  target: "ES2022",
  module: "NodeNext",
  moduleResolution: "NodeNext",
  noEmit: true,
  skipLibCheck: true,
  types: [] as string[],
} as const;

export const MAX_DIAGNOSTICS = 50;
const CLI_TIMEOUT_MS = 30_000;
const IDLE_CLOSE_MS = 15_000;
const ERROR_CATEGORY = 1;

const requireFromHere = createRequire(import.meta.url);

/** Installed TypeScript version (from node_modules, never assumed). */
export function installedTypeScriptVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(requireFromHere.resolve("typescript/package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** tsconfig.json for a project made of `include` globs, with the strict options above. */
export function strictTsconfig(include: readonly string[] = ["**/*.ts"]): string {
  return `${JSON.stringify({ compilerOptions: STRICT_COMPILER_OPTIONS, include }, null, 2)}\n`;
}

/** 1-based line/column of a UTF-16 offset. */
function lineColumn(text: string, pos: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(pos, text.length)));
  const lines = before.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

interface ApiDiagnostic {
  readonly fileName?: string | undefined;
  readonly pos: number;
  readonly code: number;
  readonly category: number;
  readonly text: string;
  readonly messageChain?: readonly ApiDiagnostic[] | undefined;
}

const flatten = (d: ApiDiagnostic): string => [d.text, ...(d.messageChain ?? []).map(flatten)].join(" ");

function checkInputs(files: Readonly<Record<string, string>>): string[] {
  const names = Object.keys(files).filter((f) => /\.(ts|mts|cts|d\.ts)$/.test(f));
  for (const name of Object.keys(files)) {
    const parts = name.split("/");
    if (name.startsWith("/") || name.includes("\\") || /^[A-Za-z]:/.test(name) || parts.some((p) => p === "" || p === "." || p === "..")) {
      throw new Error(`unsafe file name for type-checking: ${name}`);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Engine 1: compiler API with a virtual file system
// ---------------------------------------------------------------------------
type AsyncApiModule = typeof import("typescript/unstable/async");
type ApiInstance = InstanceType<AsyncApiModule["API"]>;

export class StrictTsVerifier {
  private api: ApiInstance | undefined;
  private moduleRef: AsyncApiModule | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | undefined;
  /** Virtual roots currently being checked, mapped to their files. */
  private readonly roots = new Map<string, Readonly<Record<string, string>>>();
  private readonly baseDir = nodePath.join(os.tmpdir(), `lazarus-ts-virtual-${randomUUID()}`).replace(/\\/g, "/");
  private apiUnavailable = false;

  constructor(private readonly options: { readonly engine?: "auto" | "api" | "cli"; readonly idleCloseMs?: number } = {}) {}

  /** Type-checks `files` (paths relative to a project root) under strict settings. Calls are serialized. */
  verify(files: Readonly<Record<string, string>>): Promise<TypecheckResult> {
    const task = this.queue.then(() => this.verifyNow(files));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async verifyNow(files: Readonly<Record<string, string>>): Promise<TypecheckResult> {
    const tsFiles = checkInputs(files);
    const engine = this.options.engine ?? "auto";
    if (engine === "cli" || (engine === "auto" && this.apiUnavailable)) return verifyWithCli(files, tsFiles);
    try {
      return await this.verifyWithApi(files, tsFiles);
    } catch (err: unknown) {
      if (engine === "api") throw err;
      // The in-memory API is unstable across TypeScript releases; the CLI fallback gives the same answer.
      this.apiUnavailable = true;
      await this.close();
      return verifyWithCli(files, tsFiles);
    }
  }

  private inside(path: string): { root: string; rel: string } | undefined {
    const n = path.replace(/\\/g, "/");
    if (!n.startsWith(`${this.baseDir}/`)) return undefined;
    const rest = n.slice(this.baseDir.length + 1);
    const slash = rest.indexOf("/");
    const root = slash < 0 ? rest : rest.slice(0, slash);
    return { root, rel: slash < 0 ? "" : rest.slice(slash + 1) };
  }

  private async ensureApi(): Promise<ApiInstance> {
    if (this.api !== undefined) return this.api;
    this.moduleRef ??= await import("typescript/unstable/async");
    const entriesOf = (map: Readonly<Record<string, string>>, rel: string): { files: string[]; directories: string[] } => {
      const prefix = rel === "" ? "" : `${rel}/`;
      const kids = Object.keys(map)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
      return { files: kids.filter((k) => !k.includes("/")), directories: [...new Set(kids.filter((k) => k.includes("/")).map((k) => k.split("/")[0] ?? ""))] };
    };
    this.api = new this.moduleRef.API({
      cwd: this.baseDir,
      fs: {
        // Inside the virtual base: answer from the file maps only (null = does not exist, never the real disk).
        // Outside it (TypeScript's own lib files): undefined = read the real, read-only installation.
        readFile: (f) => {
          const at = this.inside(f);
          if (at === undefined) return undefined;
          return this.roots.get(at.root)?.[at.rel] ?? null;
        },
        fileExists: (f) => {
          const at = this.inside(f);
          if (at === undefined) return undefined;
          const map = this.roots.get(at.root);
          return map !== undefined && Object.prototype.hasOwnProperty.call(map, at.rel);
        },
        directoryExists: (d) => {
          const at = this.inside(d);
          if (at === undefined) return d.replace(/\\/g, "/") === this.baseDir ? true : undefined;
          const map = this.roots.get(at.root);
          return map !== undefined && (at.rel === "" || Object.keys(map).some((k) => k.startsWith(`${at.rel}/`)));
        },
        getAccessibleEntries: (d) => {
          const at = this.inside(d);
          if (at === undefined) return d.replace(/\\/g, "/") === this.baseDir ? { files: [], directories: [...this.roots.keys()] } : undefined;
          const map = this.roots.get(at.root);
          return map === undefined ? { files: [], directories: [] } : entriesOf(map, at.rel);
        },
        realpath: (p) => (this.inside(p) !== undefined ? p.replace(/\\/g, "/") : undefined),
      },
    });
    return this.api;
  }

  private async verifyWithApi(files: Readonly<Record<string, string>>, tsFiles: string[]): Promise<TypecheckResult> {
    const started = Date.now();
    this.clearIdle();
    const reusedProcess = this.api !== undefined;
    const api = await this.ensureApi();
    const id = randomUUID();
    const map: Record<string, string> = { ...files, "tsconfig.json": strictTsconfig(), "package.json": `${JSON.stringify({ type: "module" })}\n` };
    this.roots.set(id, map);
    const configPath = `${this.baseDir}/${id}/tsconfig.json`;
    try {
      const snapshot = await api.updateSnapshot({ openProjects: [configPath] });
      try {
        const project = snapshot.getProjects().find((p) => p.configFileName.replace(/\\/g, "/") === configPath) ?? snapshot.getProjects()[0];
        if (project === undefined) throw new Error("the TypeScript API did not open the project");
        const program = project.program;
        const raw: ApiDiagnostic[] = [
          ...(await program.getProgramDiagnostics()),
          ...(await program.getSyntacticDiagnostics()),
          ...(await program.getSemanticDiagnostics()),
        ];
        const errors = raw.filter((d) => d.category === ERROR_CATEGORY);
        const diagnostics = errors.slice(0, MAX_DIAGNOSTICS).map((d): TsDiagnostic => {
          const at = d.fileName === undefined ? undefined : this.inside(d.fileName);
          const file = at?.rel ?? (d.fileName ?? "");
          const text = at !== undefined ? map[at.rel] ?? "" : "";
          const { line, column } = at !== undefined ? lineColumn(text, d.pos) : { line: 0, column: 0 };
          return { file, line, column, code: d.code, message: flatten(d) };
        });
        return { passed: errors.length === 0, errorCount: errors.length, diagnostics, elapsedMs: Date.now() - started, engine: "typescript-api", tsVersion: installedTypeScriptVersion(), filesChecked: tsFiles.length, reusedProcess };
      } finally {
        snapshot.dispose();
      }
    } finally {
      // Release the project in the compiler and forget the files.
      await api.updateSnapshot({ closeProjects: [configPath] }).then(
        (s) => s.dispose(),
        () => undefined
      );
      this.roots.delete(id);
      this.scheduleIdleClose();
    }
  }

  private clearIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdleClose(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => void this.close(), this.options.idleCloseMs ?? IDLE_CLOSE_MS);
    this.idleTimer.unref();
  }

  /** Stops the warm compiler process (if any). Safe to call repeatedly. */
  async close(): Promise<void> {
    this.clearIdle();
    const api = this.api;
    this.api = undefined;
    if (api !== undefined) await api.close().catch(() => undefined);
  }

  get isWarm(): boolean {
    return this.api !== undefined;
  }
}

// ---------------------------------------------------------------------------
// Engine 2: isolated temp dir + tsc CLI
// ---------------------------------------------------------------------------
const CLI_LINE = /^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/;

async function verifyWithCli(files: Readonly<Record<string, string>>, tsFiles: string[]): Promise<TypecheckResult> {
  const started = Date.now();
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-tsc-"));
  try {
    for (const [name, content] of Object.entries({ ...files, "tsconfig.json": strictTsconfig(), "package.json": `${JSON.stringify({ type: "module" })}\n` })) {
      const target = nodePath.join(dir, ...name.split("/"));
      fs.mkdirSync(nodePath.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf8");
    }
    const tscBin = nodePath.join(nodePath.dirname(requireFromHere.resolve("typescript/package.json")), "bin", "tsc");
    const output = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [tscBin, "-p", "tsconfig.json", "--noEmit", "--strict", "--pretty", "false"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let text = "";
      child.stdout.on("data", (c: Buffer) => (text += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (text += c.toString("utf8")));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`tsc did not finish within ${CLI_TIMEOUT_MS} ms`));
      }, CLI_TIMEOUT_MS);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, text });
      });
    });
    const errors: TsDiagnostic[] = [];
    for (const line of output.text.split(/\r?\n/)) {
      const m = CLI_LINE.exec(line.trim());
      if (m === null) continue;
      errors.push({ file: (m[1] ?? "").replace(/\\/g, "/"), line: Number(m[2]), column: Number(m[3]), code: Number(m[4]), message: m[5] ?? "" });
    }
    if (output.code !== 0 && errors.length === 0) {
      errors.push({ file: "", line: 0, column: 0, code: 0, message: `tsc exited with code ${String(output.code)}: ${output.text.trim().slice(0, 300)}` });
    }
    return { passed: errors.length === 0, errorCount: errors.length, diagnostics: errors.slice(0, MAX_DIAGNOSTICS), elapsedMs: Date.now() - started, engine: "tsc-cli", tsVersion: installedTypeScriptVersion(), filesChecked: tsFiles.length, reusedProcess: false };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Shared instance
// ---------------------------------------------------------------------------
let shared: StrictTsVerifier | undefined;

/** Strict type-check of an in-memory file map (paths relative to the project root). */
export function verifyStrictTypeScript(files: Readonly<Record<string, string>>): Promise<TypecheckResult> {
  shared ??= new StrictTsVerifier();
  return shared.verify(files);
}

/** Closes the shared warm compiler (server shutdown, test teardown). */
export async function closeSharedTsVerifier(): Promise<void> {
  const s = shared;
  shared = undefined;
  if (s !== undefined) await s.close();
}

/** One-line summary for certificates and SPEC.md, e.g. "tsc --strict: 0 errors (2 files, TypeScript 7.0.2)". */
export function describeTypecheck(result: Pick<TypecheckResult, "errorCount" | "filesChecked" | "tsVersion">): string {
  return `tsc --strict: ${plural(result.errorCount, "error")} (${plural(result.filesChecked, "file")}, TypeScript ${result.tsVersion})`;
}
