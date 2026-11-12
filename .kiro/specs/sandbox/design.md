# Design: Legacy Sandbox Subsystem

## 1. Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Orchestrator Process                                           │
│                                                                 │
│  ┌─────────────────┐        stdio (newline-delimited JSON)      │
│  │  SandboxClient  │ ◄────────────────────────────────────────► │
│  └────────┬────────┘                                            │
│           │ spawn()                                             │
│  ┌────────▼────────────────────────────────────────────────┐   │
│  │  Sandbox Host Process  (src/sandbox/host.ts)            │   │
│  │                                                         │   │
│  │  ┌────────────┐   ┌──────────────┐   ┌──────────────┐  │   │
│  │  │ RPC Router │──►│  Dispatcher  │──►│ Probe Runner │  │   │
│  │  └────────────┘   └──────────────┘   └──────┬───────┘  │   │
│  │                                             │            │   │
│  │                        spawn (vm/worker)    │            │   │
│  │                   ┌─────────────────────────▼──────┐    │   │
│  │                   │  Legacy Code Execution Context  │    │   │
│  │                   │  - network shim (blocked)       │    │   │
│  │                   │  - fs shim (write-restricted)   │    │   │
│  │                   │  - memory: --max-old-space=256  │    │   │
│  │                   │  - killed after 3000ms          │    │   │
│  │                   └────────────────────────────────-┘    │   │
│  └─────────────────────────────────────────────────────────-┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Module Structure

```
src/sandbox/
├── types.ts          # All TypeScript types & JSON-RPC schemas
├── validate.ts       # Runtime payload validation functions
├── errors.ts         # SandboxError class and error code enum
├── shims/
│   ├── network.ts    # Network module override (blocks all connections)
│   └── fs.ts         # Filesystem override (enforces /tmp/lazarus-sandbox)
├── runner.ts         # ProbeRunner — spawns child, enforces limits, collects result
├── router.ts         # RpcRouter — parses stdin, dispatches methods, writes stdout
├── host.ts           # Entry point — initialises tmp dir, starts RPC router
├── client.ts         # SandboxClient — orchestrator-side handle, spawns host
└── __tests__/
    ├── validate.test.ts    # Unit + property-based tests for validation
    ├── errors.test.ts      # Unit tests for error serialisation
    ├── shims.test.ts       # Unit tests for network and fs shims
    ├── runner.test.ts      # Unit tests for ProbeRunner (timeout, memory, cleanup)
    ├── router.test.ts      # Unit tests for RpcRouter dispatch
    └── client.test.ts      # Integration-level tests for SandboxClient ↔ host
```

---

## 3. Type Definitions (`types.ts`)

### 3.1 JSON-RPC 2.0 Base Types

```typescript
export type JsonRpcId = string | number | null;

export interface JsonRpcRequest<M extends string, P> {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: M;
  readonly params: P;
}

export interface JsonRpcSuccess<R> {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: R;
}

export interface JsonRpcError {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: SandboxErrorData;
  };
}

export type JsonRpcResponse<R> = JsonRpcSuccess<R> | JsonRpcError;
```

### 3.2 Method-Specific Types

```typescript
export interface ProbeParams {
  readonly code: string;
  readonly context?: Record<string, unknown>;
}

export interface ProbeResult {
  readonly output: unknown;
  readonly durationMs: number;
  readonly memoryUsedBytes: number;
}

export interface PingResult { readonly pong: true; }
export interface ShutdownResult { readonly acknowledged: true; }

export type SandboxRequest =
  | JsonRpcRequest<"sandbox.probe",    ProbeParams>
  | JsonRpcRequest<"sandbox.ping",     Record<string, never>>
  | JsonRpcRequest<"sandbox.shutdown", Record<string, never>>;
```

### 3.3 Error Data

```typescript
export type SandboxErrorCode =
  | "TIMEOUT" | "MEMORY_EXCEEDED" | "NETWORK_BLOCKED"
  | "FS_WRITE_DENIED" | "INVALID_REQUEST" | "EXECUTION_ERROR" | "INTERNAL_ERROR";

export interface SandboxErrorData {
  readonly sandboxCode: SandboxErrorCode;
  readonly detail?: string;
}
```

---

## 4. Runtime Validation (`validate.ts`)

Validation is pure TypeScript with no external schema library. Each exported function is a
*type predicate* returning `value is T` and throws `SandboxError(INVALID_REQUEST)` on
malformed payloads.

Key functions:
- `isJsonRpcEnvelope(v)` — validates the outer wrapper (`jsonrpc`, `id`, `method`, `params`).
  Accepts both plain objects and null-prototype objects (fast-check generates both).
- `isSandboxRequest(v)` — narrows to a known method and validates method-specific params.
- `isProbeParams(v)` — validates `code` is a non-empty string and `context` is a plain object when present.

Property-based tests with `fc.anything()` fuzz all three to ensure no input causes an
uncaught exception.

---

## 5. Error Handling (`errors.ts`)

`SandboxError extends Error` with `code: SandboxErrorCode` and optional `detail: string`.
`toJsonRpcError(id)` serialises to JSON-RPC 2.0. Numeric codes:

| `SandboxErrorCode`  | JSON-RPC numeric code |
|---------------------|-----------------------|
| `INVALID_REQUEST`   | `-32600`              |
| `TIMEOUT`           | `-32001`              |
| `MEMORY_EXCEEDED`   | `-32002`              |
| `NETWORK_BLOCKED`   | `-32003`              |
| `FS_WRITE_DENIED`   | `-32004`              |
| `EXECUTION_ERROR`   | `-32005`              |
| `INTERNAL_ERROR`    | `-32099`              |

