# Differential Property-Based Fuzzer Design

## Architecture
- `src/fuzzer/types.ts`: Defines `ParamKind`, `InputSchema`, `FuzzTrace`, `CounterexampleReport`, `FuzzOptions`, and `FuzzReport`.
- `src/fuzzer/differential.ts`: Maps `InputSchema` entries to `fast-check` arbitraries (`fc.integer`, `fc.double`, `fc.string`, `fc.boolean`, `fc.jsonValue`), runs `fc.check(fc.asyncProperty(...))` against dual `ProbeRunner` executions, and captures the shrunk counterexample alongside legacy vs. modern outputs.
- Parity Oracle (`areOutputsEquivalent`): Uses `Object.is` for primitives (catching `-0` vs `+0` and `NaN` divergences) and recursive structural comparison for arrays and plain objects.
