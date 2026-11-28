import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";
import { parse } from "acorn";
import * as fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_LCS_CELLS, diffLines, diffStats, splitLines, type DiffLine } from "../line-diff.js";
import { analyzeGraph } from "../../crew/graph-resurrector.js";
import { FakeDocument, runInlineScript, type FakeElement } from "./fake-dom.js";
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
    // Own, abortable requests: never a click on a possibly disabled button, never a stale result.
    expect(studio).toContain("const result = await guard(window.LazarusRun.start(), 30000, \"the resurrection\");");
    expect(studio).toContain('if (result.name !== "stringHash32")');
    expect(studio).toContain("await guard(window.LazarusMutation.run(), 20000");
    expect(studio).toContain('await guard(window.LazarusProbe.run("NaN"), 15000');
    expect(studio).not.toContain("waitFor(");
    // Cancel aborts the tour's in-flight requests.
    expect(studio).toContain('window.LazarusRun.abort("cancelled with the tour")');
    expect(studio).toContain("window.LazarusMutation.abort();");
    expect(studio).toContain("window.LazarusProbe.abort();");
    expect(studio).toContain("Open Tab 2");
    expect(studio).toContain("Open Tab 3");
    // The tour itself never calls fetch: every request comes from the existing, tested controls.
    expect(studio).not.toContain("fetch(");
  });

  it("has a full-width Verification Deck under the three-column table, in the pinned order", () => {
    const single = pane("pane-single");
    const deckAt = single.indexOf('<section class="verify-deck" id="verifyDeck"');
    expect(deckAt).toBeGreaterThan(single.indexOf("</main>"));
    const deck = single.slice(deckAt);
    const at = (id: string): number => deck.indexOf(`id="${id}"`);
    // Full width: the matrix (Attempt 1 vs. verified code + LCS diff) and the legacy diff.
    expect(at("healingMatrix")).toBeLessThan(deck.indexOf('<div class="deck-grid">'));
    expect(at("legacyDiffBlock")).toBeLessThan(deck.indexOf('<div class="deck-grid">'));
    // Two columns: certificate + audit, then bundle + probe.
    const order = ["healingMatrix", "matrixDiff", "legacyDiffBlock", "certCard", "mutCard", "bundlePanel", "copyPrSummaryBtn", "probeCard"].map(at);
    expect(order.every((v) => v > 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    // The three-column row keeps input, spec/code output and telemetry only.
    const main = single.slice(single.indexOf("<main>"), single.indexOf("</main>"));
    for (const id of ["legacyCode", "specOut", "sigPill", "modernOut", "tscBadge", "legacyDiffToggle", "logList"]) expect(main, id).toContain(`id="${id}"`);
    for (const id of ["healingMatrix", "certCard", "mutCard", "bundlePanel", "probeCard"]) expect(main, id).not.toContain(`id="${id}"`);
  });

  it("has the Crew Log | MCP Wire Trace toggle in the telemetry card, Crew Log by default", () => {
    const main = pane("pane-single");
    expect(main).toContain('id="teleCrewBtn" aria-pressed="true" aria-controls="logList">Crew Log</button>');
    expect(main).toContain('id="teleTraceBtn" aria-pressed="false" aria-controls="traceList">MCP Wire Trace');
    expect(main).toContain('<div class="trace-list" id="traceList" hidden');
    expect(main.indexOf('id="traceList"')).toBeGreaterThan(main.indexOf('id="logList"'));
    // Trace events go to the trace view only.
    // Inside the frame callback of the run handler (`return` skips the crew-card and log handling).
    expect(html).toContain('if (ev.type === "mcp_trace") { if (window.LazarusTrace) window.LazarusTrace.add(ev); return; }');
  });

  it("has the Copy GitHub PR Summary button in the PR Bundle bar, fed by the server export", () => {
    const bar = html.slice(html.indexOf('<div id="bundlePanel"'), html.indexOf('<pre id="bundleOut"'));
    expect(bar).toContain('id="copyPrSummaryBtn"');
    expect(bar).toContain(">Copy GitHub PR Summary</button>");
    expect(html).toContain("window.LazarusBundle = { build: buildBundleFromCurrentUI };");
    expect(html).toContain('typeof bundle.prSummary !== "string"');
  });

  it("uses correct singular/plural forms in tsc labels", () => {
    expect(html).not.toMatch(/file\(s\)|" typed \.ts files"/);
    expect(html).toContain('" typed .ts file" + (tc.filesChecked === 1 ? "" : "s")');
    expect(html).toContain('" file" + (tc.filesChecked === 1 ? "" : "s") + " checked with TypeScript "');
  });

  it("adds Kiro DNA and Audio to the header without a new tab, the drawer closed by default", () => {
    const header = html.slice(html.indexOf('<header class="studio-header">'), html.indexOf("</header>"));
    expect(header).toContain('id="dnaBtn" aria-haspopup="dialog" aria-controls="dnaDrawer" aria-expanded="false">Kiro DNA</button>');
    expect(header).toContain('id="audioBtn" aria-pressed="false"');
    expect(header).toContain(">Audio: OFF</button>");
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain('<aside class="dna-drawer" id="dnaDrawer" role="dialog" aria-modal="true" aria-labelledby="dnaTitle" hidden>');
    expect(html).toContain('<div class="dna-scrim" id="dnaScrim" hidden></div>');
    for (const organ of ["acorn", "sandbox", "fuzzer", "tsc"]) expect(html).toContain(`data-organ="${organ}"`);
    for (const label of ["Acorn AST Parser", "Node VM Sandbox", "fast-check Fuzzer", "tsc --strict"]) expect(html).toContain(label);
    // The drawer is fixed-position, so it adds no height to the page.
    expect(html).toMatch(/\.dna-drawer \{ position: fixed;/);
    expect(html).toContain('fetch("/api/kiro-dna")');
  });

  it("shows the smart-paste pill under the editor and fills the schema only when not hand-edited", () => {
    const single = pane("pane-single");
    expect(single.indexOf('id="pastePill"')).toBeGreaterThan(single.indexOf('<textarea id="legacyCode">'));
    expect(single.indexOf('id="pastePill"')).toBeLessThan(single.indexOf('id="schemaJson"'));
    expect(html).toContain('fetch("/api/scan"');
    expect(html).toContain(': "Auto-detected: ";');
    expect(html).toContain("const filled = !schemaTouched && Object.keys(r.schema).length > 0;");
  });

  it("downloads the server-built SVG certificate and keeps audio muted until the user turns it on", () => {
    expect(html).toContain('svgBtn.textContent = "DOWNLOAD CERTIFICATE (.SVG)"');
    expect(html).toContain('typeof bundle.certificateSvg !== "string"');
    const audio = scripts().find((s) => s.includes("Lab audio")) ?? "";
    expect(audio).toContain("let ctx = null, on = false;");
    // The AudioContext is created only inside the toggle's click handler.
    expect(audio.match(/new AC\(\)/g)).toHaveLength(1);
    expect(audio.indexOf("new AC()")).toBeGreaterThan(audio.indexOf('audioBtn.addEventListener("click"'));
    expect(audio).toContain("if (!on || !ctx) return;");
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

// ---------------------------------------------------------------------------------------------
// Production bugfix regressions. The page's own shipped scripts run in node:vm (no DOM library).
// ---------------------------------------------------------------------------------------------
const pageHtml = fs.readFileSync(nodePath.join(root, "public", "index.html"), "utf8");
const inlineScripts = [...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");

describe("Tab 3 Red-Team Lab buttons (shipped script, minimal DOM, scripted fetch)", () => {
  const source = inlineScripts.find((s) => s.includes("Red-Team the Sandbox: one-click containment proofs")) ?? "";
  const ATTACKS = [...pageHtml.matchAll(/<button type="button" class="rt-btn" data-attack="([\w-]+)">([^<]+)<\/button>/g)].map((m) => ({ attack: m[1] ?? "", label: m[2] ?? "" }));

  interface Harness {
    doc: FakeDocument;
    buttons: FakeElement[];
    log: FakeElement;
    calls: Array<{ url: string; init: RequestInit | undefined }>;
    timeouts: Array<{ ms: number; fn: () => void }>;
    settle: () => Promise<void>;
  }
  function setup(respond: (url: string, init: RequestInit | undefined) => Promise<Response>): Harness {
    const doc = new FakeDocument();
    const container = doc.element("div", "rtButtons");
    const buttons = ATTACKS.map(({ attack, label }) => {
      const b = doc.createElement("button");
      b.className = "rt-btn";
      b.dataset["attack"] = attack;
      b.textContent = label;
      container.append(b);
      return b;
    });
    doc.selectors.set("#rtButtons .rt-btn", buttons);
    const log = doc.element("div", "rtLog");
    const calls: Harness["calls"] = [];
    const timeouts: Harness["timeouts"] = [];
    runInlineScript(source, {
      document: doc,
      fetch: (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return respond(url, init);
      },
      setTimeout: (fn: () => void, ms: number) => { timeouts.push({ ms, fn }); return timeouts.length; },
      clearTimeout: () => undefined,
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    };
    return { doc, buttons, log, calls, timeouts, settle };
  }
  const byAttack = (h: Harness, attack: string): FakeElement => {
    const b = h.buttons.find((x) => x.dataset["attack"] === attack);
    if (b === undefined) throw new Error(`no button for ${attack}`);
    return b;
  };
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const RESULT = {
    attack: "process-exit",
    label: "process.exit(1)",
    description: "tries to terminate the host process",
    contained: true,
    recovered: true,
    respawned: false,
    canaryResult: 2,
    elapsedMs: 6,
    outcome: { ok: false, errorCode: "EXECUTION_ERROR", message: "process.exit is not a function" },
  };

  it("finds exactly the four attack buttons the page ships", () => {
    expect(ATTACKS.map((a) => a.attack)).toEqual(["infinite-loop", "process-exit", "heap-bomb", "prototype-escape"]);
    expect(ATTACKS.map((a) => a.label)).toEqual(["Infinite Loop", "process.exit(1)", "256MB Heap Bomb", "Hostile Escape"]);
  });

  it("posts the attack to /api/redteam and shows RUNNING ATTACK... immediately, with the buttons disabled", async () => {
    let release: (r: Response) => void = () => undefined;
    const h = setup(() => new Promise<Response>((resolve) => { release = resolve; }));
    byAttack(h, "heap-bomb").click();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toBe("/api/redteam");
    expect(h.calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(h.calls[0]?.init?.body))).toEqual({ attack: "heap-bomb" });
    const first = h.log.children[0];
    expect(first?.textContent).toContain("RUNNING ATTACK...");
    expect(first?.textContent).toContain("256MB Heap Bomb");
    expect(h.buttons.every((b) => b.disabled)).toBe(true);
    // A second click while running does not start another attack.
    byAttack(h, "infinite-loop").click();
    expect(h.calls).toHaveLength(1);
    release(json({ ...RESULT, attack: "heap-bomb", label: "256MB Heap Bomb", respawned: true, outcome: { ok: false, errorCode: "MEMORY_EXCEEDED", message: "heap" } }));
    await h.settle();
    expect(h.log.children).toHaveLength(1);
    expect(h.log.children[0]?.textContent).not.toContain("RUNNING ATTACK...");
    expect(h.buttons.every((b) => !b.disabled)).toBe(true);
  });

  it.each([
    [false, "NO RESPAWN NEEDED"],
    [true, "WORKER RESPAWNED & HEALTHY"],
  ])("renders the containment result into the timeline (respawned: %s)", async (respawned, recovery) => {
    const h = setup(() => Promise.resolve(json({ ...RESULT, respawned })));
    byAttack(h, "process-exit").click();
    await h.settle();
    const row = h.log.children[0];
    expect(row?.className).toBe("rt-row");
    const text = row?.textContent ?? "";
    for (const part of ["process.exit(1)", "CONTAINED", "EXECUTION_ERROR", "6 ms", "canary 1 + 1 = 2", recovery]) expect(text).toContain(part);
  });

  it.each([
    ["a 429 from the guard", () => Promise.resolve(json({ error: "Another red-team attack is still running", code: "BUSY" }, 429)), ["ATTACK NOT RUN", "HTTP 429", "Another red-team attack is still running", "another attack is still running"]],
    ["a non-JSON 502 proxy page", () => Promise.resolve(new Response("<html><h1>502 Bad Gateway</h1></html>", { status: 502, statusText: "Bad Gateway" })), ["HTTP 502 Bad Gateway", "non-JSON response", "502 Bad Gateway</h1>"]],
    ["a malformed 200 body", () => Promise.resolve(json({ hello: "world" })), ["Unexpected response from /api/redteam", "hello"]],
    ["an empty 200 body", () => Promise.resolve(new Response("", { status: 200 })), ["Unexpected response from /api/redteam: empty body"]],
    ["a network error", () => Promise.reject(new TypeError("Failed to fetch")), ["Network error: Failed to fetch"]],
  ])("surfaces %s visibly and re-enables the buttons", async (_label, respond, parts) => {
    const h = setup(respond);
    byAttack(h, "prototype-escape").click();
    await h.settle();
    expect(h.log.children).toHaveLength(1);
    const row = h.log.children[0];
    expect(row?.className).toBe("rt-row bad");
    for (const part of parts) expect(row?.textContent).toContain(part);
    expect(h.buttons.every((b) => !b.disabled)).toBe(true);
  });

  it("times out a hung request after 60 s, aborts it and says so", async () => {
    const h = setup((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    byAttack(h, "infinite-loop").click();
    const deadline = h.timeouts.find((x) => x.ms === 60000);
    expect(deadline).toBeDefined();
    deadline?.fn();
    await h.settle();
    expect(h.log.children[0]?.textContent).toContain("No answer within 60 s (request timed out and was aborted)");
    expect(h.buttons.every((b) => !b.disabled)).toBe(true);
  });
});

describe("resurrection run control (shipped lz-run core): a new run aborts the old stream", () => {
  /** The shipped core, looked up per test so a missing marker fails each test instead of the whole file. */
  const core = (): string => {
    const start = pageHtml.indexOf("/* lz-run:start */");
    const end = pageHtml.indexOf("/* lz-run:end */");
    expect(start, "lz-run markers in public/index.html").toBeGreaterThan(0);
    return pageHtml.slice(start, end);
  };
  interface RunControl {
    begin(): { token: number; signal: AbortSignal };
    isCurrent(token: number): boolean;
    abort(): void;
    token(): number;
  }
  type ReadSse = (response: Response, onData: (data: unknown) => void, isCurrent: () => boolean) => Promise<boolean>;
  const load = (): { make: () => RunControl; read: ReadSse } => {
    const exported = runInlineScript(`${core()}; ({ make: lzMakeRunControl, read: lzReadSse })`, {}) as { make: () => RunControl; read: ReadSse };
    return exported;
  };
  /** A streamed SSE response whose chunks the test pushes one by one. */
  function stream(): { response: Response; push: (text: string) => void; end: () => void } {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const enc = new TextEncoder();
    return { response: new Response(body), push: (text) => controller?.enqueue(enc.encode(text)), end: () => controller?.close() };
  }
  const frame = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`;
  const tick = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

  it("begin() aborts the previous run's signal and makes its token stale", () => {
    const rc = load().make();
    const first = rc.begin();
    expect(rc.isCurrent(first.token)).toBe(true);
    const second = rc.begin();
    expect(first.signal.aborted).toBe(true);
    expect(rc.isCurrent(first.token)).toBe(false);
    expect(rc.isCurrent(second.token)).toBe(true);
    expect(second.token).toBeGreaterThan(first.token);
    rc.abort();
    expect(second.signal.aborted).toBe(true);
    expect(rc.isCurrent(second.token)).toBe(false);
  });

  it("delivers every frame of the current run, across chunk boundaries", async () => {
    const { make, read } = load();
    const rc = make();
    const run = rc.begin();
    const s = stream();
    const got: unknown[] = [];
    const done = read(s.response, (d) => got.push(d), () => rc.isCurrent(run.token));
    const text = frame({ kind: "event", n: 1 }) + frame({ kind: "result", n: 2 });
    s.push(text.slice(0, 17));
    s.push(text.slice(17));
    s.end();
    expect(await done).toBe(true);
    expect(got).toEqual([{ kind: "event", n: 1 }, { kind: "result", n: 2 }]);
  });

  it("drops every frame of a superseded run (an earlier cjsMathUtils run cannot answer for the tour)", async () => {
    const { make, read } = load();
    const rc = make();
    const old = rc.begin();
    const oldStream = stream();
    const oldFrames: unknown[] = [];
    const oldDone = read(oldStream.response, (d) => oldFrames.push(d), () => rc.isCurrent(old.token));
    oldStream.push(frame({ kind: "event", name: "cjsMathUtils", step: 1 }));
    await tick();
    expect(oldFrames).toHaveLength(1);
    // The tour starts its own run.
    const tour = rc.begin();
    const tourStream = stream();
    const tourFrames: unknown[] = [];
    const tourDone = read(tourStream.response, (d) => tourFrames.push(d), () => rc.isCurrent(tour.token));
    oldStream.push(frame({ kind: "result", result: { name: "cjsMathUtils" } }));
    oldStream.end();
    tourStream.push(frame({ kind: "result", result: { name: "stringHash32" } }));
    tourStream.end();
    expect(await oldDone).toBe(false);
    expect(await tourDone).toBe(true);
    expect(oldFrames).toEqual([{ kind: "event", name: "cjsMathUtils", step: 1 }]);
    expect(tourFrames).toEqual([{ kind: "result", result: { name: "stringHash32" } }]);
    expect(old.signal.aborted).toBe(true);
  });

  it("treats a read rejected by the abort as a quiet stop, but rethrows real errors of the current run", async () => {
    const { make, read } = load();
    const rc = make();
    const run = rc.begin();
    const failing = new Response(new ReadableStream<Uint8Array>({ pull: () => Promise.reject(new DOMException("aborted", "AbortError")) }));
    const pending = read(failing, () => undefined, () => rc.isCurrent(run.token));
    rc.begin();
    expect(await pending).toBe(false);
    const current = rc.begin();
    const broken = new Response(new ReadableStream<Uint8Array>({ pull: () => Promise.reject(new Error("socket hang up")) }));
    await expect(read(broken, () => undefined, () => rc.isCurrent(current.token))).rejects.toThrow("socket hang up");
  });

  it("the page's run handler is built on it: one controller, token checks, no stale run-end", () => {
    expect(pageHtml).toContain("const runControl = lzMakeRunControl();");
    expect(pageHtml).toContain("const run = runControl.begin();");
    expect(pageHtml).toContain("signal: run.signal");
    expect(pageHtml).toContain("}, mine);");
    expect(pageHtml).toMatch(/finally \{\r?\n\s+if \(mine\(\)\) \{\r?\n\s+runBtn\.disabled = false;\r?\n\s+document\.dispatchEvent\(new CustomEvent\("lazarus:run-end"\)\);/);
    expect(pageHtml).toContain('parityBadge.textContent = "RUN FAILED";');
    expect(pageHtml).toContain('if (runBtn.disabled) this.abort("superseded by a new run");');
  });
});

describe("stale exports (shipped lz-stale script, minimal DOM): exports belong to the exact proven source", () => {
  const EXPORT_IDS = ["exportBtn", "downloadZipBtn", "copyPrSummaryBtn", "copyBundleBtn", "downloadFileBtn", "downloadBundleBtn", "certSvgBtn"];
  const PROOF_IDS = ["modernOut", "specOut", "parityBadge", "verifyDeck", "certCard", "bundlePanel"];
  const HINT = "Code changed — click Resurrect Specimen to refresh proof";
  const script = (): string => {
    const start = pageHtml.indexOf("/* lz-stale:start */");
    const end = pageHtml.indexOf("/* lz-stale:end */");
    expect(start, "lz-stale markers in public/index.html").toBeGreaterThan(0);
    return pageHtml.slice(start, end);
  };
  interface StaleApi {
    check(): boolean;
    isStale(): boolean;
    hint: string;
  }
  function setup(): {
    doc: FakeDocument;
    api: StaleApi;
    editor: FakeElement;
    preset: FakeElement;
    hint: FakeElement;
    button: (id: string) => FakeElement;
    run: (source: string, success: boolean) => void;
    type: (text: string) => void;
  } {
    const doc = new FakeDocument();
    const editor = doc.element("textarea", "legacyCode");
    const preset = doc.element("select", "presetSelect");
    const hint = doc.element("span", "staleHint");
    hint.hidden = true;
    for (const id of EXPORT_IDS) doc.element("button", id);
    for (const id of PROOF_IDS) doc.element("div", id);
    const win: { LazarusStale?: StaleApi } = {};
    runInlineScript(script(), { document: doc, window: win });
    if (win.LazarusStale === undefined) throw new Error("window.LazarusStale was not installed");
    const button = (id: string): FakeElement => {
      const el = doc.getElementById(id);
      if (el === null) throw new Error(id);
      return el;
    };
    return {
      doc,
      api: win.LazarusStale,
      editor,
      preset,
      hint,
      button,
      run: (source, success) => {
        doc.dispatchEvent({ type: "lazarus:run-start", detail: { source } });
        doc.dispatchEvent({ type: "lazarus:result", detail: { success } });
      },
      type: (text) => {
        editor.value = text;
        editor.dispatch("input");
      },
    };
  }
  const exportsDisabled = (t: ReturnType<typeof setup>): boolean[] => EXPORT_IDS.map((id) => t.button(id).disabled);
  const allOf = (v: boolean): boolean[] => EXPORT_IDS.map(() => v);

  it("changes nothing before the first successful resurrection", () => {
    const t = setup();
    t.type("function f(a) { return a; }");
    expect(t.api.isStale()).toBe(false);
    expect(exportsDisabled(t)).toEqual(allOf(false));
    expect(t.hint.hidden).toBe(true);
  });

  it("disables every export, dims the proof and shows the hint when the editor is edited", () => {
    const t = setup();
    t.editor.value = "function f(a) { return a; }";
    t.run(t.editor.value, true);
    expect(exportsDisabled(t)).toEqual(allOf(false));
    t.type("function f(a) { return a + 1; }");
    expect(t.api.isStale()).toBe(true);
    expect(exportsDisabled(t)).toEqual(allOf(true));
    expect(t.hint.hidden).toBe(false);
    expect(t.api.hint).toBe(HINT);
    for (const id of EXPORT_IDS) expect(t.button(id).title).toBe(HINT);
    for (const id of PROOF_IDS) expect(t.button(id).className.split(" ")).toContain("lz-stale");
    // Typing back to the exact proven source restores the proof.
    t.type("function f(a) { return a; }");
    expect(t.api.isStale()).toBe(false);
    expect(exportsDisabled(t)).toEqual(allOf(false));
    expect(t.hint.hidden).toBe(true);
    for (const id of PROOF_IDS) expect(t.button(id).className).toBe("");
  });

  it("goes stale on a preset switch and on a GitHub/npm import (programmatic writes, no input event)", () => {
    const t = setup();
    t.editor.value = "A";
    t.run("A", true);
    t.editor.value = "preset code";
    t.preset.dispatch("change");
    expect(exportsDisabled(t)).toEqual(allOf(true));
    t.run("preset code", true);
    expect(exportsDisabled(t)).toEqual(allOf(false));
    // The importers write the editor and then call check().
    t.editor.value = "module.exports = function imported(s) { return s.length; };";
    t.api.check();
    expect(t.api.isStale()).toBe(true);
    expect(exportsDisabled(t)).toEqual(allOf(true));
    const importerHooks = pageHtml.match(/legacyCode\.value = data\.source;\r?\n\s+if \(window\.LazarusStale\) window\.LazarusStale\.check\(\);/g) ?? [];
    expect(importerHooks, "GitHub and npm importers both re-check after writing the editor").toHaveLength(2);
  });

  it("re-enables only after a successful run of the current text; a failed run keeps the stale state", () => {
    const t = setup();
    t.editor.value = "A";
    t.run("A", true);
    t.type("B");
    t.run("B", false);
    expect(t.api.isStale()).toBe(true);
    expect(exportsDisabled(t)).toEqual(allOf(true));
    t.run("B", true);
    expect(t.api.isStale()).toBe(false);
    expect(exportsDisabled(t)).toEqual(allOf(false));
    expect(t.hint.hidden).toBe(true);
  });

  it("uses the source captured at run start: an edit made during the run stays stale", () => {
    const t = setup();
    t.editor.value = "A";
    t.doc.dispatchEvent({ type: "lazarus:run-start", detail: { source: "A" } });
    t.type("A edited mid-run");
    t.doc.dispatchEvent({ type: "lazarus:result", detail: { success: true } });
    expect(t.api.isStale()).toBe(true);
    expect(exportsDisabled(t)).toEqual(allOf(true));
  });

  it("does not re-enable a button that something else had disabled (for example a zip in progress)", () => {
    const t = setup();
    t.editor.value = "A";
    t.run("A", true);
    t.button("downloadZipBtn").disabled = true;
    t.type("B");
    t.type("A");
    expect(t.button("downloadZipBtn").disabled).toBe(true);
    expect(t.button("exportBtn").disabled).toBe(false);
  });

  it("is wired into the page: run-start carries the posted source, the bundle builder refuses while stale", () => {
    expect(pageHtml).toMatch(/const run = runControl\.begin\(\);\r?\n\s+const mine = [^\n]+\r?\n\s+document\.dispatchEvent\(new CustomEvent\("lazarus:run-start", \{ detail: \{ source: legacyCode\.value \} \}\)\);/);
    expect(pageHtml).toMatch(/async function buildBundleFromCurrentUI\(\) \{\r?\n\s+if \(window\.LazarusStale && window\.LazarusStale\.isStale\(\)\) \{\r?\n\s+showStatus\(window\.LazarusStale\.hint, true\);\r?\n\s+return null;/);
    expect(pageHtml).toContain('<span id="staleHint" class="stale-hint" role="status" hidden>' + HINT + "</span>");
    // Loaded after every other script, so its preset listener runs after the preset handlers wrote the editor.
    expect(pageHtml.lastIndexOf("<script>")).toBeLessThan(pageHtml.indexOf("/* lz-stale:start */"));
    // Tab 3 is out of scope: the stale script never references the Red-Team controls.
    expect(script()).not.toMatch(/redteam|redTeam|rt-/i);
  });
});

describe("repo intake and lab link (shipped lz-intake helpers and link script, minimal DOM)", () => {
  const region = (): string => {
    const start = pageHtml.indexOf("/* lz-intake:start */");
    const end = pageHtml.indexOf("/* lz-intake:end */");
    expect(start, "lz-intake markers in public/index.html").toBeGreaterThan(0);
    return pageHtml.slice(start, end);
  };
  interface Accepted { name: string; item: { name: string; size: number } }
  interface Helpers {
    check(list: Array<{ name: string; size: number }>): { accepted: Accepted[]; rejected: Array<{ name: string; reason: string }>; error: string | null };
    edges(files: Record<string, string>): Array<{ from: string; to: string }>;
    pick(files: Record<string, string>): string;
    encode(s: { name: string; code: string }): { ok: boolean; hash?: string; length: number; error?: string };
    decode(hash: unknown): { ok: boolean; name?: string; code?: string; error?: string };
    limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number; maxHash: number };
  }
  const load = (): Helpers =>
    runInlineScript(`${region()}; ({ check: lzIntakeCheck, edges: lzRequireEdges, pick: lzPickEntry, encode: lzEncodeSpecimen, decode: lzDecodeSpecimen, limits: LZ_INTAKE })`, { atob, btoa }) as Helpers;
  /** Plain-data copy, so vm-realm arrays compare with toEqual. */
  const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  it("uses the same caps as the GitHub folder importer", () => {
    expect(plain(load().limits)).toEqual({ maxFiles: 8, maxFileBytes: 32 * 1024, maxTotalBytes: 128 * 1024, maxHash: 4096 });
  });

  it("accepts .js/.cjs files and rejects the rest with a reason", () => {
    const r = load().check([
      { name: "money.cjs", size: 120 },
      { name: "invoice.JS", size: 300 },
      { name: "logo.png", size: 10 },
      { name: "notes.txt", size: 10 },
      { name: ".hidden.js", size: 10 },
      { name: "a b.js", size: 10 },
      { name: "MONEY.cjs", size: 5 },
      { name: "empty.js", size: 0 },
      { name: "C:\\fakepath\\tax.cjs", size: 40 },
    ]);
    expect(r.error).toBeNull();
    expect(r.accepted.map((a) => a.name)).toEqual(["money.cjs", "invoice.JS", "tax.cjs"]);
    expect(plain(r.rejected)).toEqual([
      { name: "logo.png", reason: "not a .js or .cjs file" },
      { name: "notes.txt", reason: "not a .js or .cjs file" },
      { name: ".hidden.js", reason: "unsafe file name (letters, digits, dot, dash, underscore)" },
      { name: "a b.js", reason: "unsafe file name (letters, digits, dot, dash, underscore)" },
      { name: "MONEY.cjs", reason: "duplicate file name" },
      { name: "empty.js", reason: "empty file" },
    ]);
  });

  it("loads nothing when a cap is exceeded", () => {
    const shipped = load();
    const h = { check: (l: Array<{ name: string; size: number }>) => plain(shipped.check(l)) };
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `m${i}.js`, size: 10 }));
    expect(h.check(many)).toMatchObject({ error: expect.stringContaining("the limit is 8") as unknown, accepted: [] });
    expect(h.check(many.slice(0, 8)).accepted).toHaveLength(8);
    expect(h.check([{ name: "big.js", size: 32 * 1024 + 1 }])).toMatchObject({ error: expect.stringContaining("per-file limit") as unknown, accepted: [] });
    expect(h.check([{ name: "edge.js", size: 32 * 1024 }]).error).toBeNull();
    const heavy = Array.from({ length: 5 }, (_, i) => ({ name: `h${i}.js`, size: 32 * 1024 }));
    expect(h.check(heavy)).toMatchObject({ error: expect.stringContaining("131072") as unknown, accepted: [] });
    expect(h.check(heavy.slice(0, 4)).error).toBeNull();
    expect(h.check([{ name: "x.png", size: 1 }]).error).toBe("No .js or .cjs files to load.");
  });

  it("auto-selects the entry module the way the server analyzer does", () => {
    const h = load();
    const invoice = { "money.cjs": "exports.a = 1;", "tax.cjs": "var m = require('./money.cjs');", "invoice.cjs": "var m = require('./money.cjs'); var t = require('./tax.cjs');" };
    expect(h.pick(invoice)).toBe("invoice.cjs");
    expect(plain(h.edges(invoice)).map((e) => e.from + ">" + e.to).sort()).toEqual(["invoice.cjs>money.cjs", "invoice.cjs>tax.cjs", "tax.cjs>money.cjs"]);
    // A root with outgoing require() edges wins over an isolated index/main; among linked roots index/main wins.
    expect(h.pick({ "a.js": "require('./b')", "b.js": "", "main.js": "" })).toBe("a.js");
    expect(h.pick({ "a.js": "require('./b')", "b.js": "", "main.js": "require('./b')" })).toBe("main.js");
    expect(h.pick({ "a.js": "", "index.js": "", "index.cjs": "" })).toBe("index.cjs");
    expect(h.pick({ "b.js": "", "a.js": "", "index.js": "" })).toBe("index.js");
    expect(h.pick({ "b.js": "", "a.js": "" })).toBe("a.js");
    expect(h.pick({ "z.js": "require('./lib/util.js')", "lib/util.js": "", "a.js": "" })).toBe("z.js");
    const shapes = fc.array(fc.array(fc.nat(7), { maxLength: 3 }), { minLength: 1, maxLength: 7 });
    const special = fc.constantFrom("main.js", "index.js", "index.cjs", "main.cjs");
    fc.assert(
      fc.property(shapes, fc.option(special), (deps, last) => {
        // File i may only require files with a higher index, so the graph is acyclic.
        const names = deps.map((_, i) => (last !== null && i === deps.length - 1 ? last : `m${i}.js`));
        const files: Record<string, string> = {};
        deps.forEach((ds, i) => {
          files[names[i] ?? ""] = ds.filter((d) => d > i && d < deps.length).map((d) => `var x${d} = require('./${names[d] ?? ""}');`).join("\n") + "\nmodule.exports = 1;\n";
        });
        expect(h.pick(files)).toBe(analyzeGraph(files).entry ?? "");
      }),
      { numRuns: 150 }
    );
  });

  it("round-trips any specimen through a #specimen= base64url link", () => {
    const h = load();
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", minLength: 1, maxLength: 200 }).filter((c) => c.trim() !== ""), fc.stringMatching(/^[A-Za-z0-9_$.-]{0,30}$/), (code, name) => {
        const enc = h.encode({ name, code });
        expect(enc.ok).toBe(true);
        expect(enc.hash).toMatch(/^#specimen=[A-Za-z0-9_-]+$/);
        expect(plain(h.decode(enc.hash))).toEqual({ ok: true, name, code });
      }),
      { numRuns: 200 }
    );
  });

  it("refuses a specimen that does not fit in 4 KB instead of truncating it", () => {
    const h = load();
    const big = h.encode({ name: "big", code: "var x = 1;\n".repeat(400) });
    expect(big.ok).toBe(false);
    expect(big.length).toBeGreaterThan(4096);
    expect(big.error).toContain("the limit is 4096");
    expect(big.hash).toBeUndefined();
  });

  it("rejects malformed, oversized or hostile links without throwing", () => {
    const h = load();
    const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
    for (const hash of [
      undefined,
      "",
      "#single",
      "#specimen=",
      "#specimen=not*base64",
      "#specimen=" + b64("not json"),
      "#specimen=" + b64(JSON.stringify({ v: 2, name: "a", code: "x" })),
      "#specimen=" + b64(JSON.stringify({ v: 1, name: "a", code: "   " })),
      "#specimen=" + b64(JSON.stringify({ v: 1, name: "<img src=x onerror=alert(1)>", code: "x" })),
      "#specimen=" + b64(JSON.stringify({ v: 1, name: "a", code: 5 })),
      "#specimen=" + Buffer.from([0xff, 0xfe, 0x00]).toString("base64url"),
      "#specimen=" + "A".repeat(5000),
    ]) {
      const r = h.decode(hash);
      expect(r.ok, String(hash).slice(0, 40)).toBe(false);
      expect(typeof r.error).toBe("string");
    }
  });

  function linkPage(hash: string): { doc: FakeDocument; code: FakeElement; name: FakeElement; note: FakeElement; btn: FakeElement; run: FakeElement; inputs: number; clipboard: string[]; win: Record<string, unknown> } {
    const doc = new FakeDocument();
    const code = doc.element("textarea", "legacyCode");
    const name = doc.element("input", "modName");
    const note = doc.element("span", "linkNote");
    const btn = doc.element("button", "copyLinkBtn");
    const run = doc.element("button", "runBtn");
    let runs = 0;
    run.addEventListener("click", () => { runs++; });
    code.value = "var half = (n / 2) | 0; half;";
    name.value = "legacy-int-halve";
    const clipboard: string[] = [];
    const out = { doc, code, name, note, btn, run, inputs: 0, clipboard, win: {} as Record<string, unknown> };
    code.addEventListener("input", () => { out.inputs++; });
    const win: Record<string, unknown> = {
      addEventListener: () => undefined,
      isSecureContext: true,
    };
    out.win = win;
    const source = scriptWith("/* Tab 1 lab link:");
    runInlineScript(`${region()};\n${source}`, {
      document: doc,
      window: win,
      atob,
      btoa,
      location: { hash, origin: "https://lazarus.example", pathname: "/" },
      history: { replaceState: () => undefined },
      navigator: { clipboard: { writeText: async (t: string) => { clipboard.push(t); } } },
      Event: class { constructor(readonly type: string) {} },
    });
    expect(runs, "opening a link never starts a resurrection").toBe(0);
    return out;
  }
  const scriptWith = (marker: string): string => {
    const found = [...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "").find((s) => s.includes(marker));
    expect(found, marker).toBeDefined();
    return found ?? "";
  };

  it("Copy Lab Link copies origin + #specimen= for the current code and name", async () => {
    const page = linkPage("");
    expect(page.inputs).toBe(0);
    page.btn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(page.clipboard).toHaveLength(1);
    const link = page.clipboard[0] ?? "";
    expect(link.startsWith("https://lazarus.example/#specimen=")).toBe(true);
    expect(plain(load().decode(link.slice(link.indexOf("#"))))).toEqual({ ok: true, name: "legacy-int-halve", code: "var half = (n / 2) | 0; half;" });
    expect(page.note.hidden).toBe(false);
    expect(page.note.textContent).toContain("Lab link copied");
  });

  it("Copy Lab Link refuses an oversized specimen with a visible note", async () => {
    const page = linkPage("");
    page.code.value = "var x = 1;\n".repeat(400);
    page.btn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(page.clipboard).toEqual([]);
    expect(page.note.textContent).toContain("the limit is 4096");
  });

  it("opening a #specimen= link loads the code and name and fires input (smart paste), without running", () => {
    const hash = load().encode({ name: "stringHash32", code: "function stringHash32(s) { return s.length | 0; }" }).hash ?? "";
    const page = linkPage(hash);
    expect(page.code.value).toBe("function stringHash32(s) { return s.length | 0; }");
    expect(page.name.value).toBe("stringHash32");
    expect(page.inputs).toBe(1);
    expect(plain(page.win["lazarusProvenance"])).toEqual({ kind: "paste", label: "shared lab link" });
    expect(page.note.textContent).toContain("Click RESURRECT SPECIMEN");
  });

  it("an invalid link leaves the editor alone and says why", () => {
    const page = linkPage("#specimen=%%%");
    expect(page.code.value).toBe("var half = (n / 2) | 0; half;");
    expect(page.inputs).toBe(0);
    expect(page.note.textContent).toContain("Lab link ignored");
  });

  it("ships the Tab 2 intake (dropzone, picker, GitHub folder bar) without new tabs, and the Tab 1 link button", () => {
    const graphPane = pageHtml.slice(pageHtml.indexOf('<div class="studio-pane" id="pane-graph"'), pageHtml.indexOf('<div class="studio-pane" id="pane-redteam"'));
    expect(graphPane).toContain('<input type="file" id="graphFiles" multiple accept=".js,.cjs"');
    expect(graphPane).toContain('<label class="gi-drop" id="graphDrop" for="graphFiles" tabindex="0">');
    expect(graphPane).toContain('id="graphRepoUrl"');
    expect(graphPane).toContain('id="graphRepoBtn"');
    expect(graphPane).toContain("legacy-invoice-engine");
    expect(graphPane).toContain("legacy-text-pipeline");
    // The intake bar sits between the header and the editor/graph body.
    expect(graphPane.indexOf('id="graphIntake"')).toBeGreaterThan(graphPane.indexOf('id="graphRunBtn"'));
    expect(graphPane.indexOf('id="graphIntake"')).toBeLessThan(graphPane.indexOf('class="graph-body"'));
    expect(pageHtml.match(/class="studio-tab"/g)).toHaveLength(3);
    const single = pageHtml.slice(pageHtml.indexOf('<div class="studio-pane" id="pane-single"'), pageHtml.indexOf('<div class="studio-pane" id="pane-graph"'));
    expect(single).toContain('<button id="copyLinkBtn" type="button" class="link-btn"');
    const graph = scriptWith("Multi-File Project (Stitch Graph): file-tab editor");
    expect(graph).toContain('fetch("/api/import/github-dir"');
    expect(graph).toContain("const checked = lzIntakeCheck(list);");
    expect(graph).toContain('drop.addEventListener("drop"');
    expect(graph).toContain("function guessEntry(edges) { return lzPickEntry(files, edges)");
    // Helpers load before every script that uses them; the stale guard stays the last script.
    expect(pageHtml.indexOf("/* lz-intake:start */")).toBeLessThan(pageHtml.indexOf("Multi-File Project (Stitch Graph): file-tab editor"));
    expect(pageHtml.indexOf("/* lz-intake:start */")).toBeLessThan(pageHtml.indexOf("/* Tab 1 lab link:"));
    expect(pageHtml.indexOf("/* Tab 1 lab link:")).toBeLessThan(pageHtml.indexOf("/* lz-stale:start */"));
  });

  it("dismisses the finished Guided Tour banner on Tab 2 and Tab 3, and keeps Close on Tab 1", () => {
    const studio = scriptWith("// ---- Guided Judge Tour: real live API calls only ----");
    expect(studio).toMatch(/history\.replaceState\(null, "", "#" \+ name\);\r?\n\s+document\.dispatchEvent\(new CustomEvent\("lazarus:tab", \{ detail: \{ name: name \} \}\)\);/);
    expect(studio).toContain('document.addEventListener("lazarus:tab", (e) => { if (!tour && e.detail && e.detail.name !== "single") hud.hidden = true; });');
    expect(studio).toContain('close.textContent = "Close"; close.addEventListener("click", () => { hud.hidden = true; });');
  });

  it("shows the hooks and the Kiro Power in the Kiro DNA drawer, and the 25-spec badge", () => {
    expect(pageHtml).toContain('<div class="dna-grid" id="dnaHooks"></div>');
    expect(pageHtml).toContain('"Agent hooks (" + dna.hooks.length + ")"');
    expect(pageHtml).toContain('<span class="proof-badge" id="badgeSpecs">25 Kiro Specs</span>');
    expect(pageHtml).toContain('<div class="dna-power" id="dnaPower"></div>');
    expect(pageHtml).toContain('"Installable Kiro Power (" + power.name + ")"');
    expect(pageHtml).toContain('copy.id = "dnaPowerCopy";');
    expect(pageHtml.indexOf('id="dnaPower"')).toBeLessThan(pageHtml.indexOf('id="dnaAgents"'));
  });
});

// ---------------------------------------------------------------------------
// V12: Mutant Autopsy Inspector, Naive AI trap card, cold-start guard, /api/health, untouched Tab 3
// ---------------------------------------------------------------------------
const v12Script = (marker: string): string => {
  const found = inlineScripts.find((s) => s.includes(marker));
  expect(found, marker).toBeDefined();
  return found ?? "";
};
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

describe("V12 Mutant Autopsy Inspector (shipped script, minimal DOM)", () => {
  const AUDIT = {
    totalMutants: 2,
    killed: 1,
    mutants: [
      {
        id: "M1",
        runs: 2,
        autopsy: {
          id: "M1",
          operator: "Math.trunc → Math.floor",
          status: "killed",
          originalLine: "const half = Math.trunc(n / 2) || 0;",
          mutatedLine: "const half = Math.floor(n / 2) || 0;",
          killerInput: { display: "n = -1", inputs: { n: -1 }, source: "boundary-corpus" },
          legacyOutput: "+0",
          mutantOutput: "-1",
          divergence: "Output mismatch: legacy=0 vs modern=-1",
        },
      },
      {
        id: "M2",
        runs: 30,
        autopsy: { id: "M2", operator: "< → <=", status: "survived", originalLine: "a < b", mutatedLine: "a <= b", killerInput: null, legacyOutput: null, mutantOutput: null, divergence: null },
      },
    ],
  };
  function setup(): { doc: FakeDocument; score: FakeElement; box: FakeElement } {
    const doc = new FakeDocument();
    const score = doc.element("div", "mutScore");
    score.textContent = "1/2 MUTANTS KILLED";
    const box = doc.element("div", "mutAutopsy");
    box.hidden = true;
    runInlineScript(v12Script("Mutant Autopsy Inspector: the mutation score toggles"), { document: doc, window: {} });
    return { doc, score, box };
  }
  const key = (el: FakeElement, k: string): boolean => el.dispatchEvent({ type: "keydown", key: k });

  it("is inert until an audit arrives, then arms the score as a collapsed toggle", () => {
    const { doc, score, box } = setup();
    score.click();
    expect(box.hidden).toBe(true);
    expect(score.getAttribute("role")).toBeNull();
    doc.dispatchEvent({ type: "lazarus:mutation", detail: AUDIT });
    expect(score.getAttribute("role")).toBe("button");
    expect(score.getAttribute("tabindex")).toBe("0");
    expect(score.getAttribute("aria-controls")).toBe("mutAutopsy");
    expect(score.getAttribute("aria-expanded")).toBe("false");
    expect(box.hidden).toBe(true);
    expect(box.children).toHaveLength(2);
    expect(score.textContent).toContain("Open Mutant Autopsy");
  });

  it("toggles with a click, Enter and Space (and ignores other keys)", () => {
    const { doc, score, box } = setup();
    doc.dispatchEvent({ type: "lazarus:mutation", detail: AUDIT });
    score.click();
    expect(box.hidden).toBe(false);
    expect(score.getAttribute("aria-expanded")).toBe("true");
    expect(score.textContent).toContain("Hide Mutant Autopsy");
    expect(key(score, "Enter")).toBe(false);
    expect(box.hidden).toBe(true);
    key(score, "a");
    expect(box.hidden).toBe(true);
    key(score, " ");
    expect(box.hidden).toBe(false);
  });

  it("shows each mutant's injected diff, killer input and exact Object.is divergence", () => {
    const { doc, box } = setup();
    doc.dispatchEvent({ type: "lazarus:mutation", detail: AUDIT });
    const [killed, survived] = box.children;
    expect(killed?.className).toBe("autopsy-row killed");
    const text = killed?.textContent ?? "";
    for (const s of ["M1", "Math.trunc → Math.floor", "KILLED", "- const half = Math.trunc(n / 2) || 0;", "+ const half = Math.floor(n / 2) || 0;", "n = -1  (boundary corpus)", "legacy+0", "mutant-1", "Object.isOutput mismatch: legacy=0 vs modern=-1"]) {
      expect(text, s).toContain(s);
    }
    expect(survived?.className).toBe("autopsy-row survived");
    expect(survived?.textContent).toContain("survived: no input among 30 exact probes told it apart");
  });

  it("collapses and disarms on a new run, and re-collapses after every new audit", () => {
    const { doc, score, box } = setup();
    doc.dispatchEvent({ type: "lazarus:mutation", detail: AUDIT });
    score.click();
    doc.dispatchEvent({ type: "lazarus:mutation", detail: AUDIT });
    expect(box.hidden).toBe(true);
    doc.dispatchEvent({ type: "lazarus:run-start", detail: { source: "x" } });
    expect(box.hidden).toBe(true);
    expect(box.children).toHaveLength(0);
    expect(score.getAttribute("role")).toBeNull();
    expect(score.getAttribute("tabindex")).toBeNull();
    // An audit without autopsy data (an old server) leaves the score as plain text.
    doc.dispatchEvent({ type: "lazarus:mutation", detail: { mutants: [{ id: "M1" }] } });
    expect(score.getAttribute("role")).toBeNull();
  });

  it("is wired into the deck: collapsed container right after the mutation table", () => {
    const card = pageHtml.slice(pageHtml.indexOf('<div class="mut-card" id="mutCard"'), pageHtml.indexOf('<div class="deck-col">', pageHtml.indexOf('<div class="mut-card" id="mutCard"')));
    expect(card).toMatch(/<\/table>\r?\n\s+<div class="mut-autopsy" id="mutAutopsy" aria-label="Mutant Autopsy Inspector" hidden><\/div>/);
    expect(card).toContain('<div class="mut-score" id="mutScore" role="status"></div>');
  });
});

describe("V12 Compare vs. Naive AI trap card (shipped script, minimal DOM, scripted fetch)", () => {
  const RESULT = { success: true, name: "legacy-int-halve", modernCode: "const half = Math.trunc(n / 2) || 0;\nhalf;", fuzzReport: { totalRuns: 100 }, attempts: 2, typecheck: { errorCount: 0 } };
  const TRAP = {
    naiveCode: "let half = Math.floor(n / 2);\nhalf;",
    rewrites: [{ rule: "bitor0-floor", before: "n / 2 | 0", after: "Math.floor(n / 2)", why: "looks like integer division" }],
    passed: false,
    totalRuns: 2,
    counterexample: { input: "n = -0", legacyOutput: "+0", naiveOutput: "-0", reason: "Output mismatch: legacy=0 vs modern=-0 (sign of zero differs)" },
  };
  function setup(reply: () => Response | Promise<Response> = () => new Response(JSON.stringify(TRAP), { status: 200 })) {
    const doc = new FakeDocument();
    const btn = doc.element("button", "naiveBtn");
    btn.hidden = true;
    const card = doc.element("div", "trapCard");
    card.hidden = true;
    const code = doc.element("textarea", "legacyCode");
    code.value = "var half = (n / 2) | 0; half;";
    const schema = doc.element("textarea", "schemaJson");
    schema.value = '{"n": "integer"}';
    const win: Record<string, unknown> = {};
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = async (url: string, init?: { body?: string }): Promise<Response> => {
      calls.push({ url, body: init?.body !== undefined ? JSON.parse(init.body) : undefined });
      return reply();
    };
    runInlineScript(v12Script("Naive AI vs. Lazarus: a deterministic naive rewrite"), { document: doc, window: win, fetch: fetchImpl });
    const resurrect = (r: Record<string, unknown> = RESULT, source = code.value): void => {
      doc.dispatchEvent({ type: "lazarus:run-start", detail: { source } });
      doc.dispatchEvent({ type: "lazarus:result", detail: r });
    };
    return { doc, btn, card, code, schema, win, calls, resurrect };
  }

  it("shows the button only after a successful single-function resurrection", () => {
    const t = setup();
    expect(t.btn.hidden).toBe(true);
    t.resurrect({ ...RESULT, success: false });
    expect(t.btn.hidden).toBe(true);
    t.resurrect({ ...RESULT, module: { functions: [] } });
    expect(t.btn.hidden).toBe(true);
    t.resurrect();
    expect(t.btn.hidden).toBe(false);
    t.doc.dispatchEvent({ type: "lazarus:run-start", detail: { source: "x" } });
    expect(t.btn.hidden).toBe(true);
  });

  it("posts the proven source and schema, then renders the red naive side and the green Lazarus side", async () => {
    const t = setup();
    t.resurrect();
    t.code.value = "edited after the run";
    t.btn.click();
    await settle();
    expect(t.calls).toEqual([{ url: "/api/compare-naive", body: { legacyCode: "var half = (n / 2) | 0; half;", schema: { n: "integer" }, seed: 1337 } }]);
    expect(t.card.hidden).toBe(false);
    expect(t.btn.getAttribute("aria-pressed")).toBe("true");
    const [naive, lazarus] = t.card.children;
    expect(naive?.className).toBe("trap-side naive");
    expect(naive?.textContent).toContain("Naive AI Refactor");
    expect(naive?.textContent).toContain("n = -0 → Legacy: +0 vs Naive: -0");
    expect(naive?.textContent).toContain("let half = Math.floor(n / 2);");
    expect(naive?.textContent).toContain("n / 2 | 0  →  Math.floor(n / 2)");
    expect(lazarus?.className).toBe("trap-side lazarus");
    for (const s of ["Lazarus Proven", "100% Exact Object.is Parity · 100 fuzz runs · 2 attempts", "const half = Math.trunc(n / 2) || 0;", "Mutation audit: not run yet", "tsc --strict: 0 errors"]) expect(lazarus?.textContent, s).toContain(s);
  });

  it("updates the kill score live, toggles closed, and reopens from cache without refetching", async () => {
    const t = setup();
    t.resurrect();
    t.btn.click();
    await settle();
    // The audit fires lazarus:mutation before it sets window.lastMutationScore: the card must read the event.
    t.doc.dispatchEvent({ type: "lazarus:mutation", detail: { killed: 4, totalMutants: 4, baselineVerified: true } });
    expect(t.card.children[1]?.textContent).toContain("Mutation audit: 4/4 mutants killed (100% proof strength)");
    t.btn.click();
    expect(t.card.hidden).toBe(true);
    expect(t.btn.getAttribute("aria-pressed")).toBe("false");
    t.btn.click();
    await settle();
    expect(t.card.hidden).toBe(false);
    expect(t.calls).toHaveLength(1);
  });

  it("reports an honest pass instead of faking a failure", async () => {
    const t = setup(() => new Response(JSON.stringify({ naiveCode: "let s = 0;", rewrites: [], passed: true, totalRuns: 100, note: "The naive rewrite matched the legacy code on all 100 exact Object.is runs" }), { status: 200 }));
    t.resurrect();
    t.btn.click();
    await settle();
    expect(t.card.children[0]?.className).toBe("trap-side naive honest");
    expect(t.card.children[0]?.textContent).toContain("No trap: The naive rewrite matched the legacy code on all 100 exact Object.is runs");
  });

  it("shows server and network errors as they are", async () => {
    const busy = setup(() => new Response(JSON.stringify({ error: "A naive comparison is already running", code: "BUSY" }), { status: 429 }));
    busy.resurrect();
    busy.btn.click();
    await settle();
    expect(busy.card.textContent).toBe("Naive comparison failed (HTTP 429): A naive comparison is already running");
    const down = setup(() => Promise.reject(new TypeError("Failed to fetch")));
    down.resurrect();
    down.btn.click();
    await settle();
    expect(down.card.textContent).toBe("Naive comparison failed: Failed to fetch");
    expect(down.btn.disabled).toBe(false);
  });

  it("sits next to the diff toggle, with the trap card in the deck", () => {
    expect(pageHtml).toMatch(/id="legacyDiffToggle"[^\n]*<\/button>\r?\n\s+<button type="button" class="diff-toggle naive-toggle" id="naiveBtn" aria-pressed="false" aria-controls="trapCard"[^>]* hidden>Compare vs\. Naive AI<\/button>/);
    const deck = pageHtml.slice(pageHtml.indexOf('<section class="verify-deck"'), pageHtml.indexOf('<div class="deck-grid">'));
    expect(deck).toContain('<div class="trap-card" id="trapCard" aria-live="polite" hidden></div>');
    expect(v12Script("Naive AI vs. Lazarus")).toContain('fetch("/api/compare-naive"');
    expect(v12Script("Naive AI vs. Lazarus")).not.toMatch(/innerHTML/);
  });
});

describe("V12 Render cold-start guard (shipped lz-health core)", () => {
  const core = (): string => {
    const start = pageHtml.indexOf("/* lz-health:start */");
    const end = pageHtml.indexOf("/* lz-health:end */");
    expect(start, "lz-health markers").toBeGreaterThan(0);
    return pageHtml.slice(start, end);
  };
  type Step = { status: number } | { error: string } | { status: number; delayMs: number };
  async function run(steps: Step[]): Promise<{ outcome: string; shown: string[]; hidden: number; failed: string[]; fetches: number }> {
    const shown: string[] = [];
    const failed: string[] = [];
    let hidden = 0;
    let fetches = 0;
    const make = runInlineScript(`${core()}; lzHealthGuard`, {}) as (deps: Record<string, unknown>) => { run: () => Promise<string> };
    const guard = make({
      fetch: async (url: string) => {
        expect(url).toBe("/api/health");
        const step = steps[Math.min(fetches++, steps.length - 1)] ?? { status: 200 };
        if ("error" in step) throw new TypeError(step.error);
        if ("delayMs" in step) await new Promise((r) => setTimeout(r, step.delayMs));
        return new Response("{}", { status: step.status });
      },
      setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      show: (t: string) => shown.push(t),
      hide: () => hidden++,
      fail: (t: string) => failed.push(t),
      slowMs: 40,
      retryMs: 5,
      timeoutMs: 2000,
    });
    const outcome = await guard.run();
    return { outcome, shown, hidden, failed, fetches };
  }

  it("stays silent when the server answers quickly", async () => {
    expect(await run([{ status: 200 }])).toEqual({ outcome: "ok", shown: [], hidden: 1, failed: [], fetches: 1 });
  });

  it("shows the waking pill only after the slow threshold, and clears it on 200", async () => {
    const r = await run([{ status: 200, delayMs: 120 }]);
    expect(r).toMatchObject({ outcome: "ok", hidden: 1, failed: [], fetches: 1 });
    expect(r.shown).toEqual(["Waking Lazarus sandbox on Render…"]);
  });

  it.each([502, 503, 504])("retries a %i cold-boot answer once and recovers", async (status) => {
    const r = await run([{ status }, { status: 200 }]);
    expect(r).toMatchObject({ outcome: "ok", hidden: 1, failed: [], fetches: 2 });
    expect(r.shown).toEqual([`Lazarus is still booting (HTTP ${status}); retrying once…`]);
  });

  it("gives a clear message after one failed retry instead of a raw browser error", async () => {
    const r = await run([{ status: 503 }, { status: 503 }]);
    expect(r).toMatchObject({ outcome: "failed", fetches: 2, hidden: 0 });
    expect(r.failed).toEqual(["Lazarus sandbox is not ready (HTTP 503). Render may still be starting the service."]);
    const offline = await run([{ error: "Failed to fetch" }, { error: "Failed to fetch" }]);
    expect(offline).toMatchObject({ outcome: "failed", fetches: 2 });
    expect(offline.failed).toEqual(["Cannot reach the Lazarus server (Failed to fetch)."]);
    expect(offline.shown).toEqual(["Lazarus did not answer yet; retrying once…"]);
  });

  it("does not retry a non-cold-boot error", async () => {
    const r = await run([{ status: 500 }, { status: 200 }]);
    expect(r).toMatchObject({ outcome: "failed", fetches: 1 });
  });

  it("is wired into the page with a fixed, non-blocking pill and a Retry button", () => {
    expect(pageHtml).toContain('<div class="wake-pill" id="wakePill" role="status" aria-live="polite" hidden></div>');
    expect(pageHtml).toMatch(/\.wake-pill \{ position: fixed;/);
    const boot = v12Script("/* lz-health:start */");
    expect(boot).toContain('fetch: (u, o) => fetch(u, o)');
    expect(boot).toContain('b.textContent = "Retry";');
    expect(boot).toContain("guard.run();");
  });
});

describe("V12 GET /api/health", () => {
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

  it("returns { ok, uptimeSec, tests, specs } without caching", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ok", "specs", "tests", "uptimeSec"]);
    expect(body["ok"]).toBe(true);
    expect(Number.isInteger(body["uptimeSec"])).toBe(true);
    const badge = Number(/id="badgeTests">(\d+) Verified Tests</.exec(pageHtml)?.[1]);
    expect(body["tests"]).toBe(badge);
    expect(body["specs"]).toBe(fs.readdirSync(nodePath.join(root, ".kiro", "specs"), { withFileTypes: true }).filter((d) => d.isDirectory()).length);
    expect(body["specs"]).toBe(25);
  });

  it("leaves the existing /health route unchanged", async () => {
    expect(await (await fetch(`${baseUrl}/health`)).json()).toEqual({ status: "ok", service: "lazarus-operating-table" });
  });
});

describe("V12 leaves Tab 3 (Red-Team) untouched", () => {
  const html = pageHtml.replace(/\r\n/g, "\n");
  const between = (a: string, b: string): string => {
    const s = html.indexOf(a);
    const e = html.indexOf(b, s + a.length);
    expect(s).toBeGreaterThan(0);
    expect(e).toBeGreaterThan(s);
    return html.slice(s, e);
  };
  const sha = async (text: string): Promise<string> => (await import("node:crypto")).createHash("sha256").update(text).digest("hex");

  it("the Red-Team CSS, pane markup and script are byte-identical to V11", async () => {
    // SHA-256 of the three Tab 3 regions on main (V11), with LF line endings.
    expect(await sha(between("/* ---- Red-Team Lab", "\n/* ----"))).toBe("e294212e10b8b7a7bff5c10b9f0b09868be7413a98da83c3a1ad5f665433553f");
    expect(await sha(between('<div class="studio-pane" id="pane-redteam"', '<div class="dna-scrim"'))).toBe("31457f48198687cc71b80f53a110ac4a47aa1302edea87b783cf3f19a021fee1");
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "").find((x) => x.includes("Red-Team the Sandbox: one-click containment proofs")) ?? "";
    expect(await sha(script)).toBe("3d9381eebc0c47c143dfe25746d5510ef519f9fda66fe0243e4bc6f36be7e633");
  });

  it("the V12 scripts never touch the Red-Team controls", () => {
    for (const marker of ["Mutant Autopsy Inspector: the mutation score", "Naive AI vs. Lazarus: a deterministic", "/* lz-health:start */"]) {
      expect(v12Script(marker)).not.toMatch(/redteam|rtLog|rtButtons|rt-btn/);
    }
  });

  it("shows 25 Kiro Specs", () => {
    expect(pageHtml).toContain('<span class="proof-badge" id="badgeSpecs">25 Kiro Specs</span>');
  });
});

describe("V13 Grand Prize Finisher (shipped scripts, minimal DOM, live server)", () => {
  const html = pageHtml.replace(/\r\n/g, "\n");
  const regionOf = (name: string): string => {
    const start = html.indexOf(`/* ${name}:start */`);
    const end = html.indexOf(`/* ${name}:end */`);
    expect(start, name).toBeGreaterThan(0);
    expect(end, name).toBeGreaterThan(start);
    return html.slice(start, end);
  };
  const server = createWebServer();
  let baseUrl = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };

  describe("Self-Healing Causal Strip", () => {
    type Node = { kind: string; step: string; label: string };
    const nodes = (r: unknown): Node[] => {
      const fn = runInlineScript(`${regionOf("lz-causal")}; lzCausalNodes`, {}) as (r: unknown, fmt: (v: unknown) => string) => Node[];
      return fn(r, (v) => JSON.stringify(v));
    };
    it("sits in the Verification Deck above the diffs, and adds no tab", () => {
      const deck = html.slice(html.indexOf('<section class="verify-deck"'), html.indexOf('<div class="studio-pane" id="pane-graph"'));
      expect(deck).toContain('<div id="causalStrip" class="causal-strip" role="list" aria-label="Self-Healing Causal Strip" hidden></div>');
      expect(deck.indexOf('id="causalStrip"')).toBeLessThan(deck.indexOf('id="healingMatrix"'));
      expect(deck.indexOf('id="causalStrip"')).toBeLessThan(deck.indexOf('id="legacyDiffBlock"'));
      expect(html.match(/data-studio-tab="/g)).toHaveLength(3);
    });
    it("shows Draft 1 -> Counterexample Caught -> Rule Rolled Back -> Draft 2 Proven after a rollback", () => {
      const result = {
        success: true,
        attempts: 2,
        modernCode: "// ast-rules: bitor0-trunc=off\n// ast-refine: attempt 2 blamed bitor0-trunc; rolled back bitor0-trunc;\nx",
        events: [{ type: "counterexample_found", payload: { counterexample: { inputs: { text: "abcdefgh" } } } }],
        certificate: { rolledBack: ["| 0 → Math.trunc(x) || 0"] },
      };
      expect(nodes(result).map((n) => n.label)).toEqual(["Draft 1", 'Counterexample Caught (text = "abcdefgh")', "Rule Rolled Back (bitor0-trunc)", "Draft 2 Proven (Object.is 100%)"]);
      expect(nodes(result).map((n) => n.kind)).toEqual(["bad", "bad", "heal", "ok"]);
    });
    it("falls back to the certificate's rolled-back rule, and truncates a long input", () => {
      const result = { success: true, attempts: 2, modernCode: "x", events: [{ type: "counterexample_found", payload: { counterexample: { inputs: { n: "z".repeat(80) } } } }], certificate: { rolledBack: ["var → const/let"] } };
      const labels = nodes(result).map((n) => n.label);
      expect(labels[1]?.length).toBeLessThan(80);
      expect(labels[2]).toBe("Rule Rolled Back (var → const/let)");
    });
    it("shows AST Lifted -> Exorcist Fuzzed -> Zero Divergences -> 100% Exact Parity when draft 1 passed", () => {
      expect(nodes({ success: true, attempts: 1, modernCode: "x", events: [], certificate: { rolledBack: [] } }).map((n) => n.label)).toEqual(["AST Lifted", "Exorcist Fuzzed", "Zero Divergences", "100% Exact Parity"]);
    });
    it("shows nothing for a failed run, and is rebuilt (not accumulated) on every result", () => {
      expect(nodes({ success: false, attempts: 3, modernCode: "x", events: [] })).toEqual([]);
      const script = html.slice(html.indexOf("function renderCausalStrip(r)"), html.indexOf("// ---- Probe Custom Edge Case"));
      expect(script).toContain('strip.textContent = "";');
      expect(script).toContain("strip.hidden = nodes.length === 0;");
      expect(html).toContain("renderCausalStrip(r);");
      expect(html).toContain('strip.hidden = true; strip.textContent = "";');
    });
  });

  describe("Guided Tour auto-dock", () => {
    interface Rig { dock: { dock(): void; dismiss(): void; resume(): void; reset(): void; isDocked(): boolean; dismissed(): boolean }; hud: { hidden: boolean }; body: { on: boolean }; doc: FakeDocument }
    const rig = (): Rig => {
      const makeClassList = (cls: string, flag: { on: boolean } | undefined, set: Set<string>) => ({
        add: (c: string) => { set.add(c); if (flag !== undefined && c === cls) flag.on = true; },
        remove: (c: string) => { set.delete(c); if (flag !== undefined && c === cls) flag.on = false; },
        contains: (c: string) => set.has(c),
      });
      const hud = { hidden: false, classList: makeClassList("docked", undefined, new Set<string>()) };
      const body = { on: false, classList: makeClassList("tour-docked", undefined, new Set<string>()) };
      const flagBody = { get on(): boolean { return body.classList.contains("tour-docked"); } };
      const doc = new FakeDocument();
      const make = runInlineScript(`${regionOf("lz-dock")}; lzMakeDock`, {}) as (h: unknown, b: unknown, d: unknown) => Rig["dock"];
      return { dock: make(hud, body, doc), hud, body: flagBody as { on: boolean }, doc };
    };
    const click = (doc: FakeDocument, selectorHit: boolean): void => {
      doc.dispatchEvent({ type: "click", ...({ target: { closest: () => (selectorHit ? {} : null) } } as object) });
    };
    it("collapses to a pill when a resurrection completes", () => {
      const { dock, doc, body } = rig();
      expect(dock.isDocked()).toBe(false);
      doc.dispatchEvent({ type: "lazarus:result", detail: { success: true } });
      expect(dock.isDocked()).toBe(true);
      expect(body.on).toBe(true);
    });
    it("collapses when the Trap Card, Mutant Autopsy or Certificate controls are clicked, not on other clicks", () => {
      const { dock, doc } = rig();
      click(doc, false);
      expect(dock.isDocked()).toBe(false);
      click(doc, true);
      expect(dock.isDocked()).toBe(true);
    });
    it("Resume Tour expands the banner again, and x dismisses it until the next tour", () => {
      const { dock, doc, hud, body } = rig();
      doc.dispatchEvent({ type: "lazarus:result" });
      dock.resume();
      expect(dock.isDocked()).toBe(false);
      expect(body.on).toBe(false);
      doc.dispatchEvent({ type: "lazarus:result" });
      dock.dismiss();
      expect(hud.hidden).toBe(true);
      expect(dock.dismissed()).toBe(true);
      expect(dock.isDocked()).toBe(false);
      hud.hidden = false;
      doc.dispatchEvent({ type: "lazarus:result" });
      expect(dock.isDocked()).toBe(false);
      dock.reset();
      doc.dispatchEvent({ type: "lazarus:result" });
      expect(dock.isDocked()).toBe(true);
    });
    it("does not dock a hidden banner, and undocks when the user leaves Tab 1", () => {
      const { dock, doc, hud } = rig();
      hud.hidden = true;
      doc.dispatchEvent({ type: "lazarus:result" });
      expect(dock.isDocked()).toBe(false);
      hud.hidden = false;
      doc.dispatchEvent({ type: "lazarus:result" });
      doc.dispatchEvent({ type: "lazarus:tab", detail: { name: "graph" } });
      expect(dock.isDocked()).toBe(false);
    });
    it("ships the pill markup, the CSS that keeps it in a corner, and keeps the original tour hooks", () => {
      expect(html).toContain('id="tourResume">Resume Tour</button>');
      expect(html).toContain('id="tourPillClose"');
      expect(html).toContain(".tour-hud.docked { left: auto; right: 14px; bottom: 14px; transform: none;");
      expect(html).toContain(".tour-hud.docked > :not(.tour-pill) { display: none; }");
      expect(html).toContain("body.tour-docked { padding-bottom: 64px; }");
      expect(html).toContain('id="tourHud" role="status" aria-live="polite" hidden');
      expect(html).toContain('resumeBtn.addEventListener("click", () => dock.resume());');
      expect(html).toContain('pillClose.addEventListener("click", () => dock.dismiss());');
    });
  });

  describe("Ed25519 badge and Simulate 1-Byte Tamper (shipped script, live /api/verify-certificate)", () => {
    const LEGACY = "function half(n) { return (n / 2) | 0; }";
    async function resurrect(): Promise<{ modernCode: string; certificate: { signature: { keyId: string; payload: Record<string, unknown>; signatureB64: string; publicKeyPem: string } } }> {
      const res = await fetch(`${baseUrl}/api/resurrect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "half", legacyCode: LEGACY, schema: { n: "integer" }, fuzzRuns: 60, seed: 7 }) });
      const text = await res.text();
      const line = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as { kind: string; result?: unknown }).find((m) => m.kind === "result");
      return line?.result as Awaited<ReturnType<typeof resurrect>>;
    }
    it("/api/resurrect attaches an Ed25519 signature that verifies against the resurrected code", async () => {
      const r = await resurrect();
      const sig = r.certificate.signature;
      expect(sig.keyId).toMatch(/^[0-9a-f]{16}$/);
      expect(Object.keys(sig.payload)).toEqual(["legacySha256", "resurrectedSha256", "paritySummary", "mutantsKilled", "tscStrictErrors", "issuedAt"]);
      const ok = await fetch(`${baseUrl}/api/verify-certificate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload: sig.payload, signatureB64: sig.signatureB64, publicKeyPem: sig.publicKeyPem, resurrectedCode: r.modernCode, legacyCode: LEGACY }) });
      expect(((await ok.json()) as { valid: boolean }).valid).toBe(true);
    }, 60_000);
    it("flips the badge to TAMPER DETECTED on a 1-byte change and back with Restore Verified", async () => {
      const r = await resurrect();
      const doc = new FakeDocument();
      const window = { lastResurrectedCode: r.modernCode };
      const calls: string[] = [];
      const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
        calls.push(String(init?.body ?? ""));
        return fetch(`${baseUrl}${url}`, init);
      };
      const signatureRow = runInlineScript(`${regionOf("lz-sig")}; signatureRow`, { document: doc, window, fetch: fetchImpl }) as (sig: unknown) => FakeElement;
      const row = signatureRow(r.certificate.signature);
      const find = (id: string): FakeElement => {
        const walk = (el: FakeElement): FakeElement | undefined => (el.id === id ? el : el.children.map(walk).find((x) => x !== undefined));
        const hit = walk(row);
        if (hit === undefined) throw new Error(`no #${id}`);
        return hit;
      };
      await settle();
      expect(find("certSigBadge").textContent).toBe("Ed25519 Signed \u00b7 VERIFIED");
      expect(find("certRestoreBtn").hidden).toBe(true);
      find("certTamperBtn").click();
      await settle();
      expect(find("certSigBadge").textContent).toBe("TAMPER DETECTED (Digest / Signature Mismatch)");
      expect(find("certSigBadge").className).toContain("tamper");
      expect(find("certRestoreBtn").hidden).toBe(false);
      // Exactly one character of a copy changed; the real code is untouched.
      const sent = JSON.parse(calls[1] ?? "{}") as { resurrectedCode: string };
      let differing = 0;
      for (let i = 0; i < r.modernCode.length; i++) if (sent.resurrectedCode[i] !== r.modernCode[i]) differing++;
      expect(sent.resurrectedCode.length).toBe(r.modernCode.length);
      expect(differing).toBe(1);
      expect(window.lastResurrectedCode).toBe(r.modernCode);
      find("certRestoreBtn").click();
      await settle();
      expect(find("certSigBadge").textContent).toBe("Ed25519 Signed \u00b7 VERIFIED");
      expect(find("certRestoreBtn").hidden).toBe(true);
    }, 60_000);
    it("renders the badge from certificate.signature and keeps old certificates (no signature) unchanged", () => {
      expect(html).toContain("if (c.signature) card.append(signatureRow(c.signature));");
      expect(html).toContain("window.lastResurrectedCode = r.modernCode;");
      expect(html).toContain('badge.textContent = "Ed25519 Signed \\u00b7 VERIFYING..."');
    });
  });

  describe("3-way Judge Probe card", () => {
    it("has Legacy, Naive AI and Lazarus cells, a RUN PROBE button, and still hides for the async preset", () => {
      const card = html.slice(html.indexOf('<div id="probeCard"'), html.indexOf("</section>", html.indexOf('<div id="probeCard"')));
      expect(card).toContain('id="probeBtn" type="button" class="primary">RUN PROBE</button>');
      expect(card.indexOf('id="probeLegacySide"')).toBeLessThan(card.indexOf('id="probeNaiveSide"'));
      expect(card.indexOf('id="probeNaiveSide"')).toBeLessThan(card.indexOf('id="probeModernSide"'));
      expect(card).toContain("<h4>Naive AI</h4>");
      expect(card).toContain("<h4>Lazarus Proven</h4>");
      expect(html).toContain("compareNaive: !$(\"probeCard\").hidden");
      expect(html).toContain("if (probe) probe.hidden = true;");
      expect(html).toContain("naive-diverges");
      expect(html).toContain("(Object.is: true)");
    });
  });

  describe("scope guard", () => {
    const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
    const between = (a: string, b: string): string => {
      const s = html.indexOf(a);
      const e = html.indexOf(b, s + a.length);
      expect(s).toBeGreaterThan(0);
      expect(e).toBeGreaterThan(s);
      return html.slice(s, e);
    };
    it("changes 0 Tab 3 Red-Team lines (CSS, pane markup and script hashes equal V12)", () => {
      expect(sha(between("/* ---- Red-Team Lab", "\n/* ----"))).toBe("e294212e10b8b7a7bff5c10b9f0b09868be7413a98da83c3a1ad5f665433553f");
      expect(sha(between('<div class="studio-pane" id="pane-redteam"', '<div class="dna-scrim"'))).toBe("31457f48198687cc71b80f53a110ac4a47aa1302edea87b783cf3f19a021fee1");
      const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "").find((x) => x.includes("Red-Team the Sandbox: one-click containment proofs")) ?? "";
      expect(sha(script)).toBe("3d9381eebc0c47c143dfe25746d5510ef519f9fda66fe0243e4bc6f36be7e633");
      expect(html.match(/^.*(?:redteam|\.rt-|Red-Team Lab).*$/gm)?.filter((l) => /^\s*</.test(l) === false)).toHaveLength(30);
    });
    it("needs no external API key or new dependency", () => {
      const pkg = JSON.parse(fs.readFileSync(nodePath.join(root, "package.json"), "utf8")) as { dependencies: Record<string, string>; scripts: Record<string, string> };
      expect(Object.keys(pkg.dependencies).sort()).toEqual(["@modelcontextprotocol/sdk", "acorn", "astring", "typescript", "zod"]);
      expect(pkg.scripts["verify"]).toBe("tsx src/cli.ts verify");
    });
    it("shows 25 Kiro Specs", () => {
      expect(html).toContain('<span class="proof-badge" id="badgeSpecs">25 Kiro Specs</span>');
    });
  });
});

