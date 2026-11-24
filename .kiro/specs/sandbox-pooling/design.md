# Design: Sandbox Pooling

## Why a new worker

`SandboxClient` spawns `host.ts`, whose `RpcRouter` delegates each probe to `ProbeRunner`, which
spawns another child. Pooling on top of that adds a process per probe. The warm path therefore needs
an in-process executor inside the worker.

```
DifferentialFuzzer / ResurrectionOrchestrator
   └─ PooledProbeRunner (queue, watchdog, respawn)        one per side: legacy, modern
        └─ SandboxClient (JSON-RPC over stdio)
             └─ worker.ts  (shims → RpcRouter → VmProbeExecutor)   --max-old-space-size=256
                  └─ fresh node:vm context per probe
```

## Units

| File | Role |
|------|------|
| `types.ts` | Add `ProbeExecutor { run(params): Promise<ProbeResult> }`; optional `stdout?`/`stderr?` on `ProbeResult`. |
| `vm-executor.ts` | `VmProbeExecutor implements ProbeExecutor`. One fresh context per call. |
| `worker.ts` | Entry: import network + fs shims, then `new RpcRouter({ runner: new VmProbeExecutor() })`. |
| `router.ts` | `RouterDeps.runner` widened from `ProbeRunner` to `ProbeExecutor` (compatible). |
| `client.ts` | Optional `SandboxClientOptions` (`execArgv`, `env`, `pipeStderr`); add `isAlive`, `pid`, `stderrTail`, `kill()`; swallow stdin `EPIPE`. Defaults unchanged. |
| `pool.ts` | `PooledProbeRunner`, `PoolWorker` interface (implemented by `SandboxClient`, injectable for tests). |
| `fuzzer/differential.ts` | Accept `ProbeExecutor \| { legacy, modern }`; default path uses per-call pools. |
| `crew/orchestrator.ts` | Session-scoped pools when nothing is injected. |

## VmProbeExecutor isolation

1. `createContext(Object.create(null))`, so `this.constructor` resolves inside the context realm, not
   the host's `Object`/`Function`.
2. Inputs are passed as a JSON string and parsed **inside** the context, so no host-realm object is
   reachable. `console` (capturing stdout/stderr, capped at 64 KB) and `process = { env: {} }` are
   created inside the context too.
3. User code runs with `timeout: 2800`. The result is serialised by a `JSON.stringify` captured
   before user code ran, executed via `runInContext` under the remaining budget, so user `toJSON` code
   cannot run unbounded in the worker.
4. Thrown values are described inside the context. Host-side checks use only trap-free operations
   (`util.types.isNativeError`, own data-property descriptors).
5. `vm` is not a security boundary on its own. The boundary is the worker process (256 MB heap,
   shims, watchdog, kill-on-failure). The null-prototype sandbox removes the known cheap escapes.

## PooledProbeRunner

- Serial queue (promise chain): one in-flight probe per worker, so a long synchronous probe cannot
  make a queued probe miss its own deadline.
- Watchdog `min(probeTimeoutMs, 3000)` per probe. On expiry reject `TIMEOUT` and kill the worker.
- Health check before each probe (`isAlive`); dead workers are disposed and replaced.
- After a failure: dispose on `TIMEOUT | MEMORY_EXCEEDED | INTERNAL_ERROR` or if the worker died.
  A death mid-probe is reclassified from `INTERNAL_ERROR` to `EXECUTION_ERROR` / `MEMORY_EXCEEDED`.
- `close()`: wait for the queue to drain, ask for graceful `sandbox.shutdown` (1 s cap), then `kill()`
  and await the `exit` event. `stats` exposes `spawns`, `respawns`, `probes`, `disposals`.

## Test plan (`__tests__/pool.test.ts`)

- Vm executor in-process: global and prototype state never leaks (unit and fast-check), host realm
  not reachable, console capture, error classification.
- Real worker: warm reuse (same pid), escape attempt cannot kill the worker, respawn after `TIMEOUT`,
  respawn after an external kill mid-probe and between probes, OOM classification, teardown (pid gone)
  on normal exit and on error path, closed-runner behaviour.
- Fake `PoolWorker`: watchdog, death classification, fast-check state machine (random outcome
  sequences leave at most one live worker and zero after `close()`).
- Fuzzer/orchestrator wiring: pools are disposed even when the fuzz run throws.
