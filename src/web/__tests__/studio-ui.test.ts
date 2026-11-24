import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";
import { parse } from "acorn";
import * as fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_LCS_CELLS, diffLines, diffStats, splitLines, type DiffLine } from "../line-diff.js";
import { createWebServer } from "../server.js";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("GET / serves Lazarus Studio", () => {
  const server = createWebServer();
  let baseUrl = "";
  let html = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    html = await res.text();
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  const scripts = (): string[] => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
  /** Markup of one tab pane (from its opening tag to the next pane, or the first script). */
  const pane = (id: string): string => {
    const start = html.indexOf(`<div class="studio-pane" id="${id}"`);
    expect(start).toBeGreaterThan(0);
    const nextPane = html.indexOf('<div class="studio-pane"', start + 1);
    const end = nextPane > 0 ? nextPane : html.indexOf("<script>", start);
    return html.slice(start, end);
  };

  it("parses as a document, and every inline script parses cleanly with acorn", () => {
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html.match(/<body>/g)).toHaveLength(1);
    expect(html.match(/<\/body>/g)).toHaveLength(1);
    const all = scripts();
    expect(all.length).toBeGreaterThanOrEqual(8);
    for (const [i, code] of all.entries()) {
      expect(() => parse(code, { ecmaVersion: "latest", sourceType: "script" }), `inline script #${i}`).not.toThrow();
    }
  });

  it("has unique element ids", () => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });

  it("has a header with brand, honest proof badges and the tour controls", () => {
    expect(html).toContain("<h1>LAZARUS STUDIO</h1>");
    const specs = fs.readdirSync(nodePath.join(root, ".kiro", "specs"), { withFileTypes: true }).filter((d) => d.isDirectory()).length;
    expect(html).toContain(`<span class="proof-badge" id="badgeSpecs">${specs} Kiro Specs</span>`);
    expect(html).toMatch(/<span class="proof-badge" id="badgeTests">\d+ Verified Tests<\/span>/);
    expect(html).toContain(">Exact Object.is<");
    expect(html).toContain(">tsc --strict<");
    expect(html).toContain('id="tourBtn">&#9654; Run 20s Guided Judge Tour</button>');
    expect(html).toContain('id="tourCancel" hidden>Cancel Tour</button>');
    expect(html).toContain('id="tourHud" role="status" aria-live="polite" hidden');
  });

  it("has three accessible tabs linked to their panels, the first selected", () => {
    const tabs = [...html.matchAll(/<button type="button" role="tab" class="studio-tab" id="(tab-\w+)" data-studio-tab="(\w+)" aria-controls="(pane-\w+)" aria-selected="(true|false)"/g)];
    expect(tabs.map((m) => [m[1], m[2], m[3], m[4]])).toEqual([
      ["tab-single", "single", "pane-single", "true"],
      ["tab-graph", "graph", "pane-graph", "false"],
      ["tab-redteam", "redteam", "pane-redteam", "false"],
    ]);
    expect(html).toContain("1 &middot; Single File &amp; npm Graveyard");
    expect(html).toContain("2 &middot; Multi-File Project (Stitch Graph)");
    expect(html).toContain("3 &middot; Sandbox Red-Team Lab");
    expect(html).toContain('role="tablist"');
    expect(html).toContain('<div class="studio-pane" id="pane-single" role="tabpanel" aria-labelledby="tab-single">');
    expect(html).toContain('<div class="studio-pane" id="pane-graph" role="tabpanel" aria-labelledby="tab-graph" hidden>');
    expect(html).toContain('<div class="studio-pane" id="pane-redteam" role="tabpanel" aria-labelledby="tab-redteam" hidden>');
  });

  it("puts each workspace's tools in its own tab", () => {
    const single = pane("pane-single");
    for (const id of ["presetSelect", "runBtn", "exportBtn", "legacyCode", "githubUrl", "npmGraveyard", "card-exorcist", "logList", "sigPill", "modernOut", "tscBadge", "legacyDiffToggle", "healingMatrix", "matrixDiff", "certCard", "mutCard", "probeCard", "bundlePanel", "downloadZipBtn"]) {
      expect(single, id).toContain(`id="${id}"`);
    }
    expect(single).toContain("LAZARUS // OPERATING TABLE");
    const graph = pane("pane-graph");
    for (const id of ["graphPanel", "graphPreset", "graphTabs", "graphEditor", "graphSvg", "graphVerdict", "graphEsmOut", "graphZipBtn"]) expect(graph, id).toContain(`id="${id}"`);
    const lab = pane("pane-redteam");
    for (const id of ["redteamCard", "rtButtons", "rtLog"]) expect(lab, id).toContain(`id="${id}"`);
    for (const attack of ["infinite-loop", "process-exit", "heap-bomb", "prototype-escape"]) expect(lab).toContain(`data-attack="${attack}"`);
    expect(lab).toContain("1 + 1 === 2");
    expect(lab).toContain("Sandbox isolation spec");
    for (const fact of ["256 MB", "3000 ms", "/tmp/lazarus-sandbox", "JSON-RPC 2.0"]) expect(lab).toContain(fact);
    // Nothing from one workspace leaks into another.
    expect(single).not.toContain('id="graphSvg"');
    expect(single).not.toContain('id="rtButtons"');
    expect(graph).not.toContain('id="probeCard"');
  });

  it("ships the diff renderer and wires it into the Self-Healing Matrix and the Legacy vs. Resurrected view", () => {
    expect(html).toContain("/* lz-diff:start */");
    expect(html).toContain("/* lz-diff:end */");
    expect(html).toContain("Self-Healing Diff &middot; rejected draft (&minus;) vs verified code (+)");
    expect(html).toContain('window.LazarusDiff.render($("matrixDiff"), String(draft).trim(), String(r.modernCode || "").trim(), $("matrixDiffStats"));');
    expect(html).toContain("Legacy vs. Resurrected Diff");
    expect(html).toContain('id="legacyDiffBlock" hidden');
    for (const cls of [".d-del", ".d-add", ".d-same", ".d-no"]) expect(html).toContain(cls);
  });

  it("drives the tour through the page's own live result events, never canned data", () => {
    for (const event of ["lazarus:result", "lazarus:run-end", "lazarus:mutation", "lazarus:mutation-end", "lazarus:probe", "lazarus:probe-end"]) {
      expect(html).toContain(`new CustomEvent("${event}"`);
    }
    const studio = scripts().find((s) => s.includes("Guided Judge Tour")) ?? "";
    expect(studio).toContain('preset.value = "es5-string-hash"');
    expect(studio).toContain('$("runBtn").click()');
    expect(studio).toContain('$("mutBtn").click()');
    expect(studio).toContain('c.dataset.value === "NaN"');
    expect(studio).toContain("Open Tab 2");
    expect(studio).toContain("Open Tab 3");
    // The tour itself never calls fetch: every request comes from the existing, tested controls.
    expect(studio).not.toContain("fetch(");
  });

  it("keeps the routes the tour relies on", async () => {
    const audit = await fetch(`${baseUrl}/api/mutation-audit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(audit.status).toBe(400);
    const probe = await fetch(`${baseUrl}/api/probe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(probe.status).toBe(400);
  });

  describe("the shipped inline diff is the tested one", () => {
    const shipped = (): ((a: string, b: string) => DiffLine[]) => {
      const start = html.indexOf("/* lz-diff:start */");
      const end = html.indexOf("/* lz-diff:end */");
      const code = html.slice(start, end);
      const fn: unknown = new vm.Script(`(function () { ${code}; return lzDiffLines; })()`).runInNewContext({ Uint32Array, Math });
      if (typeof fn !== "function") throw new Error("lzDiffLines not found");
      return (a, b) => JSON.parse(JSON.stringify((fn as (x: string, y: string) => unknown)(a, b))) as DiffLine[];
    };

    it("agrees with src/web/line-diff.ts on random line edits (property)", () => {
      const inline = shipped();
      const line = fc.constantFrom("a", "b", "c", "return x;", "", "  }", "let h = 0;", "h = h | 0;");
      fc.assert(
        fc.property(fc.array(line, { maxLength: 14 }), fc.array(line, { maxLength: 14 }), fc.boolean(), (a, b, crlf) => {
          const sep = crlf ? "\r\n" : "\n";
          const oldText = a.join(sep);
          const newText = b.join(sep);
          expect(inline(oldText, newText)).toEqual(JSON.parse(JSON.stringify(diffLines(oldText, newText))));
        }),
        { numRuns: 300 }
      );
    });
  });
});

