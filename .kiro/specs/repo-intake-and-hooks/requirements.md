# Requirements: Repo Intake and Hooks
## Introduction
Turn Tab 2 (Multi-File Project, Stitch Graph) into a real intake for multi-file legacy code: a GitHub folder importer
and drag-and-drop / file-picker upload of `.js`/`.cjs` files. Add a shareable Tab 1 lab link, keep the finished
Guided Tour banner off Tabs 2 and 3, and expand the `.kiro/hooks/` automation suite, shown live in the Kiro DNA drawer
next to specs, agents and steering.
Constraints: no new workspace tabs, no new runtime npm dependencies, strict TypeScript, zod validation at every trust
boundary, imported and uploaded code is only parsed and handed to the sandbox (never executed on the host), and all
745 existing tests keep passing. Tab 3 (Red-Team) is not touched.
## Requirements
### R1. GitHub folder importer (`src/importer/github-dir.ts`)
1. Input is exactly `https://github.com/{owner}/{repo}/tree/{branch}/{path}` (path may be empty for the repo root),
   validated with zod: HTTPS only, host `github.com`, no credentials, no port, and every segment matches a strict
   character set (no `..`, no `.`-only segments, no encoded separators). `branch` is a single path segment; branch
   names that contain `/` are not supported and are rejected with a clear message. Query strings and fragments are
   ignored.
2. Network access is limited to `https://api.github.com` (the contents API listing) and
   `https://raw.githubusercontent.com` (file bodies). Every URL is built by the importer from validated segments, each
   is checked against the allowlist before it is fetched, and `download_url` values from GitHub are ignored. Redirects
   are handled manually (`redirect: "manual"`): a target is followed only after it passes the same allowlist check
   (HTTPS, one of the two hosts, no port, no credentials, no `..` or `%2e%2e` segments), at most 3 times. One 5 s
   deadline (`AbortController`) covers the whole import.
3. The listing is read one level deep (non-recursive). Only entries of type `file` whose names end in `.js` or `.cjs`
   and match a safe file-name pattern are kept. Directories and other files are counted and reported, never fetched.
4. Caps: at most 8 JavaScript files, at most 32 KB per file (checked against the listed size before fetching and again
   while reading the body), and at most 128 KB in total. Exceeding any cap is an error. Files are never silently
   dropped or truncated.
5. Success returns `{ files, entry, repo, branch, path, totalBytes }` (plus `skipped`, `sourceUrl` and the graph
   `edges` for the UI): `files` is a flat `name -> source` map ready for Tab 2, and `entry` is the entry module chosen by
   the same analyzer that `/api/resurrect-graph` uses (R1.8).
8. Entry rule (shared by the importer, `/api/resurrect-graph` and the page): a root file (required by no other file in
   the map) that itself `require('./...')`s files in the map; among several, `index`/`main` first, then the one that
   reaches the most files, then by name. When no root requires anything: `index.cjs`, then `index.js`, then the first
   root by name. External requires (`fs`, packages) are not edges.
6. Failures are structured `{ error, code, details? }` with honest codes and HTTP statuses:
   `INVALID_URL` 400, `NOT_FOUND` 404, `NOT_A_DIRECTORY` 422, `NO_JS_FILES` 422, `TOO_MANY_FILES` 413,
   `FILE_TOO_LARGE` 413, `TOO_LARGE` 413, `RATE_LIMITED` 429 (GitHub 429, or 403 with `x-ratelimit-remaining: 0` or a
   rate-limit message; includes the reset time when GitHub sends it), `FORBIDDEN` 403, `TIMEOUT` 504,
   `UPSTREAM_ERROR` 502, `REDIRECT_REJECTED` 502. No file content is ever fabricated.
7. `POST /api/import/github-dir` accepts exactly `{ url: string }` (strict zod body) and returns the result or the
   structured error. The server accepts an injected `fetch` so tests are fully offline.
### R2. Tab 2 upload intake (`public/index.html`)
1. Tab 2 gets a compact intake bar under its header: a dropzone that is also a file picker
   (`<input type="file" multiple accept=".js,.cjs">`), a GitHub folder URL input with an Import button, and a status
   line. The existing `legacy-invoice-engine` and `legacy-text-pipeline` presets stay.
