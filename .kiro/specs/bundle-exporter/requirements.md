# Requirements: GitHub Legacy Importer & Resurrection Bundle Exporter

**User Story 1: Raw GitHub CommonJS Ingestion**
As an engineer migrating legacy dependencies, I want to fetch a raw .js file from GitHub or select a multi-function CommonJS module so Lazarus can resurrect real-world files beyond single-line expressions.

**Acceptance Criteria**
1. WHEN a valid raw GitHub .js URL or curated CommonJS module is selected THEN the system SHALL sanitize and load the legacy source into the Operating Table.
2. IF the URL is not a valid HTTPS GitHub/Gist raw JavaScript source or exceeds 32 KB THEN the importer SHALL reject the request with a structured validation error.

**User Story 2: Multi-Function AST Signature Extraction**
As the Archaeologist agent, I want to extract exported function names, parameter arity, and return invariants across a legacy file so the Architect agent can synthesize complete module specifications.

**User Story 3: One-Click Resurrection Bundle Export**
As a developer ready to open a Pull Request, I want to export a complete migration bundle containing the modernized .ts module, SPEC.md blueprint, and runnable fast-check Vitest suite (resurrected.test.ts).
