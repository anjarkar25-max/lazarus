// Read-only view of the repository's Kiro configuration for the "Kiro DNA" drawer.
//
// Only these are ever read: .kiro/specs (requirements/design/tasks of each spec), .kiro/agents (*.json),
// .kiro/steering (*.md), .kiro/hooks (*.json), and the Kiro Power package power-lazarus/ (plugin.json, mcp.json,
// skills/*/SKILL.md and skills/*/references/*.md; its scripts are never read). Directory listings are enumerated by the server; request input is only ever compared
// against those listings. Every file path is resolved, symlinks are refused, and the real path must stay inside its
// directory.
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { z } from "zod";

export const MAX_KIRO_FILE_BYTES = 256 * 1024;
export const SPEC_DOCUMENTS = ["requirements", "design", "tasks"] as const;
export type SpecDocument = (typeof SPEC_DOCUMENTS)[number];

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export type RequirementStyle = "REQ-ids" | "R-headings" | "user-stories" | "bullets" | "none";

export interface SpecSummary {
  readonly name: string;
  readonly title: string;
  readonly requirementCount: number;
  readonly requirementStyle: RequirementStyle;
  readonly taskCount: number;
  readonly tasksDone: number;
  readonly documents: Record<SpecDocument, boolean>;
}

export interface AgentSummary {
  readonly file: string;
  readonly name: string;
  readonly description: string;
  readonly model: string;
  readonly tools: string[];
}

export interface SteeringSummary {
  readonly file: string;
  readonly title: string;
  readonly inclusion: string;
  readonly fileMatchPattern?: string;
  readonly rules: number;
}

export interface HookSummary {
  readonly file: string;
  readonly name: string;
  readonly description: string;
  /** Kiro v1 trigger (e.g. PostFileSave), or the legacy `when.type` (e.g. fileEdited). */
  readonly trigger: string;
  /** v1 regex matcher, or the legacy glob patterns joined with ", ". */
  readonly matcher?: string;
  readonly action: "command" | "agent";
  /** The shell command (command hooks) or the prompt (agent hooks). */
  readonly run: string;
  readonly enabled: boolean;
  readonly format: "v1" | "legacy";
}

export interface PowerSkill {
  /** Folder under power-lazarus/skills (equal to `name`). */
  readonly folder: string;
  readonly name: string;
  readonly description: string;
  /** Files in the skill's references/ folder. */
  readonly references: string[];
}

export interface PowerMcpServer {
  readonly name: string;
  readonly type: "stdio" | "streamable-http" | "sse";
  /** stdio: the command token; HTTP transports: the URL. */
  readonly command: string;
  readonly args: string[];
  /** How Kiro names the server once the Power is installed: power-<plugin>-<server>. */
  readonly namespacedAs: string;
}

export interface PowerSummary {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly keywords: string[];
  readonly author: { readonly name: string; readonly url?: string };
  readonly homepage?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly skills: PowerSkill[];
  readonly mcpServers: PowerMcpServer[];
  /** GitHub URL of the package folder, for Kiro's "Import power from a repository URL". */
  readonly installUrl?: string;
  readonly folder: string;
}

export interface KiroDna {
  readonly specCount: number;
  readonly specs: SpecSummary[];
  readonly agents: AgentSummary[];
  readonly steering: SteeringSummary[];
  readonly hooks: HookSummary[];
  /** Number of hook files that were read (one file may define several hooks). */
  readonly hookFiles: number;
  /** The installable Kiro Power in power-lazarus/, or null when its manifest is missing or invalid. */
  readonly power: PowerSummary | null;
  /** Files that exist but were not used, with the reason (oversized, invalid, symlink). */
  readonly skipped: Array<{ readonly path: string; readonly reason: string }>;
  readonly generatedFrom: string;
}

const AgentSchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().min(1).max(2000),
    tools: z.array(z.string().min(1).max(100)).max(50).default([]),
    model: z.string().min(1).max(100).default("auto"),
  })
  .passthrough();

