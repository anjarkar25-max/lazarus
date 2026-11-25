// Read-only view of the repository's Kiro configuration for the "Kiro DNA" drawer.
//
// Only three directories are ever read: .kiro/specs (requirements/design/tasks of each spec), .kiro/agents (*.json)
// and .kiro/steering (*.md). Directory listings are enumerated by the server; request input is only ever compared
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

export interface KiroDna {
  readonly specCount: number;
  readonly specs: SpecSummary[];
  readonly agents: AgentSummary[];
  readonly steering: SteeringSummary[];
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

  return { specCount: specs.length, specs, agents, steering, skipped, generatedFrom: ".kiro/{specs,agents,steering}" };
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
