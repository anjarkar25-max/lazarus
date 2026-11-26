# Design: Kiro Power Package
## Package layout
```
power-lazarus/
  plugin.json                      Agent Plugins manifest (closed schema)
  mcp.json                         { $schema, mcpServers: { lazarus-sandbox: { type: "stdio", command: "node", args } } }
  scripts/start-mcp.mjs            launcher: finds a Lazarus checkout, runs src/mcp/server.ts with tsx
  skills/resurrect-legacy-js/SKILL.md
  skills/resurrect-legacy-js/references/parity-invariants.md
  skills/prove-the-proof/SKILL.md
```
- `mcp.json` args use `${PLUGIN_ROOT}/scripts/start-mcp.mjs`, the spec's portable plugin-root placeholder (expanded
  in `args`, also exported as the `PLUGIN_ROOT` environment variable). The launcher itself falls back to its own
  location, so it works however it is invoked.
- Launcher candidate order: `LAZARUS_HOME`, then `dirname(PLUGIN_ROOT)`. A candidate is accepted only when
  `package.json` parses with `name === "lazarus"`, `src/mcp/server.ts` exists and `node_modules/tsx/package.json`
  exists. It spawns `process.execPath --import tsx/esm src/mcp/server.ts` with `cwd` = the checkout and
  `stdio: "inherit"` (no shell, no npx), forwards SIGINT/SIGTERM, and exits with the child's code. The server already
  stops when stdin ends, so closing the MCP client ends both processes.
- Why a launcher instead of copying the workspace entry: Agent Plugins resolves `cwd` inside the plugin root and does
  not allow `cwd` outside it, and the installed package has no `src/`, so `npx tsx src/mcp/server.ts` could never
  start. Fetching the repository at activation time was rejected: it would download and run code without the user
  choosing it.
## Reader (`readKiroDna`)
- `power-lazarus/` is a fifth fixed directory. `safeFile(powerDir, "plugin.json" | "mcp.json")`; skill folders come
  from `listDirs(power/skills)`; each `SKILL.md` via `safeFile`; references via `listFiles(skill/references, ".md")`
  + `safeFile`. `scripts/` is never read.
- zod schemas mirror the official JSON schemas: `PluginManifestSchema` (strict, `$schema` literal, name pattern,
  strict `author`) plus Kiro's required fields; `PluginMcpSchema` (strict, discriminated `type` union, strict server
  objects). `SKILL.md` frontmatter uses the existing `frontMatter()` parser, then `SkillFrontmatterSchema` and a
  name-equals-folder check.
- `installUrl` = `repository` (must match `^https://github\.com/[\w.-]+/[\w.-]+$`) + `/tree/main/power-lazarus`.
  Namespaced server name follows Kiro's documented rule: `power-<plugin name>-<server name>`.
- `generatedFrom` becomes `.kiro/{specs,agents,steering,hooks} + power-lazarus/`.
## Drawer
- `<h3 id="dnaPowerTitle">` + `<div id="dnaPower">` placed after the Chimera diagram, before the agents. Cards: header
  (name, version, description), keyword chips, one card per skill (name, description, reference files), MCP server
  card, install URL `<code>` + `#dnaPowerCopy` (clipboard with a textarea fallback).
## Tests
- `kiro-power.test.ts` reads the package files directly (independent of the reader) and checks them against the
  official rules, then checks the reader, the route, and the launcher (spawned with an injected `LAZARUS_HOME`, via the
  MCP SDK's stdio client that the project already depends on).