const V1HookSchema = z
  .object({
    version: z.literal("v1"),
    hooks: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            description: z.string().max(2000).optional(),
            trigger: z.string().min(1).max(100),
            matcher: z.string().max(500).optional(),
            enabled: z.boolean().optional(),
            action: z.discriminatedUnion("type", [
              z.object({ type: z.literal("command"), command: z.string().min(1).max(4000) }).passthrough(),
              z.object({ type: z.literal("agent"), prompt: z.string().min(1).max(8000) }).passthrough(),
            ]),
          })
          .passthrough()
      )
      .min(1)
      .max(50),
  })
  .passthrough();

const LegacyHookSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    enabled: z.boolean().optional(),
    when: z.object({ type: z.string().min(1).max(100), patterns: z.array(z.string().max(500)).max(50).optional() }).passthrough(),
    then: z.discriminatedUnion("type", [
      z.object({ type: z.literal("runCommand"), command: z.string().min(1).max(4000) }).passthrough(),
      z.object({ type: z.literal("askAgent"), prompt: z.string().min(1).max(8000) }).passthrough(),
    ]),
  })
  .passthrough();

/** Normalizes a hook file in the Kiro v1 format or the legacy when/then format; `{ error }` when it is neither. */
export function parseHookFile(file: string, json: unknown): HookSummary[] | { error: string } {
  const v1 = V1HookSchema.safeParse(json);
  if (v1.success) {
    return v1.data.hooks.map((h) => ({
      file,
      name: h.name,
      description: h.description ?? "",
      trigger: h.trigger,
      ...(h.matcher !== undefined ? { matcher: h.matcher } : {}),
      action: h.action.type,
      run: h.action.type === "command" ? h.action.command : h.action.prompt,
      enabled: h.enabled ?? true,
      format: "v1" as const,
    }));
  }
  const legacy = LegacyHookSchema.safeParse(json);
  if (legacy.success) {
    const h = legacy.data;
    const patterns = h.when.patterns ?? [];
    return [
      {
        file,
        name: h.name,
        description: h.description ?? "",
        trigger: h.when.type,
        ...(patterns.length > 0 ? { matcher: patterns.join(", ") } : {}),
        action: h.then.type === "runCommand" ? "command" : "agent",
        run: h.then.type === "runCommand" ? h.then.command : h.then.prompt,
        enabled: h.enabled ?? true,
        format: "legacy",
      },
    ];
  }
  return { error: `not a Kiro hook (${v1.error.issues[0]?.message ?? "invalid"})` };
}

// ---- Kiro Power (Agent Plugins 1.0.0) ----
export const POWER_FOLDER = "power-lazarus";
export const PLUGIN_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const MCP_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
/** Agent Plugins name rule: 1-64 chars of a-z 0-9 . -, alphanumeric at both ends, no "--" or "..". */
export const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
/** Kiro skill name rule: lower-case letters, digits and hyphens, at most 64 characters. */
export const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const GITHUB_REPO = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** plugin.json: the closed Agent Plugins schema, plus the fields Kiro requires (version, description, author.name, keywords). */
export const PluginManifestSchema = z
  .object({
    $schema: z.literal(PLUGIN_SCHEMA_URL),
    name: z.string().min(1).max(64).regex(PLUGIN_NAME, "name must be kebab-case per Agent Plugins"),
    version: z.string().min(1).max(64),
    description: z.string().min(1).max(2000),
    author: z.object({ name: z.string().min(1).max(200), email: z.string().max(200).optional(), url: z.string().max(500).optional() }).strict(),
    homepage: z.string().max(500).optional(),
    repository: z.string().max(500).optional(),
    license: z.string().max(100).optional(),
    keywords: z.array(z.string().min(1).max(50)).min(1).max(50),
    extensions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  })
  .strict();

const StdioServerSchema = z
  .object({
    type: z.literal("stdio"),
    command: z.string().min(1).max(500),
    args: z.array(z.string().max(2000)).max(100).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().regex(/^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/).optional(),
  })
  .strict()
  .refine((s) => s.env === undefined || !("PLUGIN_ROOT" in s.env || "PLUGIN_DATA" in s.env), "env must not set PLUGIN_ROOT or PLUGIN_DATA");
