# Tasks: Kiro Power Package
- [x] 1. `power-lazarus/plugin.json` and `power-lazarus/mcp.json` per the Agent Plugins 1.0.0 schemas.
- [x] 2. `power-lazarus/scripts/start-mcp.mjs`: checkout discovery and validation, child process with inherited stdio, signal forwarding.
- [x] 3. Skills: `resurrect-legacy-js` (+ `references/parity-invariants.md`) and `prove-the-proof`.
- [x] 4. `readKiroDna()`: `power` (zod-validated manifest, MCP servers, skills, references, install URL), allowlisted reads only.
- [x] 5. Drawer: Installable Kiro Power section with keywords, skills, MCP server, install URL and Copy button.
- [x] 6. Tests: `kiro-power.test.ts` (package, launcher end to end, reader, route, traversal); `kiro-dna.test.ts` and `studio-ui.test.ts` updates.
- [x] 7. Verify: browser check of the drawer, acorn parse, `tsc`, full `vitest run`, leak check, badges (`20 Kiro Specs`, final test count).
