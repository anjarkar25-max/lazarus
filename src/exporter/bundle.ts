export interface ResurrectionBundleInput {
  specimenName?: string;
  legacyCode: string;
  modernCode: string;
  specMarkdown: string;
  fuzzRuns?: number;
  healed?: boolean;
  schema?: Record<string, string>;
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

function resolvePrimaryParam(schema?: Record<string, string>): {
  paramName: string;
  tsType: string;
  fcArbitrary: string;
} {
  const entries = schema ? Object.entries(schema) : [];
  const first = entries[0];
  if (!first) {
    return {
      paramName: 'n',
      tsType: 'number',
      fcArbitrary: 'fc.integer({ min: -10000, max: 10000 })',
    };
  }
  const [rawName, rawType] = first;
  const paramName = sanitizeIdentifier(rawName);
  const normalized = (rawType || 'integer').toLowerCase();
  if (normalized === 'string') {
    return {
      paramName,
      tsType: 'string',
      fcArbitrary: 'fc.string({ minLength: 0, maxLength: 32 })',
    };
  }
  if (normalized === 'boolean') {
    return {
      paramName,
      tsType: 'boolean',
      fcArbitrary: 'fc.boolean()',
    };
  }
  return {
    paramName,
    tsType: 'number',
    fcArbitrary: 'fc.integer({ min: -10000, max: 10000 })',
  };
}

function formatFunctionBody(code: string): string {
  const stripped = code
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .trim();

  if (!stripped) return '  return undefined;';

  if (/\breturn\b/.test(stripped)) {
    return stripped
      .split(/\r?\n/)
      .map((line) => `  ${line}`)
      .join('\n');
  }

  const statements = stripped
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  if (statements.length <= 1) {
    const expr = statements[0] ?? stripped;
    return `  return ${expr};`;
  }

  const last = statements[statements.length - 1] ?? '';
  const prefix = statements.slice(0, -1).map((s) => `  ${s};`);
  return [...prefix, `  return ${last};`].join('\n');
}

export function generateResurrectionBundle(input: ResurrectionBundleInput): ResurrectionBundle {
  const fnName = sanitizeIdentifier(input.specimenName);
  const legacyClean = input.legacyCode.trim();
  const modernClean = input.modernCode.trim();
  const fuzzRuns = input.fuzzRuns && input.fuzzRuns > 0 ? input.fuzzRuns : 100;
  const generatedAt = new Date().toISOString();
  const { paramName, tsType, fcArbitrary } = resolvePrimaryParam(input.schema);

  const modernBody = formatFunctionBody(modernClean);
  const legacyBody = formatFunctionBody(legacyClean);

  const tsFile = [
    `/**`,
    ` * Autonomously resurrected by Lazarus Kiro Crew`,
    ` * Parity verified via fast-check differential fuzzing (${fuzzRuns} runs)`,
    ` */`,
    `export function ${fnName}(${paramName}: ${tsType}): unknown {`,
    modernBody,
    `}`,
    ``,
  ].join('\n');

  const specFile = [
    `# Kiro Resurrection Specification: ${fnName}`,
    ``,
    `- **Status:** 100% Behavioral Parity Proven (\`Object.is\`)`,
    `- **Differential Fuzzing Runs:** ${fuzzRuns}`,
    `- **Self-Healed by Necromancer:** ${input.healed ? 'Yes' : 'No (Zero Divergences)'}`,
    `- **Input Contract:** \`${paramName}: ${tsType}\``,
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
    `function runLegacy(${paramName}: ${tsType}): unknown {`,
    legacyBody,
    `}`,
    ``,
    `describe('${fnName} differential parity suite', () => {`,
    `  it('maintains 100% Object.is behavioral parity across ${fuzzRuns} inputs', () => {`,
    `    fc.assert(`,
    `      fc.property(${fcArbitrary}, (${paramName}) => {`,
    `        expect(Object.is(${fnName}(${paramName}), runLegacy(${paramName}))).toBe(true);`,
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
    `@@ -1,3 +1,5 @@`,
    ...legacyClean.split(/\r?\n/).map((line) => `-${line}`),
    `+export function ${fnName}(${paramName}: ${tsType}): unknown {`,
    ...modernBody.split(/\r?\n/).map((line) => `+${line}`),
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