const HttpServerSchema = z
  .object({ type: z.enum(["streamable-http", "sse"]), url: z.string().min(1).max(2000), headers: z.record(z.string(), z.string()).optional() })
  .strict();
/** mcp.json: the closed Agent Plugins MCP schema. */
export const PluginMcpSchema = z
  .object({
    $schema: z.literal(MCP_SCHEMA_URL),
    mcpServers: z.record(z.string().min(1).max(100), z.union([StdioServerSchema, HttpServerSchema])),
  })
  .strict();

export const SkillFrontmatterSchema = z
  .object({
    name: z.string().regex(SKILL_NAME, "skill name must be lower-case letters, digits and hyphens (at most 64)"),
    description: z.string().min(1).max(1024),
  })
  .passthrough();

type Skipped = KiroDna["skipped"];

/** Real path of `dir/name` if it is a regular file (not a symlink) inside `dir` and small enough; otherwise undefined. */
function safeFile(dir: string, name: string, skipped?: Skipped, label?: string): string | undefined {
  if (!SAFE_NAME.test(name)) return undefined;
  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    return undefined;
  }
  const candidate = nodePath.join(realDir, name);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch {
    return undefined;
  }
  if (stat.isSymbolicLink()) {
    skipped?.push({ path: label ?? name, reason: "symbolic link (not followed)" });
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  const real = fs.realpathSync(candidate);
  if (!real.startsWith(realDir + nodePath.sep)) return undefined;
  if (stat.size > MAX_KIRO_FILE_BYTES) {
    skipped?.push({ path: label ?? name, reason: `larger than ${MAX_KIRO_FILE_BYTES} bytes` });
    return undefined;
  }
  return real;
}

