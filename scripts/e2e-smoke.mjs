// Live-browser E2E smoke test of the real Lazarus Studio. Zero dependencies beyond what the repo already has: Node's http,
// child_process, fs and the built-in WebSocket, plus Edge or Chrome speaking the DevTools Protocol (CDP).
//
//   npm run test:e2e                       boots the Studio on an ephemeral port, drives it in headless Edge/Chrome
//   E2E_BROWSER="C:\path\to\chrome.exe" npm run test:e2e
//   npm run test:e2e -- --require-browser  exit 1 (instead of skipping) when no browser is installed
//   npm run test:e2e -- --headed           show the window while it runs
//
// Any console.error, uncaught exception, failed own-origin request or failed check makes the run exit 1.
// With no browser binary it prints a clear message and exits 0 (CI machines without a browser).
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
];

// ---------------------------------------------------------------------------------------------------------------------
// Browser discovery
// ---------------------------------------------------------------------------------------------------------------------
/** Path of an installed Edge or Chrome, or undefined. `E2E_BROWSER` wins. */
export function findBrowser(env = process.env, platform = process.platform, exists = fs.existsSync) {
  if (env.E2E_BROWSER) return exists(env.E2E_BROWSER) ? env.E2E_BROWSER : undefined;
  const candidates = [];
  if (platform === "win32") {
    for (const base of [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA]) {
      if (!base) continue;
      candidates.push(nodePath.join(base, "Microsoft", "Edge", "Application", "msedge.exe"), nodePath.join(base, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else if (platform === "darwin") {
    candidates.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    for (const dir of (env.PATH ?? "").split(nodePath.delimiter)) {
      for (const name of ["microsoft-edge", "microsoft-edge-stable", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) if (dir) candidates.push(nodePath.join(dir, name));
    }
  }
  return candidates.find((c) => exists(c));
}

// ---------------------------------------------------------------------------------------------------------------------
// A small CDP client
// ---------------------------------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params ?? {});
    }
  });
  ws.addEventListener("close", () => {
    for (const p of pending.values()) p.reject(new Error("the browser connection closed"));
    pending.clear();
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, fn) {
      listeners.set(method, [...(listeners.get(method) ?? []), fn]);
    },
    close() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

async function waitForFile(file, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const text = fs.readFileSync(file, "utf8");
      if (text.split("\n").length >= 2) return text;
    } catch {
      /* not written yet */
    }
    await sleep(100);
  }
  throw new Error(`the browser did not start (no ${nodePath.basename(file)} within ${timeoutMs / 1000} s)`);
}

function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

async function launchBrowser(exe, profileDir) {
  const flags = [
    args.has("--headed") ? "" : "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--mute-audio",
    "--hide-scrollbars",
    ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    "about:blank",
  ].filter(Boolean);
  const child = spawn(exe, flags, { stdio: "ignore", detached: process.platform !== "win32", windowsHide: true });
  child.on("error", () => undefined);
  const active = await waitForFile(nodePath.join(profileDir, "DevToolsActivePort"), 20_000);
  const port = Number(active.split("\n")[0]);
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("the browser has no page target");
  return { child, cdp: await connect(page.webSocketDebuggerUrl) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The Studio, in this process, on an ephemeral port
// ---------------------------------------------------------------------------------------------------------------------
async function startStudio() {
  const { register } = await import("tsx/esm/api");
  register();
  const { createWebServer } = await import(pathToFileURL(nodePath.join(root, "src", "web", "server.ts")).href);
  const server = createWebServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      try {
        const { closeSharedTsVerifier } = await import(pathToFileURL(nodePath.join(root, "src", "crew", "ts-verifier.ts")).href);
        await closeSharedTsVerifier();
      } catch {
        /* nothing to close */
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// In-page helpers (plain strings evaluated in the Studio page)
// ---------------------------------------------------------------------------------------------------------------------
/** Layout facts: horizontal overflow, header badges and open drawers. */
const LAYOUT = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight, de = document.documentElement;
  const label = (n) => n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + (typeof n.className === "string" && n.className ? "." + n.className.trim().split(/\\s+/).join(".") : "");
  const clipped = (n) => {
    for (let p = n.parentElement; p && p !== document.body && p !== de; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o !== "visible") { const r = p.getBoundingClientRect(); if (r.right <= vw + 1 && r.left >= -1) return true; }
    }
    return false;
  };
  const offenders = [];
  for (const n of document.body.querySelectorAll("*")) {
    if (n.closest("[hidden]") || n.closest("svg") && n.tagName.toLowerCase() !== "svg") continue;
    const cs = getComputedStyle(n);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed") continue;
    const r = n.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1 && !clipped(n)) offenders.push(label(n) + " right=" + Math.round(r.right));
  }
  const badge = (id) => { const n = document.getElementById(id); if (!n) return null; const r = n.getBoundingClientRect(); return { text: n.textContent.trim(), visible: r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= vw + 1 && getComputedStyle(n).visibility !== "hidden" }; };
  const openDrawers = [...document.querySelectorAll(".dna-drawer")].filter((d) => !d.hidden).map((d) => d.id);
  const openScrims = [...document.querySelectorAll(".dna-scrim")].filter((d) => !d.hidden).map((d) => d.id);
  const drawerBox = openDrawers.map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return { id, left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; });
  return { vw, vh, scrollWidth: de.scrollWidth, bodyScrollWidth: document.body.scrollWidth, offenders: offenders.slice(0, 6), badges: { specs: badge("badgeSpecs"), tests: badge("badgeTests") }, openDrawers, openScrims, drawerBox };
})()`;

// ---------------------------------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------------------------------
async function main() {
  const exe = findBrowser();
  if (!exe) {
    const msg = process.env.E2E_BROWSER ? `E2E_BROWSER is set to "${process.env.E2E_BROWSER}", which does not exist.` : "no Edge or Chrome found (set E2E_BROWSER to a browser executable).";
    console.log(`e2e-smoke: SKIPPED: ${msg}`);
    return args.has("--require-browser") ? 1 : 0;
  }
  const started = Date.now();
  const profileDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-e2e-"));
  let studio;
  let browser;
  const failures = [];
  const browserErrors = [];
  let checks = 0;
  try {
    console.log(`e2e-smoke: browser ${exe}`);
    studio = await startStudio();
    console.log(`e2e-smoke: Studio on ${studio.url}`);
    browser = await launchBrowser(exe, profileDir);
    const { cdp } = browser;
    for (const domain of ["Page", "Runtime", "Log", "Network"]) await cdp.send(`${domain}.enable`);
    const origin = new URL(studio.url).origin;
    cdp.on("Runtime.consoleAPICalled", (p) => {
      if (p.type === "error") browserErrors.push(`console.error: ${(p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(" ")}`);
    });
    cdp.on("Runtime.exceptionThrown", (p) => browserErrors.push(`uncaught exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "unknown"}`));
    cdp.on("Log.entryAdded", (p) => {
      if (p.entry?.level === "error") browserErrors.push(`log error (${p.entry.source}): ${p.entry.text} ${p.entry.url ?? ""}`);
    });
    const requests = new Map();
    cdp.on("Network.requestWillBeSent", (p) => requests.set(p.requestId, p.request.url));
    cdp.on("Network.loadingFailed", (p) => {
      const url = requests.get(p.requestId) ?? "";
      if (url.startsWith(origin) && !p.canceled && p.errorText !== "net::ERR_ABORTED") browserErrors.push(`request failed: ${url} (${p.errorText})`);
    });

    const evaluate = async (expression) => {
      const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`in page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    };
    const waitFor = async (expression, what, timeoutMs = 30_000) => {
      const end = Date.now() + timeoutMs;
      let last;
      while (Date.now() < end) {
        try {
          last = await evaluate(expression);
          if (last) return last;
        } catch (err) {
          last = String(err.message);
        }
        await sleep(120);
      }
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}${typeof last === "string" ? ` (${last})` : ""}`);
    };
    const key = async (name, code, vk, modifiers = 0) => {
      const base = { key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    };
    const check = (cond, message) => {
      checks++;
      if (!cond) throw new Error(message);
    };
    const step = async (name, fn) => {
      const t0 = Date.now();
      const errorsBefore = browserErrors.length;
      try {
        await fn();
        const newErrors = browserErrors.slice(errorsBefore);
        if (newErrors.length) throw new Error(`browser errors: ${newErrors.join(" | ")}`);
        console.log(`  ok    ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      } catch (err) {
        failures.push(`${name}: ${err.message}`);
        console.log(`  FAIL  ${name}: ${err.message}`);
      }
    };
    const load = async (viewport) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
      await cdp.send("Page.navigate", { url: studio.url + "/" });
      await waitFor(`document.readyState === "complete" && !!document.getElementById("runBtn") && !!window.LazarusDrawers`, "the Studio page to load", 20_000);
      await evaluate(`window.__e2e = { results: [], starts: 0 }; document.addEventListener("lazarus:result", (e) => window.__e2e.results.push({ name: e.detail && e.detail.name, success: !!(e.detail && e.detail.success) })); document.addEventListener("lazarus:run-start", () => window.__e2e.starts++); true`);
    };

    // ---- 1. Initial render at both viewports ----
    for (const vp of VIEWPORTS) {
      await step(`initial render ${vp.width}x${vp.height}: no overflow, badges visible, no open drawer`, async () => {
        await load(vp);
        for (const tab of ["single", "graph", "redteam"]) {
          await evaluate(`document.querySelector('[data-studio-tab="${tab}"]').click(); true`);
          await sleep(150);
          const l = await evaluate(LAYOUT);
          check(l.scrollWidth <= l.vw, `${tab}: page scrollWidth ${l.scrollWidth} > viewport ${l.vw}`);
          check(l.offenders.length === 0, `${tab}: elements past the right edge: ${l.offenders.join(", ")}`);
          check(l.openDrawers.length === 0 && l.openScrims.length === 0, `${tab}: a drawer or scrim is open at load`);
          check(l.badges.specs?.visible && l.badges.tests?.visible, `${tab}: header badges not visible (${JSON.stringify(l.badges)})`);
        }
        await evaluate(`document.querySelector('[data-studio-tab="single"]').click(); true`);
        const l = await evaluate(LAYOUT);
        check(/^\d+ Kiro Specs$/.test(l.badges.specs.text) && /^[\d,]+ Verified Tests$/.test(l.badges.tests.text), `unexpected badge text ${JSON.stringify(l.badges)}`);
        check((await evaluate(`document.querySelectorAll("[data-studio-tab]").length`)) === 3, "the Studio must have exactly 3 tabs");
      });
    }

    // ---- 1b. Keyboard focus ring ----
    await step("keyboard: the first header controls show a visible focus ring", async () => {
      await load(VIEWPORTS[1]);
      const seen = [];
      for (let i = 0; i < 6; i++) {
        await key("Tab", "Tab", 9);
        seen.push(await evaluate(`(() => { const a = document.activeElement; if (!a || a === document.body) return null; const cs = getComputedStyle(a); return { id: a.id || a.tagName, style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) }; })()`));
      }
      check(seen.every((s) => s !== null), `Tab did not reach controls: ${JSON.stringify(seen)}`);
      const bare = seen.filter((s) => s.style === "none" || s.width < 1);
      check(bare.length === 0, `controls without a focus ring: ${JSON.stringify(bare)}`);
    });
    // ---- 2. Drawers: click, Escape, one at a time, focus return, no overflow at either viewport ----
    for (const vp of VIEWPORTS) {
      await step(`drawers ${vp.width}x${vp.height}: open by click, one at a time, Escape closes and restores focus`, async () => {
        await load(vp);
        for (const [btn, drawer] of [["sarifBtn", "sarifDrawer"], ["verifyBtn", "verifyDrawer"], ["dnaBtn", "dnaDrawer"]]) {
          await evaluate(`document.getElementById("${btn}").focus(); document.getElementById("${btn}").click(); true`);
          await waitFor(`!document.getElementById("${drawer}").hidden`, `${drawer} to open`, 5_000);
          await sleep(450); // the drawer slides in over 0.22 s; measure it at rest
          const l = await evaluate(LAYOUT);
          check(l.openDrawers.join() === drawer && l.openScrims.length === 1, `${drawer}: open drawers ${l.openDrawers}, scrims ${l.openScrims}`);
          check(l.scrollWidth <= l.vw, `${drawer}: page scrollWidth ${l.scrollWidth} > viewport ${l.vw}`);
          const box = l.drawerBox[0];
          check(box.left >= 0 && box.right <= l.vw + 1 && box.top >= 0 && box.bottom <= l.vh + 1, `${drawer} does not fit the viewport: ${JSON.stringify(box)}`);
          check((await evaluate(`document.getElementById("${btn}").getAttribute("aria-expanded")`)) === "true", `${btn}: aria-expanded not true`);
          check((await evaluate(`document.getElementById("${drawer}").contains(document.activeElement)`)) === true, `${drawer}: focus did not move into the drawer`);
          await key("Escape", "Escape", 27);
          await waitFor(`document.getElementById("${drawer}").hidden`, `${drawer} to close on Escape`, 5_000);
          check((await evaluate(`document.activeElement && document.activeElement.id`)) === btn, `${drawer}: focus did not return to #${btn}`);
          const after = await evaluate(LAYOUT);
          check(after.openDrawers.length === 0 && after.openScrims.length === 0, `${drawer}: something is still open after Escape`);
        }
        // Mutual exclusion: opening the next drawer closes the one that is open.
        await evaluate(`document.getElementById("verifyBtn").click(); true`);
        await waitFor(`!document.getElementById("verifyDrawer").hidden`, "Verify Bundle to open", 5_000);
        await evaluate(`document.getElementById("sarifBtn").click(); true`);
        await waitFor(`!document.getElementById("sarifDrawer").hidden`, "SARIF Audit to open", 5_000);
        let l = await evaluate(LAYOUT);
        check(l.openDrawers.join() === "sarifDrawer" && l.openScrims.join() === "sarifScrim", `drawers stacked: ${l.openDrawers}, scrims ${l.openScrims}`);
        await evaluate(`document.getElementById("dnaBtn").click(); true`);
        await waitFor(`!document.getElementById("dnaDrawer").hidden`, "Kiro DNA to open", 5_000);
        l = await evaluate(LAYOUT);
        check(l.openDrawers.join() === "dnaDrawer" && l.openScrims.join() === "dnaScrim", `drawers stacked: ${l.openDrawers}, scrims ${l.openScrims}`);
        // Tab never leaves an open drawer.
        for (let i = 0; i < 40; i++) await key("Tab", "Tab", 9);
        check((await evaluate(`document.getElementById("dnaDrawer").contains(document.activeElement)`)) === true, "Tab moved focus out of the open drawer");
        for (let i = 0; i < 6; i++) await key("Tab", "Tab", 9, 8);
        check((await evaluate(`document.getElementById("dnaDrawer").contains(document.activeElement)`)) === true, "Shift+Tab moved focus out of the open drawer");
        await key("Escape", "Escape", 27);
        await waitFor(`document.getElementById("dnaDrawer").hidden`, "Kiro DNA to close on Escape", 5_000);
        // The scrim and the Close buttons still work.
        await evaluate(`document.getElementById("verifyBtn").click(); true`);
        await evaluate(`document.getElementById("verifyClose").click(); true`);
        check((await evaluate(`document.getElementById("verifyDrawer").hidden`)) === true, "Verify Bundle Close button did not close it");
        await evaluate(`document.getElementById("sarifBtn").click(); true`);
        await evaluate(`document.getElementById("sarifScrim").click(); true`);
        check((await evaluate(`document.getElementById("sarifDrawer").hidden`)) === true, "the SARIF scrim did not close it");
      });
    }

    // ---- 3. Tab 1: the Guided Tour resurrects stringHash32 (mutation audit and probe included) and auto-docks ----
    await step("Tab 1: Guided Tour resurrects stringHash32 and auto-docks the banner", async () => {
      await load(VIEWPORTS[0]);
      await evaluate(`document.getElementById("tourBtn").click(); true`);
      await waitFor(`!document.getElementById("tourHud").hidden`, "the tour banner", 10_000);
      await waitFor(`/Tour complete/.test(document.getElementById("tourPillText").textContent) || /Tour stopped/.test(document.getElementById("tourPillText").textContent)`, "the tour to finish", 90_000);
      const state = await evaluate(`({ text: document.getElementById("tourPillText").textContent, docked: document.getElementById("tourHud").classList.contains("docked"), body: document.body.classList.contains("tour-docked"), results: window.__e2e.results })`);
      check(/Tour complete/.test(state.text), `the tour did not complete: ${state.text}`);
      check(state.docked && state.body, "the tour banner did not dock into the corner pill");
      check(state.results.some((r) => r.name === "stringHash32" && r.success), `no successful stringHash32 result (${JSON.stringify(state.results)})`);
    });
    await step("Tab 1: Causal Strip, Perf Parity chip, tsc --strict, Mutant Autopsy render", async () => {
      const strip = await evaluate(`({ hidden: document.getElementById("causalStrip").hidden, nodes: document.querySelectorAll("#causalStrip .causal-node").length })`);
      check(!strip.hidden && strip.nodes >= 3, `Causal Strip not rendered (${JSON.stringify(strip)})`);
      await waitFor(`!document.getElementById("perfBadge").hidden && /^Perf: /.test(document.getElementById("perfBadge").textContent)`, "the Perf Parity chip", 30_000);
      check((await evaluate(`document.getElementById("tscBadge").textContent`)) === "tsc --strict: 0 errors", "tsc --strict: 0 errors not shown");
      const score = await evaluate(`document.getElementById("mutScore").textContent`);
      check(/\d+\s*\/\s*\d+/.test(score) || /killed/i.test(score), `no mutation score: ${score}`);
      await evaluate(`document.getElementById("mutScore").click(); true`);
      await waitFor(`!document.getElementById("mutAutopsy").hidden`, "the Mutant Autopsy panel", 10_000);
      // Escape collapses the expanded popover and puts focus on it.
      check((await evaluate(`document.getElementById("mutScore").getAttribute("aria-expanded")`)) === "true", "Mutant Autopsy toggle is not expanded");
      await key("Escape", "Escape", 27);
      await waitFor(`document.getElementById("mutScore").getAttribute("aria-expanded") !== "true"`, "Escape to collapse the Mutant Autopsy", 5_000);
      check((await evaluate(`document.activeElement && document.activeElement.id`)) === "mutScore", "focus did not move to the collapsed Mutant Autopsy toggle");
    });
    await step("Tab 1: Compare vs. Naive AI shows the trap card with a busy state while it runs", async () => {
      await waitFor(`!document.getElementById("naiveBtn").hidden`, "the Compare vs. Naive AI button", 10_000);
      const busy = await evaluate(`(() => { const b = document.getElementById("naiveBtn"); b.click(); return { busy: b.getAttribute("aria-busy"), disabled: b.disabled }; })()`);
      check(busy.busy === "true" && busy.disabled === true, `no busy state right after the click: ${JSON.stringify(busy)}`);
      await waitFor(`!document.getElementById("trapCard").hidden && document.getElementById("trapCard").textContent.length > 20`, "the trap card", 40_000);
      check((await evaluate(`document.getElementById("naiveBtn").getAttribute("aria-busy")`)) === null, "aria-busy is still set after the comparison");
      check(/Compare vs\. Naive AI/.test(await evaluate(`document.getElementById("naiveBtn").textContent`)), "the button text did not come back");
    });
    await step("Tab 1: 3-Way Judge Probe runs with Legacy, Naive AI and Lazarus sides", async () => {
      const busy = await evaluate(`(() => { const b = document.getElementById("probeBtn"); b.click(); return { busy: b.getAttribute("aria-busy"), disabled: b.disabled }; })()`);
      check(busy.busy === "true" && busy.disabled === true, `RUN PROBE has no busy state: ${JSON.stringify(busy)}`);
      await waitFor(`document.getElementById("probeBtn").getAttribute("aria-busy") === null && !document.getElementById("probeBtn").disabled`, "the probe to finish", 30_000);
      const sides = await evaluate(`({ legacy: document.getElementById("probeLegacyVal").textContent, modern: document.getElementById("probeModernVal").textContent, naiveShown: !document.getElementById("probeNaiveSide").hidden })`);
      check(sides.legacy !== "" && sides.modern !== "", `probe sides empty: ${JSON.stringify(sides)}`);
      check(sides.naiveShown, "the Naive AI side of the 3-way probe is not shown");
    });
    await step("Tab 1: Ed25519 certificate verifies, a 1-byte tamper is caught offline or by the API, Restore recovers", async () => {
      await waitFor(`document.getElementById("certSigBadge") && /VERIFIED/.test(document.getElementById("certSigBadge").textContent)`, "the Ed25519 badge to verify", 30_000);
      const pill = await evaluate(`({ hidden: document.getElementById("certOfflinePill").hidden, text: document.getElementById("certOfflinePill").textContent })`);
      console.log(`        Ed25519 path: ${pill.hidden ? "Studio API fallback (this browser has no WebCrypto Ed25519)" : pill.text}`);
      const busy = await evaluate(`(() => { const b = document.getElementById("certTamperBtn"); b.click(); return { busy: b.getAttribute("aria-busy"), disabled: b.disabled }; })()`);
      check(busy.disabled === true, "Simulate 1-Byte Tamper stayed enabled while it ran");
      await waitFor(`/TAMPER DETECTED/.test(document.getElementById("certSigBadge").textContent)`, "TAMPER DETECTED", 20_000);
      check((await evaluate(`document.getElementById("certTamperBtn").getAttribute("aria-busy")`)) === null, "aria-busy is still set after the tamper check");
      check((await evaluate(`document.getElementById("certRestoreBtn").hidden`)) === false, "Restore Verified is not shown");
      await evaluate(`document.getElementById("certRestoreBtn").click(); true`);
      await waitFor(`/VERIFIED/.test(document.getElementById("certSigBadge").textContent) && !/TAMPER/.test(document.getElementById("certSigBadge").textContent)`, "Restore Verified to re-verify", 20_000);
    });
    await step("Tab 1: SARIF Audit runs on the editor code and shows 7 rule chips, with a busy button", async () => {
      await evaluate(`document.getElementById("sarifBtn").click(); true`);
      await waitFor(`!document.getElementById("sarifDrawer").hidden`, "the SARIF drawer", 5_000);
      const busy = await evaluate(`(() => { const b = document.getElementById("sarifRun"); b.click(); return { busy: b.getAttribute("aria-busy"), disabled: b.disabled, text: b.textContent }; })()`);
      check(busy.busy === "true" && busy.disabled === true && busy.text === "Run SARIF Audit", `Run SARIF Audit busy state: ${JSON.stringify(busy)}`);
      await waitFor(`document.getElementById("sarifChips").children.length === 7 && document.getElementById("sarifRun").getAttribute("aria-busy") === null`, "7 rule chips", 20_000);
      check((await evaluate(`document.getElementById("sarifDownload").disabled`)) === false, "Download .sarif is still disabled after an audit");
      await key("Escape", "Escape", 27);
      await waitFor(`document.getElementById("sarifDrawer").hidden`, "the SARIF drawer to close", 5_000);
    });

    // ---- 4. Async presets ----
    for (const [preset, what] of [["legacyReadConfigCb", "error-first callback"], ["legacyPromiseChain", "Promise chain"]]) {
      await step(`Tab 1: ${preset} (${what}) resurrects to async/await with tsc --strict: 0 errors`, async () => {
        await load(VIEWPORTS[1]);
        await evaluate(`(() => { const s = document.getElementById("presetSelect"); s.value = "${preset}"; s.dispatchEvent(new Event("change")); document.getElementById("runBtn").click(); return true; })()`);
        await waitFor(`window.__e2e.results.some((r) => r.name === "${preset}")`, `the ${preset} result`, 90_000);
        const out = await evaluate(`({ ok: window.__e2e.results.find((r) => r.name === "${preset}").success, code: document.getElementById("modernOut").textContent, tsc: document.getElementById("tscBadge").textContent, note: document.getElementById("asyncNote").hidden ? "" : document.getElementById("asyncNote").textContent })`);
        check(out.ok, `${preset}: parity was not proven`);
        check(/async/.test(out.code) && /await/.test(out.code), `${preset}: the resurrected code is not async/await`);
        check(out.tsc === "tsc --strict: 0 errors", `${preset}: ${out.tsc}`);
        check(out.note !== "", `${preset}: no async note shown`);
      });
    }

    // ---- 4b. V18: legacyLeakyMutator, the 5-Pill Proof Strip, SARIF LAZ008, the offline report and the PR Preview drawer ----
    await step("Tab 1: legacyLeakyMutator repairs the leaked global (let total), proves parity + purity, tsc --strict: 0 errors", async () => {
      await load(VIEWPORTS[1]);
      await evaluate(`(() => { const s = document.getElementById("presetSelect"); s.value = "legacyLeakyMutator"; s.dispatchEvent(new Event("change")); document.getElementById("runBtn").click(); return true; })()`);
      await waitFor(`window.__e2e.results.some((r) => r.name === "legacyLeakyMutator")`, "the legacyLeakyMutator result", 90_000);
      const out = await evaluate(`({ ok: window.__e2e.results.find((r) => r.name === "legacyLeakyMutator").success, code: document.getElementById("modernOut").textContent, tsc: document.getElementById("tscBadge").textContent })`);
      check(out.ok, "legacyLeakyMutator: parity was not proven");
      check(/let total = 0;/.test(out.code), "the leaked accumulator was not declared with let");
      check(!/^\s*total = 0;/m.test(out.code), "the resurrected code still assigns an undeclared total");
      check(out.tsc === "tsc --strict: 0 errors", `legacyLeakyMutator: ${out.tsc}`);
      const rb = await evaluate(`Array.from(document.querySelectorAll("#xrayChips button")).map((b) => b.textContent).join("|")`);
      check(/global-leak-fix/.test(rb), `Rule Blame X-Ray has no global-leak-fix chip: ${rb}`);
    });
    await step("Tab 1: the 5-Pill Proof Strip shows the five pillars and each pill opens its detail", async () => {
      const strip = await evaluate(`({ hidden: document.getElementById("proofStrip").hidden, ids: Array.from(document.querySelectorAll("#proofStrip .proof-pill")).map((b) => b.id) })`);
      check(!strip.hidden, "the proof strip is hidden after a resurrection");
      check(strip.ids.join() === "pillParity,pillPurity,pillMutants,pillEd,pillPerf", `pills: ${strip.ids}`);
      const text = (id) => evaluate(`document.getElementById("${id}").lastElementChild.textContent`);
      const tone = (id) => evaluate(`document.getElementById("${id}").dataset.tone`);
      check(/^PROVEN/.test(await text("pillParity")) && (await tone("pillParity")) === "ok", "parity pill is not proven");
      check(/^Fixed 1 leak$/.test(await text("pillPurity")) && (await tone("pillPurity")) === "ok", `purity pill: ${await text("pillPurity")}`);
      // Purity pill reveals the purityProof, and Escape collapses it.
      await evaluate(`document.getElementById("pillPurity").click(); true`);
      const detail = await evaluate(`({ hidden: document.getElementById("purityDetail").hidden, text: document.getElementById("purityDetail").textContent })`);
      check(!detail.hidden && /total/.test(detail.text) && /Input mutation parity/.test(detail.text) && /Object\.prototype/.test(detail.text), `purity detail: ${detail.text}`);
      await key("Escape", "Escape", 27);
      await waitFor(`document.getElementById("purityDetail").hidden`, "Escape to collapse the purity detail", 5_000);
      // Parity pill focuses the Causal Strip.
      await evaluate(`document.getElementById("pillParity").click(); true`);
      check((await evaluate(`document.activeElement && document.activeElement.id`)) === "causalStrip", "the parity pill did not focus the Causal Strip");
      // Mutants pill: run the audit, then the pill reports it and opens the Mutant Autopsy.
      await evaluate(`document.getElementById("mutBtn").click(); true`);
      await waitFor(`/\\d+\\/\\d+ killed/.test(document.getElementById("pillMutants").lastElementChild.textContent)`, "the Mutants Killed pill", 60_000);
      await evaluate(`document.getElementById("pillMutants").click(); true`);
      await waitFor(`!document.getElementById("mutAutopsy").hidden`, "the Mutant Autopsy via the pill", 10_000);
      // Ed25519 pill: offline or API verification, and it focuses Simulate 1-Byte Tamper.
      await waitFor(`/^Verified/.test(document.getElementById("pillEd").lastElementChild.textContent)`, "the Ed25519 pill", 30_000);
      await evaluate(`document.getElementById("pillEd").click(); true`);
      check((await evaluate(`document.activeElement && document.activeElement.id`)) === "certTamperBtn", "the Ed25519 pill did not focus Simulate 1-Byte Tamper");
      // Perf Parity pill: a live ratio (this sync specimen) or an honest note.
      await waitFor(`!/measuring/.test(document.getElementById("pillPerf").lastElementChild.textContent) && document.getElementById("pillPerf").lastElementChild.textContent !== "-"`, "the Perf Parity pill", 30_000);
      const perf = await text("pillPerf");
      check(/\d+\.\d+x (faster|parity|slower)|skipped|unavailable|not/.test(perf), `perf pill: ${perf}`);
      const l = await evaluate(LAYOUT);
      check(l.scrollWidth <= l.vw && l.offenders.length === 0, `overflow with the strip: ${l.scrollWidth}/${l.vw} ${l.offenders.join(", ")}`);
    });
    await step("Tab 1: Compare vs. Naive AI shows the naive strict-mode rewrite throwing a ReferenceError", async () => {
      await waitFor(`!document.getElementById("naiveBtn").hidden`, "the Compare vs. Naive AI button", 10_000);
      await evaluate(`document.getElementById("naiveBtn").click(); true`);
      await waitFor(`!document.getElementById("trapCard").hidden && document.getElementById("trapCard").textContent.length > 20`, "the trap card", 40_000);
      const trap = await evaluate(`document.getElementById("trapCard").textContent`);
      check(/ReferenceError|not defined/.test(trap), `the trap card does not show the ReferenceError: ${trap.slice(0, 200)}`);
    });
    await step("SARIF Audit reports the leak as LAZ008 (8 rule chips) for the leaky specimen", async () => {
      await evaluate(`document.getElementById("sarifBtn").click(); true`);
      await waitFor(`!document.getElementById("sarifDrawer").hidden`, "the SARIF drawer", 5_000);
      await evaluate(`document.getElementById("sarifRun").click(); true`);
      await waitFor(`document.getElementById("sarifChips").children.length === 8 && document.getElementById("sarifRun").getAttribute("aria-busy") === null`, "8 rule chips (LAZ001-LAZ008)", 20_000);
      const text = await evaluate(`document.getElementById("sarifChips").textContent + "|" + document.getElementById("sarifList").textContent`);
      check(/LAZ008/.test(text) && /UndeclaredGlobalLeak|Undeclared global/.test(text), `no LAZ008 in the drawer: ${text.slice(0, 200)}`);
      await key("Escape", "Escape", 27);
      await waitFor(`document.getElementById("sarifDrawer").hidden`, "the SARIF drawer to close", 5_000);
    });
    await step("PR Preview: the report is in the bundle, and the drawer opens, stays single-active and closes on Escape", async () => {
      await evaluate(`document.getElementById("exportBtn").click(); true`);
      await waitFor(`document.getElementById("bundlePanel") && document.getElementById("bundlePanel").style.display === "block"`, "the PR bundle panel", 60_000);
      const bundle = await evaluate(`window.LazarusBundle.build().then((b) => ({ report: b.reportHtml || "", files: Object.keys(b.files), signed: !!b.signature }))`);
      check(/<h1>Resurrection Report: legacyLeakyMutator/.test(bundle.report), "the export has no RESURRECTION_REPORT.html for legacyLeakyMutator");
      check(!/<script|https?:\/\//i.test(bundle.report), "the offline report loads or contains a script or URL");
      check(/5-Pillar Proof Scorecard/.test(bundle.report) && /Purity \/ no global leaks/.test(bundle.report) && /PROVEN/.test(bundle.report), "the report lacks the scorecard");
      check(bundle.signed, "the export is not signed");
      const btn = await evaluate(`(() => { const b = document.getElementById("prPreviewBtn"); const r = b.getBoundingClientRect(); const z = document.getElementById("downloadZipBtn").getBoundingClientRect(); return { visible: r.width > 0, sameRow: Math.abs(r.top - z.top) < 40, after: r.left >= z.right - 1 }; })()`);
      check(btn.visible && btn.sameRow, `PR Preview is not beside the .zip button: ${JSON.stringify(btn)}`);
      await evaluate(`document.getElementById("prPreviewBtn").focus(); document.getElementById("prPreviewBtn").click(); true`);
      await waitFor(`!document.getElementById("prDrawer").hidden`, "the PR Preview drawer", 5_000);
      await waitFor(`document.querySelectorAll("#prBody .pr-card").length >= 4`, "the PR preview cards", 60_000);
      await sleep(450);
      const pr = await evaluate(`({ text: document.getElementById("prBody").textContent, dl: !document.getElementById("prDownloadReport").disabled })`);
      for (const s of ["Resurrect legacyLeakyMutator", "RESURRECTION_REPORT.html", "lazarus-audit.yml", "lazarus-parity.yml", "resurrected.ts", "certificate.json", "git apply --check", "git diff", "tsc --strict: 0 errors"]) check(pr.text.includes(s), `PR Preview lacks "${s}"`);
      check(pr.dl, "Download Offline Report (.html) is disabled");
      let l = await evaluate(LAYOUT);
      check(l.openDrawers.join() === "prDrawer" && l.openScrims.join() === "prScrim", `PR drawer stacking: ${l.openDrawers} / ${l.openScrims}`);
      check(l.scrollWidth <= l.vw, `PR Preview overflows: ${l.scrollWidth}/${l.vw}`);
      const box = l.drawerBox[0];
      check(box.left >= 0 && box.right <= l.vw + 1 && box.bottom <= l.vh + 1, `PR drawer does not fit: ${JSON.stringify(box)}`);
      // Single-active: the next drawer closes it; opening it again closes that one.
      await evaluate(`document.getElementById("sarifBtn").click(); true`);
      await waitFor(`!document.getElementById("sarifDrawer").hidden`, "SARIF Audit to open over PR Preview", 5_000);
      l = await evaluate(LAYOUT);
      check(l.openDrawers.join() === "sarifDrawer" && l.openScrims.join() === "sarifScrim", `drawers stacked after SARIF: ${l.openDrawers}`);
      await evaluate(`document.getElementById("prPreviewBtn").click(); true`);
      await waitFor(`!document.getElementById("prDrawer").hidden && document.getElementById("sarifDrawer").hidden`, "PR Preview to replace SARIF Audit", 5_000);
      // Tab stays inside, Escape closes and returns focus to PR Preview.
      for (let i = 0; i < 30; i++) await key("Tab", "Tab", 9);
      check((await evaluate(`document.getElementById("prDrawer").contains(document.activeElement)`)) === true, "Tab left the PR Preview drawer");
      await key("Escape", "Escape", 27);
      await waitFor(`document.getElementById("prDrawer").hidden`, "PR Preview to close on Escape", 5_000);
      check((await evaluate(`document.activeElement && document.activeElement.id`)) === "prPreviewBtn", "focus did not return to PR Preview");
      l = await evaluate(LAYOUT);
      check(l.openDrawers.length === 0 && l.openScrims.length === 0, "a drawer is still open after Escape");
    });
    await step("Kiro DNA: the Ecosystem Architecture Map shows the live counts from disk", async () => {
      await load(VIEWPORTS[0]);
      await evaluate(`document.getElementById("dnaBtn").click(); true`);
      await waitFor(`/^\\d+ Specs$/.test(document.getElementById("dmSpecs").textContent)`, "the map to load the specs count", 20_000);
      const m = await evaluate(`({ specs: document.getElementById("dmSpecs").textContent, agents: document.getElementById("dmAgents").textContent, hooks: document.getElementById("dmHooks").textContent, steering: document.getElementById("dmSteering").textContent, power: document.getElementById("dmPower").textContent, nodes: document.querySelectorAll("#dnaMap .dm-node").length, badge: document.getElementById("badgeSpecs").textContent })`);
      check(m.nodes === 7, `the map has ${m.nodes} nodes`);
      check(m.specs === "28 Specs" && m.badge === "28 Kiro Specs", `specs: ${m.specs} / ${m.badge}`);
      check(m.agents === "4 Crew Agents" && m.hooks === "4 Hooks" && m.steering === "3 Steering Docs", `counts: ${m.agents}, ${m.hooks}, ${m.steering}`);
      check(/power-lazarus\/ \u00b7 v/.test(m.power), `power node: ${m.power}`);
      const l = await evaluate(LAYOUT);
      check(l.scrollWidth <= l.vw, "the DNA drawer overflows");
      await key("Escape", "Escape", 27);
      await waitFor(`document.getElementById("dnaDrawer").hidden`, "Kiro DNA to close", 5_000);
    });

    // ---- 5. Tab 2: circular ledger ----
    await step("Tab 2: legacy-circular-ledger resolves its cycle (amber edges, Cycle Resolved)", async () => {
      await load(VIEWPORTS[0]);
      await evaluate(`document.querySelector('[data-studio-tab="graph"]').click(); true`);
      await waitFor(`!document.getElementById("pane-graph").hidden`, "Tab 2", 5_000);
      await evaluate(`(() => { const s = document.getElementById("graphPreset"); s.value = "circular"; s.dispatchEvent(new Event("change")); return true; })()`);
      await sleep(200);
      await evaluate(`document.getElementById("graphRunBtn").click(); true`);
      await waitFor(`/Cycle Resolved/.test(document.getElementById("graphCyclePill").textContent) && !document.getElementById("graphCyclePill").hidden`, "Cycle Resolved", 90_000);
      const g = await evaluate(`({ edges: document.querySelectorAll("#graphSvg .edge.cycle").length, stroke: (() => { const e = document.querySelector("#graphSvg .edge.cycle"); return e ? getComputedStyle(e).stroke : ""; })(), verdict: document.getElementById("graphVerdict").textContent })`);
      check(g.edges >= 1, "no amber cycle edge in the graph");
      check(/245,\s*158,\s*11|f59e0b/i.test(g.stroke), `cycle edge is not amber (${g.stroke})`);
      check(/PARITY PROVEN/.test(g.verdict), `whole-graph parity not proven: ${g.verdict}`);
      const l = await evaluate(LAYOUT);
      check(l.scrollWidth <= l.vw && l.offenders.length === 0, `Tab 2 overflow after the run: ${l.scrollWidth}/${l.vw} ${l.offenders.join(", ")}`);
    });

    // ---- 6. Final layout sweep with the results on screen ----
    for (const vp of VIEWPORTS) {
      await step(`result layout ${vp.width}x${vp.height}: no overflow with a finished resurrection on screen`, async () => {
        await load(vp);
        await evaluate(`(() => { const s = document.getElementById("presetSelect"); s.value = "es5-string-hash"; s.dispatchEvent(new Event("change")); document.getElementById("runBtn").click(); return true; })()`);
        await waitFor(`window.__e2e.results.some((r) => r.name === "stringHash32" && r.success)`, "the stringHash32 result", 90_000);
        await waitFor(`!document.getElementById("perfBadge").hidden`, "the Perf Parity chip", 30_000);
        const l = await evaluate(LAYOUT);
        check(l.scrollWidth <= l.vw, `scrollWidth ${l.scrollWidth} > viewport ${l.vw}`);
        check(l.offenders.length === 0, `elements past the right edge: ${l.offenders.join(", ")}`);
      });
    }
  } catch (err) {
    failures.push(`setup: ${err.message}`);
    console.log(`  FAIL  setup: ${err.message}`);
  } finally {
    browser?.cdp.close();
    if (browser) killTree(browser.child);
    await studio?.close().catch(() => undefined);
    await sleep(300);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch {
      console.log(`e2e-smoke: could not remove ${profileDir}`);
    }
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const unique = [...new Set(browserErrors)];
  if (unique.length) for (const e of unique) console.log(`  browser error: ${e}`);
  if (failures.length === 0 && unique.length === 0) {
    console.log(`e2e-smoke: PASSED (${checks} checks, 0 browser errors, ${seconds} s)`);
    return 0;
  }
  console.log(`e2e-smoke: FAILED (${failures.length} failed step(s), ${unique.length} browser error(s), ${seconds} s)`);
  return 1;
}

const isMain = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const code = await main().catch((err) => {
    console.error(`e2e-smoke: ${err instanceof Error ? err.stack : String(err)}`);
    return 1;
  });
  process.exit(code);
}
