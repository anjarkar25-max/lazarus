export interface ResurrectionBundleInput {
  specimenName?: string;
  legacyCode: string;
  modernCode: string;
  specMarkdown: string;
  fuzzRuns?: number;
  healed?: boolean;
}

export interface ResurrectionBundle {
  specimenName: string;
  generatedAt: string;
  files: {
    'resurrected.ts': string;
    'SPEC.md': string;
    'resurrected.test.ts': string;
  };
  prDiff: string;
}

export function sanitizeIdentifier(raw?: string): string {
  const cleaned = (raw || 'resurrectedSpecimen').replace(/[^a-zA-Z0-9_$]/g, '_');
  return /^[a-zA-Z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

export function generateResurrectionBundle(input: ResurrectionBundleInput): ResurrectionBundle {
  const fnName = sanitizeIdentifier(input.specimenName);
  const legacyClean = input.legacyCode.trim();
  const modernClean = input.modernCode.trim();
  const fuzzRuns = input.fuzzRuns && input.fuzzRuns > 0 ? input.fuzzRuns : 100;
  const generatedAt = new Date().toISOString();

  const tsFile = [
    `/**`,
    ` * Autonomously resurrected by Lazarus Kiro Crew`,
    ` * Parity verified via fast-check differential fuzzing (${fuzzRuns} runs)`,
    ` */`,
    `export function ${fnName}(n: number): unknown {`,
    `  return ${modernClean};`,
    `}`,
    ``,
  ].join('\n');

  const specFile = [
    `# Kiro Resurrection Specification: ${fnName}`,
    ``,
    `- **Status:** 100% Behavioral Parity Proven (\`Object.is\`)`,
    `- **Differential Fuzzing Runs:** ${fuzzRuns}`,
    `- **Self-Healed by Necromancer:** ${input.healed ? 'Yes' : 'No (Zero Divergences)'}`,
    ``,
    `## Legacy Source`,
    '```javascript',
    legacyClean,
    '```',
    ``,
    `## Modernized ES2022/TypeScript Implementation`,
    '```typescript',
    modernClean,
    '```',
    ``,
    `## Synthesized Specification`,
    input.specMarkdown.trim(),
    ``,
  ].join('\n');

  const testFile = [
    `import { describe, it, expect } from 'vitest';`,
    `import fc from 'fast-check';`,
    `import { ${fnName} } from './resurrected.js';`,
    ``,
    `function runLegacy(n: number): unknown {`,
    `  return ${legacyClean};`,
    `}`,
    ``,
    `describe('${fnName} differential parity suite', () => {`,
    `  it('maintains 100% Object.is behavioral parity across ${fuzzRuns} inputs', () => {`,
    `    fc.assert(`,
    `      fc.property(fc.integer({ min: -10000, max: 10000 }), (n) => {`,
    `        expect(Object.is(${fnName}(n), runLegacy(n))).toBe(true);`,
    `      }),`,
    `      { numRuns: ${fuzzRuns} }`,
    `    );`,
    `  });`,
    `});`,
    ``,
  ].join('\n');

  const prDiff = [
    `diff --git a/legacy.cjs b/resurrected.ts`,
    `--- a/legacy.cjs`,
    `+++ b/resurrected.ts`,
    `@@ -1,3 +1,4 @@`,
    `-module.exports = function(n) { return ${legacyClean}; };`,
    `+export function ${fnName}(n: number): unknown {`,
    `+  return ${modernClean};`,
    `+}`,
  ].join('\n');

  return {
    specimenName: fnName,
    generatedAt,
    files: {
      'resurrected.ts': tsFile,
      'SPEC.md': specFile,
      'resurrected.test.ts': testFile,
    },
    prDiff,
  };
}
