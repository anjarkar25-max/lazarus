import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { AUDIT_USAGE, auditDirectory, renderAuditMarkdown, runAuditCli, type AuditReport } from "../cli-audit.js";
import { main } from "../cli.js";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../..");
function io(): { io: { stdout: (t: string) => void; stderr: (t: string) => void; cwd: string }; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return { io: { stdout: (t) => void (out += t), stderr: (t) => void (err += t), cwd: root }, out: () => out, err: () => err };
}
const json = (args: string[]): AuditReport => {
  const h = io();
  expect(runAuditCli([...args, "--json"], h.io)).toBe(0);
  return JSON.parse(h.out()) as AuditReport;
};
const kinds = (r: AuditReport, file: string): string[] => (r.files.find((f) => f.file === file)?.findings ?? []).map((f) => `${f.kind}:${f.severity}:${f.line}`);

describe("lazarus audit: examples/legacy-invoice-engine", () => {
  const r = json(["examples/legacy-invoice-engine"]);

  it("--json: flags every | 0 truncation as high, var hoisting as medium, and the require graph", () => {
    expect(r.directory).toBe("examples/legacy-invoice-engine");
    expect(r.files.map((f) => f.file)).toEqual(["invoice.cjs", "money.cjs", "tax.cjs"]);
    expect(kinds(r, "money.cjs")).toEqual(["require-graph:info:0", "bitwise-truncation:high:3", "var-hoisting:medium:7", "bitwise-truncation:high:8", "bitwise-truncation:high:14"]);
    expect(kinds(r, "tax.cjs")).toEqual(["require-graph:info:0", "var-hoisting:medium:2", "bitwise-truncation:high:7"]);
    expect(kinds(r, "invoice.cjs")).toEqual(["require-graph:info:0", "var-hoisting:medium:2"]);
    expect(r.graph.edges).toEqual([
      { from: "invoice.cjs", to: "money.cjs" },
      { from: "invoice.cjs", to: "tax.cjs" },
      { from: "tax.cjs", to: "money.cjs" },
    ]);
    expect(r.files.map((f) => [f.file, f.fanIn, f.fanOut])).toEqual([
      ["invoice.cjs", 0, 2],
      ["money.cjs", 2, 0],
      ["tax.cjs", 1, 1],
    ]);
    expect(r.graph.entry).toBe("invoice.cjs");
    expect(r.graph.cycles).toEqual([]);
  });

  it("--json: scores readiness deterministically and recommends the exact resurrect command", () => {
    expect(r.totals).toEqual({ files: 3, high: 4, medium: 3, info: 3 });
    expect(r.files.map((f) => [f.file, f.readiness])).toEqual([
      ["invoice.cjs", 94],
      ["money.cjs", 58],
      ["tax.cjs", 82],
    ]);
    expect(r.readiness).toBe(78);
    expect(r.grade).toBe("B");
    expect(r.recommendedCommand).toBe("npm run resurrect -- examples/legacy-invoice-engine --entry invoice.cjs --out ./resurrected-out");
    expect(json(["examples/legacy-invoice-engine"])).toEqual(r);
  });

  it("table mode: Markdown summary, findings, graph and next step", () => {
    const h = io();
    expect(runAuditCli(["examples/legacy-invoice-engine"], h.io)).toBe(0);
    const md = h.out();
    expect(md).toBe(renderAuditMarkdown(r));
    expect(md).toContain("# Lazarus Legacy Risk Report: examples/legacy-invoice-engine");
    expect(md).toContain("Migration readiness: **78/100 (grade B)**");
    expect(md).toContain("| money.cjs | 58 | 3 | 1 | 1 | 2 | 0 |");
    expect(md).toContain("| HIGH | money.cjs:3 | bitwise-truncation |");
    expect(md).toContain("- tax.cjs -> money.cjs");
    expect(md).toContain("Entry module: `invoice.cjs`");
    expect(md).toContain("```bash\nnpm run resurrect -- examples/legacy-invoice-engine --entry invoice.cjs --out ./resurrected-out\n```");
    // Literal pipes inside table cells are escaped.
    expect(md).toContain("`x \\| 0` truncates to int32");
  });
});

describe("lazarus audit: examples/legacy-text-pipeline", () => {
  it("--json and table mode", () => {
    const r = json(["examples/legacy-text-pipeline"]);
    expect(r.files.map((f) => [f.file, f.readiness, f.counts])).toEqual([
      ["pad.cjs", 82, { high: 1, medium: 1, info: 1 }],
      ["slug.cjs", 94, { high: 0, medium: 1, info: 1 }],
      ["trim.cjs", 94, { high: 0, medium: 1, info: 1 }],
    ]);
    expect(kinds(r, "pad.cjs")).toContain("bitwise-truncation:high:6");
    expect(r.graph.entry).toBe("slug.cjs");
    expect(r).toMatchObject({ readiness: 90, grade: "A", recommendedCommand: "npm run resurrect -- examples/legacy-text-pipeline --entry slug.cjs --out ./resurrected-out" });
    const h = io();
    expect(runAuditCli(["examples/legacy-text-pipeline/"], h.io)).toBe(0);
    expect(h.out()).toContain("Migration readiness: **90/100 (grade A)**");
    expect(h.out()).toContain("npm run resurrect -- examples/legacy-text-pipeline --entry slug.cjs");
  });

  it("recommends one command per independent require graph for a folder that holds several", () => {
    const r = json(["examples"]);
    expect(r.recommendedCommand.split("\n")).toEqual([
      "npm run resurrect -- examples/legacy-invoice-engine --entry invoice.cjs --out ./resurrected-out/legacy-invoice-engine",
      "npm run resurrect -- examples/legacy-text-pipeline --entry slug.cjs --out ./resurrected-out/legacy-text-pipeline",
      "npm run resurrect -- examples/legacy-quantize.cjs --out ./resurrected-out",
    ]);
    expect(r.notes.some((n) => n.startsWith("3 independent require graphs"))).toBe(true);
  });
});

