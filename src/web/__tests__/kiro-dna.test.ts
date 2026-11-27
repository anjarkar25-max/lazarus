import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_KIRO_FILE_BYTES, countRequirements, countTasks, parseHookFile, readKiroDna, resolveKiroDocument } from "../kiro-dna.js";
import { createWebServer } from "../server.js";

const repoRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../../..");
const specDirs = fs.readdirSync(nodePath.join(repoRoot, ".kiro", "specs"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

describe("readKiroDna (live repository)", () => {
  const dna = readKiroDna(repoRoot);

  it("returns every spec, including this one, with honest counts", () => {
    expect(dna.specCount).toBe(specDirs.length);
    expect(dna.specs.map((s) => s.name)).toEqual(specDirs);
    expect(dna.specs.map((s) => s.name)).toContain("kiro-dna-and-smart-paste");
    for (const s of dna.specs) {
      expect(s.documents).toEqual({ requirements: true, design: true, tasks: true });
      expect(s.requirementCount).toBeGreaterThan(0);
      expect(s.taskCount).toBeGreaterThan(0);
      expect(s.tasksDone).toBeLessThanOrEqual(s.taskCount);
      expect(s.title.length).toBeGreaterThan(0);
    }
    expect(dna.skipped).toEqual([]);
  });

  it("counts requirements in every format the specs use, and says which", () => {
    const by = (name: string) => dna.specs.find((s) => s.name === name);
    expect(by("sandbox")).toMatchObject({ requirementStyle: "REQ-ids" });
    expect(by("strict-ts-verification")).toMatchObject({ requirementStyle: "R-headings", requirementCount: 6 });
    expect(by("bundle-exporter")).toMatchObject({ requirementStyle: "user-stories", requirementCount: 3 });
    expect(by("mcp-server")).toMatchObject({ requirementStyle: "bullets" });
    // Titles survive the UTF-8 byte-order marks some of these files start with.
    expect(by("bundle-exporter")?.title).toBe("GitHub Legacy Importer & Resurrection Bundle Exporter");
  });

  it("returns the four Kiro Crew agents with model, tools and responsibility", () => {
    expect(dna.agents.map((a) => a.name).sort()).toEqual(["archaeologist", "architect", "exorcist", "necromancer"]);
    const archaeologist = dna.agents.find((a) => a.name === "archaeologist");
    expect(archaeologist).toMatchObject({ file: "archaeologist.json", model: "auto" });
    expect(archaeologist?.tools).toContain("run_legacy_probe");
    for (const a of dna.agents) expect(a.description.length).toBeGreaterThan(20);
  });

  it("returns the steering rules with their inclusion modes", () => {
    const steering = Object.fromEntries(dna.steering.map((s) => [s.file, s]));
    expect(steering["architecture.md"]).toMatchObject({ title: "Lazarus Core Architecture & Standards", inclusion: "always" });
    expect(steering["sandbox-security.md"]).toMatchObject({ inclusion: "fileMatch", fileMatchPattern: "src/sandbox/**" });
    expect(steering["ui-aesthetics.md"]).toMatchObject({ inclusion: "fileMatch" });
  });

  it("returns all four agent hooks, all in the current Kiro v1 format", () => {
    const hookFiles = fs.readdirSync(nodePath.join(repoRoot, ".kiro", "hooks")).filter((f) => f.endsWith(".json")).sort();
    expect(hookFiles).toEqual(["kiro-dna-sync-check.json", "run-tests-on-save.json", "sandbox-security-guard.json", "strict-typecheck-on-crew.json"]);
    expect(dna.hookFiles).toBe(4);
    expect([...new Set(dna.hooks.map((h) => h.file))].sort()).toEqual(hookFiles);
    const by = Object.fromEntries(dna.hooks.map((h) => [h.file, h]));
    expect(by["run-tests-on-save.json"]).toMatchObject({ format: "v1", trigger: "PostFileSave", matcher: "src[\\\\/].*\\.ts$", action: "command", run: "npx vitest run", enabled: true });
    expect(dna.hooks.every((h) => h.format === "v1" && h.trigger === "PostFileSave")).toBe(true);
    expect(dna.skipped.filter((x) => x.path.startsWith("hooks/"))).toEqual([]);
    expect(by["sandbox-security-guard.json"]).toMatchObject({ format: "v1", trigger: "PostFileSave", action: "agent", enabled: true });
    expect(by["sandbox-security-guard.json"]?.run).toContain("child_process");
    expect(by["strict-typecheck-on-crew.json"]).toMatchObject({ format: "v1", trigger: "PostFileSave", action: "command", run: "npx tsc --noEmit" });
    expect(by["kiro-dna-sync-check.json"]).toMatchObject({ format: "v1", action: "command", run: "npx vitest run src/web/__tests__/kiro-dna.test.ts" });
    expect(dna.generatedFrom).toBe(".kiro/{specs,agents,steering,hooks} + power-lazarus/");
  });
  it("hook matchers select exactly the paths they are meant for (both path separators)", () => {
    const matcher = (file: string): RegExp => new RegExp(dna.hooks.find((h) => h.file === file)?.matcher ?? "^$");
    const sandbox = matcher("sandbox-security-guard.json");
    const crew = matcher("strict-typecheck-on-crew.json");
    const specs = matcher("kiro-dna-sync-check.json");
    const tests = matcher("run-tests-on-save.json");
    expect(["src/crew/orchestrator.ts", "src\\web\\__tests__\\kiro-dna.test.ts"].every((f) => tests.test(f))).toBe(true);
    expect(tests.test("public/index.html")).toBe(false);
    expect(tests.test("scripts/build.mjs")).toBe(false);
    expect(["src/sandbox/pool.ts", "src\\sandbox\\worker.ts"].every((f) => sandbox.test(f))).toBe(true);
    expect(sandbox.test("src/crew/orchestrator.ts")).toBe(false);
    expect(["src/crew/orchestrator.ts", "src\\exporter\\bundle.ts"].every((f) => crew.test(f))).toBe(true);
    expect(crew.test("src/web/server.ts")).toBe(false);
    expect(["/repo/.kiro/specs/sandbox/tasks.md", ".kiro\\specs\\x\\design.md"].every((f) => specs.test(f))).toBe(true);
    expect(specs.test(".kiro/steering/architecture.md")).toBe(false);
  });
  it("counts 21 specs, including the V12 autopsy-and-audit spec with all three documents", () => {
    expect(dna.specCount).toBe(21);
    const v12 = dna.specs.find((s) => s.name === "v12-grandmaster-autopsy-and-audit");
    expect(v12).toMatchObject({ title: "V12 Grandmaster Autopsy and Audit", documents: { requirements: true, design: true, tasks: true }, requirementStyle: "R-headings", requirementCount: 4 });
    expect(v12?.taskCount).toBe(8);
    const html = fs.readFileSync(nodePath.join(repoRoot, "public", "index.html"), "utf8");
    expect(html).toContain('<span class="proof-badge" id="badgeSpecs">21 Kiro Specs</span>');
  });
  it("keeps the static header badge in sync with .kiro/specs (what kiro-dna-sync-check runs)", () => {
    const html = fs.readFileSync(nodePath.join(repoRoot, "public", "index.html"), "utf8");
    expect(html).toContain(`<span class="proof-badge" id="badgeSpecs">${specDirs.length} Kiro Specs</span>`);
    expect(html).toMatch(/<span class="proof-badge" id="badgeTests">\d+ Verified Tests<\/span>/);
  });
  it("reads one document only for an enumerated spec and a known document name", () => {
    expect(resolveKiroDocument(repoRoot, "kiro-dna-and-smart-paste", "requirements")).toContain("# Requirements: Kiro DNA and Smart Paste");
    for (const [spec, doc] of [
      ["..", "requirements"],
      ["../steering", "requirements"],
      ["sandbox/../../package.json", "requirements"],
      ["/etc/passwd", "requirements"],
      ["C:\\Windows\\win.ini", "requirements"],
      ["%2e%2e", "requirements"],
      ["sandbox", "../../package"],
      ["sandbox", "requirements.md"],
      ["sandbox", "secrets"],
      ["does-not-exist", "requirements"],
      [5, "requirements"],
      ["sandbox", null],
    ] as const) {
      expect(resolveKiroDocument(repoRoot, spec, doc), `${String(spec)} / ${String(doc)}`).toBeUndefined();
    }
  });
});

describe("readKiroDna (hostile fixture)", () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-dna-"));
  const kiro = nodePath.join(root, ".kiro");
  beforeAll(() => {
    fs.mkdirSync(nodePath.join(kiro, "specs", "good"), { recursive: true });
    fs.mkdirSync(nodePath.join(kiro, "specs", "huge"), { recursive: true });
    fs.mkdirSync(nodePath.join(kiro, "agents"), { recursive: true });
    fs.mkdirSync(nodePath.join(kiro, "steering"), { recursive: true });
    fs.writeFileSync(nodePath.join(root, "secret.txt"), "TOP SECRET");
    fs.writeFileSync(nodePath.join(kiro, "specs", "good", "requirements.md"), "\uFEFF# Requirements: Good\r\n- **REQ-GD-01 a.**\r\n- **REQ-GD-02 b.** see REQ-GD-01\r\n");
    fs.writeFileSync(nodePath.join(kiro, "specs", "good", "tasks.md"), "- [x] 1. a\n- [ ] 2. b\n  - [X] 2.1 c\n");
    fs.writeFileSync(nodePath.join(kiro, "specs", "huge", "requirements.md"), "x".repeat(MAX_KIRO_FILE_BYTES + 1));
    fs.writeFileSync(nodePath.join(kiro, "agents", "broken.json"), "{ nope");
    fs.writeFileSync(nodePath.join(kiro, "agents", "wrong.json"), JSON.stringify({ name: "x" }));
    fs.writeFileSync(nodePath.join(kiro, "agents", "ok.json"), JSON.stringify({ name: "ok", description: "does a careful job" }));
    fs.writeFileSync(nodePath.join(kiro, "agents", "notes.txt"), "ignored");
    fs.mkdirSync(nodePath.join(kiro, "hooks"), { recursive: true });
    fs.writeFileSync(nodePath.join(kiro, "hooks", "v1.json"), JSON.stringify({ version: "v1", hooks: [{ name: "a", trigger: "PostFileSave", matcher: "x", action: { type: "command", command: "echo a" } }, { name: "b", trigger: "Stop", enabled: false, action: { type: "agent", prompt: "check" } }] }));
    fs.writeFileSync(nodePath.join(kiro, "hooks", "bad-action.json"), JSON.stringify({ version: "v1", hooks: [{ name: "x", trigger: "Stop", action: { type: "shell", command: "rm -rf /" } }] }));
    fs.writeFileSync(nodePath.join(kiro, "hooks", "garbage.json"), "[1, 2");
    // Anything outside the three directories is never read.
    fs.writeFileSync(nodePath.join(kiro, "settings.json"), "{}");
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("counts honestly, skips oversized and invalid files with a reason, and fills agent defaults", () => {
    const dna = readKiroDna(root);
    expect(dna.specs.map((s) => s.name)).toEqual(["good", "huge"]);
    expect(dna.specs[0]).toMatchObject({ title: "Good", requirementCount: 2, requirementStyle: "REQ-ids", taskCount: 3, tasksDone: 2, documents: { requirements: true, design: false, tasks: true } });
    expect(dna.specs[1]).toMatchObject({ requirementCount: 0, requirementStyle: "none", documents: { requirements: false } });
    expect(dna.agents).toEqual([{ file: "ok.json", name: "ok", description: "does a careful job", model: "auto", tools: [] }]);
    expect(dna.skipped.map((s) => s.path).sort()).toEqual(["agents/broken.json", "agents/wrong.json", "hooks/bad-action.json", "hooks/garbage.json", "specs/huge/requirements.md"]);
    expect(dna.hookFiles).toBe(1);
    expect(dna.hooks).toEqual([
      { file: "v1.json", name: "a", description: "", trigger: "PostFileSave", matcher: "x", action: "command", run: "echo a", enabled: true, format: "v1" },
      { file: "v1.json", name: "b", description: "", trigger: "Stop", action: "agent", run: "check", enabled: false, format: "v1" },
    ]);
    expect(JSON.stringify(dna)).not.toContain("TOP SECRET");
  });

  it("refuses symbolic links that point outside .kiro (when the OS allows creating one)", () => {
    const link = nodePath.join(kiro, "specs", "good", "design.md");
    let created = false;
    try {
      fs.symlinkSync(nodePath.join(root, "secret.txt"), link);
      created = true;
    } catch {
      /* Windows without symlink privileges: nothing to test */
    }
    if (!created) return;
    const dna = readKiroDna(root);
    expect(dna.specs[0]?.documents.design).toBe(false);
    expect(dna.skipped.some((s) => s.reason.includes("symbolic link"))).toBe(true);
    expect(resolveKiroDocument(root, "good", "design")).toBeUndefined();
  });

  it("returns an empty, valid result when .kiro is missing", () => {
    const empty = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-dna-empty-"));
    try {
      expect(readKiroDna(empty)).toMatchObject({ specCount: 0, specs: [], agents: [], steering: [], hooks: [], hookFiles: 0, power: null });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("parseHookFile", () => {
  it("normalizes the legacy when/then format", () => {
    expect(parseHookFile("l.json", { name: "L", when: { type: "fileEdited", patterns: ["a/**", "b/**"] }, then: { type: "askAgent", prompt: "p" } })).toEqual([
      { file: "l.json", name: "L", description: "", trigger: "fileEdited", matcher: "a/**, b/**", action: "agent", run: "p", enabled: true, format: "legacy" },
    ]);
  });
  it.each([[null], [[]], [{ version: "v2", hooks: [] }], [{ version: "v1", hooks: [] }], [{ name: "x", when: { type: "fileEdited" }, then: { type: "deploy" } }]])("rejects %j", (json) => {
    expect(Array.isArray(parseHookFile("x.json", json))).toBe(false);
  });
});
describe("counters", () => {
  it.each([
    ["### R1. a\n### R2. b\n### R2b. c\n", 3, "R-headings"],
    ["**User Story 1: a**\n**User Story 2: b**\n", 2, "user-stories"],
    ["- a\n- b\n  - nested\n- c\n", 3, "bullets"],
    ["### REQ-SB-01\n- **REQ-SB-02** x\nREQ-SB-01 again", 2, "REQ-ids"],
    ["just prose", 0, "none"],
  ])("countRequirements(%j)", (text, count, style) => {
    expect(countRequirements(text)).toEqual({ count, style });
  });

  it("counts tasks and completed tasks, nested included", () => {
    expect(countTasks("- [x] a\n- [ ] b\n    - [X] c\n- not a task\n")).toEqual({ total: 3, done: 2 });
  });
});

describe("GET /api/kiro-dna", () => {
  const server = createWebServer();
  let baseUrl = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("returns the live metadata: all specs and all four agents", async () => {
    const res = await fetch(`${baseUrl}/api/kiro-dna`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { specCount: number; specs: Array<{ name: string }>; agents: Array<{ name: string }>; steering: unknown[]; hookFiles: number; hooks: Array<{ file: string }> };
    expect(body.specCount).toBe(specDirs.length);
    expect(body.specs.map((s) => s.name)).toContain("kiro-dna-and-smart-paste");
    expect(body.agents.map((a) => a.name).sort()).toEqual(["archaeologist", "architect", "exorcist", "necromancer"]);
    expect(body.steering).toHaveLength(3);
    expect(body.hookFiles).toBe(4);
    expect(new Set(body.hooks.map((h) => h.file)).size).toBe(4);
  });

  it("serves one spec document", async () => {
    const res = await fetch(`${baseUrl}/api/kiro-dna?spec=kiro-dna-and-smart-paste&doc=tasks`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spec: string; doc: string; text: string };
    expect(body).toMatchObject({ spec: "kiro-dna-and-smart-paste", doc: "tasks" });
    expect(body.text).toContain("# Tasks: Kiro DNA and Smart Paste");
  });

  it.each([
    ["spec=..%2F..%2Fpackage.json", 400],
    ["spec=..", 400],
    ["spec=sandbox%2F..%2F..%2Fsrc", 400],
    ["spec=%2Fetc%2Fpasswd", 400],
    ["spec=sandbox&doc=..%2F..%2Fpackage", 400],
    ["spec=sandbox&doc=secrets", 400],
    ["spec=" + "a".repeat(200), 400],
    ["spec=no-such-spec", 404],
  ])("blocks ?%s with %i, revealing nothing outside .kiro", async (query, status) => {
    const res = await fetch(`${baseUrl}/api/kiro-dna?${query}`);
    expect(res.status).toBe(status);
    const text = await res.text();
    expect(text).not.toContain('"name": "lazarus"');
    expect(text).not.toContain("dependencies");
  });

  it("does not serve .kiro files through any other path", async () => {
    for (const p of ["/.kiro/agents/archaeologist.json", "/api/kiro-dna/../../package.json", "/api/kiro-dna/agents/archaeologist.json"]) {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status, p).toBe(404);
    }
  });
});
