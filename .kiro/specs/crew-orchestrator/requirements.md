# Kiro Crew Resurrection Orchestrator Requirements

- Coordinate four specialized agents in sequence: Archaeologist -> Architect -> Necromancer -> Exorcist.
- Stream structured telemetry events (`agent_started`, `spec_generated`, `code_synthesized`, `fuzz_progress`, `counterexample_found`, `self_healed`, `completed`) for live UI rendering.
- Run a bounded self-healing loop (up to `maxHealingAttempts`) whenever Exorcist uncovers a behavioral counterexample via `DifferentialFuzzer`.
- Support both live LLM-backed synthesis (when an API key is configured) and deterministic local AST/pattern resurrection so offline tests and live demos run reliably without external rate-limit failures.
