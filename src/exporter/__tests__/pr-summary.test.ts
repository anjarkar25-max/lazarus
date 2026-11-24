import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defaultLevels, encodeLevels } from "../../crew/ast-modernizer.js";
import { plural } from "../../text/plural.js";
import { describeTypecheck } from "../../crew/ts-verifier.js";
import { buildGitHubPrSummary, compactDiff, stripGeneratedHeader, type PrSummaryInput } from "../pr-summary.js";

const HASH = "var h = 0; for (var i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; } h;";
const levels = { ...defaultLevels(), "bitor0-trunc": 1 };
const MODERN = [
  "// Resurrected by Lazarus Necromancer (attempt 2)",
  `// ast-rules: ${encodeLevels(levels)}`,
  "// ast-refine: attempt 2 blamed bitor0-trunc; rolled back bitor0-trunc (trunc-or0 -> off); parity restored",
  "let h = 0;",
  "for (let i = 0; i < text.length; i++) {",
  "  h = h * 31 + text.charCodeAt(i) | 0;",
  "}",
  "h;",
].join("\n");

const input = (over: Partial<PrSummaryInput> = {}): PrSummaryInput => ({
  name: "stringHash32",
  provenance: { kind: "preset", label: "es5-string-hash" },
  legacySource: HASH,
  modernCode: MODERN,
  fuzz: { totalRuns: 100, exact: true, boundaryRuns: 50 },
  attempts: 2,
  typecheck: { errorCount: 0, filesChecked: 2, tsVersion: "7.0.2" },
  ...over,
});

describe("plural", () => {
  it("formats singular and plural counts", () => {
    expect([plural(0, "file"), plural(1, "file"), plural(2, "file"), plural(1, "entry export"), plural(3, "query", "queries")]).toEqual(["0 files", "1 file", "2 files", "1 entry export", "3 queries"]);
  });

  it("is used by every tsc --strict label", () => {
    expect(describeTypecheck({ errorCount: 0, filesChecked: 1, tsVersion: "7.0.2" })).toBe("tsc --strict: 0 errors (1 file, TypeScript 7.0.2)");
    expect(describeTypecheck({ errorCount: 1, filesChecked: 2, tsVersion: "7.0.2" })).toBe("tsc --strict: 1 error (2 files, TypeScript 7.0.2)");
    expect(describeTypecheck({ errorCount: 2, filesChecked: 3, tsVersion: "7.0.2" })).toBe("tsc --strict: 2 errors (3 files, TypeScript 7.0.2)");
  });
});

