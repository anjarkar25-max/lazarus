# Design: Repo Intake and Hooks
## GitHub folder importer
- `parseGitHubFolderUrl(raw)`: zod string -> `URL`, then segment checks:
  owner `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`, repo `^[A-Za-z0-9._-]{1,100}$`, branch and path segments
  `^[A-Za-z0-9._-]{1,100}$`, none equal to `.` or `..`, path at most 8 segments. The raw pathname is checked for `%`
  so encoded separators or dots never reach the segment checks.
- URLs are built only from validated segments, each segment `encodeURIComponent`-encoded:
  - listing: `https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={branch}`;
  - file: `https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}/{name}`.
  `assertAllowedGitHubUrl(url)` re-checks protocol, host, port and credentials before every fetch, including every
  redirect hop. A redirect's raw `Location` is checked for `..`/`%2e%2e` segments before URL parsing (which would
  silently collapse them), resolved against the current URL, and followed at most 3 times.
- One `AbortController` plus a timer gives the whole import a single deadline (default 5000 ms, injectable for tests).
  A promise race turns the deadline into `TIMEOUT` even when an injected fetch ignores the signal.
- Listing: zod-validated array of `{ name, type, size }` entries (extra fields ignored, `download_url` never used). An
  object instead of an array means the URL names a file: `NOT_A_DIRECTORY`. Kept entries: `type === "file"`, name
  matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.c?js$`. Everything else goes to `skipped` with a reason.
- Caps are checked on listed sizes first (count > 8, any size > 32 KB, sum > 128 KB), then while reading each body
  (streamed, stops past the per-file cap) and again on the actual total.
- Rate limits: 429, or 403 with `x-ratelimit-remaining: 0` or a body message mentioning "rate limit", become
  `RATE_LIMITED` with `details.resetAt` (ISO time from `x-ratelimit-reset`) when present. Other 403s are `FORBIDDEN`.
- `entry` and `edges` come from `analyzeGraph(files)` (the resurrect-graph analyzer). Fetches run in parallel.
- Entry rule change in `analyzeGraph` (no hint given): `linked = roots with at least one resolved dependency`; pick
  index/main among `linked`, else the widest reach, else by name; with no linked root, `index.cjs`, `index.js`, the
  first root. Both built-in projects keep their entries (`invoice.cjs`, `slug.cjs`); the old rule could pick an
  isolated `index.js` over the file that actually stitches the project together.
- Errors are `GitHubDirError(code, message, details)`; `statusForGitHubDir(code)` maps them to HTTP statuses.
## Route
- `POST /api/import/github-dir`: `readJsonUnknown` -> strict zod `{ url }` -> `importGitHubFolder(url, { fetch })`.
  `WebServerOptions.githubFetch` is injected by tests.
## Page
- New inline script with pure helpers between `/* lz-intake:start */` and `/* lz-intake:end */`, loaded before the
  graph and link scripts and testable in `node:vm`:
  - `lzIntakeCheck(list)`: `list` is `[{ name, size }]`; returns `{ accepted, rejected, error }` using the R1.4 caps;
  - `lzRequireEdges(files)`, `lzPickEntry(files)`: the server's entry rule (roots, `index`/`main`, widest reach, name);
  - `lzEncodeSpecimen({ name, code })` / `lzDecodeSpecimen(hash)`: base64url UTF-8 JSON, 4096-character cap, strict
    shape check.
- Tab 2: an intake bar (`#graphIntake`) between the header and the body: `<label class="gi-drop">` around the hidden
  `<input type="file" multiple accept=".js,.cjs">`, `#graphRepoUrl` + `#graphRepoBtn`, and `#graphIntakeStatus`. The
  graph script gains `loadFiles(name, files)`, which adds or updates a `custom` option in `#graphPreset`. The entry
  pick is for display; the run lets the server's AST analyzer choose (same rule), so a `require` inside a comment can
  never mislead it.
- Tab 1: `#copyLinkBtn` after EXPORT PR BUNDLE. A link script (before `lz-stale`, which stays last) reads the hash on
  load and on `hashchange`, switches tabs through the existing tab button, and dispatches `input` on the editor.
- Tour banner: `switchTab()` dispatches `lazarus:tab` with the tab name; the tour code (declared later in the same
  script, so no listener is needed at the initial hash switch) hides `#tourHud` for `graph`/`redteam` when no tour
  is running.
- Drawer: `#dnaHooksTitle` + `#dnaHooks` list after steering; cards show trigger, matcher and action.
## Kiro DNA hooks
- `listFiles(hooksDir, ".json")` + `safeFile`, then a zod union of the v1 schema
  (`{ version: "v1", hooks: [{ name, description?, trigger, matcher?, action: { type: "command", command } |
  { type: "agent", prompt }, enabled? }] }`) and the legacy schema (`{ name, description?, when: { type, patterns? },
  then: { type: "runCommand", command } | { type: "askAgent", prompt } }`). Both are normalized to `HookSummary`.
  `generatedFrom` becomes `.kiro/{specs,agents,steering,hooks}`.
## Decisions
- Over-cap folders are rejected rather than truncated: a partial module graph would fail resolution in confusing
  ways, and the requirement asks for honest errors.
- Non-recursive listing: one request, predictable cost under GitHub's unauthenticated rate limit (60 per hour per IP).
- All four hooks use the documented Kiro v1 `.json` format so Kiro actually loads them; `run-tests-on-save.json` was
  converted on request.
