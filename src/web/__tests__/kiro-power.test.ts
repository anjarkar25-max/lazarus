import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MCP_SCHEMA_URL, PLUGIN_NAME, PLUGIN_SCHEMA_URL, PluginManifestSchema, PluginMcpSchema, SKILL_NAME, readKiroDna } from "../kiro-dna.js";
import { createWebServer } from "../server.js";

const repoRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../../..");
const powerDir = nodePath.join(repoRoot, "power-lazarus");
const launcher = nodePath.join(powerDir, "scripts", "start-mcp.mjs");
const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(nodePath.join(powerDir, file), "utf8")) as Record<string, unknown>;
const specDirs = fs.readdirSync(nodePath.join(repoRoot, ".kiro", "specs"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const skillDirs = fs.readdirSync(nodePath.join(powerDir, "skills"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
/** Plain string environment (process.env values may be undefined), minus the given keys. */
const envWithout = (...keys: string[]): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !keys.includes(e[0])));

describe("power-lazarus/plugin.json (Agent Plugins 1.0.0 manifest)", () => {
  const manifest = readJson("plugin.json");

  it("has only the fields the closed Agent Plugins schema allows", () => {
    const allowed = ["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"];
    expect(Object.keys(manifest).filter((k) => !allowed.includes(k))).toEqual([]);
    expect(Object.keys(manifest.author as object).filter((k) => !["name", "email", "url"].includes(k))).toEqual([]);
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("carries every required field with a valid value", () => {
    expect(manifest.$schema).toBe(PLUGIN_SCHEMA_URL);
    expect(manifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(manifest.name).toBe("lazarus-resurrection");
    expect(String(manifest.name)).toMatch(PLUGIN_NAME);
    expect(String(manifest.name)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(manifest.version).toBe("1.0.0");
    expect(String(manifest.version)).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
    for (const phrase of ["ES5", "CommonJS", "Object.is", "mutation audit", "tsc --strict"]) expect(String(manifest.description)).toContain(phrase);
    expect(manifest.author).toEqual({ name: "Ashlesha Anjarkar", url: "https://github.com/anjarkar25-max/lazarus" });
    expect(manifest.homepage).toBe("https://lazarus-yf0a.onrender.com");
    expect(manifest.repository).toBe("https://github.com/anjarkar25-max/lazarus");
    expect(new URL(String(manifest.repository)).protocol).toBe("https:");
    expect(manifest.license).toBe("MIT");
    expect(fs.readFileSync(nodePath.join(repoRoot, "LICENSE"), "utf8")).toContain("MIT");
    expect(manifest.keywords).toEqual(["legacy", "commonjs", "es5", "resurrect", "differential-fuzz", "mutation-audit", "lazarus", "modernize"]);
  });

  it("rejects manifests that break the schema", () => {
    const good = PluginManifestSchema.parse(manifest);
    for (const bad of [
      { ...good, $schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json" },
      { ...good, name: "Lazarus Resurrection" },
      { ...good, name: "lazarus--resurrection" },
      { ...good, name: "-lazarus" },
      { ...good, keywords: [] },
      { ...good, author: { name: "x", twitter: "@x" } },
      { ...good, displayName: "Lazarus" },
    ]) {
      expect(PluginManifestSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });
});

describe("power-lazarus/mcp.json (Agent Plugins 1.0.0 MCP config)", () => {
  const mcp = readJson("mcp.json");
  const workspace = JSON.parse(fs.readFileSync(nodePath.join(repoRoot, ".kiro", "settings", "mcp.json"), "utf8")) as { mcpServers: Record<string, { args: string[] }> };

  it("declares the lazarus-sandbox stdio server with only schema fields", () => {
    expect(Object.keys(mcp).sort()).toEqual(["$schema", "mcpServers"]);
    expect(mcp.$schema).toBe(MCP_SCHEMA_URL);
    const servers = mcp.mcpServers as Record<string, Record<string, unknown>>;
    expect(Object.keys(servers)).toEqual(["lazarus-sandbox"]);
    const server = servers["lazarus-sandbox"] ?? {};
    expect(server).toEqual({ type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/scripts/start-mcp.mjs"] });
    // A single executable token, no shell syntax.
    expect(String(server.command)).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(PluginMcpSchema.safeParse(mcp).success).toBe(true);
  });

  it("wires the same server as the workspace config", () => {
    expect(Object.keys(workspace.mcpServers)).toEqual(["lazarus-sandbox"]);
    expect(workspace.mcpServers["lazarus-sandbox"]?.args).toContain("src/mcp/server.ts");
    expect(fs.readFileSync(launcher, "utf8")).toContain('path.join("src", "mcp", "server.ts")');
  });

  it("rejects configs that break the schema", () => {
    const base = { $schema: MCP_SCHEMA_URL, mcpServers: { s: { type: "stdio", command: "node" } } };
    expect(PluginMcpSchema.safeParse(base).success).toBe(true);
    for (const bad of [
      { mcpServers: base.mcpServers },
      { ...base, extra: 1 },
      { ...base, mcpServers: { s: { command: "node" } } },
      { ...base, mcpServers: { s: { type: "stdio", command: "node", disabled: false } } },
      { ...base, mcpServers: { s: { type: "stdio", command: "node", autoApprove: ["x"] } } },
      { ...base, mcpServers: { s: { type: "stdio", command: "node", cwd: "/etc" } } },
      { ...base, mcpServers: { s: { type: "stdio", command: "node", env: { PLUGIN_ROOT: "/x" } } } },
      { ...base, mcpServers: { s: { type: "sse" } } },
    ]) {
      expect(PluginMcpSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("power-lazarus/skills", () => {
  /** Frontmatter lines `key: value`; rejects anything a plain-scalar YAML parser would read differently. */
  function frontmatter(text: string): Record<string, string> {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    expect(m, "frontmatter block").not.toBeNull();
    const out: Record<string, string> = {};
    for (const line of (m?.[1] ?? "").split(/\r?\n/)) {
      const kv = /^([a-z][a-z0-9_-]*): (.+)$/.exec(line);
      expect(kv, `frontmatter line ${JSON.stringify(line)}`).not.toBeNull();
      const value = kv?.[2] ?? "";
      expect(value, "plain YAML scalar").not.toMatch(/^[-?:,[\]{}#&*!|>'"%@`]|: | #/);
      out[kv?.[1] ?? ""] = value;
    }
    return out;
  }

  it("ships exactly the two skills", () => {
    expect(skillDirs).toEqual(["prove-the-proof", "resurrect-legacy-js"]);
  });

  it.each(skillDirs)("%s has valid frontmatter whose name matches its folder", (dir) => {
    const fm = frontmatter(fs.readFileSync(nodePath.join(powerDir, "skills", dir, "SKILL.md"), "utf8"));
    expect(Object.keys(fm).sort()).toEqual(["description", "name"]);
    expect(fm.name).toBe(dir);
    expect(fm.name).toMatch(SKILL_NAME);
    expect((fm.description ?? "").length).toBeGreaterThan(40);
    expect((fm.description ?? "").length).toBeLessThanOrEqual(1024);
    expect(fm.description).toMatch(/Use (after|when)/);
  });

  it.each(skillDirs)("every relative file %s links to exists inside the skill folder", (dir) => {
    const skillDir = nodePath.join(powerDir, "skills", dir);
    const text = fs.readFileSync(nodePath.join(skillDir, "SKILL.md"), "utf8");
    const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? "").filter((l) => !/^(https?:|#|mailto:)/.test(l));
    for (const link of links) {
      const target = nodePath.resolve(skillDir, link);
      expect(target.startsWith(skillDir + nodePath.sep), link).toBe(true);
      expect(fs.existsSync(target), link).toBe(true);
    }
    if (dir === "resurrect-legacy-js") expect(links).toContain("references/parity-invariants.md");
  });

  it("documents the -0, NaN, int32 overflow and prototype-to-class invariants", () => {
    const ref = fs.readFileSync(nodePath.join(powerDir, "skills", "resurrect-legacy-js", "references", "parity-invariants.md"), "utf8");
    for (const heading of ["## `-0`", "## `NaN`", "## 32-bit `| 0` overflow", "## Prototype to class"]) expect(ref).toContain(heading);
    // The facts the document states hold in this JavaScript engine.
    expect(Object.is((-0.5) | 0, 0)).toBe(true);
    expect(Object.is(Math.trunc(-0.5), -0)).toBe(true);
    expect(Object.is(Math.trunc(-0.5) || 0, 0)).toBe(true);
    expect(Number.NaN | 0).toBe(0);
    expect(Math.trunc(Number.NaN) || 0).toBe(0);
    expect(2 ** 31 | 0).toBe(-2147483648);
    expect(Infinity | 0).toBe(0);
    expect(Math.trunc(Infinity) || 0).toBe(Infinity);
    class C {
      m(): number {
        return 1;
      }
    }
    expect(Object.keys(C.prototype)).toEqual([]);
    expect(() => (C as unknown as () => void)()).toThrow(TypeError);
  });

  it("prove-the-proof names the real audit operators and the certificate digest rule", () => {
    const text = fs.readFileSync(nodePath.join(powerDir, "skills", "prove-the-proof", "SKILL.md"), "utf8");
    const audit = fs.readFileSync(nodePath.join(repoRoot, "src", "crew", "mutation-audit.ts"), "utf8");
    for (const op of ["truncation-sabotage", "boundary-flip", "arithmetic-flip", "guard-sabotage", "equality-flip"]) {
      expect(text).toContain(op);
      expect(audit).toContain(`"${op}"`);
    }
    expect(audit).toContain("export const MAX_MUTANTS = 5;");
    expect(text).toContain("up to 5 mutants");
    const cert = fs.readFileSync(nodePath.join(repoRoot, "src", "exporter", "certificate.ts"), "utf8");
    expect(cert).toContain("const sha256 = sha256Hex(input.legacySource);");
    expect(cert).toContain("const id = `LZ-${shortDigest.toUpperCase()}`;");
    expect(text).toContain("first 12 hex characters of the SHA-256 digest");
  });
});

describe("power-lazarus/scripts/start-mcp.mjs (MCP launcher)", () => {
  const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-power-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("refuses to run anything when no Lazarus checkout is found, and keeps stdout clean", () => {
    // An installed Power on its own: just the package, no repository around it.
    const installed = nodePath.join(tmp, "installed", "power-lazarus", "scripts");
    fs.mkdirSync(installed, { recursive: true });
    fs.copyFileSync(launcher, nodePath.join(installed, "start-mcp.mjs"));
    // A folder that looks like a checkout but is not the lazarus package.
    const impostor = nodePath.join(tmp, "impostor");
    fs.mkdirSync(nodePath.join(impostor, "src", "mcp"), { recursive: true });
    fs.writeFileSync(nodePath.join(impostor, "package.json"), JSON.stringify({ name: "evil" }));
    fs.writeFileSync(nodePath.join(impostor, "src", "mcp", "server.ts"), "process.stdout.write('pwned')");
    for (const env of [envWithout("LAZARUS_HOME", "PLUGIN_ROOT"), { ...envWithout("PLUGIN_ROOT"), LAZARUS_HOME: impostor }]) {
      const r = spawnSync(process.execPath, [nodePath.join(installed, "start-mcp.mjs")], { env, encoding: "utf8", timeout: 20_000 });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("lazarus-sandbox: no Lazarus checkout found");
      expect(r.stderr).toContain("set LAZARUS_HOME");
    }
    const r = spawnSync(process.execPath, [nodePath.join(installed, "start-mcp.mjs")], { env: { ...envWithout("PLUGIN_ROOT"), LAZARUS_HOME: impostor }, encoding: "utf8", timeout: 20_000 });
    expect(r.stderr).toContain("package.json is not the lazarus package");
  });

  async function probeThroughLauncher(env: Record<string, string>): Promise<void> {
    const mcp = readJson("mcp.json") as { mcpServers: Record<string, { command: string; args: string[] }> };
    const server = mcp.mcpServers["lazarus-sandbox"];
    expect(server?.command).toBe("node");
    // What an Agent Plugins client does: expand ${PLUGIN_ROOT} in args and run the command token.
    const args = (server?.args ?? []).map((a) => a.split("${PLUGIN_ROOT}").join(powerDir));
    const transport = new StdioClientTransport({ command: process.execPath, args, env: { ...env, PLUGIN_ROOT: powerDir }, stderr: "pipe" });
    const client = new Client({ name: "kiro-power-test", version: "1.0.0" });
    await client.connect(transport);
    const launcherPid = transport.pid;
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toEqual(["run_legacy_probe"]);
      const result = await client.callTool({ name: "run_legacy_probe", arguments: { code: "(function (n) { return (n / 2) | 0; })(-1)" } });
      const content = result.content as Array<{ type: string; text: string }>;
      const report = JSON.parse(content[0]?.text ?? "{}") as { returnValue: unknown };
      expect(report.returnValue).toBe(0);
    } finally {
      await client.close();
    }
    // The launcher exits with the server once the client closes stdio.
    expect(launcherPid).not.toBeNull();
    const deadline = Date.now() + 15_000;
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    while (launcherPid !== null && alive(launcherPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(launcherPid !== null && alive(launcherPid)).toBe(false);
  }

  it("serves run_legacy_probe end to end from LAZARUS_HOME, as the mcp.json entry runs it", async () => {
    await probeThroughLauncher({ ...envWithout("PLUGIN_ROOT"), LAZARUS_HOME: repoRoot });
  });

  it("finds the checkout that contains power-lazarus/ when LAZARUS_HOME is not set (a cloned repository)", async () => {
    await probeThroughLauncher(envWithout("LAZARUS_HOME", "PLUGIN_ROOT"));
  });
});

describe("readKiroDna: the installable Kiro Power", () => {
  const dna = readKiroDna(repoRoot);

  it("returns the live power metadata next to all specs, agents, hooks and steering rules", () => {
    expect(dna.specCount).toBe(21);
    expect(specDirs).toHaveLength(21);
    expect(dna.specs.map((s) => s.name)).toContain("kiro-power-package");
    expect(dna.agents).toHaveLength(4);
    expect(dna.hookFiles).toBe(4);
    expect(dna.steering).toHaveLength(3);
    expect(dna.skipped).toEqual([]);
    expect(dna.power).toMatchObject({
      name: "lazarus-resurrection",
      version: "1.0.0",
      keywords: ["legacy", "commonjs", "es5", "resurrect", "differential-fuzz", "mutation-audit", "lazarus", "modernize"],
      author: { name: "Ashlesha Anjarkar" },
      repository: "https://github.com/anjarkar25-max/lazarus",
      installUrl: "https://github.com/anjarkar25-max/lazarus/tree/main/power-lazarus",
      folder: "power-lazarus",
      mcpServers: [{ name: "lazarus-sandbox", type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/scripts/start-mcp.mjs"], namespacedAs: "power-lazarus-resurrection-lazarus-sandbox" }],
    });
    expect(dna.power?.skills.map((s) => [s.name, s.references])).toEqual([
      ["prove-the-proof", []],
      ["resurrect-legacy-js", ["parity-invariants.md"]],
    ]);
    expect(dna.generatedFrom).toBe(".kiro/{specs,agents,steering,hooks} + power-lazarus/");
  });

  describe("hostile fixture", () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-power-dna-"));
    const power = nodePath.join(root, "power-lazarus");
    const good = { $schema: PLUGIN_SCHEMA_URL, name: "p", version: "1.0.0", description: "d", author: { name: "a" }, keywords: ["k"], repository: "https://github.com/a/b" };
    const write = (rel: string, text: string): void => {
      fs.mkdirSync(nodePath.dirname(nodePath.join(power, rel)), { recursive: true });
      fs.writeFileSync(nodePath.join(power, rel), text);
    };
    beforeAll(() => {
      fs.writeFileSync(nodePath.join(root, "secret.txt"), "TOP SECRET");
      write("plugin.json", JSON.stringify(good));
      write("mcp.json", JSON.stringify({ $schema: MCP_SCHEMA_URL, mcpServers: { s: { type: "stdio", command: "node", disabled: false } } }));
      write("skills/ok/SKILL.md", "---\nname: ok\ndescription: fine\n---\n# ok\n");
      write("skills/ok/references/a.md", "a");
      write("skills/ok/references/b.txt", "ignored");
      write("skills/mismatch/SKILL.md", "---\nname: other\ndescription: x\n---\n");
      write("skills/Bad_Name/SKILL.md", "---\nname: Bad_Name\ndescription: x\n---\n");
      write("skills/nofm/SKILL.md", "# no frontmatter\n");
      write("scripts/start-mcp.mjs", "TOP SECRET LAUNCHER");
    });
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    it("reads only the package's manifest, MCP config and skills, and reports invalid files", () => {
      const r = readKiroDna(root);
      expect(r.power).toMatchObject({ name: "p", installUrl: "https://github.com/a/b/tree/main/power-lazarus", mcpServers: [] });
      expect(r.power?.skills).toEqual([{ folder: "ok", name: "ok", description: "fine", references: ["a.md"] }]);
      expect(r.skipped.map((s) => s.path).sort()).toEqual([
        "power-lazarus/mcp.json",
        "power-lazarus/skills/Bad_Name/SKILL.md",
        "power-lazarus/skills/mismatch/SKILL.md",
        "power-lazarus/skills/nofm/SKILL.md",
      ]);
      expect(JSON.stringify(r)).not.toContain("TOP SECRET");
    });

    it("returns power: null for a missing or invalid manifest, and no install URL for a non-GitHub repository", () => {
      write("plugin.json", JSON.stringify({ ...good, name: "Not Kebab" }));
      const bad = readKiroDna(root);
      expect(bad.power).toBeNull();
      expect(bad.skipped.find((s) => s.path === "power-lazarus/plugin.json")?.reason).toContain("name");
      write("plugin.json", "{ nope");
      expect(readKiroDna(root).power).toBeNull();
      write("plugin.json", JSON.stringify({ ...good, repository: "https://evil.example/a/b" }));
      expect(readKiroDna(root).power?.installUrl).toBeUndefined();
      write("plugin.json", JSON.stringify(good));
      const empty = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-power-empty-"));
      try {
        expect(readKiroDna(empty).power).toBeNull();
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });

    it("refuses a symlinked manifest (when the OS allows creating one)", () => {
      const link = nodePath.join(root, "linked");
      fs.mkdirSync(nodePath.join(link, "power-lazarus"), { recursive: true });
      try {
        fs.symlinkSync(nodePath.join(power, "plugin.json"), nodePath.join(link, "power-lazarus", "plugin.json"));
      } catch {
        return; // Windows without symlink privileges
      }
      const r = readKiroDna(link);
      expect(r.power).toBeNull();
      expect(r.skipped.some((s) => s.reason.includes("symbolic link"))).toBe(true);
    });
  });
});

describe("GET /api/kiro-dna with the Kiro Power", () => {
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

  it("returns the power alongside 21 specs, 4 agents, 4 hooks and the steering rules", async () => {
    const res = await fetch(`${baseUrl}/api/kiro-dna`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { specCount: number; agents: unknown[]; hookFiles: number; steering: unknown[]; power: { name: string; installUrl: string; skills: Array<{ name: string }>; mcpServers: Array<{ name: string }> } };
    expect(body.specCount).toBe(21);
    expect(body.agents).toHaveLength(4);
    expect(body.hookFiles).toBe(4);
    expect(body.steering).toHaveLength(3);
    expect(body.power.name).toBe("lazarus-resurrection");
    expect(body.power.installUrl).toBe("https://github.com/anjarkar25-max/lazarus/tree/main/power-lazarus");
    expect(body.power.skills.map((s) => s.name)).toEqual(["prove-the-proof", "resurrect-legacy-js"]);
    expect(body.power.mcpServers.map((s) => s.name)).toEqual(["lazarus-sandbox"]);
  });

  it.each([
    "spec=..%2Fpower-lazarus",
    "spec=..%2F..%2Fpower-lazarus%2Fplugin.json",
    "spec=power-lazarus&doc=plugin",
    "spec=kiro-power-package&doc=..%2F..%2F..%2Fpower-lazarus%2Fscripts%2Fstart-mcp",
    "spec=..&doc=requirements",
  ])("still blocks ?%s", async (query) => {
    const res = await fetch(`${baseUrl}/api/kiro-dna?${query}`);
    expect([400, 404]).toContain(res.status);
    const text = await res.text();
    expect(text).not.toContain("no Lazarus checkout found");
    expect(text).not.toContain("agent-plugins.org");
  });

  it("does not serve power-lazarus files directly", async () => {
    for (const p of ["/power-lazarus/plugin.json", "/power-lazarus/scripts/start-mcp.mjs", "/api/kiro-dna/../power-lazarus/mcp.json"]) {
      expect((await fetch(`${baseUrl}${p}`)).status, p).toBe(404);
    }
  });
});
