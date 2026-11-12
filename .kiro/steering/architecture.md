---
inclusion: always
---
# Lazarus Core Architecture & Standards
- Stack: Strict TypeScript (ESM), Node.js, Vitest, and fast-check for property-based testing.
- Never use `any` or suppress TypeScript errors with `@ts-ignore`.
- Every subsystem must follow Spec-Driven Development: update `.kiro/specs/<feature>/` (`requirements.md`, `design.md`, `tasks.md`) before writing implementation code.
- All inter-process communication between the orchestrator and legacy sandboxes must use typed JSON-RPC 2.0 payloads validated at runtime.