describe("buildGitHubPrSummary", () => {
  it("is deterministic: same input, byte-identical Markdown, no timestamps", () => {
    const a = buildGitHubPrSummary(input());
    expect(buildGitHubPrSummary(input())).toBe(a);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
  });

  it("contains provenance, digest, the exact Object.is proof, self-healing, tsc and debt", () => {
    const md = buildGitHubPrSummary(input());
    expect(md.startsWith("## Resurrect `stringHash32` with Lazarus\n")).toBe(true);
    expect(md).toContain("**Provenance:** Operating Table preset `es5-string-hash`");
    expect(md).toMatch(/\*\*Legacy SHA-256:\*\* `[0-9a-f]{64}` \(certificate `LZ-[0-9A-F]{12}`\)/);
    expect(md).toContain("- **Behavioral parity:** exact `Object.is` across 100 differential fuzz runs (50 from the boundary corpus), tagged so -0, NaN and undefined are compared exactly.");
    expect(md).toContain("- **Self-healing:** healed in 2 attempts; rolled back `| 0 → Math.trunc(x) || 0`.");
    expect(md).toContain("- **TypeScript:** `tsc --strict: 0 errors (2 files, TypeScript 7.0.2)`.");
    expect(md).toMatch(/- \*\*Legacy debt score:\*\* \d+\/100 \(\w+\)\./);
    expect(md).toContain("- var → const/let");
  });

  it("uses singular forms (1 file, 1 attempt, 1 run)", () => {
    // A first draft at default rule levels: nothing was rolled back.
    const firstDraft = `// ast-rules: ${encodeLevels(defaultLevels())}\nlet h = 0;\nfor (let i = 0; i < text.length; i++) {\n  h = Math.trunc(h * 31 + text.charCodeAt(i)) || 0;\n}\nh;`;
    const md = buildGitHubPrSummary(input({ modernCode: firstDraft, attempts: 1, fuzz: { totalRuns: 1, exact: true }, typecheck: { errorCount: 1, filesChecked: 1, tsVersion: "7.0.2" } }));
    expect(md).toContain("`tsc --strict: 1 error (1 file, TypeScript 7.0.2)`");
    expect(md).toContain("across 1 differential fuzz run,");
    expect(md).toContain("- **Self-healing:** first draft held.");
    expect(md).not.toMatch(/\(s\)|1 files|1 errors|1 runs/);
  });

  it("includes the mutation kill score only when an audit ran", () => {
    expect(buildGitHubPrSummary(input())).not.toContain("Mutation audit");
    expect(buildGitHubPrSummary(input({ mutation: { killed: 5, total: 5 } }))).toContain("- **Mutation audit:** 5/5 mutants killed (100% proof strength).");
    // An impossible score is dropped (the certificate's validation applies).
    expect(buildGitHubPrSummary(input({ mutation: { killed: 9, total: 4 } }))).not.toContain("Mutation audit");
  });

  it("says when tsc was not checked", () => {
    const { typecheck: _omit, ...rest } = input();
    expect(buildGitHubPrSummary(rest as PrSummaryInput)).toContain("- **TypeScript:** not checked.");
  });

  it("shows a compact unified diff without Lazarus' own header comments", () => {
    const md = buildGitHubPrSummary(input());
    const diff = md.slice(md.indexOf("```diff\n") + 8, md.indexOf("\n```", md.indexOf("```diff")));
    expect(diff.split("\n")).toEqual([
      "-var h = 0; for (var i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; } h;",
      "+let h = 0;",
      "+for (let i = 0; i < text.length; i++) {",
      "+  h = h * 31 + text.charCodeAt(i) | 0;",
      "+}",
      "+h;",
    ]);
    expect(md).toContain("### Diff (legacy -> resurrected, 1 line removed, 5 lines added)");
    expect(md).not.toContain("ast-rules:");
  });

  it("caps long diffs and points at the patch", () => {
    const legacy = Array.from({ length: 80 }, (_, i) => `var a${i} = ${i};`).join("\n");
    const modern = Array.from({ length: 80 }, (_, i) => `const a${i} = ${i};`).join("\n");
    const md = buildGitHubPrSummary(input({ legacySource: legacy, modernCode: modern, maxDiffLines: 10 }));
    expect(md).toContain("@@ 150 more lines: see resurrection.patch");
  });
});

describe("compactDiff and stripGeneratedHeader", () => {
  it("keeps one line of context and marks skipped stretches", () => {
    const a = ["1", "2", "3", "4", "5", "6", "7"].join("\n");
    const b = ["1", "2", "X", "4", "5", "6", "Y"].join("\n");
    expect(compactDiff(a, b).text.split("\n")).toEqual([" 2", "-3", "+X", " 4", "@@", " 6", "-7", "+Y"]);
  });

  it("strips only leading Lazarus header comments", () => {
    expect(stripGeneratedHeader("// Resurrected by Lazarus Necromancer (attempt 1)\n// ast-rules: x\n// a real comment\nlet x = 1;")).toBe("// a real comment\nlet x = 1;");
    expect(stripGeneratedHeader("let x = 1; // ast-rules: inline stays")).toBe("let x = 1; // ast-rules: inline stays");
  });

  it("never invents lines: every diff line comes from one of the two texts (property)", () => {
    const line: fc.Arbitrary<string> = fc.constantFrom("a", "b", "c", "let x = 1;", "");
    fc.assert(
      fc.property(fc.array(line, { maxLength: 12 }), fc.array(line, { maxLength: 12 }), (a, b) => {
        const { text } = compactDiff(a.join("\n"), b.join("\n"), 1, 1000);
        for (const l of text === "" ? [] : text.split("\n")) {
          if (l === "@@") continue;
          const body = l.slice(1);
          if (l.startsWith("-")) expect(a).toContain(body);
          else if (l.startsWith("+")) expect(b).toContain(body);
          else expect(a.includes(body) && b.includes(body)).toBe(true);
        }
      }),
      { numRuns: 200 }
    );
  });
});