describe("lazarus audit: patterns, safety and usage", () => {
  const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-audit-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(nodePath.dirname(nodePath.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(nodePath.join(tmp, rel), text);
  };

  it("finds shift / ~~ truncation, prototype chains, arguments, external requires and cycles; skips ignored folders", () => {
    write("shape.js", "function Shape(w) { this.w = w; }\nShape.prototype.area = function () { return this.w * this.w; };\nShape.prototype.half = function () { return ~~(this.w / 2) + (this.w >>> 0) + (this.w << 2); };\nfunction sum() { return arguments.length; }\nmodule.exports = Shape;\n");
    write("a.cjs", "var b = require('./b.cjs'); var fs = require('fs'); module.exports = 1;");
    write("b.cjs", "var a = require('./a.cjs'); module.exports = 2;");
    write("missing.cjs", "require('./nope.cjs');");
    write("node_modules/dep/index.js", "var x = 1 | 0;");
    write(".git/hooks/x.js", "var x = 1 | 0;");
    write("dist/bundle.js", "var x = 1 | 0;");
    write("broken.js", "function (");
    write("notes.txt", "var x = 1 | 0;");
    const r = auditDirectory(tmp);
    expect(r.files.map((f) => f.file)).toEqual(["a.cjs", "b.cjs", "broken.js", "missing.cjs", "shape.js"]);
    const shape = r.files.find((f) => f.file === "shape.js")?.findings ?? [];
    expect(shape.filter((f) => f.kind === "bitwise-truncation").map((f) => f.severity)).toEqual(["high", "high", "high"]);
    expect(shape.find((f) => f.kind === "prototype-chain")).toMatchObject({ severity: "medium", line: 2 });
    expect(shape.find((f) => f.kind === "prototype-chain")?.message).toContain("constructor Shape with 2 prototype member(s)");
    expect(shape.find((f) => f.kind === "arguments-usage")).toMatchObject({ severity: "medium", line: 4 });
    const a = r.files.find((f) => f.file === "a.cjs")?.findings ?? [];
    expect(a.find((f) => f.kind === "external-require")?.message).toContain("require('fs')");
    expect(a.find((f) => f.kind === "require-graph")).toMatchObject({ severity: "high" });
    expect(r.graph.cycles).toEqual([["a.cjs", "b.cjs"]]);
    expect(r.files.find((f) => f.file === "missing.cjs")?.findings[0]).toMatchObject({ kind: "external-require", severity: "high" });
    expect(r.files.find((f) => f.file === "broken.js")?.findings[0]).toMatchObject({ kind: "parse-error", severity: "high" });
    expect(r.notes.some((n) => n.includes("cannot run in the sandbox"))).toBe(true);
    expect(r.notes.some((n) => n.includes("require cycle"))).toBe(true);
    for (const f of r.files) expect(f.readiness).toBeGreaterThanOrEqual(0);
  });

  it("never executes the audited code", () => {
    const marker = nodePath.join(tmp, "PWNED");
    write("evil/evil.js", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(3);`);
    auditDirectory(nodePath.join(tmp, "evil"));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("skips oversized files and symbolic links", () => {
    write("big/huge.js", `var x = "${"a".repeat(260 * 1024)}";`);
    write("big/ok.js", "var y = 1;");
    let linked = false;
    try {
      fs.symlinkSync(nodePath.join(tmp, "shape.js"), nodePath.join(tmp, "big", "link.js"));
      linked = true;
    } catch {
      /* Windows without symlink privileges */
    }
    const r = auditDirectory(nodePath.join(tmp, "big"));
    expect(r.files.map((f) => f.file)).toEqual(["ok.js"]);
    expect(r.skipped.find((s) => s.file === "huge.js")?.reason).toContain("larger than");
    if (linked) expect(r.skipped.find((s) => s.file === "link.js")?.reason).toContain("symbolic link");
  });

  it("reports an empty folder honestly", () => {
    fs.mkdirSync(nodePath.join(tmp, "empty"), { recursive: true });
    const r = auditDirectory(nodePath.join(tmp, "empty"));
    expect(r).toMatchObject({ files: [], readiness: 100, recommendedCommand: expect.stringContaining("no .js / .cjs files") as unknown });
  });

  it("usage errors exit 2; --help exits 0", () => {
    for (const args of [[], ["--nope"], ["a", "b"], ["does-not-exist-dir"], ["package.json"]]) {
      const h = io();
      expect(runAuditCli(args, h.io), args.join(" ")).toBe(2);
      expect(h.err()).toMatch(/^error: /);
      expect(h.out()).toBe("");
    }
    const h = io();
    expect(runAuditCli(["--help"], h.io)).toBe(0);
    expect(h.out()).toBe(`${AUDIT_USAGE}\n`);
  });

  it("is wired into the lazarus CLI and npm run audit", async () => {
    const h = io();
    expect(await main(["audit", "examples/legacy-text-pipeline", "--json"], h.io)).toBe(0);
    expect((JSON.parse(h.out()) as AuditReport).graph.entry).toBe("slug.cjs");
    const pkg = JSON.parse(fs.readFileSync(nodePath.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["audit"]).toBe("tsx src/cli.ts audit");
    const skill = fs.readFileSync(nodePath.join(root, "power-lazarus", "skills", "resurrect-legacy-js", "SKILL.md"), "utf8");
    expect(skill).toContain("npm run audit -- <dir>");
    expect(skill).toContain("lazarus audit <dir>");
  });
});
