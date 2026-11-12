# Kiro Crew Resurrection Orchestrator Design

- `src/crew/types.ts`: Typed `AgentRole`, `CrewEvent`, `ResurrectionRequest`, `ResurrectionResult`, and `CodeSynthesizer` interface.
- `src/crew/synthesizer.ts`: Pluggable synthesis engine with a deterministic modernizer (handles legacy `var`, C-style loops, bitwise truncation `| 0`, CommonJS helpers) plus optional OpenAI-compatible HTTP adapter.
- `src/crew/orchestrator.ts`: `ResurrectionOrchestrator` executing the 4-agent state machine, invoking `ProbeRunner` and `DifferentialFuzzer`, and feeding counterexamples back to `Necromancer` until parity passes.
