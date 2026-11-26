---
name: prove-the-proof
description: Check that a Lazarus parity proof is strong enough to catch real bugs by running the AST mutation audit, then issue the SHA-256 Resurrection Certificate. Use after a successful resurrection, when asked how trustworthy a modernization is, for mutation testing, a mutation score or kill rate, or a resurrection certificate.
---
# Prove the proof

A green fuzz run only matters if the same fuzzer would have failed a broken rewrite. The mutation audit injects
realistic rewrite bugs into the verified code and fuzzes each mutant against the legacy original. Run it only after a
resurrection proved parity, and report the numbers exactly as returned.

## 1. Run the mutation audit
- In the studio (Tab 1): ATTACK MY OWN PROOF, or `POST /api/mutation-audit` with
  `{ "legacyCode": "<runnable legacy expression>", "modernCode": "<verified code>", "schema": { "n": "integer" }, "seed": 1337 }`.
  `legacyCode` is the specimen expression the resurrection ran, and `schema` is its fuzz schema (at most 16 parameters).
- Lazarus generates up to 5 mutants with AST operators: `truncation-sabotage` (for example `Math.trunc` to
  `Math.floor`), `boundary-flip` (`<` to `<=`), `arithmetic-flip` (`+` to `-`), `guard-sabotage` and
  `equality-flip` (`===` to `!==`). Each mutant runs in the sandbox against the legacy baseline.
- First check `baselineVerified`. If it is `false`, the unmutated candidate already differed and no mutant was
  judged; go back to the `resurrect-legacy-js` skill.

## 2. Read the kill rate honestly
- The result has `totalMutants`, `killed`, `survived` and `killRatePercent`. Each mutant reports `KILLED` with its
  `killingCounterexample`, or `SURVIVED`.
- 100% (every mutant killed) means the fuzz domain tells every generated bug apart from the original. Report it as
  "N/N mutants killed", not as a guarantee about other bugs.
- A survivor is a finding, not noise. Either the mutant is equivalent for the domain (say why, for example
  `Math.floor` vs `Math.trunc` when every input is non-negative), or the schema is too narrow. Widen the schema or
  raise the runs, resurrect again, and re-run the audit. Never delete or hide a survivor.
- `totalMutants: 0` means the code had nothing to mutate (`note` says why). That is not 100% proof strength.

## 3. Issue the Resurrection Certificate
- EXPORT PR BUNDLE in the studio, or `POST /api/export-bundle` with the verified result. The CLI writes the same
  certificate into `SPEC.md`. Pass the audit score as `mutationAudit: { killed, total }` so the certificate records
  the proof strength.
- The certificate ID is `LZ-` plus the first 12 hex characters of the SHA-256 digest. The digest covers the legacy
  source with line endings normalized to LF. It identifies which legacy code was proven; it is not a signature and
  does not cover the generated code.
- The certificate lists the parity mode (exact `Object.is`), fuzz runs and boundary runs, attempts, rules kept and
  rolled back, the `tsc --strict` result, the provenance (file, preset, GitHub, npm or pasted) and the mutation score.
  `certificateSvg` in the bundle response is the downloadable SVG version.

## Report
Give the kill rate as `killed/total`, list every survivor with its operator and your explanation, quote the
certificate ID and full SHA-256, and state the `tsc --strict` error count.