describe("V14 Final Boss (shipped scripts, minimal DOM)", () => {
  const html = pageHtml.replace(/\r\n/g, "\n");
  const regionOf = (name: string): string => {
    const start = html.indexOf(`/* ${name}:start */`);
    const end = html.indexOf(`/* ${name}:end */`);
    expect(start, name).toBeGreaterThan(0);
    expect(end, name).toBeGreaterThan(start);
    return html.slice(start, end);
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };

  describe("Tab 2: cycle edges in the SVG dependency graph", () => {
    const cycleEdges = (edges: Array<{ from: string; to: string }>): string[] => {
      const fn = runInlineScript(`${regionOf("lz-cycle")}; lzCycleEdges`, {}) as (e: unknown) => Record<string, boolean>;
      return Object.keys(fn(edges)).sort();
    };
    it("flags exactly the edges inside a strongly connected component", () => {
      expect(cycleEdges([{ from: "tax.cjs", to: "discount.cjs" }, { from: "discount.cjs", to: "tax.cjs" }, { from: "index.cjs", to: "tax.cjs" }, { from: "index.cjs", to: "discount.cjs" }])).toEqual(["discount.cjs->tax.cjs", "tax.cjs->discount.cjs"]);
      expect(cycleEdges([{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }, { from: "c", to: "d" }])).toEqual(["a->b", "b->c", "c->a"]);
    });
    it("leaves acyclic graphs (and self-requires, which stay a blocking error) unflagged", () => {
      expect(cycleEdges([{ from: "invoice.cjs", to: "money.cjs" }, { from: "invoice.cjs", to: "tax.cjs" }, { from: "tax.cjs", to: "money.cjs" }])).toEqual([]);
      expect(cycleEdges([{ from: "trim.cjs", to: "pad.cjs" }])).toEqual([]);
      expect(cycleEdges([{ from: "self.cjs", to: "self.cjs" }])).toEqual([]);
      expect(cycleEdges([])).toEqual([]);
    });
    it("agrees with the server's analyzeGraph on the shipped presets and on random graphs (property)", () => {
      const clientEdges = (files: Record<string, string>): Array<{ from: string; to: string }> => analyzeGraph(files).edges.map((e) => ({ from: e.from, to: e.to }));
      for (const dir of ["legacy-circular-ledger", "legacy-invoice-engine", "legacy-text-pipeline"]) {
        const files: Record<string, string> = {};
        for (const f of fs.readdirSync(nodePath.join(root, "examples", dir))) files[f] = fs.readFileSync(nodePath.join(root, "examples", dir, f), "utf8");
        const g = analyzeGraph(files);
        expect(cycleEdges(clientEdges(files)), dir).toEqual(g.cycleEdges.map((e) => `${e.from}->${e.to}`).sort());
      }
      fc.assert(
        fc.property(fc.integer({ min: 2, max: 6 }), fc.array(fc.tuple(fc.nat(5), fc.nat(5)), { maxLength: 12 }), (n, pairs) => {
          const files: Record<string, string> = {};
          for (let i = 0; i < n; i++) files[`m${i}.cjs`] = `${[...new Set(pairs.filter(([a, b]) => a % n === i && b % n !== i).map(([, b]) => b % n))].map((d) => `var d${d} = require('./m${d}.cjs');`).join("\n")}\nexports.v = function (x) { return x; };`;
          expect(cycleEdges(clientEdges(files))).toEqual(analyzeGraph(files).cycleEdges.map((e) => `${e.from}->${e.to}`).sort());
        }),
        { numRuns: 60 }
      );
    });
    it("adds legacy-circular-ledger to Tab 2's preset list with the exact example files, amber edges and the pill", () => {
      const graphPane = html.slice(html.indexOf('<div class="studio-pane" id="pane-graph"'), html.indexOf('<div class="studio-pane" id="pane-redteam"'));
      expect(graphPane).toContain('<option value="circular">legacy-circular-ledger (tax &harr; discount, cycle)</option>');
      expect(graphPane).toContain('<option value="invoice">legacy-invoice-engine');
      expect(graphPane).toContain('<option value="text">legacy-text-pipeline');
      for (const f of ["tax.cjs", "discount.cjs", "index.cjs"]) {
        const source = fs.readFileSync(nodePath.join(root, "examples", "legacy-circular-ledger", f), "utf8").replace(/\r\n/g, "\n");
        expect(html, f).toContain(`${JSON.stringify(f)}: ${JSON.stringify(source)}`);
      }
      expect(html).toContain('<span class="cycle-pill" id="graphCyclePill" role="status" hidden></span>');
      expect(html).toContain("#graphSvg .edge.cycle, #graphSvg .edge.cycle.stitched { stroke: #f59e0b;");
      expect(html).toContain('"Cycle Resolved (ESM Live Bindings)"');
      expect(html).toContain('"Cycle detected (resolves as ESM live bindings)"');
      expect(html).toContain('id: "lzArrowCycle"');
      // The acyclic presets keep their geometry and styling: importers sit to the right of their dependencies.
      expect(html).toContain("const backward = a.x <= b.x;");
      expect(html).toContain('x.path.setAttribute("class", "edge" + (x.cycle ? " cycle" : "") + (stitched ? " stitched" : ""));');
      expect(html).toContain("#graphSvg .edge.stitched { stroke: #10b981; stroke-width: 2; }");
    });
  });

  describe("Tab 1: Perf Parity chip", () => {
    const perfApi = (): { label: (p: unknown) => string; cls: (v: string) => string; micros: (n: number) => string } => {
      const out = runInlineScript(`${regionOf("lz-perf")}; ({ label: lzPerfLabel, cls: lzPerfClass, micros: lzPerfMicros })`, {}) as { label: (p: unknown) => string; cls: (v: string) => string; micros: (n: number) => string };
      return out;
    };
    it("labels the chip like `Perf: 1.12x \u00b7 3.4\u00b5s vs 3.8\u00b5s` and classifies the verdict", () => {
      const { label, cls, micros } = perfApi();
      expect(label({ ratio: 1.118, resurrectedMedianUs: 3.4, legacyMedianUs: 3.8 })).toBe("Perf: 1.12x \u00b7 3.4\u00b5s vs 3.8\u00b5s");
      expect(label({ ratio: 0.8, resurrectedMedianUs: 125, legacyMedianUs: 100 })).toBe("Perf: 0.80x \u00b7 125\u00b5s vs 100\u00b5s");
      expect(label({ ratio: 1, resurrectedMedianUs: 0.0215, legacyMedianUs: 0.0215 })).toBe("Perf: 1.00x \u00b7 0.02\u00b5s vs 0.02\u00b5s");
      expect(micros(12.34)).toBe("12.3\u00b5s");
      expect([cls("faster"), cls("parity"), cls("slower")]).toEqual(["pass", "neutral", "warn"]);
    });
    it("sits beside the proof badges, and its script comes before the stale guard (which stays last)", () => {
      expect(html).toContain('<span class="tsc-badge" id="tscBadge" hidden></span>\n              <span class="tsc-badge perf-chip" id="perfBadge" role="status" hidden></span>');
      const perfAt = html.indexOf("Perf Parity chip: POST /api/perf-parity");
      expect(perfAt).toBeGreaterThan(0);
      expect(perfAt).toBeLessThan(html.indexOf("/* lz-stale:start */"));
      const run = html.slice(html.indexOf("async function startRun") > 0 ? html.indexOf("async function startRun") : 0, html.indexOf("let lastStarted = null;"));
      expect(run).not.toContain("perf-parity");
    });

    interface Rig { doc: FakeDocument; chip: FakeElement; calls: Array<{ url: string; body: Record<string, unknown> }>; fire: (type: string, detail: unknown) => void; release: Array<() => void> }
    function rig(respond: (n: number) => Response | Promise<Response>, schema = '{"n":"integer"}'): Rig {
      const doc = new FakeDocument();
      const chip = doc.element("span", "perfBadge");
      chip.hidden = true;
      doc.element("textarea", "schemaJson").value = schema;
      doc.element("textarea", "legacyCode").value = HALVE_SOURCE;
      const calls: Rig["calls"] = [];
      const script = [...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "").find((s) => s.includes("Perf Parity chip: POST /api/perf-parity")) ?? "";
      expect(script.length).toBeGreaterThan(500);
      runInlineScript(script, {
        document: doc,
        CustomEvent: class { constructor(readonly type: string, readonly init?: { detail?: unknown }) {} get detail(): unknown { return this.init?.detail; } },
        fetch: async (url: string, init: RequestInit) => {
          calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
          return respond(calls.length);
        },
      });
      return { doc, chip, calls, release: [], fire: (type, detail) => void doc.dispatchEvent({ type, detail }) };
    }
    const HALVE_SOURCE = "function half(n) { return (n / 2) | 0; }";
    const PAYLOAD = { iterations: 5000, legacyMedianUs: 3.8, resurrectedMedianUs: 3.4, legacyOpsPerSec: 263158, resurrectedOpsPerSec: 294118, ratio: 1.118, verdict: "faster", inputs: 16, elapsedMs: 140, budgetMs: 136 };
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    it("calls POST /api/perf-parity after a proven synchronous resurrection and shows the chip (non-blocking)", async () => {
      const r = rig(() => json(PAYLOAD));
      r.fire("lazarus:run-start", { source: HALVE_SOURCE });
      expect(r.chip.hidden).toBe(true);
      r.fire("lazarus:result", { success: true, modernCode: "Math.trunc(n / 2) || 0" });
      expect(r.chip.hidden).toBe(false);
      expect(r.chip.textContent).toBe("Perf: measuring...");
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]).toEqual({ url: "/api/perf-parity", body: { legacyCode: HALVE_SOURCE, modernCode: "Math.trunc(n / 2) || 0", schema: { n: "integer" } } });
      await settle();
      expect(r.chip.textContent).toBe("Perf: 1.12x \u00b7 3.4\u00b5s vs 3.8\u00b5s");
      expect(r.chip.className).toBe("tsc-badge perf-chip pass");
      expect(r.chip.title).toContain("Verdict: faster");
      expect(r.chip.title).toContain("294118 ops/s");
    });
    it("shows slower and parity verdicts honestly", async () => {
      const slower = rig(() => json({ ...PAYLOAD, ratio: 0.8, verdict: "slower", resurrectedMedianUs: 4.75, legacyMedianUs: 3.8 }));
      slower.fire("lazarus:run-start", { source: HALVE_SOURCE });
      slower.fire("lazarus:result", { success: true, modernCode: "x" });
      await settle();
      expect(slower.chip.textContent).toBe("Perf: 0.80x \u00b7 4.8\u00b5s vs 3.8\u00b5s");
      expect(slower.chip.className).toContain("warn");
      const parity = rig(() => json({ ...PAYLOAD, ratio: 1.01, verdict: "parity" }));
      parity.fire("lazarus:run-start", { source: HALVE_SOURCE });
      parity.fire("lazarus:result", { success: true, modernCode: "x" });
      await settle();
      expect(parity.chip.className).toContain("neutral");
    });
    it("skips with a note for async callback presets and multi-export modules, and for failed runs shows nothing", async () => {
      const r = rig(() => json(PAYLOAD));
      r.fire("lazarus:result", { success: true, asyncCallback: { entry: "legacyReadConfigCb" }, modernCode: "x" });
      expect(r.chip.hidden).toBe(false);
      expect(r.chip.textContent).toBe("Perf: skipped (async callback)");
      r.fire("lazarus:result", { success: true, module: { functions: [] }, modernCode: "x" });
      expect(r.chip.textContent).toBe("Perf: skipped (multi-export module)");
      r.fire("lazarus:result", { success: false, modernCode: "x" });
      expect(r.chip.hidden).toBe(true);
      await settle();
      expect(r.calls).toEqual([]);
    });
    it("discards a stale answer when a newer run started, and reports an unavailable or skipped benchmark", async () => {
      let first: (r: Response) => void = () => undefined;
      const r = rig((n) => (n === 1 ? new Promise<Response>((resolve) => (first = resolve)) : json({ ...PAYLOAD, ratio: 2, verdict: "faster" })));
      r.fire("lazarus:run-start", { source: HALVE_SOURCE });
      r.fire("lazarus:result", { success: true, modernCode: "old" });
      r.fire("lazarus:run-start", { source: HALVE_SOURCE });
      expect(r.chip.hidden).toBe(true);
      r.fire("lazarus:result", { success: true, modernCode: "new" });
      await settle();
      expect(r.chip.textContent).toContain("2.00x");
      first(json({ ...PAYLOAD, ratio: 9, verdict: "faster" }));
      await settle();
      expect(r.chip.textContent).toContain("2.00x");
      const down = rig(() => json({ error: "A performance benchmark is already running" }, 429));
      down.fire("lazarus:result", { success: true, modernCode: "x" });
      await settle();
      expect(down.chip.textContent).toBe("Perf: unavailable");
      expect(down.chip.title).toContain("already running");
      const skip = rig(() => json({ skipped: true, reason: "nothing to time" }));
      skip.fire("lazarus:result", { success: true, modernCode: "x" });
      await settle();
      expect(skip.chip.textContent).toBe("Perf: skipped");
      expect(skip.chip.title).toBe("nothing to time");
    });
    it("omits the schema when the field is not a flat kind map (the server falls back to the scanner)", async () => {
      const r = rig(() => json(PAYLOAD), '{"a":{"n":"integer"}}');
      r.fire("lazarus:result", { success: true, modernCode: "x" });
      expect(r.calls[0]?.body).not.toHaveProperty("schema");
    });
  });

  it("adds no tab, keeps Tab 3 byte-identical, shows 25 Kiro Specs and needs no new dependency", () => {
    expect(html.match(/data-studio-tab="/g)).toHaveLength(3);
    const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
    const start = html.indexOf('/* ---- Red-Team Lab');
    expect(sha(html.slice(start, html.indexOf("\n/* ----", start + 5)))).toBe("e294212e10b8b7a7bff5c10b9f0b09868be7413a98da83c3a1ad5f665433553f");
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "").find((x) => x.includes("Red-Team the Sandbox: one-click containment proofs")) ?? "";
    expect(sha(script)).toBe("3d9381eebc0c47c143dfe25746d5510ef519f9fda66fe0243e4bc6f36be7e633");
    expect(html).toContain('<span class="proof-badge" id="badgeSpecs">25 Kiro Specs</span>');
    const pkg = JSON.parse(fs.readFileSync(nodePath.join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@modelcontextprotocol/sdk", "acorn", "astring", "typescript", "zod"]);
  });
});

describe("V15 Compiler Depth: Shrink Trace waterfall and Rule Blame X-Ray (shipped scripts, minimal DOM)", () => {
  const html = pageHtml.replace(/\r\n/g, "\n");
  const regionOf = (name: string): string => {
    const start = html.indexOf(`/* ${name}:start */`);
    const end = html.indexOf(`/* ${name}:end */`);
    expect(start, name).toBeGreaterThan(0);
    expect(end, name).toBeGreaterThan(start);
    return html.slice(start, end);
  };
  const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

  describe("Shrink Trace", () => {
    const TRACE = {
      initialFailure: { step: 0, input: `text = "${"x".repeat(40)}"`, legacyOutput: "-1424315703", modernOutput: "5.1e+19" },
      steps: [
        { step: 0, input: `text = "${"x".repeat(40)}"`, legacyOutput: "-1424315703", modernOutput: "5.1e+19" },
        { step: 3, input: `text = "${"x".repeat(21)}"`, legacyOutput: "1", modernOutput: "2" },
        { step: 9, input: `text = "${"x".repeat(9)}"`, legacyOutput: "3", modernOutput: "4" },
        { step: 14, input: `text = "${"x".repeat(7)}"`, legacyOutput: "-2147483648", modernOutput: "2147483648" },
      ],
      finalMinimal: { step: 14, input: `text = "${"x".repeat(7)}"`, legacyOutput: "-2147483648", modernOutput: "2147483648" },
      totalShrinks: 14,
    };
    const lib = (): { size: (s: unknown) => number; summary: (t: unknown) => string; widths: (t: unknown) => number[]; nodes: (r: unknown, fmt: (v: unknown) => string) => Array<{ label: string; kind: string; shrink: unknown }> } =>
      runInlineScript(`${regionOf("lz-causal")}; ${regionOf("lz-shrink")}; ({ size: lzShrinkSize, summary: lzShrinkSummary, widths: lzShrinkWidths, nodes: lzCausalNodes })`, {}) as ReturnType<typeof lib>;

    it("summarizes the journey as `40-char input -> ... -> minimal killer` and sizes the bars to the largest input", () => {
      const { size, summary, widths } = lib();
      expect(size(TRACE.initialFailure)).toBe(40);
      expect(size(TRACE.finalMinimal)).toBe(7);
      expect(size({ input: "n = -0" })).toBe(2);
      expect(summary(TRACE)).toBe("40-char input \u2192 \u2026 \u2192 minimal killer (7 chars) \u00b7 14 shrinks");
      expect(summary({ ...TRACE, steps: TRACE.steps.slice(0, 2), totalShrinks: 1, finalMinimal: { ...TRACE.finalMinimal, input: 'text = "x"' } })).toBe("40-char input \u2192 minimal killer (1 char) \u00b7 1 shrink");
      const w = widths(TRACE);
      expect(w[0]).toBe(100);
      expect(w.every((n) => n >= 6 && n <= 100)).toBe(true);
      expect([...w].sort((a, b) => b - a)).toEqual(w);
    });

    it("hangs the trace on the Counterexample Caught node only when the run recorded one", () => {
      const { nodes } = lib();
      const cx = { inputs: { text: "abc" }, shrinkTrace: TRACE };
      const withTrace = nodes({ success: true, attempts: 2, modernCode: "// ast-refine: attempt 2 blamed bitor0-trunc; rolled back bitor0-trunc (trunc-or0 -> off); x", events: [{ type: "counterexample_found", payload: { counterexample: cx } }], certificate: { rolledBack: [] } }, (v) => JSON.stringify(v));
      expect(withTrace[1]?.label).toBe('Counterexample Caught (text = "abc")');
      expect(withTrace[1]?.shrink).toEqual(TRACE);
      expect(withTrace.filter((n) => n.shrink)).toHaveLength(1);
      const without = nodes({ success: true, attempts: 2, modernCode: "x", events: [{ type: "counterexample_found", payload: { counterexample: { inputs: { text: "abc" } } } }], certificate: { rolledBack: ["r"] } }, (v) => JSON.stringify(v));
      expect(without[1]?.shrink).toBeNull();
      const noRollback = nodes({ success: true, attempts: 1, modernCode: "x", events: [], certificate: { rolledBack: [] } }, (v) => JSON.stringify(v));
      expect(noRollback.map((n) => n.label)).toEqual(["AST Lifted", "Exorcist Fuzzed", "Zero Divergences", "100% Exact Parity"]);
      expect(noRollback.every((n) => n.shrink === undefined)).toBe(true);
    });

    it("renders a collapsed `Shrink Trace (N steps)` toggle that opens and closes the waterfall", () => {
      const script = [...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "").find((s) => s.includes("Judge Playground: Self-Healing Matrix")) ?? "";
      expect(script.length).toBeGreaterThan(1000);
      const doc = new FakeDocument();
      for (const id of ["causalStrip", "cxDraft", "cxInput", "cxLegacy", "cxReason", "healingMatrix", "legacyCode", "matrixDiff", "matrixDiffStats", "matrixDraft", "matrixFinal", "matrixFinalTitle", "matrixRules", "matrixSummary", "modernOut", "presetSelect", "probeBtn", "probeCard", "probeChips", "probeInputs", "probeModernSide", "probeNaiveMeta", "probeNaiveSide", "probeResults", "probeStatus", "probeVerdict", "schemaJson", "shrinkWaterfall"]) {
        const el = doc.element("div", id);
        Object.assign(el, { querySelectorAll: () => [] });
      }
      const strip = doc.getElementById("causalStrip") as FakeElement;
      const wf = doc.getElementById("shrinkWaterfall") as FakeElement;
      strip.hidden = true;
      wf.hidden = true;
      const win: Record<string, unknown> = {};
      runInlineScript(script, { document: doc, window: win, fetch: () => Promise.reject(new Error("no network in this test")), CustomEvent: class {} });
      const ui = win["LazarusUI"] as { onResult(r: unknown): void; onRunStart(): void };
      ui.onResult({
        success: true,
        attempts: 2,
        modernCode: "// ast-refine: attempt 2 blamed bitor0-trunc; rolled back bitor0-trunc (trunc-or0 -> off); counterexample {}\nx",
        events: [{ type: "counterexample_found", payload: { counterexample: { inputs: { text: "xxxxxxx" }, shrinkTrace: TRACE } } }],
        certificate: { rolledBack: ["| 0 \u2192 Math.trunc(x) || 0"] },
      });
      expect(strip.hidden).toBe(false);
      const find = (el: FakeElement, pick: (e: FakeElement) => boolean): FakeElement | undefined => (pick(el) ? el : el.children.map((c) => find(c, pick)).find((x) => x !== undefined));
      const toggle = find(strip, (e) => e.id === "shrinkToggle");
      expect(toggle?.textContent).toBe("Shrink Trace (4 steps)");
      expect(toggle?.getAttribute("aria-expanded")).toBe("false");
      expect(toggle?.getAttribute("aria-controls")).toBe("shrinkWaterfall");
      // The toggle lives on the counterexample node, which is the second node.
      const nodes = strip.children.filter((c) => c.className.startsWith("causal-node"));
      expect(nodes[1]?.textContent).toContain("Counterexample Caught");
      expect(find(nodes[1] as FakeElement, (e) => e === toggle)).toBe(toggle);
      expect(nodes.filter((n) => find(n, (e) => e === toggle) !== undefined)).toHaveLength(1);
      // Collapsed by default: nothing rendered, not visible.
      expect(wf.hidden).toBe(true);
      expect(wf.children).toHaveLength(0);
      toggle?.click();
      expect(wf.hidden).toBe(false);
      expect(toggle?.getAttribute("aria-expanded")).toBe("true");
      expect(wf.children[0]?.textContent).toBe("Shrink Trace \u00b7 40-char input \u2192 \u2026 \u2192 minimal killer (7 chars) \u00b7 14 shrinks");
      const rows = wf.children.filter((c) => c.className.startsWith("sw-row"));
      expect(rows).toHaveLength(4);
      expect(rows.map((r) => r.children[0]?.textContent)).toEqual(["#0", "#3", "#9", "#14"]);
      expect(rows[0]?.children[2]?.textContent).toBe(`text = "${"x".repeat(40)}"`);
      expect(rows[3]?.className).toContain("minimal");
      expect(rows[3]?.children[3]?.textContent).toBe("legacy -2147483648 \u00b7 draft 2147483648");
      expect(rows[0]?.children[1]?.children[0]?.style["width"]).toBe("100%");
      toggle?.click();
      expect(wf.hidden).toBe(true);
      expect(toggle?.getAttribute("aria-expanded")).toBe("false");
      // A new result starts collapsed again, and a run without a trace has no toggle.
      toggle?.click();
      ui.onResult({ success: true, attempts: 2, modernCode: "x", events: [{ type: "counterexample_found", payload: { counterexample: { inputs: { n: 1 } } } }], certificate: { rolledBack: ["r"] } });
      expect(wf.hidden).toBe(true);
      expect(find(strip, (e) => e.id === "shrinkToggle")).toBeUndefined();
      ui.onResult({ success: true, attempts: 1, modernCode: "x", events: [], certificate: { rolledBack: [] } });
      expect(find(strip, (e) => e.id === "shrinkToggle")).toBeUndefined();
    });

    it("ships the waterfall element after the strip, hidden, and the styles", () => {
      expect(html).toContain('<div id="shrinkWaterfall" class="shrink-waterfall" role="region" aria-label="Shrink Trace waterfall" hidden></div>');
      expect(html.indexOf('id="causalStrip"')).toBeLessThan(html.indexOf('id="shrinkWaterfall"'));
      expect(html.indexOf('id="shrinkWaterfall"')).toBeLessThan(html.indexOf('id="healingMatrix"'));
      expect(html).toContain(".shrink-waterfall[hidden] { display: none; }");
      expect(html).toContain('toggle.textContent = "Shrink Trace (" + n.shrink.steps.length + " step"');
    });
  });

  describe("Rule Blame X-Ray", () => {
    const LEGACY = "\n\nvar h = 0;\nfor (var i = 0; i < text.length; i++) {\n  h = (h * 31 + text.charCodeAt(i)) | 0;\n}\nh;\n";
    const MODERN = "// Resurrected by Lazarus Necromancer (attempt 2)\n// ast-rules: var-scoping=let-const bitor0-trunc=off\nlet h = 0;\nfor (let i = 0; i < text.length; i++) {\n  h = h * 31 + text.charCodeAt(i) | 0;\n}\nh;";
    // Blame as the server sends it, with legacy lines counted on the untrimmed text (2 blank lines first).
    const BLAME = [
      { rule: "var-scoping", status: "applied", legacyLines: [3, 4], resurrectedLines: [3, 4], sites: 2, reason: "`var` became block-scoped `let`/`const` at 2 sites; the Exorcist found no divergence." },
      { rule: "bitor0-trunc", status: "rolled-back", legacyLines: [5], resurrectedLines: [5], sites: 1, reason: "Rolled back: `x | 0` became `Math.trunc(x) || 0` was blamed for the counterexample text = \"abcdefg\".", counterexample: { attempt: 1, input: 'text = "abcdefg"', legacyOutput: "-1", modernOutput: "2" } },
    ];
    // The page's own renderDiff and diff algorithm, so the rows are exactly what the Studio draws.
    const renderDiff = (doc: FakeDocument): ((container: FakeElement, a: string, b: string, stats: FakeElement | null, expand?: boolean) => void) => {
      const start = html.indexOf("/** Renders a diff with line numbers");
      const end = html.indexOf("window.LazarusDiff = {");
      expect(start).toBeGreaterThan(0);
      return runInlineScript(`${regionOf("lz-diff")}\n${html.slice(start, end)}; renderDiff`, { document: doc }) as ReturnType<typeof renderDiff>;
    };
    interface Rig {
      doc: FakeDocument;
      xray: { setBlame(l: unknown): void; toggle(r: string): void; clear(): void; register(el: FakeElement, rule: string): void; has(r: string): boolean; active(): string | null };
      bar: FakeElement;
      chips: FakeElement;
      callout: FakeElement;
      diffBlock: FakeElement;
      diff: FakeElement;
      toggleBtn: FakeElement;
    }
    function rig(legacy = LEGACY, modern = MODERN): Rig {
      const doc = new FakeDocument();
      const bar = doc.element("div", "xrayBar");
      const chips = doc.element("span", "xrayChips");
      const callout = doc.element("div", "xrayCallout");
      const block = doc.element("div", "legacyDiffBlock");
      const diff = doc.element("div", "legacyDiff");
      const stats = doc.element("span", "legacyDiffStats");
      const toggleBtn = doc.element("button", "legacyDiffToggle");
      block.hidden = true;
      const make = runInlineScript(`${regionOf("lz-xray")}; lzMakeXray`, {}) as (env: unknown) => Rig["xray"];
      const xray = make({ bar, chips, callout, diffBlock: block, diffEl: diff, statsEl: stats, toggle: toggleBtn, legacyText: () => legacy, modernText: () => modern, renderDiff: renderDiff(doc), createEl: (t: string) => doc.createElement(t) });
      return { doc, xray, bar, chips, callout, diffBlock: block, diff, toggleBtn } as unknown as Rig;
    }
    const marked = (r: Rig, cls: string): string[] => r.diff.children.filter((row) => row.className.split(/\s+/).includes(cls)).map((row) => `${row.children[0]?.textContent ?? ""}|${row.children[1]?.textContent ?? ""}`);

    it("computes the lines to mark and the one-line callout, shifting legacy lines by the trimmed blank lines", () => {
      const { marks, leading } = runInlineScript(`${regionOf("lz-xray")}; ({ marks: lzXrayMarks, leading: lzXrayLeading })`, {}) as { marks: (e: unknown, l: number) => { kind: string; legacy: number[]; modern: number[]; callout: string }; leading: (t: string) => number };
      expect(leading(LEGACY)).toBe(2);
      expect(leading("var a;")).toBe(0);
      expect(leading("  \n\t\nvar a;")).toBe(2);
      const m = marks(BLAME[1], 2);
      expect(m).toMatchObject({ kind: "rolled-back", legacy: [3], modern: [5] });
      expect(m.callout).toBe('bitor0-trunc (rolled back): Rolled back: `x | 0` became `Math.trunc(x) || 0` was blamed for the counterexample text = "abcdefg". [legacy line 3 \u2192 resurrected line 5]');
      expect(marks(BLAME[0], 2)).toMatchObject({ kind: "applied", legacy: [1, 2], modern: [3, 4] });
      expect(marks({ rule: "r", status: "applied", legacyLines: [1], resurrectedLines: [], reason: "why" }, 0).callout).toBe("r (applied): why [legacy line 1]");
      expect(marks({ rule: "r", status: "applied", legacyLines: [], resurrectedLines: [], reason: "why" }, 0).callout).toBe("r (applied): why");
    });

    it("renders keyboard-accessible button chips, one per rule, hidden when there is no blame", () => {
      const r = rig();
      r.xray.setBlame(BLAME);
      expect(r.bar.hidden).toBe(false);
      expect(r.chips.children.map((c) => c.tagName)).toEqual(["button", "button"]);
      expect(r.chips.children.map((c) => c.textContent)).toEqual(["var-scoping", "bitor0-trunc \u00b7 rolled back"]);
      expect(r.chips.children.map((c) => c.className)).toEqual(["chip-rule xray-chip xray-applied", "chip-rule xray-chip xray-rolled-back"]);
      expect(r.chips.children.map((c) => c.getAttribute("aria-pressed"))).toEqual(["false", "false"]);
      expect(r.chips.children.every((c) => (c as unknown as { type: string }).type === "button")).toBe(true);
      expect(r.chips.children[1]?.title).toContain("blamed for the counterexample");
      expect(r.xray.has("bitor0-trunc")).toBe(true);
      expect(r.xray.has("function-arrow")).toBe(false);
      r.xray.setBlame([]);
      expect(r.bar.hidden).toBe(true);
      expect(r.chips.children).toHaveLength(0);
      r.xray.setBlame(undefined);
      expect(r.bar.hidden).toBe(true);
    });

    it("highlights the exact lines of an applied rule in green, opens the diff, and shows the callout", () => {
      const r = rig();
      r.xray.setBlame(BLAME);
      expect(r.diffBlock.hidden).toBe(true);
      r.chips.children[0]?.click();
      expect(r.diffBlock.hidden).toBe(false);
      expect(r.toggleBtn.getAttribute("aria-pressed")).toBe("true");
      expect(r.xray.active()).toBe("var-scoping");
      // Legacy lines 1-2 of the trimmed text are `var h = 0;` and `for (var i ...`; their replacements are lines 3-4 of the candidate.
      expect(marked(r, "xray-applied")).toEqual(["1|", "2|", "|3", "|4"]);
      expect(marked(r, "xray-rolled-back")).toEqual([]);
      expect(r.callout.hidden).toBe(false);
      expect(r.callout.className).toBe("xray-callout applied");
      expect(r.callout.textContent).toContain("var-scoping (applied): `var` became block-scoped");
      expect(r.callout.textContent).toContain("[legacy lines 1, 2 \u2192 resurrected lines 3, 4]");
      expect(r.chips.children.map((c) => c.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    });

    it("highlights a rolled-back rule in amber on the lines that kept the legacy `| 0`, with its counterexample reason", () => {
      const r = rig();
      r.xray.setBlame(BLAME);
      r.chips.children[1]?.click();
      // The kept `| 0` line is printed without its redundant parentheses, so it is a removed row (old 3) and an added row (new 5).
      expect(marked(r, "xray-rolled-back")).toEqual(["3|", "|5"]);
      expect(marked(r, "xray-applied")).toEqual([]);
      expect(r.callout.className).toBe("xray-callout rolled-back");
      expect(r.callout.textContent).toContain("bitor0-trunc (rolled back): Rolled back: `x | 0` became");
      expect(r.callout.textContent).toContain("[legacy line 3 \u2192 resurrected line 5]");
    });

    it("selecting another chip moves the highlight; selecting the active chip again clears it and the callout", () => {
      const r = rig();
      r.xray.setBlame(BLAME);
      r.chips.children[0]?.click();
      r.chips.children[1]?.click();
      expect(marked(r, "xray-applied")).toEqual([]);
      expect(marked(r, "xray-rolled-back")).toEqual(["3|", "|5"]);
      expect(r.chips.children.map((c) => c.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
      r.chips.children[1]?.click();
      expect(r.xray.active()).toBeNull();
      expect(marked(r, "xray-applied")).toEqual([]);
      expect(marked(r, "xray-rolled-back")).toEqual([]);
      expect(r.callout.hidden).toBe(true);
      expect(r.callout.textContent).toBe("");
      expect(r.chips.children.map((c) => c.getAttribute("aria-pressed"))).toEqual(["false", "false"]);
      // The diff was closed before the first click, so it is closed again.
      expect(r.diffBlock.hidden).toBe(true);
      expect(r.toggleBtn.getAttribute("aria-pressed")).toBe("false");
    });

    it("keeps an already-open diff open, and goes back to its collapsed view when cleared", () => {
      const r = rig();
      r.diffBlock.hidden = false;
      r.xray.setBlame(BLAME);
      r.xray.toggle("var-scoping");
      expect(r.diff.children.some((row) => row.className.includes("d-gap"))).toBe(false);
      r.xray.clear();
      expect(r.diffBlock.hidden).toBe(false);
      expect(marked(r, "xray-applied")).toEqual([]);
    });

    it("registers external chips (the Self-Healing Matrix) so they share the pressed state", () => {
      const r = rig();
      r.xray.setBlame(BLAME);
      const matrixChip = r.doc.createElement("button");
      r.xray.register(matrixChip, "bitor0-trunc");
      expect(matrixChip.getAttribute("aria-pressed")).toBe("false");
      r.xray.toggle("bitor0-trunc");
      expect(matrixChip.getAttribute("aria-pressed")).toBe("true");
      r.xray.toggle("var-scoping");
      expect(matrixChip.getAttribute("aria-pressed")).toBe("false");
      r.xray.toggle("not-a-rule");
      expect(r.xray.active()).toBe("var-scoping");
    });

    it("a new run or result resets the bar, the highlight and the diff it opened", () => {
      const r = rig();
      r.xray.setBlame(BLAME);
      r.xray.toggle("var-scoping");
      expect(r.diffBlock.hidden).toBe(false);
      r.xray.setBlame([]);
      expect(r.diffBlock.hidden).toBe(true);
      expect(r.bar.hidden).toBe(true);
      expect(r.callout.hidden).toBe(true);
      expect(r.xray.active()).toBeNull();
    });

    it("ships the bar markup, the row styles, and wires the chips of the Self-Healing Matrix", () => {
      expect(html).toContain('<div id="xrayBar" class="xray-bar" hidden>');
      expect(html).toContain('<div id="xrayCallout" class="xray-callout" role="status" aria-live="polite" hidden></div>');
      expect(html).toContain(".d-row.xray-applied { box-shadow: inset 3px 0 0 var(--emerald);");
      expect(html).toContain(".d-row.xray-rolled-back { box-shadow: inset 3px 0 0 var(--amber);");
      expect(html).toContain("button.xray-chip:focus-visible { outline: 2px solid var(--violet);");
      expect(html).toContain('chip("blamed", "AST rule blamed: " + refine.blamed, refine.blamed)');
      expect(html).toContain('chips.append(chip("active", p[0] + " \\u00b7 " + p[1], p[0]))');
      expect(html).toContain('document.addEventListener("lazarus:result", (e) => { const r = e.detail || {}; xray.setBlame(r.success ? r.ruleBlame : []); });');
      expect(html.indexOf('id="xrayBar"')).toBeLessThan(html.indexOf('id="healingMatrix"'));
      expect(html.indexOf('id="causalStrip"')).toBeLessThan(html.indexOf('id="xrayBar"'));
    });
  });

  it("ships Preset 12 and Preset 13 in the Tab 1 dropdown and a Promise-chain note, without a new tab", () => {
    expect(html).toContain('label: "Preset 12: ES5 Inheritance (Object.create + arguments.apply -> class extends + rest/spread)"');
    expect(html).toContain('label: "Preset 13: Promise Chain (.then().catch() -> async/await try/catch)"');
    expect(html).toContain('value: "legacySubclassMeter"');
    expect(html).toContain('value: "legacyPromiseChain"');
    expect(html).toContain('a.kind === "promise-chain" ? "Promise chain \\u2192 async/await. " : "Error-first callback \\u2192 async/await. "');
    expect(html.match(/data-studio-tab="/g)).toHaveLength(3);
    const pane = html.slice(html.indexOf('<div class="studio-pane" id="pane-single"'), html.indexOf('<div class="studio-pane" id="pane-graph"'));
    expect(pane).toContain('id="xrayBar"');
    expect(pane).toContain('id="shrinkWaterfall"');
  });

  it("keeps Tab 3 Red-Team byte-identical (the three SHA-256 invariants) and shows 25 Kiro Specs", () => {
    const between = (a: string, b: string): string => {
      const s = html.indexOf(a);
      const e = html.indexOf(b, s + a.length);
      expect(s).toBeGreaterThan(0);
      expect(e).toBeGreaterThan(s);
      return html.slice(s, e);
    };
    expect(sha(between("/* ---- Red-Team Lab", "\n/* ----"))).toBe("e294212e10b8b7a7bff5c10b9f0b09868be7413a98da83c3a1ad5f665433553f");
    expect(sha(between('<div class="studio-pane" id="pane-redteam"', '<div class="dna-scrim"'))).toBe("31457f48198687cc71b80f53a110ac4a47aa1302edea87b783cf3f19a021fee1");
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "").find((x) => x.includes("Red-Team the Sandbox: one-click containment proofs")) ?? "";
    expect(sha(script)).toBe("3d9381eebc0c47c143dfe25746d5510ef519f9fda66fe0243e4bc6f36be7e633");
    expect(html).toContain('<span class="proof-badge" id="badgeSpecs">25 Kiro Specs</span>');
    const tab3 = between('<div class="studio-pane" id="pane-redteam"', '<div class="dna-scrim"');
    expect(tab3).not.toMatch(/xray|shrink|ruleBlame|legacySubclassMeter|legacyPromiseChain/i);
  });
});