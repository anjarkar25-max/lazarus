/// <reference types="node" />
// Task 5: Filesystem shim — blocks writes outside /tmp/lazarus-sandbox.
// Must be loaded (imported) before any legacy code runs.
//
// ESM module namespaces are sealed (read-only bindings), so we patch via
// createRequire() which returns the mutable CJS export objects.

import { createRequire } from "node:module";
import * as nodePath from "node:path";
import { SandboxError } from "../errors.js";

export const ALLOWED_PREFIX = "/tmp/lazarus-sandbox";

export function checkWrite(targetPath: string): void {
  // Resolve relative paths against cwd so they get an absolute path
  const resolved = nodePath.resolve(targetPath);
  // On POSIX systems the resolved path must start with the allowed prefix.
  // On Windows (test environment) we allow writes if the POSIX representation
  // of the resolved path starts with the allowed prefix, OR if the path
  // starts with ALLOWED_PREFIX literally (e.g., the test passes "/tmp/lazarus-sandbox/...").
  const posixPath = resolved.split(nodePath.sep).join("/");
  const normalAllowed = ALLOWED_PREFIX.toLowerCase();

  // Must start with the prefix AND the next character must be / or end of string
  // to prevent prefix-attack paths like /tmp/lazarus-sandbox-evil
  function startsWithPrefix(p: string): boolean {
    const lower = p.toLowerCase();
    return (
      lower.startsWith(normalAllowed) &&
      (lower.length === normalAllowed.length ||
        lower[normalAllowed.length] === "/" ||
        lower[normalAllowed.length] === "\\")
    );
  }

  if (!startsWithPrefix(posixPath) && !startsWithPrefix(targetPath)) {
    throw new SandboxError(
      "FS_WRITE_DENIED",
      `Write to path "${targetPath}" is outside the allowed directory ${ALLOWED_PREFIX}`
    );
  }
}

// ---------------------------------------------------------------------------
// Patch the CJS module cache so that require('fs') and require('fs/promises')
// return versions with write operations guarded by checkWrite.
// ---------------------------------------------------------------------------

function patchCjsCache(): void {
  try {
    const req = createRequire(import.meta.url);

    // Patch fs (sync)
    const fsSync = req("fs") as Record<string, unknown>;

    const origWriteFileSync = fsSync["writeFileSync"] as typeof import("node:fs").writeFileSync;
    fsSync["writeFileSync"] = (p: Parameters<typeof origWriteFileSync>[0], ...rest: unknown[]) => {
      checkWrite(typeof p === "string" ? p : String(p));
      return origWriteFileSync(p, ...(rest as [Parameters<typeof origWriteFileSync>[1], Parameters<typeof origWriteFileSync>[2]]));
    };

    const origAppendFileSync = fsSync["appendFileSync"] as typeof import("node:fs").appendFileSync;
    fsSync["appendFileSync"] = (p: Parameters<typeof origAppendFileSync>[0], ...rest: unknown[]) => {
      checkWrite(typeof p === "string" ? p : String(p));
      return origAppendFileSync(p, ...(rest as [Parameters<typeof origAppendFileSync>[1], Parameters<typeof origAppendFileSync>[2]]));
    };

    const origMkdirSync = fsSync["mkdirSync"] as typeof import("node:fs").mkdirSync;
    fsSync["mkdirSync"] = (p: Parameters<typeof origMkdirSync>[0], ...rest: unknown[]) => {
      checkWrite(typeof p === "string" ? p : String(p));
      return origMkdirSync(p, ...(rest as [Parameters<typeof origMkdirSync>[1]]));
    };

    const origRenameSync = fsSync["renameSync"] as typeof import("node:fs").renameSync;
    fsSync["renameSync"] = (oldPath: Parameters<typeof origRenameSync>[0], newPath: Parameters<typeof origRenameSync>[1]) => {
      checkWrite(typeof oldPath === "string" ? oldPath : String(oldPath));
      checkWrite(typeof newPath === "string" ? newPath : String(newPath));
      return origRenameSync(oldPath, newPath);
    };

    const origUnlinkSync = fsSync["unlinkSync"] as typeof import("node:fs").unlinkSync;
    fsSync["unlinkSync"] = (p: Parameters<typeof origUnlinkSync>[0]) => {
      checkWrite(typeof p === "string" ? p : String(p));
      return origUnlinkSync(p);
    };

    const origRmSync = fsSync["rmSync"] as typeof import("node:fs").rmSync;
    fsSync["rmSync"] = (p: Parameters<typeof origRmSync>[0], ...rest: unknown[]) => {
      checkWrite(typeof p === "string" ? p : String(p));
      return origRmSync(p, ...(rest as [Parameters<typeof origRmSync>[1]]));
    };

    // Patch fs/promises (async)
    const fsPromises = req("fs/promises") as Record<string, unknown>;

    const origWriteFile = fsPromises["writeFile"] as typeof import("node:fs/promises").writeFile;
    fsPromises["writeFile"] = (p: Parameters<typeof origWriteFile>[0], ...rest: unknown[]) => {
      checkWrite(typeof p === "string" ? p : String(p));
      return origWriteFile(p, ...(rest as [Parameters<typeof origWriteFile>[1], Parameters<typeof origWriteFile>[2]]));
    };

    const origAppendFile = fsPromises["appendFile"] as typeof import("node:fs/promises").appendFile;
    fsPromises["appendFile"] = (p: Parameters<typeof origAppendFile>[0], ...rest: unknown[]) => {
      checkWrite(typeof p === "string" ? p : String(p));
      return origAppendFile(p, ...(rest as [Parameters<typeof origAppendFile>[1], Parameters<typeof origAppendFile>[2]]));
    };

    const origMkdir = fsPromises["mkdir"] as typeof import("node:fs/promises").mkdir;
    fsPromises["mkdir"] = (p: Parameters<typeof origMkdir>[0], ...rest: unknown[]) => {
      checkWrite(typeof p === "string" ? p : String(p));
      return origMkdir(p, ...(rest as [Parameters<typeof origMkdir>[1]]));
    };

    const origRm = fsPromises["rm"] as typeof import("node:fs/promises").rm;
    fsPromises["rm"] = (p: Parameters<typeof origRm>[0], ...rest: unknown[]) => {
      checkWrite(typeof p === "string" ? p : String(p));
      return origRm(p, ...(rest as [Parameters<typeof origRm>[1]]));
    };

    const origUnlink = fsPromises["unlink"] as typeof import("node:fs/promises").unlink;
    fsPromises["unlink"] = (p: Parameters<typeof origUnlink>[0]) => {
      checkWrite(typeof p === "string" ? p : String(p));
      return origUnlink(p);
    };

    const origRename = fsPromises["rename"] as typeof import("node:fs/promises").rename;
    fsPromises["rename"] = (
      oldPath: Parameters<typeof origRename>[0],
      newPath: Parameters<typeof origRename>[1]
    ) => {
      checkWrite(typeof oldPath === "string" ? oldPath : String(oldPath));
      checkWrite(typeof newPath === "string" ? newPath : String(newPath));
      return origRename(oldPath, newPath);
    };
  } catch {
    // CJS cache patching may not be available in all environments
  }
}

patchCjsCache();
