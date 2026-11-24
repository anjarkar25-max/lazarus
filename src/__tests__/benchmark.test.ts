import * as fs from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import type * as ESTree from "estree";
import { describe, expect, it } from "vitest";
import { BENCHMARK_PRESETS } from "../benchmark-presets.js";
import { renderBenchmarkTable, runBenchmark } from "../benchmark.js";
import { walk } from "../crew/ast-scope.js";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../..");

/** { name, code, schema } object literals of the presets the page ships. */
function uiPresets(): Array<{ name: string; code: string; schema: unknown }> {
  const html = fs.readFileSync(nodePath.join(root, "public", "index.html"), "utf8");
  const found: Array<{ name: string; code: string; schema: unknown }> = [];
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    const ast = parse(m[1] ?? "", { ecmaVersion: "latest", sourceType: "script" }) as unknown as ESTree.Program;
    walk(ast, (n) => {
      if (n.type !== "ObjectExpression") return undefined;
      const get = (k: string): unknown => {
        const p = n.properties.find((x): x is ESTree.Property => x.type === "Property" && x.key.type === "Identifier" && x.key.name === k);
        return p !== undefined && p.value.type === "Literal" ? p.value.value : undefined;
      };
      const name = get("name");
      const code = get("code");
      const schema = get("schema");
      if (typeof name === "string" && typeof code === "string" && typeof schema === "string") found.push({ name, code, schema: JSON.parse(schema) as unknown });
      return undefined;
    });
  }
  return found;
}

describe("benchmark presets", () => {
  it("are exactly the curated presets the UI ships (same names, code and schemas)", () => {
    const ui = uiPresets();
    expect(BENCHMARK_PRESETS.map((p) => p.name).sort()).toEqual(ui.map((p) => p.name).sort());
    for (const preset of BENCHMARK_PRESETS) {
      const shipped = ui.find((p) => p.name === preset.name);
      expect(shipped?.code, preset.name).toBe(preset.code);
      expect(shipped?.schema, preset.name).toEqual(preset.schema);
    }
  });
});

describe("runBenchmark", () => {
  it("runs presets through the real orchestrator and tsc --strict, and renders a Markdown table", async () => {
    const pick = BENCHMARK_PRESETS.filter((p) => ["stringHash32", "cjsMathUtils"].includes(p.name));
    const rows = await runBenchmark({ presets: pick, fuzzRuns: 60 });
    expect(rows.map((r) => r.specimen)).toEqual(["stringHash32", "cjsMathUtils"]);
    for (const r of rows) {
      expect(r.success).toBe(true);
      expect(r.tscPassed).toBe(true);
      expect(r.durationMs).toBeGreaterThan(0);
    }
    expect(rows[0]).toMatchObject({ attempts: 2, fuzzRuns: 60, tsc: "tsc --strict: 0 errors (2 files, TypeScript 7.0.2)" });
    // A module bundle checks one file: singular.
    expect(rows[1]).toMatchObject({ fuzzRuns: 180, tsc: "tsc --strict: 0 errors (1 file, TypeScript 7.0.2)" });
    const table = renderBenchmarkTable(rows).split("\n");
    expect(table[0]).toBe("| Specimen | Parity | Attempts | Fuzz runs | tsc --strict | Duration (ms) |");
    expect(table[1]).toBe("| --- | --- | ---: | ---: | --- | ---: |");
    expect(table[2]).toMatch(/^\| `stringHash32` \| exact Object\.is \| 2 \| 60 \| tsc --strict: 0 errors \(2 files, TypeScript 7\.0\.2\) \| \d+ \|$/);
    expect(table).toHaveLength(4);
  }, 60_000);

  it("is wired as npm run benchmark", () => {
    const pkg = JSON.parse(fs.readFileSync(nodePath.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.benchmark).toBe("npx tsx src/benchmark.ts");
  });
});
