import { createHash } from "node:crypto";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { allOff, defaultLevels, encodeLevels } from "../../crew/ast-modernizer.js";
import { generateResurrectionBundle } from "../bundle.js";
import { gradeFor, generateCertificate, sanitizeProvenance, sha256Hex, type CertificateInput } from "../certificate.js";

const HALF = "var half = (n / 2) | 0; half;";
const HEADER = (levels = defaultLevels()): string => `// ast-rules: ${encodeLevels(levels)}\n`;
const COUNTER = `function Counter(start) { this.n = start; }
Counter.prototype.inc = function (step) { this.n = this.n + step; return this; };
Counter.prototype.value = function () { return this.n; };
var c = new Counter(start); c.inc(step); c.value();`;

const input = (over: Partial<CertificateInput> = {}): CertificateInput => ({
  provenance: { kind: "npm", label: "left-pad", version: "1.3.0", cdnHost: "unpkg.com", byteLength: 1469 },
  legacySource: HALF,
  modernCode: `${HEADER()}const half = Math.trunc(n / 2) || 0;\nhalf;`,
  fuzz: { totalRuns: 100, exact: true, boundaryRuns: 50 },
  attempts: 1,
  ...over,
});

describe("generateCertificate", () => {
  it("is fully deterministic: same input, byte-identical certificate", () => {
    const a = generateCertificate(input());
    const b = generateCertificate(input());
    expect(b).toEqual(a);
    expect(b.markdown).toBe(a.markdown);
    expect(a.markdown).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("computes the SHA-256 of the legacy source (LF-normalized) and a 12-hex short digest", () => {
    const cert = generateCertificate(input());
    expect(cert.sha256).toBe(createHash("sha256").update(HALF).digest("hex"));
    expect(cert.shortDigest).toBe(cert.sha256.slice(0, 12));
    expect(cert.id).toBe(`LZ-${cert.shortDigest.toUpperCase()}`);
    expect(sha256Hex("a\r\nb")).toBe(sha256Hex("a\nb"));
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(cert.markdown).toContain(cert.sha256);
  });

  it("any change to the legacy source changes the digest (property)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ minLength: 1, maxLength: 5 }), (s, suffix) => {
        fc.pre(!`${s}${suffix}`.replace(/\r\n/g, "\n").startsWith(s.replace(/\r\n/g, "\n")) || suffix.length > 0);
        expect(sha256Hex(s)).not.toBe(sha256Hex(`${s}${suffix}`));
      })
    );
  });

  it("scores debt from the rewrites available on the legacy source", () => {
    const cert = generateCertificate(input());
    // var-scoping (1 site) + bitor0-trunc (1 site)
    expect(cert.debtScore).toBe(1 + 3);
    expect(cert.debtGrade).toBe("low");
    expect(cert.modernized).toEqual(expect.arrayContaining(["var → const/let", "| 0 → Math.trunc(x) || 0"]));
    expect(cert.idioms).toContain("32-bit bitwise truncation (| 0)");
  });

  it("scores clean code 0", () => {
    const cert = generateCertificate(input({ legacySource: "const x = 1; x;", modernCode: "const x = 1; x;" }));
    expect(cert.debtScore).toBe(0);
    expect(cert.debtGrade).toBe("clean");
    expect(cert.modernized).toEqual([]);
    expect(cert.markdown).toContain("nothing needed rewriting");
  });

  it("scores prototype classes and CommonJS higher, and lists the modernizations", () => {
    const cjs = "module.exports = function (n) { return (n / 2) | 0; };";
    const cert = generateCertificate(input({ legacySource: cjs, esmComplete: true }));
    expect(cert.idioms).toContain("CommonJS export");
    expect(cert.modernized).toContain("CommonJS → ESM named exports");
    expect(cert.debtScore).toBe(3 + 5);
    const proto = generateCertificate(input({ legacySource: COUNTER, modernCode: `${HEADER()}class Counter {}` }));
    expect(proto.modernized).toContain("prototype → class");
    expect(proto.debtScore).toBeGreaterThanOrEqual(8);
  });

  it("reports rules the Exorcist rolled back instead of claiming them", () => {
    const levels = { ...defaultLevels(), "prototype-class": 1 };
    const cert = generateCertificate(input({ legacySource: COUNTER, modernCode: `${HEADER(levels)}function Counter() {}`, attempts: 2 }));
    expect(cert.rolledBack).toEqual(["prototype → class"]);
    expect(cert.modernized).not.toContain("prototype → class");
    expect(cert.parity.selfHealed).toBe(true);
    expect(cert.markdown).toContain("(self-healed)");
    expect(cert.markdown).toContain("prototype → class");
  });

  it("treats a fully rolled-back candidate as having modernized nothing", () => {
    const cert = generateCertificate(input({ modernCode: `${HEADER(allOff())}var half = (n / 2) | 0;` }));
    expect(cert.modernized).toEqual([]);
    expect(cert.rolledBack.length).toBeGreaterThan(0);
  });

  it("states the parity proof with the real run count and mode", () => {
    const exact = generateCertificate(input({ fuzz: { totalRuns: 137, exact: true, boundaryRuns: 60 } }));
    expect(exact.parity).toMatchObject({ mode: "exact Object.is (tagged)", runs: 137, boundaryRuns: 60, attempts: 1, selfHealed: false });
    expect(exact.markdown).toContain("exact Object.is (tagged), 137 fuzz runs (60 boundary)");
    expect(exact.markdown).toContain("first draft held");
    const loose = generateCertificate(input({ fuzz: { totalRuns: 20, exact: false } }));
    expect(loose.parity.mode).toBe("JSON-level");
  });

  it("debt score stays within 0..100 and never drops when more legacy sites are added (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 12 }), fc.integer({ min: 0, max: 12 }), (a, b) => {
        const make = (k: number): string => Array.from({ length: k }, (_, i) => `var v${i} = (n / ${i + 2}) | 0;`).join("\n");
        const small = generateCertificate(input({ legacySource: make(Math.min(a, b)) }));
        const large = generateCertificate(input({ legacySource: make(Math.max(a, b)) }));
        expect(small.debtScore).toBeGreaterThanOrEqual(0);
        expect(large.debtScore).toBeLessThanOrEqual(100);
        expect(large.debtScore).toBeGreaterThanOrEqual(small.debtScore);
      }),
      { numRuns: 30 }
    );
  });

  it("maps scores to grades", () => {
    expect([0, 1, 19, 20, 49, 50, 100].map(gradeFor)).toEqual(["clean", "low", "low", "moderate", "moderate", "severe", "severe"]);
  });

  it.each([
    [{ kind: "preset", label: "legacyCounterClass" }, "Operating Table preset `legacyCounterClass`"],
    [{ kind: "github", label: "x", url: "https://github.com/o/r/blob/main/a.js" }, "GitHub https://github.com/o/r/blob/main/a.js"],
    [{ kind: "npm", label: "left-pad", version: "1.3.0", cdnHost: "cdn.jsdelivr.net", byteLength: 1469 }, "npm `left-pad@1.3.0` via cdn.jsdelivr.net (1469 bytes)"],
    [{ kind: "paste", label: "pasted specimen" }, "pasted specimen"],
    [{ kind: "file", label: "legacy.cjs" }, "file `legacy.cjs`"],
  ] as const)("describes provenance %#", (provenance, expected) => {
    expect(generateCertificate(input({ provenance })).provenanceLine).toBe(expected);
  });
});