2. Dropping or picking files applies the same caps as R1.4 on the client. Non-`.js`/`.cjs` files, unsafe names and
   duplicates are rejected with the reason shown; if a cap is exceeded nothing is loaded and the reason is shown.
3. Accepted files (from upload or the folder importer) replace the Tab 2 project at once: file tabs, editor and graph
   are rebuilt, a "Your files" entry appears in the project selector, and the entry module is auto-selected with the
   R1.8 rule. This is the same rule as the server analyzer, which re-analyzes the files with acorn on **Resurrect Project Graph**
   and has the final say (the page shows the server's entry once the graph event arrives).
4. Uploaded files are read with `File.text()` in the browser and are only sent to `/api/resurrect-graph`.
### R3. Copy Lab Link (Tab 1)
1. A compact **Copy Lab Link** button in the Tab 1 toolbar encodes the current specimen code and module name as
   base64url UTF-8 JSON in `#specimen=...`.
2. The hash is capped at 4096 characters. A specimen that does not fit is refused with a visible message; it is
   never truncated.
3. Opening a page whose hash carries a valid specimen loads it into Tab 1 (switching to Tab 1), sets the module name,
   records provenance `{ kind: "paste", label: "shared lab link" }` (no new certificate kind), and fires the editor's `input` event so smart-paste detection runs. It never starts a
   resurrection by itself. An invalid or oversized hash is ignored with a visible note.
4. **Guided Tour banner.** Once the tour has finished (or stopped), switching to Tab 2 or Tab 3 hides its banner, so it
   never covers the lower panels there. On Tab 1 it stays until **Close**. A running tour keeps its banner.
### R4. Kiro agent hooks
1. Add three hooks in `.kiro/hooks/` in the Kiro v1 hook format (`{ version: "v1", hooks: [...] }`, `trigger`,
   regex `matcher`, `action` of type `command` or `agent`):
   - `sandbox-security-guard.json`: on saves under `src/sandbox/`, an agent check that no host `fs`/`child_process`
     access or escape route and no process leak was introduced (and the sandbox tests still pass);
   - `strict-typecheck-on-crew.json`: on saves under `src/crew/` or `src/exporter/`, run `npx tsc --noEmit`;
   - `kiro-dna-sync-check.json`: on saves under `.kiro/specs/`, run the Kiro DNA sync test, which checks the
     `N Kiro Specs` badge in `public/index.html` against `.kiro/specs` and that the reader sees every spec and hook.
2. The existing `run-tests-on-save.json` is converted from the legacy `when`/`then` format to the v1 format (same command, `PostFileSave` on `src/**/*.ts`), so all four hooks load in current Kiro. The reader still accepts the legacy format.
3. `readKiroDna()` also reads `.kiro/hooks/*.json` with the same allowlist and file checks, validates both the v1 and
   the legacy format with zod, and returns `hooks` (file, name, description, trigger, matcher, action type, and the
   command or prompt, plus the format). Invalid files are listed in `skipped` with a reason.
4. The Kiro DNA drawer shows a Hooks section next to Specs, Agents and Steering, and the subtitle counts all four.
### R5. Badges and tests
1. Header badges read `19 Kiro Specs` and the exact final passing test count.
2. `src/importer/__tests__/github-dir.test.ts` uses an injected `fetch` only (offline, deterministic) and covers a
   valid import, URL/host/SSRF rejection, the file-count and byte caps, rate limits (403 and 429) and other upstream
   errors, plus the HTTP route.
3. `kiro-dna.test.ts` checks that all four hook files are returned and that the spec badge matches `.kiro/specs`.
   `studio-ui.test.ts` covers the intake helpers (caps, entry choice, link encode/decode) in `node:vm`, the Tab 2
   intake markup and the Copy Lab Link button. Every inline `<script>` parses with acorn.
4. `npx tsc --noEmit` exits 0, the full `npx vitest run` passes, and no Node processes leak.
