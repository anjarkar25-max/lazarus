# Tasks: Legacy Sandbox Subsystem

## Status Legend
- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete

---

## Task 1 — Types and Schemas
**File:** `src/sandbox/types.ts`

- [x] 1.1 Define `JsonRpcId`, `JsonRpcRequest<M, P>`, `JsonRpcSuccess<R>`, `JsonRpcError`,
         and `JsonRpcResponse<R>` base types.
- [x] 1.2 Define `ProbeParams`, `ProbeResult`, `PingResult`, and `ShutdownResult`.
- [x] 1.3 Define `SandboxErrorCode` string union and `SandboxErrorData` interface.
- [x] 1.4 Define `SandboxRequest` discriminated union covering `sandbox.probe`,
         `sandbox.ping`, and `sandbox.shutdown`.
- [x] 1.5 Confirm zero TypeScript errors under `strict` mode with no `any` usage.

---

## Task 2 — Error Class
**File:** `src/sandbox/errors.ts`

- [x] 2.1 Implement `SandboxError extends Error` with `code: SandboxErrorCode` and optional
         `detail: string`.
- [x] 2.2 Implement `SandboxError.toJsonRpcError(id: JsonRpcId): JsonRpcError` mapping each
         `SandboxErrorCode` to its documented numeric JSON-RPC code.
- [x] 2.3 Write Vitest unit tests in `src/sandbox/__tests__/errors.test.ts`:
  - Each `SandboxErrorCode` produces the correct numeric code.
  - `message` and `data.detail` are preserved in the output.
  - `id` is forwarded unchanged (string, number, and null variants).

---

## Task 3 — Runtime Validation
**File:** `src/sandbox/validate.ts`

- [x] 3.1 Implement `isJsonRpcEnvelope(v: unknown)` type predicate.
- [x] 3.2 Implement `isProbeParams(v: unknown)` type predicate validating `code` is a
         non-empty string and `context`, when present, is a plain object.
- [x] 3.3 Implement `isSandboxRequest(v: unknown)` type predicate dispatching on `method`.
- [x] 3.4 Write Vitest unit tests in `src/sandbox/__tests__/validate.test.ts`:
  - Valid envelopes pass; missing/wrong `jsonrpc` field fails.
  - `isSandboxRequest` rejects unknown method names.
  - Empty `code` string rejected by `isProbeParams`.
- [x] 3.5 Write fast-check property tests in the same file:
  - `fc.anything()` as input to each predicate never throws an unhandled exception.
  - Well-formed envelope records always pass `isJsonRpcEnvelope`.

---

## Task 4 — Network Shim
**File:** `src/sandbox/shims/network.ts`

- [x] 4.1 Export named blocking functions for `net.connect`, `net.createConnection`,
         `http.request`, `http.get`, `https.request`, `https.get`, `dgram.createSocket`;
         each throws `SandboxError(NETWORK_BLOCKED)`.
         Patch the CJS module cache via `createRequire()` on import (ESM namespaces are
         sealed and cannot be mutated directly).
- [x] 4.2 Write Vitest unit tests in `src/sandbox/__tests__/shims.test.ts`:
  - Each exported blocking function throws `SandboxError` with `NETWORK_BLOCKED`.
  - CJS require cache is patched for `net.connect` and `http.request`.

---

## Task 5 — Filesystem Shim
**File:** `src/sandbox/shims/fs.ts`

- [x] 5.1 Export `checkWrite(path)` that resolves to absolute and blocks writes outside
         `/tmp/lazarus-sandbox` (trailing-separator check prevents prefix attacks).
- [x] 5.2 Patch CJS module cache for all write-capable `fs` and `fs/promises` functions
         via `createRequire()`.
- [x] 5.3 Leave read-only operations (`readFile`, `readdir`, `stat`, etc.) unmodified.
- [x] 5.4 Extend `src/sandbox/__tests__/shims.test.ts`:
  - Write to `/tmp/lazarus-sandbox/allowed.txt` is not blocked.
  - Write to `/etc/hosts` throws `SandboxError(FS_WRITE_DENIED)`.
  - Prefix-attack path `/tmp/lazarus-sandbox-evil/file.txt` is blocked.
  - `readFile` is not affected.
