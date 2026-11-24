import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, USAGE, type CliIo } from "../cli.js";

const repoRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..", "..");
const quantizeExample = nodePath.join(repoRoot, "examples", "legacy-quantize.cjs");

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-cli-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function io(): { io: CliIo; out: () => string; err: () => string } {
  let stdout = "";
  let stderr = "";
  return { io: { stdout: (t) => void (stdout += t), stderr: (t) => void (stderr += t), cwd: dir }, out: () => stdout, err: () => stderr };
}

function write(name: string, content: string): string {
  const file = nodePath.join(dir, name);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

const read = (...parts: string[]): string => fs.readFileSync(nodePath.join(dir, ...parts), "utf8");

describe("lazarus CLI: resurrecting legacy-quantize.cjs", () => {
  it("writes the verified bundle (ts, test, spec, patch, plus exact ESM files) to --out", async () => {
    write("legacy-quantize.cjs", fs.readFileSync(quantizeExample, "utf8"));
    const cli = io();

    const code = await main(["./legacy-quantize.cjs", "--out", "./resurrected-out", "--runs", "30", "--seed", "11"], cli.io);

    expect(code).toBe(0);
    expect(cli.out()).toContain("Parity proven: 30 fuzz runs");
    for (const file of ["resurrected.ts", "resurrected.test.ts", "SPEC.md", "resurrection.patch", "resurrected.mjs", "legacy.cjs", "resurrected.esm.test.ts"]) {
      expect(fs.existsSync(nodePath.join(dir, "resurrected-out", file)), file).toBe(true);
    }

    const ts = read("resurrected-out", "resurrected.ts");
    expect(ts).toContain("export function quantizeClamp(n: number): unknown {");
    expect(ts).toContain("const clamped = n < -100 ? -100 : n > 100 ? 100 : n;");
    expect(ts).toContain("return Math.trunc(clamped / 3) || 0;");
    expect(ts).not.toMatch(/\(function/); // no untyped inner function

    const test = read("resurrected-out", "resurrected.test.ts");
    expect(test).toContain("Object.is(quantizeClamp(n), runLegacy(n))");
    expect(test).toContain("{ numRuns: 30 }");

    const spec = read("resurrected-out", "SPEC.md");
    expect(spec).toContain("# Kiro Resurrection Specification: quantizeClamp");
    expect(spec).toContain("## Legacy Idioms (AST analysis)");
    expect(spec).toContain("module.exports = function quantizeClamp");

    expect(read("resurrected-out", "resurrected.mjs")).toContain("export default function quantizeClamp(n)");
  }, 60_000);

  it("emits a patch with correct hunk counts", async () => {
    write("legacy-quantize.cjs", fs.readFileSync(quantizeExample, "utf8"));
    expect(await main(["legacy-quantize.cjs", "-o", "out", "--runs", "20"], io().io)).toBe(0);

    const lines = read("out", "resurrection.patch").trimEnd().split("\n");
    const hunk = lines.findIndex((l) => l.startsWith("@@"));
    const match = /^@@ -1,(\d+) \+1,(\d+) @@$/.exec(lines[hunk] ?? "");
    expect(match).not.toBeNull();
    const body = lines.slice(hunk + 1);
    expect(body.filter((l) => l.startsWith("-")).length).toBe(Number(match?.[1]));
    expect(body.filter((l) => l.startsWith("+")).length).toBe(Number(match?.[2]));
  }, 60_000);

  it("generates TypeScript that behaves exactly like the legacy module (Object.is, including negatives)", async () => {
    const legacyPath = write("legacy-quantize.cjs", fs.readFileSync(quantizeExample, "utf8"));
    expect(await main(["legacy-quantize.cjs", "--out", "out", "--runs", "20"], io().io)).toBe(0);

    const modern = (await import(/* @vite-ignore */ pathToFileURL(nodePath.join(dir, "out", "resurrected.ts")).href)) as { quantizeClamp: (n: number) => unknown };
    const legacy = createRequire(import.meta.url)(legacyPath) as (n: number) => unknown;
    for (let n = -400; n <= 400; n++) expect(Object.is(modern.quantizeClamp(n), legacy(n)), `n=${n}`).toBe(true);
  }, 60_000);

  it("runs as a real process: tsx src/cli.ts <file> --out <dir>", () => {
    const source = write("legacy-quantize.cjs", fs.readFileSync(quantizeExample, "utf8"));
    const out = nodePath.join(dir, "process-out");
    const run = spawnSync(process.execPath, ["--import", "tsx/esm", "src/cli.ts", source, "--out", out, "--runs", "20", "--seed", "3"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 90_000,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Parity proven");
    expect(fs.readFileSync(nodePath.join(out, "resurrected.ts"), "utf8")).toContain("export function quantizeClamp");
    expect(fs.existsSync(nodePath.join(out, "resurrection.patch"))).toBe(true);
  }, 120_000);
});

describe("lazarus CLI: other inputs", () => {
  it("keeps every parameter of a multi-parameter CommonJS module", async () => {
    write("mix.cjs", "exports.mix = function (a, b) { var s = a * 3 + b; return (s / 2) | 0; };");
    expect(await main(["mix.cjs", "--out", "out", "--runs", "30", "--seed", "5"], io().io)).toBe(0);

    expect(read("out", "resurrected.ts")).toContain("export function mix(a: number, b: number): unknown {");
    const test = read("out", "resurrected.test.ts");
    expect(test).toContain("function runLegacy(a: number, b: number): unknown {");
    expect(test).toContain("fc.property(fc.integer({ min: -10000, max: 10000 }), fc.integer({ min: -10000, max: 10000 }), (a, b) => {");
    expect(test).toContain("Object.is(mix(a, b), runLegacy(a, b))");
  }, 60_000);

  it("selects a function with --function and takes an explicit --schema and --name", async () => {
    write("two.cjs", "exports.first = function (n) { return n; };\nexports.second = function (s) { return s.length | 0; };");
    const cli = io();
    expect(await main(["two.cjs", "--function", "second", "--schema", '{"s":"string"}', "--name", "lengthOf", "--out", "out", "--runs", "20"], cli.io)).toBe(0);
    expect(cli.out()).toContain('(from --schema)');
    expect(read("out", "resurrected.ts")).toContain("export function lengthOf(s: string): unknown {");
  }, 60_000);

  it("infers a string parameter from how the code uses it", async () => {
    write("pad.cjs", "module.exports = function leftPad(text) { var out = text.toUpperCase(); while (out.length < 6) { out = '0' + out; } return out; };");
    const cli = io();
    expect(await main(["pad.cjs", "--out", "out", "--runs", "20"], cli.io)).toBe(0);
    expect(cli.out()).toContain('{"text":"string"}');
    expect(read("out", "resurrected.ts")).toContain("leftPad(text: string)");
  }, 60_000);

  it("contains hostile legacy code in the sandbox: process.exit cannot stop the CLI", async () => {
    write("evil.cjs", "module.exports = function (n) { process.exit(7); return n; };");
    const cli = io();
    expect(await main(["evil.cjs", "--out", "out", "--runs", "10"], cli.io)).toBe(0);
    expect(cli.out()).toContain("Parity proven");
  }, 60_000);

  it("writes nothing and exits 1 when parity cannot be proven (non-deterministic legacy code)", async () => {
    write("random.cjs", "module.exports = function (n) { return Math.random() + n; };");
    const cli = io();
    const code = await main(["random.cjs", "--out", "out", "--runs", "10", "--seed", "1"], cli.io);
    expect(code).toBe(1);
    expect(cli.err()).toContain("NOT resurrected");
    expect(cli.err()).toContain("counterexample inputs");
    expect(fs.existsSync(nodePath.join(dir, "out"))).toBe(false);
  }, 90_000);
});

describe("lazarus CLI: usage errors", () => {
  it.each([
    ["no arguments", [], 2, "no input file"],
    ["an unknown option", ["x.cjs", "--wat"], 2, "unknown option --wat"],
    ["a missing option value", ["x.cjs", "--out"], 2, "--out needs a value"],
    ["a non-integer --runs", ["x.cjs", "--runs", "many"], 2, "--runs must be an integer"],
    ["an out-of-range --runs", ["x.cjs", "--runs", "1"], 2, "between 5 and 2000"],
    ["two input files", ["a.cjs", "b.cjs"], 2, "unexpected extra argument"],
    ["a non-JavaScript file", ["notes.txt"], 2, "not a .js, .cjs or .mjs file"],
    ["a missing file", ["nope.cjs"], 2, "cannot read nope.cjs"],
  ])("rejects %s", async (_label, argv, expectedCode, message) => {
    const cli = io();
    expect(await main(argv, cli.io)).toBe(expectedCode);
    expect(cli.err()).toContain(message);
  });

  it("validates --schema and --function, and reports unparsable files", async () => {
    write("ok.cjs", "module.exports = function (n) { return n; };");
    write("broken.cjs", "module.exports = function (n { return n; };");
    const badJson = io();
    expect(await main(["ok.cjs", "--schema", "{nope"], badJson.io)).toBe(2);
    expect(badJson.err()).toContain("--schema is not valid JSON");

    const badKind = io();
    expect(await main(["ok.cjs", "--schema", '{"n":"float"}'], badKind.io)).toBe(2);
    expect(badKind.err()).toContain("invalid --schema");

    const noFn = io();
    expect(await main(["ok.cjs", "--function", "missing"], noFn.io)).toBe(2);
    expect(noFn.err()).toContain('no function named "missing"');

    const broken = io();
    expect(await main(["broken.cjs"], broken.io)).toBe(1);
    expect(broken.err()).toContain("could not be parsed");
  });

  it("prints usage for --help and refuses oversized files", async () => {
    const help = io();
    expect(await main(["--help"], help.io)).toBe(0);
    expect(help.out()).toBe(`${USAGE}\n`);
    write("huge.cjs", `module.exports = function (n) { return n; };\n// ${"x".repeat(300_000)}`);
    const huge = io();
    expect(await main(["huge.cjs"], huge.io)).toBe(2);
    expect(huge.err()).toContain("the limit is 256000");
  });
});
