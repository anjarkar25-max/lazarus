# Requirements: Legacy Sandbox Subsystem

## Overview

The sandbox subsystem provides an isolated execution environment for untrusted legacy code
within the Lazarus platform. It enforces hard resource limits, blocks all outbound network
access and host filesystem mutations, and communicates exclusively with the orchestrator
through runtime-validated JSON-RPC 2.0 messages over stdio.

---

## Functional Requirements

### REQ-SB-01 — Isolated Execution
The sandbox **must** execute untrusted legacy code inside a child process that is completely
isolated from the host process. No legacy code module may be `require`d or `import`ed
directly into the orchestrator's Node.js process.

### REQ-SB-02 — Memory Limit
The sandbox **must** enforce a hard memory ceiling of **256 MB** (268,435,456 bytes) on the
child process. Any process that exceeds this limit must be terminated immediately and the
orchestrator notified with a structured error response.

### REQ-SB-03 — Execution Timeout
Each probe invocation **must** complete within **3,000 ms** (3 seconds). If a probe has not
returned a result within this window the sandbox host must kill the child process and return
a timeout error to the orchestrator.

### REQ-SB-04 — No Outbound Network Access
The sandbox environment **must** prevent any outbound network connections initiated by
legacy code. At minimum, Node.js's `net`, `http`, `https`, `dgram`, and `dns` modules must
be overridden or blocked inside the child process context before untrusted code is loaded.

### REQ-SB-05 — Filesystem Write Restriction
The sandbox **must** block all filesystem write operations outside the directory
`/tmp/lazarus-sandbox`. Any attempt to write to a path outside this directory must throw a
`PermissionDenied` error and must not reach the underlying OS filesystem call.

### REQ-SB-06 — JSON-RPC 2.0 Communication
All messages exchanged between the orchestrator and the sandbox host process **must**
conform to the [JSON-RPC 2.0 specification](https://www.jsonrpc.org/specification). Both
request and response payloads must be validated at runtime before processing.

### REQ-SB-07 — Typed Request & Response Schemas
The subsystem must define and export TypeScript types for every JSON-RPC method it exposes.
Runtime validation must reject any payload that does not match the declared schema before
any execution begins.

### REQ-SB-08 — Probe Execution Method
The sandbox must expose a JSON-RPC method `sandbox.probe` that accepts a code string and
optional context object, executes the code under all sandbox constraints, and returns either
a success result or a structured error.

### REQ-SB-09 — Health Check Method
The sandbox must expose a JSON-RPC method `sandbox.ping` that returns `{ "pong": true }`
to allow the orchestrator to verify that the sandbox host is alive.

### REQ-SB-10 — Graceful Shutdown Method
The sandbox must expose a JSON-RPC method `sandbox.shutdown` that causes the sandbox host
process to exit cleanly after sending a final acknowledgment response.

### REQ-SB-11 — Error Classification
Every error returned by the sandbox must carry a machine-readable `code` field drawn from a
documented enum (`TIMEOUT`, `MEMORY_EXCEEDED`, `NETWORK_BLOCKED`, `FS_WRITE_DENIED`,
`INVALID_REQUEST`, `EXECUTION_ERROR`, `INTERNAL_ERROR`).

### REQ-SB-12 — Tmp Directory Initialization
On startup the sandbox host must ensure `/tmp/lazarus-sandbox` exists and is writable,
creating it if necessary. If creation fails the process must exit with a non-zero code.

---

## Non-Functional Requirements

### REQ-SB-NF-01 — No `any` Types
All TypeScript in the sandbox subsystem must comply with the project's `strict` mode and
must not use `any` or `@ts-ignore`.

### REQ-SB-NF-02 — ESM Module Format
All source files must be valid ESM modules (`.ts` with `"module": "nodenext"`) consistent
with the project's `tsconfig.json`.

### REQ-SB-NF-03 — Unit and Property-Based Tests
All public interfaces must have unit tests (Vitest) and all schema-validation and
boundary-condition logic must have property-based tests (fast-check). Tests must run via
`vitest --run` without a watch-mode dependency.

### REQ-SB-NF-04 — No External Runtime Dependencies
The sandbox subsystem must not introduce any new production `dependencies` in
`package.json`. It must rely only on Node.js built-ins and the packages already present in
`devDependencies` for tests.

### REQ-SB-NF-05 — Deterministic Resource Cleanup
Every child process spawned by the sandbox host must be explicitly killed and its resources
released whether execution succeeds, times out, or throws. No zombie processes may be left
behind.
