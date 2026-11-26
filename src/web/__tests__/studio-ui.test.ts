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

  it("shows the hooks and the Kiro Power in the Kiro DNA drawer, and the 20-spec badge", () => {
    expect(pageHtml).toContain('<div class="dna-grid" id="dnaHooks"></div>');
    expect(pageHtml).toContain('"Agent hooks (" + dna.hooks.length + ")"');
    expect(pageHtml).toContain('<span class="proof-badge" id="badgeSpecs">20 Kiro Specs</span>');
    expect(pageHtml).toContain('<div class="dna-power" id="dnaPower"></div>');
    expect(pageHtml).toContain('"Installable Kiro Power (" + power.name + ")"');
    expect(pageHtml).toContain('copy.id = "dnaPowerCopy";');
    expect(pageHtml.indexOf('id="dnaPower"')).toBeLessThan(pageHtml.indexOf('id="dnaAgents"'));
  });
});
