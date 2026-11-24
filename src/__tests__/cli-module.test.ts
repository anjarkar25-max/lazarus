import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../cli.js";

describe("CLI module mode", () => {
  it("resurrects every export of a multi-export file into one bundle", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "lazarus-cli-"));
    try {
      fs.writeFileSync(nodePath.join(dir, "math.cjs"), "exports.add = function (a, b) { return a + b; };\nexports.halve = function (n) { return (n / 2) | 0; };\n");
      let out = "";
      let err = "";
      const code = await main(["math.cjs", "--out", "out", "--runs", "20", "--seed", "5"], {
        stdout: (t) => void (out += t),
        stderr: (t) => void (err += t),
        cwd: dir,
      });
      expect(err).toBe("");
      expect(code).toBe(0);
      expect(out).toContain("Parity proven for 2 functions");
      const ts = fs.readFileSync(nodePath.join(dir, "out", "resurrected.ts"), "utf8");
      expect(ts).toContain("export function add(");
      expect(ts).toContain("export function halve(");
      expect(fs.readFileSync(nodePath.join(dir, "out", "resurrected.mjs"), "utf8")).toContain("export function add(");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
