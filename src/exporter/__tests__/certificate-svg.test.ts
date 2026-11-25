import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { escapeXml, generateCertificate, renderCertificateSvg, type CertificateInput } from "../certificate.js";

const HASH = "var h = 0; for (var i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; } h;";
const input = (over: Partial<CertificateInput> = {}): CertificateInput => ({
  provenance: { kind: "preset", label: "es5-string-hash" },
  legacySource: HASH,
  modernCode: "let h = 0;",
  fuzz: { totalRuns: 100, exact: true, boundaryRuns: 50 },
  attempts: 2,
  mutation: { killed: 5, total: 5 },
  typecheck: { errorCount: 0, filesChecked: 2, tsVersion: "7.0.2" },
  ...over,
});

/**
 * Minimal XML well-formedness check: one root, balanced and properly nested tags, quoted attributes, no raw `<` or
 * stray `&` in text or attribute values.
 */
function assertWellFormed(xml: string): void {
  const body = xml.replace(/^<\?xml [^?]*\?>\s*/, "");
  const stack: string[] = [];
  let roots = 0;
  const token = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/gy;
  let consumed = 0;
  for (let m = token.exec(body); m !== null; m = token.exec(body)) {
    consumed = token.lastIndex;
    const [, close, name, attrs, selfClose, text] = m;
    if (text !== undefined) {
      expect(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(text), `stray & in ${text.slice(0, 40)}`).toBe(false);
      if (stack.length === 0) expect(text.trim()).toBe("");
      continue;
    }
    expect(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/.test(attrs ?? ""), `stray & in attributes of <${name}>`).toBe(false);
    if (close === "/") {
      expect(stack.pop(), `</${name}>`).toBe(name);
    } else if (selfClose !== "/") {
      if (stack.length === 0) roots++;
      stack.push(name ?? "");
    } else if (stack.length === 0) {
      roots++;
    }
  }
  expect(consumed, "unparseable markup").toBe(body.length);
  expect(stack).toEqual([]);
  expect(roots).toBe(1);
}

describe("renderCertificateSvg", () => {
  const cert = generateCertificate(input());
  const svg = renderCertificateSvg(cert, { name: "stringHash32" });

  it("emits a well-formed, self-contained <svg> document", () => {
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    assertWellFormed(svg);
    expect(svg).not.toMatch(/<script|<foreignObject|href=|url\((?!#)|on[a-z]+=/i);
  });

  it("shows the specimen, the digest, the proof, the kill score and the tsc --strict status", () => {
    expect(svg).toContain(">stringHash32<");
    expect(svg).toContain(`${cert.shortDigest} · ${cert.id}`);
    expect(svg).toContain(">exact Object.is · 100 fuzz runs<");
    expect(svg).toContain(">5/5 mutants killed (100% proof strength)<");
    expect(svg).toContain(">tsc --strict: 0 errors<");
    expect(svg).toContain(`>${cert.debtScore}/100 ${cert.debtGrade}<`);
    expect(svg).toContain("<title id=\"t\">Lazarus Resurrection Certificate " + cert.id + "</title>");
  });

  it("is deterministic", () => {
    expect(renderCertificateSvg(generateCertificate(input()), { name: "stringHash32" })).toBe(svg);
  });

  it("never claims what the certificate does not contain", () => {
    const { mutation: _m, typecheck: _t, ...bare } = input();
    const plain = renderCertificateSvg(generateCertificate(bare as CertificateInput), { name: "x" });
    expect(plain).toContain(">not audited<");
    expect(plain).toContain(">not checked<");
    expect(plain).not.toContain("0 errors");
    const failing = renderCertificateSvg(generateCertificate(input({ typecheck: { errorCount: 1, filesChecked: 1, tsVersion: "7.0.2" }, mutation: { killed: 3, total: 5 } })), { name: "x" });
    expect(failing).toContain(">tsc --strict: 1 error<");
    expect(failing).toContain(">3/5 mutants killed (60% proof strength)<");
    expect(failing).toContain('fill="#ef4444">tsc --strict: 1 error<');
    expect(renderCertificateSvg(generateCertificate(input({ fuzz: { totalRuns: 1, exact: true }, attempts: 1 })), { name: "x" })).toContain(">exact Object.is · 1 fuzz run<");
  });

  it("escapes hostile names and provenance so the XML stays well-formed (property)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), fc.string({ maxLength: 60 }), (name, label) => {
        const doc = renderCertificateSvg(generateCertificate(input({ provenance: { kind: "npm", label } })), { name });
        assertWellFormed(doc);
        expect(doc).not.toContain("<script");
      }),
      { numRuns: 200 }
    );
    const evil = renderCertificateSvg(cert, { name: '</text><script>alert(1)</script><text a="' });
    expect(evil).not.toContain("<script>");
    expect(evil).toContain("&lt;/text&gt;&lt;script&gt;");
  });

  it("escapeXml handles the five entities and strips forbidden control characters", () => {
    expect(escapeXml(`a & b < c > d " e ' f\u0000\u0007g`)).toBe("a &amp; b &lt; c &gt; d &quot; e &apos; fg");
  });
});
