// Task 1: All TypeScript types and JSON-RPC 2.0 schemas for the sandbox subsystem.

// ---------------------------------------------------------------------------
// 1.1  JSON-RPC 2.0 base types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 1.3  Error data
// ---------------------------------------------------------------------------

export type SandboxErrorCode =
  | "TIMEOUT"
  | "MEMORY_EXCEEDED"
  | "NETWORK_BLOCKED"
  | "FS_WRITE_DENIED"
  | "INVALID_REQUEST"
  | "EXECUTION_ERROR"
  | "INTERNAL_ERROR";

export interface SandboxErrorData {
  readonly sandboxCode: SandboxErrorCode;
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// 1.2  Method-specific parameter / result types
// ---------------------------------------------------------------------------

export interface ProbeParams {
  readonly code: string;
  readonly context?: Record<string, unknown>;
  /**
   * "tagged" exchanges -0, NaN, Infinity and undefined as `{"$lazarus": kind}` markers in both
   * `context` and the returned `output` (see tagged.ts). Defaults to plain JSON.
   */
  readonly encoding?: "json" | "tagged";
}

export interface ProbeResult {
  readonly output: unknown;
  readonly durationMs: number;
  readonly memoryUsedBytes: number;
  /** Captured console.log/info/debug output (only produced by the pooled worker). */
  readonly stdout?: string;
  /** Captured console.warn/error output (only produced by the pooled worker). */
  readonly stderr?: string;
}

/** Anything that can execute a probe: ProbeRunner, VmProbeExecutor, PooledProbeRunner. */
export interface ProbeExecutor {
  run(params: ProbeParams): Promise<ProbeResult>;
  /**
   * True when the executor honours `ProbeParams.encoding === "tagged"` (see tagged.ts), which is what
   * lets the fuzzer compare `-0`, `NaN`, `Infinity` and `undefined` exactly. Absent means plain JSON only.
   */
  readonly supportsTaggedEncoding?: boolean;
}

export interface PingResult {
  readonly pong: true;
}

export interface ShutdownResult {
  readonly acknowledged: true;
}

// ---------------------------------------------------------------------------
// 1.4  Discriminated union of all supported request shapes
// ---------------------------------------------------------------------------

export type SandboxRequest =
  | JsonRpcRequest<"sandbox.probe", ProbeParams>
  | JsonRpcRequest<"sandbox.ping", Record<string, never>>
  | JsonRpcRequest<"sandbox.shutdown", Record<string, never>>;
