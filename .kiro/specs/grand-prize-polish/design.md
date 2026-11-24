# Design: Grand Prize Polish

## ZIP (`src/exporter/zip.ts`)
- `ZipEntry { name: string; data: string | Uint8Array }`. `createZip(entries): Buffer`.
- Per entry: bytes = `Buffer.from(data)`; `crc = crc32(bytes)` (table-based, pure TS; verified against `zlib.crc32` in tests);
  `deflated = zlib.deflateRawSync(bytes, { level: 9 })`; use method 8 when `deflated.length < bytes.length`, else method 0.
- Local header: signature `0x04034b50`, version needed 20, flags `0x0800` (UTF-8 names), method, time `0`, date `0x21` (1980-01-01), crc, sizes, name.
- Central header: `0x02014b50`, version made by `0x031E` (UNIX), external attrs `0o100644 << 16`, offset of the local header.
- EOCD: `0x06054b50`, entry count, central size and offset, no comment.
- `readZip(buf)`: locate EOCD scanning backwards (max comment 65 535), walk the central directory, read each local header,
  inflate, verify CRC and sizes, return `{ name, data: Buffer }[]`. Throws `ZipError` on any inconsistency.
- `assertEntryName(name)` rejects unsafe or duplicate names.

## Bundle
- `renderWorkflow()` in `bundle.ts` returns the YAML. `files[".github/workflows/lazarus-parity.yml"]` is added for single and module bundles.
- `bundleToZipEntries(bundle)` = `Object.entries(files)` (stable order) plus `resurrection.patch` from `prDiff`.
- CLI: `fs.mkdirSync(dirname(target), { recursive: true })` before each write; it already iterates `bundle.files`.

## Server
- The export-bundle handler serves both routes. After the bundle is built: JSON for `/api/export-bundle`; for
  `/api/export-zip` write `application/zip`, `Content-Disposition`, `Content-Length` and the buffer. `Cache-Control: no-store`.
- `src/sandbox/redteam.ts` (sandbox area, so it follows `sandbox-security.md`): `ATTACKS` table (label, snippet, expectation),
  `RedTeamAttackSchema` (zod enum), `runRedTeam(pool, attack)`.
  1. warm the pool (`0`) and record `pidBefore` and `stats.spawns`;
  2. run the snippet, time it, classify (`SandboxError.code` or returned value);
  3. run the canary `1 + 1`, expecting `2`;
  4. `respawned = spawns increased || pid changed`; `recovered = canary === 2`.
  `contained`: for the three error attacks, the run was rejected with a sandbox error; for the escape attempt, it returned
  `NO_HOST_ACCESS` (the snippet probes `process`, `require`, `this.constructor.constructor('return process')()` and
  `console.log.constructor(...)`; any reachable host capability makes it return `ESCAPED`).
- Route: lazily created dedicated pool, single-flight flag (`429`), pool closed on server `close`.

## UI
- `.github/workflows/lazarus-parity.yml` tab button (hidden until a bundle exists, like the others via `renderActiveTab`).
- `lastBundleBody` keeps the exact payload used for the bundle so the zip button posts the same data.
- Export click: `bundlePanel.scrollIntoView({ behavior: "smooth", block: "start" })` after a successful build.
- Red-Team `<details>` card in the middle column, own script block, `textContent` only.
  Colors: #090d16, #111827, #10b981 contained, #ef4444 escaped, #8b5cf6 accents.

## Risks
- The heap bomb takes a few seconds and a 256 MB allocation inside the worker. The `429` guard keeps it single-flight.
- Deflate output may differ between zlib versions, so tests assert round trips and structure, not fixed bytes.
