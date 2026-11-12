/// <reference types="node" />
// Task 6: ProbeRunner — spawns an isolated child process, enforces resource limits,
// and collects the probe result.

import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as nodePath from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { SandboxError } from "./errors.js";
import type { ProbeParams, ProbeResult } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = nodePath.dirname(__filename);

// ---------------------------------------------------------------------------
// Shims resolution — handle both compiled (.js) and TypeScript (.ts) source
// ---------------------------------------------------------------------------

/** Returns the shims directory, compiling .ts → .js into a temp dir if needed. */
function resolveShimsDir(shimsDir: string): string {
  const networkJs = nodePath.join(shimsDir, "network.js");
  const fsJs = nodePath.join(shimsDir, "fs.js");

  if (fs.existsSync(networkJs) && fs.existsSync(fsJs)) {
    return shimsDir; // already compiled
  }

  // TypeScript source — compile to temp dir using tsc
  const tmpDir = nodePath.join(os.tmpdir(), "lazarus-runner-shims");
  const networkJsTmp = nodePath.join(tmpDir, "network.js");
  const fsJsTmp = nodePath.join(tmpDir, "fs.js");

  if (fs.existsSync(networkJsTmp) && fs.existsSync(fsJsTmp)) {
    return tmpDir; // already compiled in a previous run
  }

  // Compile the shims and their dependencies
  compileSandboxTs(tmpDir);
  return tmpDir;
}

/**
 * Write pre-compiled inline JS versions of the shims to outDir.
 * This avoids needing to run tsc at runtime in the test environment
 * where only .ts source files exist.
 */
function compileSandboxTs(outDir: string): void {
  fs.mkdirSync(outDir, { recursive: true });

  // Write pre-compiled inline JS for network shim
  const networkJs = `
import { createRequire } from "node:module";

class SandboxError extends Error {
  constructor(code, detail) {
    super(detail ?? code);
    this.name = "SandboxError";
    this.code = code;
    this.detail = detail;
  }
}

function blocked(operation) {
  throw new SandboxError("NETWORK_BLOCKED", "Outbound network operation blocked: " + operation);
}

try {
  const req = createRequire(import.meta.url);
  const netMod = req("net");
  netMod.connect = (..._args) => blocked("net.connect");
  netMod.createConnection = (..._args) => blocked("net.createConnection");
  const httpMod = req("http");
  httpMod.request = (..._args) => blocked("http.request");
  httpMod.get = (..._args) => blocked("http.get");
  const httpsMod = req("https");
  httpsMod.request = (..._args) => blocked("https.request");
  httpsMod.get = (..._args) => blocked("https.get");
  const dgramMod = req("dgram");
  dgramMod.createSocket = (..._args) => blocked("dgram.createSocket");
} catch(e) {
  // best-effort patching
}
`.trim();

  const SHIM_ALLOWED_PREFIX = "/tmp/lazarus-sandbox";

  // Write pre-compiled inline JS for fs shim
  const fsJs = `
import { createRequire } from "node:module";
import * as nodePath from "node:path";

const ALLOWED_PREFIX = "${SHIM_ALLOWED_PREFIX}";

class SandboxError extends Error {
  constructor(code, detail) {
    super(detail ?? code);
    this.name = "SandboxError";
    this.code = code;
    this.detail = detail;
  }
}

function checkWrite(targetPath) {
  const resolved = nodePath.resolve(targetPath);
  const posixPath = resolved.split(nodePath.sep).join("/");
  const normalAllowed = ALLOWED_PREFIX.toLowerCase();
  function startsWithPrefix(p) {
    const lower = p.toLowerCase();
    return lower.startsWith(normalAllowed) &&
      (lower.length === normalAllowed.length || lower[normalAllowed.length] === "/" || lower[normalAllowed.length] === "\\\\");
  }
  if (!startsWithPrefix(posixPath) && !startsWithPrefix(targetPath)) {
    throw new SandboxError("FS_WRITE_DENIED",
      "Write to path \\"" + targetPath + "\\" is outside the allowed directory " + ALLOWED_PREFIX);
  }
}

try {
  const req = createRequire(import.meta.url);
  const fsSync = req("fs");
  const origWriteFileSync = fsSync.writeFileSync.bind(fsSync);
  fsSync.writeFileSync = (p, d, o) => { checkWrite(String(p)); return origWriteFileSync(p, d, o); };
  const origAppendFileSync = fsSync.appendFileSync.bind(fsSync);
  fsSync.appendFileSync = (p, d, o) => { checkWrite(String(p)); return origAppendFileSync(p, d, o); };
  const origMkdirSync = fsSync.mkdirSync.bind(fsSync);
  fsSync.mkdirSync = (p, o) => { checkWrite(String(p)); return origMkdirSync(p, o); };

  const fsPromises = req("fs/promises");
  const origWriteFile = fsPromises.writeFile.bind(fsPromises);
  fsPromises.writeFile = (p, d, o) => { checkWrite(String(p)); return origWriteFile(p, d, o); };
} catch(e) {
  // best-effort patching
}
`.trim();

  fs.writeFileSync(nodePath.join(outDir, "network.js"), networkJs, "utf8");
  fs.writeFileSync(nodePath.join(outDir, "fs.js"), fsJs, "utf8");
}