- [x] 5.5 Write fast-check property tests: arbitrary paths outside the allowed prefix are blocked.

---

## Task 6 — Probe Runner
**File:** `src/sandbox/runner.ts`

- [x] 6.1 Implement `ProbeRunner.run(params: ProbeParams): Promise<ProbeResult>`.
- [x] 6.2 Spawn child with `--max-old-space-size=256`; inline script loads shims via
         `import()` using `file://` URLs (required on Windows for absolute paths).
- [x] 6.3 Set 3,000 ms `setTimeout`; on expiry `SIGKILL` child and reject with `TIMEOUT`.
- [x] 6.4 Detect OOM (V8 OOM string in stderr) → `MEMORY_EXCEEDED`; detect vm timeout
         message → `TIMEOUT`; other non-zero exit → `EXECUTION_ERROR`.
- [x] 6.5 `settle()` guard ensures `child.kill()` and `clearTimeout` always execute.
- [x] 6.6 Write Vitest unit tests in `src/sandbox/__tests__/runner.test.ts`:
  - Well-behaved script resolves `ProbeResult`.
  - Busy-loop > 3 s rejects with `TIMEOUT`.
  - `process.exit(1)` rejects with `EXECUTION_ERROR`.
  - Thrown error rejects with `EXECUTION_ERROR`.

---

## Task 7 — RPC Router
**File:** `src/sandbox/router.ts`

- [x] 7.1 Implement line-delimited stdin reader via `readline`.
- [x] 7.2 Dispatch `sandbox.ping` → `{ pong: true }`.
- [x] 7.3 Dispatch `sandbox.probe` → delegate to `ProbeRunner.run`; preserve `SandboxError`
         codes from runner (do not force to `EXECUTION_ERROR`).
- [x] 7.4 Dispatch `sandbox.shutdown` → write `{ acknowledged: true }` then exit.
- [x] 7.5 Write parse error (`-32700`) for non-JSON lines.
- [x] 7.6 Write `INVALID_REQUEST (-32600)` for JSON that fails `isSandboxRequest`.
- [x] 7.7 Write Vitest unit tests in `src/sandbox/__tests__/router.test.ts`.

---

## Task 8 — Host Entry Point
**File:** `src/sandbox/host.ts`

- [x] 8.1 On startup, verify/create `/tmp/lazarus-sandbox`; exit with code `1` if it fails.
- [x] 8.2 Instantiate `RpcRouter` and begin reading stdin.
- [x] 8.3 Handle `SIGTERM` / `SIGINT` gracefully.

---

## Task 9 — Sandbox Client
**File:** `src/sandbox/client.ts`

- [x] 9.1 Implement `SandboxClient.spawn()`: detect `.ts` host and use `tsx` (platform-aware
         `.cmd` on Windows) to run it; fall back to `node --import tsx/esm`.
- [x] 9.2 Implement `SandboxClient.probe(params)`.
- [x] 9.3 Implement `SandboxClient.shutdown()`.
- [x] 9.4 Implement `SandboxClient[Symbol.asyncDispose]()` for `await using`.
- [x] 9.5 `Map<id, {resolve, reject}>` for in-flight requests; unexpected host exit rejects
         all pending with `INTERNAL_ERROR`.
- [x] 9.6 Write Vitest integration tests in `src/sandbox/__tests__/client.test.ts`.

---

## Task 10 — Vitest Configuration and CI Scripts
**Files:** `vitest.config.mjs`, `package.json`

- [x] 10.1 Add `vitest.config.mjs` with `environment: 'node'`, `include` pattern,
          `testTimeout: 10_000`, `pool: 'forks'`, and `cacheDir` pointing outside
          `node_modules` to avoid write-permission issues.
- [x] 10.2 Add `"test": "vitest --run"` and `"test:sandbox": "vitest --run src/sandbox"`
          to `package.json`; set `"type": "module"`.
- [x] 10.3 All 76 tests pass: `npm run test:sandbox` exits 0.
