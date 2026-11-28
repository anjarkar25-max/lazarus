# Design: V19 Gauntlet and Security

## Edge Gauntlet
`src/crew/edge-gauntlet.ts` exports `EDGE_CASES` (the 12 fixed cases), `buildEdgeContext(schema, case)`, `runEdgeGauntlet(input, executors)`
and a convenience `runEdgeGauntletPooled` that owns two `PooledProbeRunner`s and closes them. Every case runs three probes (legacy
expression, naive rewrite, resurrected code) with `encoding: "tagged"`; the outputs are decoded and compared with
`areOutputsEquivalent` (tagged `Object.is`). The server keeps two dedicated pools and a busy flag, like the naive comparison.
The sandbox protocol is untouched (typed JSON-RPC 2.0 already validates every probe).

## Security Exorcist
`src/crew/security-exorcist.ts` has the pure analysis (`findProtoPollutionSites`, `findLooseEqualitySites`, both on `ast-scope`'s
walk) and the sandbox exploit probe (`probeProtoPollution`). `ast-modernizer.ts` adds the rule `proto-pollution-guard` right before
`global-leak-fix` in `RULE_ORDER` (so `encodeLevels` still ends with `global-leak-fix=declare`). The guard statement is built from AST nodes.
The exploit probe wraps the resurrected code: it sets every `json` input to the parsed `{"__proto__":{"polluted":true}}` payload (and a
fresh `{}` for the others), evaluates the code with indirect eval, reads `({}).polluted`, and deletes the key again so a pooled worker
is never left polluted. `auditPurity` calls it and sets `protoPollutionBlocked` only when the legacy code is a copy-loop site.

## Seeds
The orchestrator's request `seed` is the base seed (attempt n fuzzes with `seed + n`). The server draws `proofSeed` (31-bit integer) when
the client sends none and reports `proofSeed` and `numRuns` on the result. `signCertificate` takes an optional `proofSeed`; the canonical
payload appends it after `issuedAt` only when present, so older signatures verify unchanged. Bundles take `seed` and print
`{ numRuns: N, seed: S }`; the report shows the seed in the proof section.

## UI
All additions are new elements inside Tab 1 and a new script/CSS block after the V18 ones (`/* ---- V19:`), outside every Tab 3 region.