---

## 6. Network Shim (`shims/network.ts`)

**Design note:** ESM module namespaces are sealed (read-only bindings). Direct property
assignment on `import * as net` throws in strict mode. The shim uses `createRequire()` to
get the mutable CJS export object and patches it there. It also exports named blocking
functions (`blockedNetConnect`, etc.) for direct unit testing.

Patched operations: `net.connect`, `net.createConnection`, `http.request`, `http.get`,
`https.request`, `https.get`, `dgram.createSocket`. Each throws `SandboxError(NETWORK_BLOCKED)`.

---

## 7. Filesystem Shim (`shims/fs.ts`)

Same `createRequire()` strategy as the network shim. Exports `checkWrite(path)` which:
1. Resolves the path to absolute.
2. Converts to POSIX separators.
3. Checks the path starts with `/tmp/lazarus-sandbox` **and** is followed by `/` or end-of-string
   (prevents prefix-attack paths like `/tmp/lazarus-sandbox-evil/`).
4. Throws `SandboxError(FS_WRITE_DENIED)` on violation.

Patched operations (sync): `writeFileSync`, `appendFileSync`, `mkdirSync`, `renameSync`,
`unlinkSync`, `rmSync`. Patched (async via fs/promises): `writeFile`, `appendFile`, `mkdir`,
`rename`, `unlink`, `rm`. Read-only operations are unaffected.

---

## 8. Probe Runner (`runner.ts`)

```
ProbeRunner.run(params: ProbeParams): Promise<ProbeResult>
```

**Shim resolution:** Checks for `.js` shim files in the shims directory. If only `.ts`
files exist (test environment), generates pre-compiled inline JS versions into
`%TMPDIR%/lazarus-runner-shims` on first use. This avoids needing to run `tsc` at runtime.

**Execution sequence:**
1. Spawn a Node.js child with `--max-old-space-size=256 --input-type=module --eval <script>`.
2. The inline script `import()`s network and fs shims, then reads params from stdin and
   evaluates `code` via `node:vm` `runInContext` with a 2800ms vm-level timeout.
3. A 3000ms `setTimeout` in the parent kills the child with `SIGKILL` and rejects with `TIMEOUT`.
4. Exit handler: OOM exit → `MEMORY_EXCEEDED`; vm timeout message in stderr → `TIMEOUT`;
   any other non-zero exit → `EXECUTION_ERROR`. Zero exit → parse stdout as `ProbeResult`.
5. `finally`-equivalent: `child.kill()` and `clearTimeout` always run via a `settle()` guard.

---

## 9. RPC Router (`router.ts`)

Reads newline-delimited JSON from `process.stdin` via `readline`. For each line:
1. Parse JSON → on failure write `-32700` parse error.
2. `isSandboxRequest(parsed)` → on failure write `INVALID_REQUEST (-32600)`.
3. Dispatch: `sandbox.ping` → `{ pong: true }`, `sandbox.probe` → `ProbeRunner.run`,
   `sandbox.shutdown` → `{ acknowledged: true }` then `process.exit(0)`.
4. Runner errors preserve the original `SandboxError` code (not forced to `EXECUTION_ERROR`).

Every incoming line produces exactly one outgoing line (no dropped requests).

---

## 10. Sandbox Client (`client.ts`)

The orchestrator-side handle. Spawns `host.ts` (or `host.js` when compiled):
- Uses `tsx.cmd` (Windows) / `tsx` (POSIX) when the host path ends in `.ts`.
- Falls back to `node --import tsx/esm` if no tsx binary is found.
- Tracks in-flight requests via `Map<id, {resolve, reject}>`.
- Unexpected host exit rejects all in-flight requests with `INTERNAL_ERROR`.
- Implements `[Symbol.asyncDispose]` for `await using` teardown.

---

## 11. Data Flow: `sandbox.probe` End-to-End

```
Orchestrator               Sandbox Host             Child Process
─────────────              ────────────             ─────────────
client.probe(params)
  build JsonRpcRequest
  write to host stdin ──► router reads line
                            isSandboxRequest()
                            dispatch → runner.run()
                              spawn child ────────► load shims (via import())
                              set 3s timer           eval code in vm
                              await exit  ◄───────── write ProbeResult JSON
                            build JsonRpcSuccess
  resolve promise ◄──────── write to stdout
```

---

## 12. Test Strategy

| Layer         | Tool       | Coverage                                                         |
|---------------|------------|------------------------------------------------------------------|
| `validate.ts` | fast-check | Arbitrary unknown values never throw unhandled exceptions        |
| `validate.ts` | Vitest     | Valid payloads accepted; specific invalid shapes rejected        |
| `errors.ts`   | Vitest     | Each code → correct numeric JSON-RPC code; id forwarded          |
| `shims/`      | Vitest     | Blocking fns throw `NETWORK_BLOCKED`; `checkWrite` prefix logic  |
| `shims/fs.ts` | fast-check | Arbitrary paths outside allowed prefix are blocked              |
| `runner.ts`   | Vitest     | Clean exit resolves; timeout/OOM/throw → correct error codes     |
| `router.ts`   | Vitest     | Malformed JSON / unknown method / all three methods dispatched   |
| `client.ts`   | Vitest     | Full spawn→ping→probe→shutdown lifecycle; `await using` teardown |