describe("diffLines (LCS line diff)", () => {
  const show = (lines: readonly DiffLine[]): string[] => lines.map((l) => `${l.kind === "del" ? "-" : l.kind === "add" ? "+" : " "}${l.text}`);

  it("single-line edit: the classic self-healing fix", () => {
    const lines = diffLines("return Math.floor(n / 2);", "return Math.trunc(n / 2) || 0;");
    expect(lines).toEqual([
      { kind: "del", text: "return Math.floor(n / 2);", oldLine: 1 },
      { kind: "add", text: "return Math.trunc(n / 2) || 0;", newLine: 1 },
    ]);
  });

  it("multi-line edit keeps unchanged context with both line numbers", () => {
    const draft = "// attempt 1\nlet h = 0;\nfor (let i = 0; i < text.length; i++) {\n  h = Math.trunc(h * 31 + text.charCodeAt(i)) || 0;\n}\nh;";
    const final = "// attempt 2\n// ast-refine: rolled back bitor0-trunc\nlet h = 0;\nfor (let i = 0; i < text.length; i++) {\n  h = h * 31 + text.charCodeAt(i) | 0;\n}\nh;";
    const lines = diffLines(draft, final);
    expect(show(lines)).toEqual([
      "-// attempt 1",
      "+// attempt 2",
      "+// ast-refine: rolled back bitor0-trunc",
      " let h = 0;",
      " for (let i = 0; i < text.length; i++) {",
      "-  h = Math.trunc(h * 31 + text.charCodeAt(i)) || 0;",
      "+  h = h * 31 + text.charCodeAt(i) | 0;",
      " }",
      " h;",
    ]);
    expect(lines[3]).toEqual({ kind: "same", text: "let h = 0;", oldLine: 2, newLine: 3 });
    expect(lines.at(-1)).toEqual({ kind: "same", text: "h;", oldLine: 6, newLine: 7 });
    expect(diffStats(lines)).toEqual({ added: 3, removed: 2, unchanged: 4 });
  });

  it.each([
    ["identical", "a\nb", "a\nb", [" a", " b"]],
    ["both empty", "", "", []],
    ["pure addition", "", "x\ny", ["+x", "+y"]],
    ["pure deletion", "x\ny", "", ["-x", "-y"]],
    ["insert in the middle", "a\nc", "a\nb\nc", [" a", "+b", " c"]],
    ["delete in the middle", "a\nb\nc", "a\nc", [" a", "-b", " c"]],
    ["trailing newline adds no line", "a\n", "a", [" a"]],
    ["CRLF equals LF", "a\r\nb\r\n", "a\nb", [" a", " b"]],
    ["blank lines are lines", "a\n\nb", "a\nb", [" a", "-", " b"]],
  ])("%s", (_label, a, b, expected) => {
    expect(show(diffLines(a, b))).toEqual(expected);
  });

  /** Reference LCS length, to check minimality. */
  const lcsLength = (a: string[], b: string[]): number => {
    const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    return dp[0]![0]!;
  };

  it("reconstructs both texts, numbers lines in order, and is minimal (property)", () => {
    const line = fc.constantFrom("a", "b", "c", "d", "");
    fc.assert(
      fc.property(fc.array(line, { maxLength: 16 }), fc.array(line, { maxLength: 16 }), (a, b) => {
        const lines = diffLines(a.join("\n"), b.join("\n"));
        const oldSide = lines.filter((l) => l.kind !== "add");
        const newSide = lines.filter((l) => l.kind !== "del");
        expect(oldSide.map((l) => l.text)).toEqual(splitLines(a.join("\n")));
        expect(newSide.map((l) => l.text)).toEqual(splitLines(b.join("\n")));
        expect(oldSide.map((l) => l.oldLine)).toEqual(oldSide.map((_, i) => i + 1));
        expect(newSide.map((l) => l.newLine)).toEqual(newSide.map((_, i) => i + 1));
        expect(lines.filter((l) => l.kind === "same").length).toBe(lcsLength(splitLines(a.join("\n")), splitLines(b.join("\n"))));
        // Inside each change run, every deletion comes before every addition.
        for (let i = 1; i < lines.length; i++) expect(lines[i - 1]?.kind === "add" && lines[i]?.kind === "del").toBe(false);
      }),
      { numRuns: 300 }
    );
  });

  it("falls back to a correct (non-minimal) diff for very large changes", () => {
    const size = Math.ceil(Math.sqrt(MAX_LCS_CELLS)) + 5;
    const a = Array.from({ length: size }, (_, i) => `old ${i}`);
    const b = Array.from({ length: size }, (_, i) => `new ${i}`);
    const lines = diffLines(["head", ...a, "tail"].join("\n"), ["head", ...b, "tail"].join("\n"));
    expect(lines[0]).toEqual({ kind: "same", text: "head", oldLine: 1, newLine: 1 });
    expect(lines.at(-1)).toEqual({ kind: "same", text: "tail", oldLine: size + 2, newLine: size + 2 });
    expect(diffStats(lines)).toEqual({ added: size, removed: size, unchanged: 2 });
  });
});
