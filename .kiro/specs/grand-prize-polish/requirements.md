# Requirements: Grand Prize Polish

## Introduction
Three finishing features: a one-click `.zip` PR archive with a generated GitHub Actions workflow, scroll-into-view on bundle
export, and a live "Red-Team the Sandbox" panel that proves containment with real attacks. Constraints: strict TypeScript,
no new runtime dependencies (Node built-ins only), all 433 existing tests keep passing, `tsc --noEmit` clean, legacy or hostile
code runs only inside the pooled sandbox worker (`sandbox-security.md`), UI follows `ui-aesthetics.md`.

## Requirements

### R1. ZIP builder (`src/exporter/zip.ts`)
1. `createZip(entries)` returns a standards-compliant ZIP (local file headers `PK\x03\x04`, central directory `PK\x01\x02`,
   end-of-central-directory `PK\x05\x06`) using only `node:zlib` and `Buffer`. No ZIP64.
2. Each entry is Deflate-compressed (`deflateRawSync`) when that is smaller, otherwise Stored. CRC-32 is computed per entry.
3. Names are UTF-8 (general-purpose flag bit 11), use `/`, and are validated: no empty, absolute, drive-letter, backslash,
   `..` or duplicate names. Limits (65 535 entries, 4 GiB) throw instead of producing a corrupt archive.
4. Output is deterministic (fixed DOS timestamp, fixed attributes), so the same input gives byte-identical archives.
5. `readZip(buffer)` parses the central directory, inflates entries and verifies CRC-32 and sizes. It exists for tests and
   self-checks, and rejects truncated or tampered archives.

### R2. CI workflow and bundle
1. `generateResurrectionBundle` adds `.github/workflows/lazarus-parity.yml` to `files`: on `pull_request` (and manual
   `workflow_dispatch`), checkout, setup-node, `npm ci`, `npx vitest run resurrected.test.ts`. Least-privilege
   `permissions: contents: read`.
2. The PR Bundle Exporter shows it as a tab next to `resurrected.ts`, `resurrected.test.ts`, `SPEC.md` and the PR diff.
3. The CLI writes nested bundle paths (creating directories) and the exported set stays identical to the web bundle.

### R3. `POST /api/export-zip`
1. Same request body and validation as `/api/export-bundle`. Response: `200`, `Content-Type: application/zip`,
   `Content-Disposition: attachment; filename="lazarus-pr-bundle.zip"`, body is the archive.
2. The archive holds every bundle file plus `resurrection.patch` (the PR diff), organized with the workflow under
   `.github/workflows/`. Errors reuse the JSON error shape of `/api/export-bundle` (400).

### R4. UI polish
1. A "Download .zip PR Archive" button in the PR Bundle header fetches `/api/export-zip` and saves `lazarus-pr-bundle.zip`.
2. When EXPORT PR BUNDLE succeeds, the PR Bundle section scrolls into view with
   `scrollIntoView({ behavior: 'smooth', block: 'start' })`.
3. The workflow file is a tab; downloading a nested tab uses its base file name.

### R5. `POST /api/redteam`
1. Body `{ attack }` validated with `zod` (strict): `infinite-loop | process-exit | heap-bomb | prototype-escape`.
   Anything else is `400`. The server runs only its own whitelisted snippets; no request data ever reaches the sandbox as code.
2. The attack runs in a dedicated `PooledProbeRunner` (separate from probe/resurrect pools). The response reports
   `contained`, the real outcome (`errorCode` such as `TIMEOUT`, `EXECUTION_ERROR`, `MEMORY_EXCEEDED`, or the returned value
   for the escape attempt), elapsed ms, whether the worker was respawned (spawn counter and PID), and a benign canary
   `1 + 1` run on the same pool: `canaryResult: 2`, `recovered: true`.
3. One attack at a time: a concurrent request gets `429 BUSY`, so the endpoint cannot be used to stack heap bombs.
4. The pool is closed with the server, with no leaked Node processes.

### R6. Red-Team card (UI)
1. A compact collapsible "Red-Team the Sandbox" card with four buttons: Infinite Loop, `process.exit(1)`, 256MB Heap Bomb,
   Hostile Escape.
2. Each run shows a `CONTAINED` (emerald) or `ESCAPED` (crimson) badge, the real error code, elapsed ms, the canary result
   and `WORKER RESPAWNED & HEALTHY` (or `WORKER HEALTHY` when no respawn was needed). Built with `textContent`, no frameworks.

### R7. Tests
1. `src/exporter/__tests__/zip.test.ts`: magic numbers, EOCD, CRC-32 (against `zlib.crc32`), names including the workflow,
   byte-exact UTF-8 round trip of every bundle file, Stored vs Deflate, name validation, determinism, tamper detection.
2. `src/web/__tests__/redteam.test.ts`: all four attacks with accurate codes, `canaryResult === 2`, respawn on
   TIMEOUT/MEMORY_EXCEEDED, unknown attack names `400`, `429` under concurrency, `/api/export-zip` headers and body, and no leaked Node processes.
3. `npx tsc --noEmit` and the full `npx vitest run` pass.
