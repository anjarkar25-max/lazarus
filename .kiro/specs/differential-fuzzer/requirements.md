# Differential Property-Based Fuzzer Requirements

## Functional Requirements
- Accept a legacy JavaScript snippet, a modernized candidate snippet, and a typed input schema (`integer`, `number`, `string`, `boolean`, `json`).
- Generate randomized edge-case inputs using `fast-check` arbitraries (including boundary numbers, negative zero, empty/unicode strings, and nested JSON).
- Execute both snippets independently inside `ProbeRunner` so untrusted legacy code remains strictly isolated.
- Compare execution outcomes for behavioral parity: both must either succeed with deeply equal outputs (`Object.is` semantics) or fail with matching error behavior.
- Shrink any failing input to its minimal reproducible counterexample and return sampled I/O execution traces for downstream spec synthesis.
