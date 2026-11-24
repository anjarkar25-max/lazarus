# Requirements: Sandbox Pooling

Goal: stop spawning a fresh `ProbeRunner` child process for every fuzz input. Reuse one warm,
isolated worker per implementation side (legacy, modern) for the lifetime of a `fuzz()` call or a
`resurrect()` session, without weakening any sandbox guarantee.

## Functional

- **REQ-SP-01 Persistent worker.** A new `src/sandbox/worker.ts` process serves many
  `sandbox.probe` calls over the existing typed, runtime-validated JSON-RPC 2.0 stdio protocol.
- **REQ-SP-02 Per-probe isolation.** Every probe runs in a fresh `node:vm` context built with a
  null-prototype sandbox. Nothing from the host realm (`console`, context values, `constructor`
  chains) is reachable from probe code. Mutations to globals or built-in prototypes in one probe
  are never visible to the next.
- **REQ-SP-03 `PooledProbeRunner`.** Implements `ProbeExecutor` (`run(params) => Promise<ProbeResult>`)
  and `AsyncDisposable`. It spawns its worker lazily, runs probes one at a time, and reuses the
  worker until it is unhealthy.
- **REQ-SP-04 Self-recovery.** If a probe ends in `TIMEOUT`, `MEMORY_EXCEEDED` or `INTERNAL_ERROR`,
  or the worker process is found dead (including death between probes), the runner kills and
  disposes that worker and transparently spawns a fresh one for the next probe. A probe that
  kills the worker is reported as `EXECUTION_ERROR`, or `MEMORY_EXCEEDED` when stderr shows a V8
  out-of-memory abort. An ordinary thrown error leaves a healthy worker in place.
- **REQ-SP-05 Deterministic teardown.** `close()` and `[Symbol.asyncDispose]` stop the worker,
  wait for its process to exit, and are idempotent. No Node process survives, on success or on
  error paths. A closed runner rejects new probes with `INTERNAL_ERROR`.
- **REQ-SP-06 Fuzzer wiring.** `DifferentialFuzzer` accepts any `ProbeExecutor`, or separate
  `{ legacy, modern }` executors. With no executor injected, each `fuzz()` call creates one
  `PooledProbeRunner` per side and disposes both with `await using`.
- **REQ-SP-07 Orchestrator wiring.** With no runner or fuzzer injected, `ResurrectionOrchestrator.resurrect()`
  creates one legacy and one modern pool for the whole session, uses the legacy pool for the baseline
  probes, shares both pools across every healing attempt, and disposes them in all outcomes.

## Non-functional / security

- **REQ-SP-08 Same limits as `ProbeRunner`.** Worker heap capped at 256 MB
  (`--max-old-space-size=256`); at most 3000 ms per probe, enforced by a vm timeout inside the
  worker and a hard watchdog in the pool that kills the worker; network and filesystem-write shims
  loaded before any probe code. Legacy code never runs in the host or orchestrator process.
- **REQ-SP-09 No regressions.** `ProbeRunner`, `SandboxClient`, `RpcRouter` public APIs stay
  source-compatible; all 108 existing tests pass unchanged and unweakened.
- **REQ-SP-10 Typing.** Strict TypeScript, no `any`, no `@ts-ignore`; every worker message passes
  the existing runtime validators.
- **REQ-SP-11 Performance.** `orchestrator.test.ts` completes well under 15 s; total `vitest run`
  time is measured before and after.
