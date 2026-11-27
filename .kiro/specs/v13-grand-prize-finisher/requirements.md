# Requirements: V13 Grand Prize Finisher

Three strictly additive polish upgrades to Tab 1 (Operating Table). Constraints that hold for every requirement:
no new top-level tab, no edit to any Tab 3 Red-Team line in `public/index.html`, no external API key, no new npm
dependency, and no regression in the 957 existing tests.

## R1. Guided Judge Tour auto-dock and Self-Healing Causal Strip (Tab 1)

- R1.1 When a resurrection completes, or the user clicks "Compare vs. Naive AI", "Open Mutant Autopsy" or the Certificate
  controls, the Guided Judge Tour banner (`#tourHud`) collapses into a compact corner pill with `Resume Tour` and `×`.
  The pill never covers the Trap Card, Mutant Autopsy or Certificate controls.
- R1.2 `Resume Tour` expands the banner again. `×` closes it. Cancelling or finishing the tour keeps existing behavior.
- R1.3 The Verification Deck shows a compact horizontal Self-Healing Causal Strip of 4 nodes above the diff once a
  resurrection succeeds.
  - With a rollback: `Draft 1` → `Counterexample Caught (<input>)` → `Rule Rolled Back (<rule>)` → `Draft 2 Proven (Object.is 100%)`.
  - Without a rollback: `AST Lifted` → `Exorcist Fuzzed` → `Zero Divergences` → `100% Exact Parity`.
- R1.4 The strip is built only from data of the actual run (counterexample event, certificate `rolledBack`, attempts).
  It is rebuilt (never accumulated) on each run and hidden while a run is in progress or after a failure.

## R2. Ed25519 signed certificates and tamper verifier

- R2.1 `src/exporter/cert-crypto.ts` uses only `node:crypto` (`ed25519`). The key is read from `LAZARUS_ED25519_PRIVATE_KEY_PEM`
  when set, otherwise derived deterministically from a fixed public demo seed (the demo key is therefore not a secret; this is stated in the UI/docs).
- R2.2 The signed canonical JSON payload has the fields `legacySha256`, `resurrectedSha256`, `paritySummary`,
  `mutantsKilled` (number or `null`), `tscStrictErrors` (number or `null`), `issuedAt`, serialized with a fixed key order.
  The signature block has `signatureB64`, `publicKeyPem`, `keyId`.
- R2.3 `/api/resurrect` attaches the block as `certificate.signature`. `generateCertificate` and its Markdown/SHA-256 output stay
  unchanged and pure. The SVG certificate gains an embedded `<metadata>` element and a one-line signature note. The export `.zip`
  gains `certificate.json` (payload, signature block, and the file that was hashed).
- R2.4 `POST /api/verify-certificate` accepts `{ payload, signatureB64, publicKeyPem, resurrectedCode, legacyCode? }` (zod `strict`) and returns
  `{ valid, reason, expectedDigest, actualDigest, keyId }`. The digest is the SHA-256 of the submitted code; it is compared with
  `payload.resurrectedSha256`; then the signature is verified over the canonical payload.
- R2.5 `lazarus verify <bundle.zip>` (and `npm run verify -- <bundle.zip>`) reads `certificate.json` and the hashed file from the zip,
  prints the result, and exits 0 when valid, 1 when invalid, 2 on bad usage.
- R2.6 Tab 1's Certificate viewer shows a `Ed25519 Signed · VERIFIED` badge and a `Simulate 1-Byte Tamper` button. The button changes one
  character in a copy of the resurrected code, calls `/api/verify-certificate`, and turns the badge red:
  `TAMPER DETECTED (Digest / Signature Mismatch)`. A `Restore Verified` button resets it. The real code in the editor is never modified.

## R3. 3-way interactive Judge Probe

- R3.1 For synchronous presets, `POST /api/probe` accepts an optional `compareNaive: true`. The response then adds `naive` (a probe side),
  `naiveCode`, `naiveApplies`, `naiveDiverges` (Object.is aware, vs. Legacy) and `lazarusMatchesLegacy`. Without the flag the response is unchanged.
- R3.2 The Probe card shows Legacy, Naive AI and Lazarus outputs with `-0`, `+0` and `NaN` kept distinguishable. The Naive AI cell is crimson when it
  diverges from Legacy; the verdict states `Object.is: true` when Lazarus matches Legacy.
- R3.3 The async preset (`legacyReadConfigCb`) keeps hiding the Probe card exactly as before.

## R4. Verification

- R4.1 New tests: `src/exporter/__tests__/cert-crypto.test.ts` (sign/verify, 1-byte tamper, altered signature, CLI verify on an exported zip).
- R4.2 Extended tests: `naive-refactor.test.ts`, `studio-ui.test.ts`, `kiro-dna.test.ts` (3-way probe, strip, auto-dock, `/api/verify-certificate`, `23 Kiro Specs`, zero Tab 3 diff lines).
- R4.3 `npx tsc --noEmit` exits 0. Full `npx vitest run` is green with no leaked Node processes.
- R4.4 `#badgeSpecs` reads `23 Kiro Specs`; `#badgeTests` reads the exact final passing count; every task below is ticked.
