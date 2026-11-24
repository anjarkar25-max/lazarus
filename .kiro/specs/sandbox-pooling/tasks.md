# Tasks: Sandbox Pooling

- [x] 1. Baseline: `tsc` clean; `vitest run` 108 tests / 11 suites in 18.3 s; orchestrator tests 2.09 s + 3.63 s.
- [x] 2. `types.ts`: add `ProbeExecutor`, optional `stdout`/`stderr`. `router.ts`: accept `ProbeExecutor`.
- [x] 3. `vm-executor.ts` + `worker.ts` (fresh null-prototype context per probe, shims, 256 MB flag set by the spawner).
- [x] 4. `client.ts`: options, `isAlive` (also checks the OS), `pid`, `stderrTail`, `kill()`, stdin error guard, error detail passthrough.
- [x] 5. `pool.ts`: `PooledProbeRunner` with queue, watchdog, respawn, teardown, stats.
- [x] 6. Wire `DifferentialFuzzer` (per-call pools) and `ResurrectionOrchestrator` (per-session pools), both with `return await` inside `await using`.
- [x] 7. `__tests__/pool.test.ts`: 25 tests (unit + fast-check).
- [x] 8. MCP server: `returnValue`, `stdout`, `stderr`, `metrics`; pooled runner by default; 2 new tests.
- [x] 9. Verify: `tsc` clean; 135 tests / 12 suites pass; original 11 suites 12.6 s (was 18.3 s); orchestrator tests 0.24 s + 0.25 s; 0 leaked node processes.
