import { crc32 as nodeCrc32 } from "node:zlib";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { WORKFLOW_PATH, bundleToZipEntries, generateResurrectionBundle, renderWorkflow } from "../bundle.js";
import { ZipError, assertEntryName, crc32, createZip, readZip } from "../zip.js";

const bundle = () =>
  generateResurrectionBundle({
    specimenName: "halve",
    legacyCode: "(n / 2) | 0",
    legacySource: "module.exports = function halve(n) { return (n / 2) | 0; };",
    modernCode: "Math.trunc(n / 2) || 0",
    specMarkdown: "# Spec\nünïcödé ✓ — 日本語",
    schema: { n: "integer" },
    esmModule: { code: "export function halve(n) { return Math.trunc(n / 2) || 0; }", exports: ["halve"] },
  });

describe("CRC-32", () => {
  it("matches the standard check value and node:zlib", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
  it("agrees with zlib.crc32 for arbitrary bytes (property)", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 2000 }), (bytes) => nodeCrc32(bytes) === crc32(bytes)));
  });
});

describe("createZip structure", () => {
  const zip = createZip([
    { name: "a.txt", data: "hello hello hello hello hello hello hello hello" },
    { name: "dir/b.bin", data: new Uint8Array([1, 2, 3]) },
  ]);

  it("starts with the local header magic PK\\x03\\x04 and ends with an EOCD record", () => {
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const eocd = zip.length - 22;
    expect(zip.subarray(eocd, eocd + 4)).toEqual(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(zip.readUInt16LE(eocd + 8)).toBe(2);
    expect(zip.readUInt16LE(eocd + 10)).toBe(2);
    const centralOffset = zip.readUInt32LE(eocd + 16);
    expect(zip.subarray(centralOffset, centralOffset + 4)).toEqual(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(centralOffset + zip.readUInt32LE(eocd + 12)).toBe(eocd);
  });

  it("records the CRC-32 of the uncompressed data in both headers", () => {
    const expected = nodeCrc32(Buffer.from("hello hello hello hello hello hello hello hello"));
    expect(zip.readUInt32LE(14)).toBe(expected);
    const centralOffset = zip.readUInt32LE(zip.length - 22 + 16);
    expect(zip.readUInt32LE(centralOffset + 16)).toBe(expected);
  });

  it("deflates what shrinks and stores what does not, and sets the UTF-8 flag", () => {
    const entries = readZip(zip);
    expect(entries.map((e) => [e.name, e.method])).toEqual([["a.txt", "deflated"], ["dir/b.bin", "stored"]]);
    expect(zip.readUInt16LE(6) & 0x0800).toBe(0x0800);
  });

  it("is deterministic", () => {
    const again = createZip([
      { name: "a.txt", data: "hello hello hello hello hello hello hello hello" },
      { name: "dir/b.bin", data: new Uint8Array([1, 2, 3]) },
    ]);
    expect(again.equals(zip)).toBe(true);
  });

  it("handles an empty archive and empty files", () => {
    expect(readZip(createZip([]))).toEqual([]);
    const [empty] = readZip(createZip([{ name: "empty.txt", data: "" }]));
    expect(empty?.data.length).toBe(0);
  });
});

describe("round trip", () => {
  it("restores arbitrary UTF-8 text and binary data byte for byte (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.stringMatching(/^[a-z0-9_-]{1,8}$/), fc.oneof(fc.string({ unit: "binary", maxLength: 300 }), fc.uint8Array({ maxLength: 300 }))), { maxLength: 8 }),
        (items) => {
          const entries = items.map(([name, data], i) => ({ name: `d${i % 3}/${name}-${i}.dat`, data }));
          const back = readZip(createZip(entries));
          expect(back.map((e) => e.name)).toEqual(entries.map((e) => e.name));
          back.forEach((e, i) => {
            const source = entries[i]?.data;
            const expected = typeof source === "string" ? Buffer.from(source, "utf8") : Buffer.from(source ?? []);
            expect(e.data.equals(expected)).toBe(true);
          });
        }
      ),
      { numRuns: 60 }
    );
  });

  it("round-trips every file of a real bundle, including the CI workflow, with exact UTF-8 contents", () => {
    const b = bundle();
    const entries = bundleToZipEntries(b);
    const back = readZip(createZip(entries));
    const names = back.map((e) => e.name);
    expect(names).toContain(".github/workflows/lazarus-parity.yml");
    for (const expected of ["resurrected.ts", "resurrected.test.ts", "SPEC.md", "resurrection.patch", "resurrected.mjs", "legacy.cjs"]) {
      expect(names).toContain(expected);
    }
    expect(new Set(names).size).toBe(names.length);
    for (const entry of entries) {
      const got = back.find((e) => e.name === entry.name);
      expect(got?.data.toString("utf8")).toBe(entry.data);
    }
    expect(back.find((e) => e.name === "SPEC.md")?.data.toString("utf8")).toContain("ünïcödé ✓ — 日本語");
    expect(back.find((e) => e.name === "resurrection.patch")?.data.toString("utf8")).toBe(`${b.prDiff}\n`);
  });
});

describe("CI workflow", () => {
  it("runs npm ci and the parity suite on pull requests with read-only permissions", () => {
    const yml = renderWorkflow();
    expect(yml).toContain("pull_request:");
    expect(yml).toContain("npm ci");
    expect(yml).toContain("npx vitest run resurrected.test.ts");
    expect(yml).toContain("contents: read");
    expect(yml).toContain("actions/checkout@v4");
    expect(bundle().files[WORKFLOW_PATH]).toBe(yml);
  });
});

describe("validation and tamper detection", () => {
  it.each(["", "/abs.txt", "C:/x.txt", "..", "a/../b.txt", "../x", "a\\b.txt", "dir/", "a//b", "./a", "bad\0.txt"])("rejects entry name %j", (name) => {
    expect(() => assertEntryName(name)).toThrow(ZipError);
    expect(() => createZip([{ name, data: "x" }])).toThrow(ZipError);
  });

  it("rejects duplicate names", () => {
    expect(() => createZip([{ name: "a", data: "1" }, { name: "a", data: "2" }])).toThrow(/duplicate/);
  });

  it("detects a flipped data byte through the CRC-32 (or inflate) check", () => {
    const zip = createZip([{ name: "a.txt", data: "stored data that will be tampered with" }, { name: "b.bin", data: new Uint8Array([9, 9, 9, 9]) }]);
    const tampered = Buffer.from(zip);
    const dataStart = 30 + "a.txt".length;
    tampered[dataStart + 3] = (tampered[dataStart + 3] ?? 0) ^ 0xff;
    expect(() => readZip(tampered)).toThrow();
  });

  it("rejects truncated and garbage input", () => {
    const zip = createZip([{ name: "a.txt", data: "hello" }]);
    expect(() => readZip(zip.subarray(0, zip.length - 10))).toThrow(ZipError);
    expect(() => readZip(Buffer.from("not a zip file at all, definitely not"))).toThrow(ZipError);
    expect(() => readZip(Buffer.alloc(0))).toThrow(ZipError);
  });
});
