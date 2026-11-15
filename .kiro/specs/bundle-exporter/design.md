# Design: GitHub Importer, AST Extractor & Bundle Exporter

**Architecture Overview**
1. **GitHub Source Fetcher (src/importer/github.ts):** Validates HTTPS raw GitHub URLs, enforces a 5-second timeout and 32 KB payload cap, and extracts legacy function definitions.
2. **AST Signature Scanner (src/sandbox/ast-scanner.ts):** Parses function name(params) and module.exports patterns to identify target entrypoints and parameter counts for sandbox probing.
3. **Bundle Generator (src/exporter/bundle.ts):** Packages the resurrected ES2022/TypeScript code, Kiro SPEC.md, and a standalone fast-check property test file into a downloadable JSON payload via POST /api/export.
