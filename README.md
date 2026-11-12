# LAZARUS — Autonomous Legacy & Dead-Dependency Resurrection Engine

> **Kiroween 2026 Submission — Frankenstein Category**  
> Stitching isolated legacy execution sandboxes together with a 4-agent Kiro Crew, custom MCP tooling, and `fast-check` differential property-based fuzzing.

## What Lazarus Does
Engineering teams sit on unmaintained, untested legacy modules they are afraid to touch. **Lazarus** resurrects abandoned JavaScript/CommonJS logic into modern ES2022+ code with mathematical proof of behavioral parity:

1. **Archaeologist Agent (`.kiro/agents/archaeologist.json`):** Executes the legacy module inside an isolated child-process sandbox (`src/sandbox/`) with strict memory, timeout, filesystem, and network restrictions to capture baseline I/O traces.
2. **Architect Agent (`.kiro/agents/architect.json`):** Synthesizes observed runtime behavior into formal Kiro specifications (`requirements.md` + behavioral invariants).
3. **Necromancer Agent (`.kiro/agents/necromancer.json`):** Rewrites the legacy code into clean ES2022+ while preserving subtle JavaScript edge cases.
4. **Exorcist Agent (`.kiro/agents/exorcist.json`):** Runs **differential property-based fuzzing** (`src/fuzzer/`) using `fast-check` across both the legacy sandbox and the modernized build (`Object.is` parity checks for `-0` vs `+0`, `NaN`, and integer truncation). If a mismatch occurs, Exorcist shrinks it to a minimal counterexample and feeds it back to Necromancer to self-heal automatically.

## Architecture & `.kiro/` Artifacts
- **Steering Docs (`.kiro/steering/`):** `architecture.md`, `sandbox-security.md`, and `ui-aesthetics.md`.
- **Spec-Driven Development (`.kiro/specs/`):** Full `requirements.md`, `design.md`, and `tasks.md` specs for `sandbox`, `mcp-server`, `differential-fuzzer`, `crew-orchestrator`, and `web-ui`.
- **Custom MCP Server (`.kiro/settings/mcp.json` & `src/mcp/server.ts`):** Exposes `run_legacy_probe` over stdio so Kiro agents can safely execute legacy snippets.
- **Agent Hooks (`.kiro/hooks/run-tests-on-save.json`):** Automatically runs `npx vitest run` whenever TypeScript files in `src/` are modified.
- **Custom Kiro Crew Agents (`.kiro/agents/`):** Specialized definitions for `archaeologist`, `architect`, `necromancer`, and `exorcist`.

## Quick Start

```bash
npm install
npm test        # Runs all 86 unit, integration, and property-based tests
npm start       # Launches the Resurrection Operating Table at http://localhost:3000
Open **`http://localhost:3000`**, select **Preset 1 (Self-Healing Demo)**, and click **RESURRECT SPECIMEN** to watch Exorcist catch a naive `Math.floor` negative-integer bug via fuzzing and auto-heal it to `Math.trunc`.
