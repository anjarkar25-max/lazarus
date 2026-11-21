import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { scanLegacyAst } from '../../sandbox/ast-scanner.js';
import {
  validateAndNormalizeGitHubUrl,
  enforcePayloadCap,
  MAX_SPECIMEN_BYTES,
} from '../../importer/github.js';
import {
  generateResurrectionBundle,
  sanitizeIdentifier,
} from '../bundle.js';

describe('V2 Grand Prize: AST Scanner, GitHub Importer & PR Bundle Exporter', () => {
  it('1. converts standard github.com blob URLs to raw.githubusercontent.com', () => {
    const res = validateAndNormalizeGitHubUrl(
      'https://github.com/anjarkar25-max/lazarus/blob/main/legacy/math.js'
    );
    expect(res.valid).toBe(true);
    expect(res.normalizedUrl).toBe(
      'https://raw.githubusercontent.com/anjarkar25-max/lazarus/main/legacy/math.js'
    );
  });

  it('2. accepts valid raw.githubusercontent.com .js and .cjs URLs', () => {
    const res = validateAndNormalizeGitHubUrl(
      'https://raw.githubusercontent.com/user/repo/main/index.cjs'
    );
    expect(res.valid).toBe(true);
  });

  it('3. rejects non-HTTPS URLs', () => {
    const res = validateAndNormalizeGitHubUrl(
      'http://raw.githubusercontent.com/user/repo/main/index.js'
    );
    expect(res.valid).toBe(false);
    expect(res.error).toContain('HTTPS');
  });

  it('4. rejects non-GitHub domains to prevent SSRF', () => {
    const res = validateAndNormalizeGitHubUrl('https://evil.example.com/malicious.js');
    expect(res.valid).toBe(false);
  });

  it('5. rejects non-JavaScript file extensions', () => {
    const res = validateAndNormalizeGitHubUrl(
      'https://raw.githubusercontent.com/user/repo/main/README.md'
    );
    expect(res.valid).toBe(false);
  });

  it('6. rejects URLs containing embedded credentials', () => {
    const res = validateAndNormalizeGitHubUrl(
      'https://user:pass@raw.githubusercontent.com/user/repo/main/a.js'
    );
    expect(res.valid).toBe(false);
  });

  it('7. enforces 32KB payload size cap accurately', () => {
    const oversized = 'a'.repeat(MAX_SPECIMEN_BYTES + 10);
    const res = enforcePayloadCap(oversized);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('exceeds maximum cap');
  });

  it('8. rejects empty payloads', () => {
    expect(enforcePayloadCap('').ok).toBe(false);
  });

  it('9. accepts valid payloads within the 32KB budget', () => {
    const valid = 'function half(n) { return (n / 2) | 0; }';
    const res = enforcePayloadCap(valid);
    expect(res.ok).toBe(true);
    expect(res.byteLength).toBeGreaterThan(0);
  });

  it('10. extracts named functions and parameters from CommonJS modules', () => {
    const source = 'module.exports = function truncateHalf(n) { var r = (n / 2) | 0; return r; };';
    const scan = scanLegacyAst(source);
    expect(scan.functions.length).toBe(1);
    expect(scan.functions[0]?.name).toBe('truncateHalf');
    expect(scan.functions[0]?.params).toEqual(['n']);
    expect(scan.functions[0]?.isExported).toBe(true);
    expect(scan.detectedIdioms).toContain('32-bit bitwise truncation (| 0)');
  });

  it('11. extracts exports.<name> CommonJS functions', () => {
    const source = 'exports.checksum = function(s) { return String(s).charCodeAt(0) | 0; };';
    const scan = scanLegacyAst(source);
    expect(scan.functions[0]?.name).toBe('checksum');
    expect(scan.detectedIdioms).toContain('ASCII charCodeAt loop');
  });

  it('12. falls back cleanly for single-line ES5 expressions', () => {
    const source = '(n / 2) | 0';
    const scan = scanLegacyAst(source);
    expect(scan.primaryExpression).toBe('(n / 2) | 0');
  });

  it('13. generates a complete 3-file resurrection bundle with unified PR diff', () => {
    const bundle = generateResurrectionBundle({
      specimenName: 'halfTowardsZero',
      legacyCode: '(n / 2) | 0',
      modernCode: 'Math.trunc(n / 2)',
      specMarkdown: '### Invariant\nTruncates towards zero.',
      fuzzRuns: 50,
      healed: true,
    });
    expect(bundle.files['resurrected.ts']).toContain('export function halfTowardsZero');
    expect(bundle.files['SPEC.md']).toContain('Self-Healed by Necromancer:** Yes');
    expect(bundle.files['resurrected.test.ts']).toContain('Object.is(halfTowardsZero(n), runLegacy(n))');
    expect(bundle.prDiff).toContain('+++ b/resurrected.ts');
  });

  it('14. property: sanitizeIdentifier always yields a valid JS identifier', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 40 }), (raw) => {
        const id = sanitizeIdentifier(raw);
        expect(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(id)).toBe(true);
      }),
      { numRuns: 50 }
    );
  });

  it('15. property: bundle generator preserves exact legacy and modern expressions', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{1,15}$/),
        fc.integer({ min: 10, max: 500 }),
        (name, runs) => {
          const bundle = generateResurrectionBundle({
            specimenName: name,
            legacyCode: '(n | 0)',
            modernCode: 'Math.trunc(n)',
            specMarkdown: 'Spec body',
            fuzzRuns: runs,
          });
          expect(bundle.specimenName).toBe(name);
          expect(bundle.files['resurrected.ts']).toContain(`export function ${name}`);
          expect(bundle.files['resurrected.test.ts']).toContain(`{ numRuns: ${runs} }`);
        }
      ),
      { numRuns: 30 }
    );
  });

  it('16. property: URL validator never accepts arbitrary non-GitHub hosts', () => {
    fc.assert(
      fc.property(
        fc.domain().filter((d) => !d.includes('github')),
        (domain) => {
          const res = validateAndNormalizeGitHubUrl(`https://${domain}/file.js`);
          expect(res.valid).toBe(false);
        }
      ),
      { numRuns: 30 }
    );
  });

  it('17. formats multi-statement Necromancer output into valid TypeScript', () => {
    const bundle = generateResurrectionBundle({
      specimenName: 'legacyIntHalve',
      legacyCode: 'var half = (n / 2) | 0; half;',
      modernCode: '// Resurrected by Lazarus Necromancer (attempt 2)\nlet half = Math.trunc(n / 2); half;',
      specMarkdown: 'Truncates integer halves toward zero.',
      fuzzRuns: 50,
      healed: true,
    });
    expect(bundle.files['resurrected.ts']).not.toContain('return //');
    expect(bundle.files['resurrected.ts']).toContain('let half = Math.trunc(n / 2);');
    expect(bundle.files['resurrected.ts']).toContain('return half;');
  });

  it('18. emits string parameter types and fc.string arbitraries for string schemas', () => {
    const bundle = generateResurrectionBundle({
      specimenName: 'legacyLeftPad',
      legacyCode: 'var out = String(text); while (out.length < 8) { out = "0" + out; } out;',
      modernCode: 'let out = String(text); while (out.length < 8) { out = "0" + out; } out;',
      specMarkdown: 'Pads strings to length 8.',
      fuzzRuns: 40,
      schema: { text: 'string' },
    });
    expect(bundle.files['resurrected.ts']).toContain('export function legacyLeftPad(text: string)');
    expect(bundle.files['resurrected.test.ts']).toContain('fc.string(');
    expect(bundle.files['resurrected.test.ts']).toContain('Object.is(legacyLeftPad(text), runLegacy(text))');
  });

  it('19. scans multi-statement CommonJS quantizeClamp utilities cleanly', () => {
    const source = `module.exports = function quantizeClamp(n) {
      var clamped = n < -100 ? -100 : (n > 100 ? 100 : n);
      return (clamped / 3) | 0;
    };`;
    const scan = scanLegacyAst(source);
    expect(scan.functions.length).toBe(1);
    expect(scan.functions[0]?.name).toBe('quantizeClamp');
    expect(scan.detectedIdioms).toContain('CommonJS export');
    expect(scan.detectedIdioms).toContain('32-bit bitwise truncation (| 0)');
  });

  it('20. preserves explicit return statements inside resurrected bodies', () => {
    const bundle = generateResurrectionBundle({
      specimenName: 'quantizeClamp',
      legacyCode: 'var c = n; return c;',
      modernCode: 'let c = Math.trunc(n); return c;',
      specMarkdown: 'Clamps and quantizes.',
      fuzzRuns: 25,
    });
    expect(bundle.files['resurrected.ts']).toContain('return c;');
    expect(bundle.files['resurrected.ts']).not.toContain('return return');
  });

  it('21. emits boolean parameter types and fc.boolean arbitraries when requested', () => {
    const bundle = generateResurrectionBundle({
      specimenName: 'invertFlag',
      legacyCode: '!flag',
      modernCode: '!flag',
      specMarkdown: 'Negates boolean input.',
      fuzzRuns: 20,
      schema: { flag: 'boolean' },
    });
    expect(bundle.files['resurrected.ts']).toContain('export function invertFlag(flag: boolean)');
    expect(bundle.files['resurrected.test.ts']).toContain('fc.boolean()');
  });

  it('22. property: generated resurrected.ts never contains malformed return-comment syntax', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{1,12}$/),
        (name) => {
          const bundle = generateResurrectionBundle({
            specimenName: name,
            legacyCode: 'var x = (n / 2) | 0; x;',
            modernCode: '// header comment\nlet x = Math.trunc(n / 2); x;',
            specMarkdown: 'Spec',
            fuzzRuns: 25,
          });
          expect(bundle.files['resurrected.ts']).not.toContain('return //');
          expect(bundle.files['resurrected.ts']).toContain('return x;');
        }
      ),
      { numRuns: 25 }
    );
  });
});

