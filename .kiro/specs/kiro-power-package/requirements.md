# Requirements: Kiro Power Package
## Introduction
Package Lazarus as an installable Kiro Power in the open Agent Plugins 1.0.0 format (`plugin.json`, `mcp.json`,
`skills/*/SKILL.md`) under `power-lazarus/`, and show it live in the existing Kiro DNA drawer. No new workspace tabs,
no change to Tab 3 (Red-Team), no new runtime npm dependencies, and all 825 existing tests keep passing.
Sources: https://agent-plugins.org/schemas/1.0.0/plugin.schema.json, https://agent-plugins.org/schemas/1.0.0/mcp.schema.json,
https://agent-plugins.org/specification.md, https://kiro.dev/docs/powers/create.md, https://kiro.dev/docs/skills.md.
## Requirements
### R1. Manifest (`power-lazarus/plugin.json`)
1. Valid against the Agent Plugins 1.0.0 plugin schema, which is closed (no extra top-level fields):
   `$schema` = `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`, `name` = `lazarus-resurrection` (matches
   `^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`, at most 64 characters), `version` = `1.0.0`.
2. Also carries every field Kiro lists as required: `description` (ES5/CommonJS resurrection with exact `Object.is`
   fuzzing, AST mutation audits and `tsc --strict` verification), `author` `{ name: "Ashlesha Anjarkar", url:
   "https://github.com/anjarkar25-max/lazarus" }` (only `name`/`email`/`url` allowed), and `keywords` = `legacy`,
   `commonjs`, `es5`, `resurrect`, `differential-fuzz`, `mutation-audit`, `lazarus`, `modernize` (Kiro uses them for
   activation). Plus `homepage` = `https://lazarus-yf0a.onrender.com`, `repository` =
   `https://github.com/anjarkar25-max/lazarus` and `license` = `MIT` (matches the repository's LICENSE).
### R2. MCP server (`power-lazarus/mcp.json`)
1. Valid against the Agent Plugins 1.0.0 MCP schema: top level exactly `$schema`
   (`https://agent-plugins.org/schemas/1.0.0/mcp.schema.json`) and `mcpServers`; one server `lazarus-sandbox` with
   `"type": "stdio"`, a single-token `command`, `args`, and no fields outside the schema.
2. It wires the same server as `.kiro/settings/mcp.json` (`lazarus-sandbox`, `src/mcp/server.ts`, tool
   `run_legacy_probe`). The workspace-only fields `disabled` and `autoApprove` are not part of the plugin schema and
   are left out; Kiro manages enablement and approval for Power servers.
3. An installed Power contains only `power-lazarus/`, not the server source. The server is therefore started by a
   dependency-free launcher in the package (`scripts/start-mcp.mjs`, run with `node`) that:
   - uses a Lazarus checkout from `LAZARUS_HOME`, or the folder that contains `power-lazarus/` (a clone);
   - accepts a folder only if its `package.json` is named `lazarus` and it has `src/mcp/server.ts` and an installed
     `tsx`; it never downloads or runs anything else;
   - otherwise exits with code 1 and a one-line explanation on stderr (stdout stays clean for the MCP protocol);
   - runs the server as a child process with inherited stdio, forwards SIGINT/SIGTERM and exits with the child, so
     no process is left behind.
### R3. Skills (`power-lazarus/skills/*/SKILL.md`)
1. Each skill has YAML frontmatter with `name` (matches its folder, lower-case letters, digits and hyphens, at most 64
   characters) and `description` (at most 1024 characters, says when to use it).
2. `resurrect-legacy-js`: the workflow for scanning a single ES5/CommonJS file or a multi-file `require()` graph,
   exact `Object.is` differential fuzzing with speculative AST-rule rollback, the `tsc --strict: 0 errors` gate, and
   PR bundle export, using the real CLI, HTTP routes and MCP tool. It links
   `references/parity-invariants.md`, which documents the `-0`, `NaN`, 32-bit `| 0` overflow and prototype-to-class
   invariants as the code implements them.
3. `prove-the-proof`: running the AST mutation audit (`POST /api/mutation-audit`) and reading its kill rate honestly,
   then issuing the SHA-256 Resurrection Certificate (`POST /api/export-bundle`), stating exactly what the digest covers.
4. Every relative file a SKILL.md links to exists in its skill folder.
### R4. Kiro DNA (`src/web/kiro-dna.ts`, drawer)
1. `readKiroDna(repoRoot)` also reads `power-lazarus/plugin.json`, `power-lazarus/mcp.json` and
   `power-lazarus/skills/*/SKILL.md` (and lists `skills/*/references/*.md`) with the same checks as `.kiro/`: fixed
   directories, enumerated names, safe-name pattern, no symlinks, real path inside the directory, size cap. Nothing
   else under `power-lazarus/` (the launcher included) and nothing outside `.kiro/` and `power-lazarus/` is read.
2. It returns `power`: `name`, `version`, `description`, `keywords`, `author`, `homepage`, `repository`, `license`,
   `skills` (`folder`, `name`, `description`, `references`), `mcpServers` (`name`, `type`, `command`, `args`, and the
   Kiro namespaced name `power-<plugin>-<server>`), and `installUrl`
   (`https://github.com/anjarkar25-max/lazarus/tree/main/power-lazarus`, built from a validated HTTPS GitHub
   `repository`). `power` is `null` when the manifest is missing or invalid; invalid files go to `skipped` with a reason.
3. The drawer shows a compact **Installable Kiro Power (lazarus-resurrection)** section: version and description,
   activation keywords, bundled skills, the MCP server name, and the install URL with a Copy button. `textContent` only.
### R5. Badges and tests
1. Header badges read `20 Kiro Specs` and the exact final passing test count.
2. `src/web/__tests__/kiro-power.test.ts`: manifest and MCP config against the Agent Plugins rules, skill frontmatter
   and references, the launcher (refuses a non-Lazarus folder; serves `run_legacy_probe` end to end over stdio from
   this checkout and exits cleanly), and `readKiroDna()` / `GET /api/kiro-dna` returning `power` with all 20 specs,
   4 agents, 4 hooks and the steering rules, while traversal is still blocked.
3. Every inline `<script>` parses with acorn, `npx tsc --noEmit` exits 0, the full `npx vitest run` passes, and no
   Node processes leak.