/** Sub-directories of `dir` (no symlinks), sorted. */
function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.isSymbolicLink() && SAFE_NAME.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function listFiles(dir: string, extension: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => (d.isFile() || d.isSymbolicLink()) && d.name.endsWith(extension) && SAFE_NAME.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** File text with a leading UTF-8 byte-order mark removed (several .kiro files have one) and LF line endings. */
const read = (path: string | undefined): string | undefined => (path === undefined ? undefined : fs.readFileSync(path, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"));

function parseJsonFile(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Reads power-lazarus/ with the same file checks as .kiro/. Returns null when there is no valid manifest. */
function readPower(repoRoot: string, skipped: Skipped): PowerSummary | null {
  const dir = nodePath.join(repoRoot, POWER_FOLDER);
  const label = (rest: string): string => `${POWER_FOLDER}/${rest}`;
  const manifestText = read(safeFile(dir, "plugin.json", skipped, label("plugin.json")));
  if (manifestText === undefined) return null;
  const manifestJson = parseJsonFile(manifestText);
  if (manifestJson === undefined) {
    skipped.push({ path: label("plugin.json"), reason: "not valid JSON" });
    return null;
  }
  const manifest = PluginManifestSchema.safeParse(manifestJson);
  if (!manifest.success) {
    const issue = manifest.error.issues[0];
    skipped.push({ path: label("plugin.json"), reason: `not a valid Agent Plugins manifest (${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"})` });
    return null;
  }
  const m = manifest.data;

  const mcpServers: PowerMcpServer[] = [];
  const mcpText = read(safeFile(dir, "mcp.json", skipped, label("mcp.json")));
  if (mcpText !== undefined) {
    const mcp = PluginMcpSchema.safeParse(parseJsonFile(mcpText));
    if (!mcp.success) {
      const issue = mcp.error.issues[0];
      skipped.push({ path: label("mcp.json"), reason: `not a valid Agent Plugins MCP config (${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"})` });
    } else {
      for (const [name, server] of Object.entries(mcp.data.mcpServers).sort(([a], [b]) => a.localeCompare(b))) {
        mcpServers.push({
          name,
          type: server.type,
          command: server.type === "stdio" ? server.command : server.url,
          args: server.type === "stdio" ? (server.args ?? []) : [],
          namespacedAs: `power-${m.name}-${name}`,
        });
      }
    }
  }

  const skills: PowerSkill[] = [];
  const skillsDir = nodePath.join(dir, "skills");
  for (const folder of listDirs(skillsDir)) {
    const skillDir = nodePath.join(skillsDir, folder);
    const text = read(safeFile(skillDir, "SKILL.md", skipped, label(`skills/${folder}/SKILL.md`)));
    if (text === undefined) continue;
    const fm = SkillFrontmatterSchema.safeParse(frontMatter(text));
    if (!fm.success) {
      skipped.push({ path: label(`skills/${folder}/SKILL.md`), reason: `invalid frontmatter (${fm.error.issues[0]?.path.join(".") || "root"}: ${fm.error.issues[0]?.message ?? "invalid"})` });
      continue;
    }
    if (fm.data.name !== folder) {
      skipped.push({ path: label(`skills/${folder}/SKILL.md`), reason: `frontmatter name "${fm.data.name}" does not match its folder` });
      continue;
    }
    const refsDir = nodePath.join(skillDir, "references");
    const references = listFiles(refsDir, ".md").filter((f) => safeFile(refsDir, f, skipped, label(`skills/${folder}/references/${f}`)) !== undefined);
    skills.push({ folder, name: fm.data.name, description: fm.data.description, references });
  }

  const repository = m.repository !== undefined && GITHUB_REPO.test(m.repository) ? m.repository : undefined;
  return {
    name: m.name,
    version: m.version,
    description: m.description,
    keywords: m.keywords,
    author: { name: m.author.name, ...(m.author.url !== undefined ? { url: m.author.url } : {}) },
    ...(m.homepage !== undefined ? { homepage: m.homepage } : {}),
    ...(m.repository !== undefined ? { repository: m.repository } : {}),
    ...(m.license !== undefined ? { license: m.license } : {}),
    skills,
    mcpServers,
    ...(repository !== undefined ? { installUrl: `${repository}/tree/main/${POWER_FOLDER}` } : {}),
    folder: POWER_FOLDER,
  };
}

/** Requirement count, using the first style the document actually uses. */
export function countRequirements(text: string): { count: number; style: RequirementStyle } {
  const ids = new Set([...text.matchAll(/\bREQ-[A-Z]{1,6}-\d{1,3}\b/g)].map((m) => m[0]));
  if (ids.size > 0) return { count: ids.size, style: "REQ-ids" };
  const rHeadings = text.match(/^#{2,4} R\d+[a-z]?\b/gm);
  if (rHeadings !== null && rHeadings.length > 0) return { count: rHeadings.length, style: "R-headings" };
  const stories = text.match(/^\*\*User Story\b/gm);
  if (stories !== null && stories.length > 0) return { count: stories.length, style: "user-stories" };
  const bullets = text.match(/^- \S/gm);
  if (bullets !== null && bullets.length > 0) return { count: bullets.length, style: "bullets" };
  return { count: 0, style: "none" };
}

export function countTasks(text: string): { total: number; done: number } {
  const all = text.match(/^\s*- \[[ xX]\]/gm) ?? [];
  const done = text.match(/^\s*- \[[xX]\]/gm) ?? [];
  return { total: all.length, done: done.length };
}

function titleOf(text: string | undefined, fallback: string): string {
  const heading = text?.match(/^# (.+)$/m)?.[1]?.trim();
  if (heading === undefined) return fallback;
  return heading.replace(/^(Requirements|Design|Tasks)\s*[:\u2014-]\s*/i, "").replace(/\s+Requirements$/i, "").trim() || fallback;
}

function frontMatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const out: Record<string, string> = {};
  if (m === null) return out;
  for (const line of (m[1] ?? "").split("\n")) {
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line.trim());
    if (kv?.[1] !== undefined) out[kv[1]] = (kv[2] ?? "").replace(/^"(.*)"$/, "$1");
  }
  return out;
}

export function readKiroDna(repoRoot: string): KiroDna {
  const kiro = nodePath.join(repoRoot, ".kiro");
  const skipped: Skipped = [];
  const specsDir = nodePath.join(kiro, "specs");
  const specs: SpecSummary[] = listDirs(specsDir).map((name) => {
    const dir = nodePath.join(specsDir, name);
    const docs = Object.fromEntries(SPEC_DOCUMENTS.map((d) => [d, read(safeFile(dir, `${d}.md`, skipped, `specs/${name}/${d}.md`))])) as Record<SpecDocument, string | undefined>;
    const req = countRequirements(docs.requirements ?? "");
    const tasks = countTasks(docs.tasks ?? "");
    return {
      name,
      title: titleOf(docs.requirements, name),
      requirementCount: req.count,
      requirementStyle: req.style,
      taskCount: tasks.total,
      tasksDone: tasks.done,
      documents: { requirements: docs.requirements !== undefined, design: docs.design !== undefined, tasks: docs.tasks !== undefined },
    };
  });

  const agentsDir = nodePath.join(kiro, "agents");
  const agents: AgentSummary[] = [];
  for (const file of listFiles(agentsDir, ".json")) {
    const text = read(safeFile(agentsDir, file, skipped, `agents/${file}`));
    if (text === undefined) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      skipped.push({ path: `agents/${file}`, reason: "not valid JSON" });
      continue;
    }
    const checked = AgentSchema.safeParse(json);
    if (!checked.success) {
      skipped.push({ path: `agents/${file}`, reason: `not an agent definition (${checked.error.issues[0]?.message ?? "invalid"})` });
      continue;
    }
    agents.push({ file, name: checked.data.name, description: checked.data.description, model: checked.data.model, tools: checked.data.tools });
  }

  const steeringDir = nodePath.join(kiro, "steering");
  const steering: SteeringSummary[] = [];
  for (const file of listFiles(steeringDir, ".md")) {
    const text = read(safeFile(steeringDir, file, skipped, `steering/${file}`));
    if (text === undefined) continue;
    const fm = frontMatter(text);
    steering.push({
      file,
      title: titleOf(text, file.replace(/\.md$/, "")),
      inclusion: fm["inclusion"] ?? "always",
      ...(fm["fileMatchPattern"] !== undefined ? { fileMatchPattern: fm["fileMatchPattern"] } : {}),
      rules: (text.match(/^- \S/gm) ?? []).length,
    });
  }

  const hooksDir = nodePath.join(kiro, "hooks");
  const hooks: HookSummary[] = [];
  let hookFiles = 0;
  for (const file of listFiles(hooksDir, ".json")) {
    const text = read(safeFile(hooksDir, file, skipped, `hooks/${file}`));
    if (text === undefined) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      skipped.push({ path: `hooks/${file}`, reason: "not valid JSON" });
      continue;
    }
    const parsed = parseHookFile(file, json);
    if (!Array.isArray(parsed)) {
      skipped.push({ path: `hooks/${file}`, reason: parsed.error });
      continue;
    }
    hookFiles++;
    hooks.push(...parsed);
  }

  const power = readPower(repoRoot, skipped);

  return { specCount: specs.length, specs, agents, steering, hooks, hookFiles, power, skipped, generatedFrom: ".kiro/{specs,agents,steering,hooks} + power-lazarus/" };
}

/**
 * Text of one spec document, or undefined. `spec` must be the exact name of an enumerated spec directory and `doc` one
 * of requirements | design | tasks; anything else (traversal, separators, absolute paths) is rejected before any path
 * is built.
 */
export function resolveKiroDocument(repoRoot: string, spec: unknown, doc: unknown): string | undefined {
  if (typeof spec !== "string" || typeof doc !== "string") return undefined;
  if (!(SPEC_DOCUMENTS as readonly string[]).includes(doc)) return undefined;
  const specsDir = nodePath.join(repoRoot, ".kiro", "specs");
  if (!listDirs(specsDir).includes(spec)) return undefined;
  return read(safeFile(nodePath.join(specsDir, spec), `${doc}.md`));
}