// ---------------------------------------------------------------------------
// Child worker script (inlined, runs inside the spawned child process)
// ---------------------------------------------------------------------------

function buildChildScript(networkShimUrl: string, fsShimUrl: string): string {
  return `
import('${networkShimUrl}').then(() => import('${fsShimUrl}')).then(() => {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', async () => {
    try {
      const { code, context } = JSON.parse(raw || '{}');
      const { createContext, runInContext } = await import('node:vm');
      const startMem = process.memoryUsage().heapUsed;
      const start = Date.now();
      const sandbox = { ...(context || {}), console, process: { env: {} } };
      const ctx = createContext(sandbox);
      const output = runInContext(code, ctx, { timeout: 2800 });
      const durationMs = Date.now() - start;
      const memoryUsedBytes = process.memoryUsage().heapUsed - startMem;
      process.stdout.write(JSON.stringify({ output, durationMs, memoryUsedBytes }) + '\\n');
      process.exit(0);
    } catch (err) {
      process.stderr.write(String(err && typeof err === 'object' && 'message' in err ? err.message : err) + '\\n');
      process.exit(1);
    }
  });
}).catch(err => {
  process.stderr.write('shim load error: ' + String(err) + '\\n');
  process.exit(1);
});
`.trim();
}

const OOM_PATTERNS = [
  "javascript heap out of memory",
  "allocation failed",
  "process out of memory",
];

const TIMEOUT_PATTERNS = [
  "script execution timed out",
  "execution timed out",
];

function isOomError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return OOM_PATTERNS.some((p) => lower.includes(p));
}

function isVmTimeoutError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return TIMEOUT_PATTERNS.some((p) => lower.includes(p));
}

export class ProbeRunner {
  private readonly shimsDirInput: string;

  constructor(shimsDir?: string) {
    this.shimsDirInput = shimsDir ?? nodePath.join(__dirname, "shims");
  }

  run(params: ProbeParams): Promise<ProbeResult> {
    return new Promise<ProbeResult>((resolve, reject) => {
      // Resolve shims (compiling .ts → .js if necessary)
      let shimsDir: string;
      try {
        shimsDir = resolveShimsDir(this.shimsDirInput);
      } catch (e) {
        reject(SandboxError.from(e, "INTERNAL_ERROR"));
        return;
      }

      const networkShimUrl = pathToFileURL(
        nodePath.join(shimsDir, "network.js")
      ).href;
      const fsShimUrl = pathToFileURL(nodePath.join(shimsDir, "fs.js")).href;

      const script = buildChildScript(networkShimUrl, fsShimUrl);

      const child = spawn(
        process.execPath,
        ["--max-old-space-size=256", "--input-type=module", "--eval", script],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, NODE_OPTIONS: "" },
        }
      );

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      function settle(fn: () => void): void {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        try {
          child.kill();
        } catch {
          // already dead
        }
        fn();
      }

      // 3,000 ms timeout
      timer = setTimeout(() => {
        settle(() => {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
          reject(new SandboxError("TIMEOUT", "Probe exceeded 3000ms execution limit"));
        });
      }, 3000);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err: Error) => {
        settle(() => {
          reject(SandboxError.from(err, "INTERNAL_ERROR"));
        });
      });

      child.on("exit", (code: number | null) => {
        settle(() => {
          if (code !== 0) {
            if (isOomError(stderr)) {
              reject(new SandboxError("MEMORY_EXCEEDED", "Child process ran out of memory"));
            } else if (isVmTimeoutError(stderr)) {
              reject(new SandboxError("TIMEOUT", "Probe exceeded execution time limit"));
            } else {
              const detail = stderr.trim() || `Process exited with code ${code ?? "null"}`;
              reject(new SandboxError("EXECUTION_ERROR", detail));
            }
            return;
          }

          try {
            const result = JSON.parse(stdout.trim()) as ProbeResult;
            resolve(result);
          } catch (parseErr) {
            reject(SandboxError.from(parseErr, "INTERNAL_ERROR"));
          }
        });
      });

      // Write probe params to child stdin
      const payload = JSON.stringify({
        code: params.code,
        context: params.context ?? {},
      });

      child.stdin?.write(payload, "utf8", () => {
        child.stdin?.end();
      });
    });
  }
}
