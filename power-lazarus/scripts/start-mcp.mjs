#!/usr/bin/env node
// Launcher for the lazarus-sandbox MCP server (stdio) of the lazarus-resurrection Kiro Power.
//
// The Power package does not contain the server: it runs src/mcp/server.ts from a Lazarus checkout. The checkout is
// LAZARUS_HOME, or the folder that contains this power-lazarus/ folder (a clone of the repository). A folder is used
// only if its package.json is named "lazarus" and it has src/mcp/server.ts and an installed tsx. Nothing is
// downloaded. stdout belongs to the MCP protocol, so every message from this launcher goes to stderr.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://github.com/anjarkar25-max/lazarus";
const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.PLUGIN_ROOT && process.env.PLUGIN_ROOT.trim() !== "" ? path.resolve(process.env.PLUGIN_ROOT) : path.resolve(here, "..");

/** Reason the folder is not a usable Lazarus checkout, or null when it is one. */
function problemWith(dir) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return "no readable package.json";
  }
  if (!pkg || pkg.name !== "lazarus") return "package.json is not the lazarus package";
  if (!fs.existsSync(path.join(dir, "src", "mcp", "server.ts"))) return "src/mcp/server.ts is missing";
  if (!fs.existsSync(path.join(dir, "node_modules", "tsx", "package.json"))) return "dependencies are not installed (run npm install)";
  return null;
}

const candidates = [];
if (process.env.LAZARUS_HOME && process.env.LAZARUS_HOME.trim() !== "") candidates.push(["LAZARUS_HOME", path.resolve(process.env.LAZARUS_HOME)]);
candidates.push(["the folder containing power-lazarus", path.dirname(pluginRoot)]);

const tried = [];
let home = null;
for (const [label, dir] of candidates) {
  const problem = problemWith(dir);
  if (problem === null) {
    home = dir;
    break;
  }
  tried.push(`${label} (${dir}): ${problem}`);
}

if (home === null) {
  process.stderr.write(
    `lazarus-sandbox: no Lazarus checkout found. Clone ${REPO}, run npm install in it, and set LAZARUS_HOME to that folder. Checked: ${tried.join("; ")}\n`
  );
  process.exit(1);
}

const child = spawn(process.execPath, ["--import", "tsx/esm", path.join("src", "mcp", "server.ts")], {
  cwd: home,
  stdio: "inherit",
  env: process.env,
  windowsHide: true,
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (child.exitCode === null) child.kill(signal);
  });
}
child.on("error", (err) => {
  process.stderr.write(`lazarus-sandbox: could not start the server: ${err.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
