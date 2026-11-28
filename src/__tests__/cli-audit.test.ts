import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { AUDIT_USAGE, auditDirectory, renderAuditMarkdown, renderSarif, runAuditCli, type AuditReport, type SarifLog } from "../cli-audit.js";
import { AUDIT_WORKFLOW_PATH, renderAuditWorkflow } from "../exporter/bundle.js";
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
      "npm run resurrect -- examples/legacy-circular-ledger --entry index.cjs --out ./resurrected-out/legacy-circular-ledger",
      "npm run resurrect -- examples/legacy-invoice-engine --entry invoice.cjs --out ./resurrected-out/legacy-invoice-engine",
      "npm run resurrect -- examples/legacy-text-pipeline --entry slug.cjs --out ./resurrected-out/legacy-text-pipeline",
      "npm run resurrect -- examples/legacy-quantize.cjs --out ./resurrected-out",
    ]);
    expect(r.notes.some((n) => n.startsWith("4 independent require graphs"))).toBe(true);
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

// ---------------------------------------------------------------------------
// SARIF 2.1.0 (GitHub Code Scanning)
// ---------------------------------------------------------------------------
describe("lazarus audit --sarif: SARIF 2.1.0 for GitHub Code Scanning", () => {
  const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-sarif-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(nodePath.dirname(nodePath.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(nodePath.join(tmp, rel), text);
  };
  const sarifOf = (args: string[], cwd = root): SarifLog => {
    const h = io();
    expect(runAuditCli([...args, "--sarif"], { ...h.io, cwd }), args.join(" ")).toBe(0);
    return JSON.parse(h.out()) as SarifLog;
  };
  /** Structural validation of the SARIF 2.1.0 properties GitHub reads (no JSON-schema dependency needed). */
  function expectValidSarif(log: SarifLog): void {
    expect(log.$schema).toBe("https://json.schemastore.org/sarif-2.1.0.json");
    expect(log.version).toBe("2.1.0");
    expect(log.runs).toHaveLength(1);
    const run = log.runs[0];
    const driver = run?.tool.driver;
    expect(driver?.name).toBe("Lazarus");
    expect(driver?.informationUri).toMatch(/^https:\/\//);
    const ids = (driver?.rules ?? []).map((r) => r.id);
    expect(ids).toEqual(["LAZ001", "LAZ002", "LAZ003", "LAZ004", "LAZ005", "LAZ006", "LAZ007"]);
    for (const r of driver?.rules ?? []) {
      expect(r.shortDescription.text.length).toBeGreaterThan(5);
      expect(r.help.text.length).toBeGreaterThan(20);
      expect(["error", "warning", "note"]).toContain(r.defaultConfiguration.level);
    }
    for (const res of run?.results ?? []) {
      expect(ids[res.ruleIndex]).toBe(res.ruleId);
      expect(["error", "warning", "note"]).toContain(res.level);
      expect(res.message.text).toMatch(/Fix: /);
      expect(res.locations).toHaveLength(1);
      const loc = res.locations[0]?.physicalLocation;
      expect(loc?.artifactLocation.uri).toMatch(/^[^/\\].*\.c?js$/);
      expect(loc?.artifactLocation.uri).not.toContain("\\");
      expect(loc?.artifactLocation.uriBaseId).toBe("%SRCROOT%");
      expect(Number.isInteger(loc?.region.startLine)).toBe(true);
      expect(loc?.region.startLine).toBeGreaterThanOrEqual(1);
    }
  }

  it("emits a valid SARIF log for examples/legacy-invoice-engine with exact uris and source lines", () => {
    const log = sarifOf(["examples/legacy-invoice-engine"]);
    expectValidSarif(log);
    const results = log.runs[0]?.results ?? [];
    expect(results.length).toBeGreaterThan(5);
    const truncations = results.filter((r) => r.ruleId === "LAZ001");
    expect(truncations.length).toBeGreaterThan(0);
    for (const r of truncations) {
      const loc = r.locations[0]?.physicalLocation;
      expect(loc?.artifactLocation.uri).toMatch(/^examples\/legacy-invoice-engine\/(money|tax|invoice)\.cjs$/);
      const lines = fs.readFileSync(nodePath.join(root, loc?.artifactLocation.uri ?? ""), "utf8").split(/\r?\n/);
      expect(lines[(loc?.region.startLine ?? 1) - 1], `${loc?.artifactLocation.uri}:${loc?.region.startLine}`).toMatch(/\| 0/);
      expect(r.level).toBe("error");
    }
    expect(results.some((r) => r.ruleId === "LAZ004" && r.level === "warning")).toBe(true);
  });
  it("maps every finding of the report to one result (severity -> level, kind -> rule), deterministically", () => {
    const report = json(["examples/legacy-invoice-engine"]);
    const log = sarifOf(["examples/legacy-invoice-engine"]);
    expect(log.runs[0]?.results).toHaveLength(report.files.reduce((n, f) => n + f.findings.length, 0));
    const level = { high: "error", medium: "warning", info: "note" } as const;
    const count = (l: string): number => (log.runs[0]?.results ?? []).filter((r) => r.level === l).length;
    expect(count("error")).toBe(report.totals.high);
    expect(count("warning")).toBe(report.totals.medium);
    expect(count("note")).toBe(report.totals.info);
    expect(Object.values(level)).toEqual(["error", "warning", "note"]);
    expect(sarifOf(["examples/legacy-invoice-engine"])).toEqual(log);
    expect(renderSarif(report)).toEqual(log);
  });
  it("covers LAZ002 error-first callback, LAZ003 prototype chain, LAZ004 arguments, LAZ005 external require and LAZ006 parse error", () => {
    write("rules/cb.js", "function readPort(text, cb) {\n  if (typeof text !== 'string') return cb(new TypeError('text'));\n  cb(null, parseInt(text, 10));\n}\nmodule.exports = readPort;\n");
    write("rules/proto.js", "function Shape(w) { this.w = w; }\nShape.prototype.area = function () { return this.w * this.w; };\nmodule.exports = Shape;\n");
    write("rules/args.js", "function sum() {\n  return arguments.length;\n}\nmodule.exports = sum;\n");
    write("rules/ext.js", "var fs = require('fs');\nmodule.exports = 1;\n");
    write("rules/broken.js", "function ( {\n");
    const log = sarifOf(["rules"], tmp);
    expectValidSarif(log);
    const results = log.runs[0]?.results ?? [];
    const at = (file: string, rule: string): SarifLog["runs"][number]["results"][number] | undefined => results.find((r) => r.ruleId === rule && r.locations[0]?.physicalLocation.artifactLocation.uri === `rules/${file}`);
    expect(at("cb.js", "LAZ002")).toMatchObject({ level: "warning", locations: [{ physicalLocation: { region: { startLine: 1 } } }] });
    expect(at("proto.js", "LAZ003")?.level).toBe("warning");
    expect(at("args.js", "LAZ004")?.locations[0]?.physicalLocation.region.startLine).toBe(2);
    expect(at("ext.js", "LAZ005")).toMatchObject({ level: "error", locations: [{ physicalLocation: { region: { startLine: 1 } } }] });
    expect(at("broken.js", "LAZ006")).toMatchObject({ level: "error", locations: [{ physicalLocation: { region: { startLine: 1 } } }] });
  });
  it("reports a require cycle as LAZ005 on the line of the require that closes it", () => {
    const log = sarifOf(["examples/legacy-circular-ledger"]);
    expectValidSarif(log);
    const cyc = (log.runs[0]?.results ?? []).filter((r) => r.ruleId === "LAZ005" && r.level === "error");
    expect(cyc.map((r) => r.locations[0]?.physicalLocation.artifactLocation.uri).sort()).toEqual(["examples/legacy-circular-ledger/discount.cjs", "examples/legacy-circular-ledger/tax.cjs"]);
    for (const r of cyc) {
      const loc = r.locations[0]?.physicalLocation;
      const lines = fs.readFileSync(nodePath.join(root, loc?.artifactLocation.uri ?? ""), "utf8").split(/\r?\n/);
      expect(lines[(loc?.region.startLine ?? 1) - 1]).toMatch(/require\('\.\/(tax|discount)\.cjs'\)/);
      expect(r.message.text).toContain("require cycle");
      expect(r.message.text).toContain("live bindings");
    }
  });
  it("V15 idioms land on the existing rules (LAZ003, LAZ004) and the new LAZ007, leaving LAZ001-LAZ006 untouched", () => {
    write("idioms/inherit.js", "function B() {}\nfunction C() { B.call(this); }\nC.prototype = Object.create(B.prototype);\nC.prototype.f = function () { return 1; };\nmodule.exports = C;\n");
    write("idioms/fwd.js", "function wrap(fn) {\n  return function () { return fn.apply(this, arguments); };\n}\nmodule.exports = wrap;\n");
    write("idioms/chain.js", "function load(x) {\n  return get(x).then(function (v) { return v; }).catch(function () { return 0; });\n}\nmodule.exports = load;\n");
    const log = sarifOf(["idioms"], tmp);
    expectValidSarif(log);
    const at = (file: string): Array<{ ruleId: string; level: string; line: number }> =>
      (log.runs[0]?.results ?? []).filter((r) => r.locations[0]?.physicalLocation.artifactLocation.uri === `idioms/${file}`).map((r) => ({ ruleId: r.ruleId, level: r.level, line: r.locations[0]?.physicalLocation.region.startLine ?? 0 }));
    expect(at("inherit.js")).toEqual(expect.arrayContaining([{ ruleId: "LAZ003", level: "warning", line: 3 }]));
    expect(at("fwd.js")).toEqual(expect.arrayContaining([{ ruleId: "LAZ004", level: "warning", line: 2 }]));
    expect(at("chain.js")).toEqual(expect.arrayContaining([{ ruleId: "LAZ007", level: "warning", line: 1 }]));
    const rule7 = log.runs[0]?.tool.driver.rules.find((r) => r.id === "LAZ007");
    expect(rule7).toMatchObject({ name: "PromiseChain", defaultConfiguration: { level: "warning" } });
    // The six existing rules keep their ids, names and order.
    expect(log.runs[0]?.tool.driver.rules.slice(0, 6).map((r) => `${r.id}:${r.name}`)).toEqual(["LAZ001:BitwiseTruncation", "LAZ002:ErrorFirstCallback", "LAZ003:PrototypeChain", "LAZ004:VarOrArgumentsHoisting", "LAZ005:CircularOrUnresolvableRequire", "LAZ006:UnparseableFile"]);
  });
  it("uses repository-relative uris, or bare ones for an absolute or parent folder", () => {
    const rel = sarifOf(["examples/legacy-text-pipeline/"]).runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri ?? "";
    expect(rel.startsWith("examples/legacy-text-pipeline/")).toBe(true);
    const abs = sarifOf([nodePath.join(root, "examples", "legacy-text-pipeline")]).runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri ?? "";
    expect(abs).toMatch(/^(trim|pad|slug)\.cjs$/);
    const parent = sarifOf([".."], nodePath.join(root, "examples", "legacy-text-pipeline")).runs[0]?.results ?? [];
    expect(parent.length).toBeGreaterThan(0);
    for (const r of parent) expect(r.locations[0]?.physicalLocation.artifactLocation.uri).toMatch(/^(legacy-[a-z-]+\/|legacy-quantize\.cjs)/);
  });
  it("--out writes the file (relative to the working directory), prints a summary, and keeps stdout free of the log", () => {
    const h = { out: "", err: "" };
    const code = runAuditCli(["examples/legacy-invoice-engine", "--sarif", "--out", "reports/report.sarif"], { stdout: (t) => void (h.out += t), stderr: (t) => void (h.err += t), cwd: tmp });
    expect(code).toBe(2); // the audited folder is resolved against the same cwd, and it does not exist inside tmp
    expect(h.err).toMatch(/^error: cannot audit/);
    write("src/a.js", "var x = (n / 2) | 0;\nmodule.exports = x;\n");
    const ok = { out: "", err: "" };
    expect(runAuditCli(["src", "--sarif", "--out", "reports/report.sarif"], { stdout: (t) => void (ok.out += t), stderr: (t) => void (ok.err += t), cwd: tmp })).toBe(0);
    expect(ok.err).toBe("");
    expect(ok.out).toMatch(/^Wrote SARIF 2\.1\.0 report for src to reports\/report\.sarif \(1 high/);
    expect(ok.out).not.toContain("$schema");
    const written = JSON.parse(fs.readFileSync(nodePath.join(tmp, "reports", "report.sarif"), "utf8")) as SarifLog;
    expectValidSarif(written);
    expect(written.runs[0]?.results[0]).toMatchObject({ ruleId: "LAZ001", level: "error", locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.js" }, region: { startLine: 1 } } }] });
    const md = { out: "" };
    expect(runAuditCli(["src", "--out", "reports/report.md"], { stdout: (t) => void (md.out += t), stderr: () => undefined, cwd: tmp })).toBe(0);
    expect(fs.readFileSync(nodePath.join(tmp, "reports", "report.md"), "utf8")).toContain("# Lazarus Legacy Risk Report: src");
    expect(md.out).toContain("Wrote Markdown report");
  });
  it("rejects bad combinations with exit 2 and writes nothing", () => {
    for (const args of [["src", "--sarif", "--json"], ["src", "--out"], ["src", "--out", "--sarif"]]) {
      const h = io();
      expect(runAuditCli(args, h.io), args.join(" ")).toBe(2);
      expect(h.err()).toMatch(/^error: /);
      expect(h.out()).toBe("");
    }
    write("src2/a.js", "var y = 1;\n");
    write("blocker", "a file, not a folder");
    const h = io();
    expect(runAuditCli(["src2", "--sarif", "--out", "blocker/x.sarif"], { ...h.io, cwd: tmp })).toBe(2);
    expect(h.err()).toMatch(/cannot write/);
  });
  it("is wired into the lazarus CLI, the usage text, package.json and the Power skill", async () => {
    const h = io();
    expect(await main(["audit", "examples/legacy-invoice-engine", "--sarif"], h.io)).toBe(0);
    expectValidSarif(JSON.parse(h.out()) as SarifLog);
    expect(AUDIT_USAGE).toContain("--sarif");
    expect(AUDIT_USAGE).toContain("--out");
    const skill = fs.readFileSync(nodePath.join(root, "power-lazarus", "skills", "resurrect-legacy-js", "SKILL.md"), "utf8");
    expect(skill).toContain("npm run audit -- <dir> --sarif");
    expect(skill).toContain("--sarif --out report.sarif");
    for (const id of ["LAZ001", "LAZ002", "LAZ003", "LAZ004", "LAZ005"]) expect(skill).toContain(id);
  });
  it("the Code Scanning workflow template uploads the SARIF and needs only security-events: write", () => {
    const yml = renderAuditWorkflow();
    for (const s of ["name: Lazarus Audit", "security-events: write", "npm run audit --", "--sarif --out", "github/codeql-action/upload-sarif@v3", "sarif_file: lazarus.sarif", "pull_request:"]) expect(yml, s).toContain(s);
    expect(yml).not.toMatch(/secrets\./);
    expect(AUDIT_WORKFLOW_PATH).toBe(".github/workflows/lazarus-audit.yml");
  });
});