describe("sanitizeProvenance", () => {
  it("falls back to a pasted specimen for junk and strips markdown-breaking characters", () => {
    expect(sanitizeProvenance(undefined)).toEqual({ kind: "paste", label: "pasted specimen" });
    expect(sanitizeProvenance("nope")).toEqual({ kind: "paste", label: "pasted specimen" });
    expect(sanitizeProvenance({ kind: "evil", label: 5 })).toEqual({ kind: "paste", label: "pasted specimen" });
    const hostile = sanitizeProvenance({ kind: "npm", label: "a|b`c\nd", version: "1.0.0", byteLength: -4, cdnHost: "x".repeat(500) });
    expect(hostile.label).toBe("a b c d");
    expect(hostile.cdnHost?.length).toBe(100);
    expect(hostile.byteLength).toBeUndefined();
  });
});

describe("SPEC.md embedding", () => {
  it("embeds the certificate block in the exported SPEC.md and leaves it out when absent", () => {
    const cert = generateCertificate(input());
    const base = { specimenName: "half", legacyCode: "(n / 2) | 0", modernCode: "Math.trunc(n / 2) || 0", specMarkdown: "spec", schema: { n: "integer" } };
    const withCert = generateResurrectionBundle({ ...base, certificateMarkdown: cert.markdown });
    const spec = withCert.files["SPEC.md"];
    expect(spec).toContain(`## Resurrection Certificate ${cert.id}`);
    expect(spec).toContain(cert.sha256);
    expect(spec.indexOf("Resurrection Certificate")).toBeLessThan(spec.indexOf("## Legacy Source"));
    expect(generateResurrectionBundle(base).files["SPEC.md"]).not.toContain("Resurrection Certificate");
  });
});
