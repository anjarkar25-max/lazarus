# Design: Mutation Proof and Types

## Mutant generation
- One walk of the parsed candidate registers sites (`{ operator, label, index, apply }`), where `index` is the node's
  position in walk order. To build a mutant, the source is re-parsed, the same walk finds the node at `index`, `apply`
  mutates it in place, and astring prints the program. Re-parsing keeps mutants independent of each other.
- Harness guard ranges are collected first, and sites inside them are skipped (indices still count every node, so the
  two walks agree).
- Distinctness: whitespace-normalized printed code, compared against the original and every emitted mutant.

## Audit
- `DifferentialFuzzer` with `{ exact: true, boundary: true, shrink: false }`. `shrink: false` maps to fast-check's
  `endOnFailure`; a corpus failure already returns immediately. Counterexamples are wire (tagged) inputs, shown via
  `describeValue(decodeTagged(...))`.
- Order: baseline, then mutants one after another on the same two warm pools.

## Type Alchemist
- `typeOfValue` → `mergeTypes` (structural least upper bound: arrays merge elements, objects merge fields and mark
  missing ones optional, otherwise a sorted union; more than 4 non-nullish members collapse to `unknown`).
- Observations come from the orchestrator's passing fuzz run via `FuzzOptions.observe` (legacy outcomes; the candidate
  matched them by definition). Decoding uses `decodeTagged`, so `-0`, `NaN` and `undefined` are seen exactly.
- The server never accepts type text: `parseSignature` validates the structured signature, and rendering happens
  server-side. JSDoc text is sanitized against `*/` and newlines.

## Integration
- `bundle.ts`: the typed branch is taken only when the signature's parameter names equal the resolved schema
  parameters. The untyped branch keeps the exact previous header and signature. (This also removes a broken, dead module
  branch that an earlier edit had left inside `generateSingleBundle`; the module wrapper always overwrote its output.)
- Certificate: optional `mutation: { killed, total }` adds one table row; the UI inserts the same row when copying.
- UI: `window.lastTypeSignature` and `window.lastMutationScore` are sent with the export payload. The card is hidden
  for module-mode results (no flat schema).

## Trade-offs
- Observed types are not proofs: a return type of `number` means every observed run returned a number. The JSDoc
  `@remarks` and the pill tooltip state the sample count and "fuzzed domain only".
- A mutant that loops forever costs one watchdog timeout (about 3 s) before it is killed; the audit stays correct but
  slower. Mutants that change a loop bound by one terminate.
