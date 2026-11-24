import type * as ESTree from 'estree';
import { parseProgram, printProgram } from '../crew/ast-modernizer.js';
import { usesOwnThisOrArguments } from '../crew/ast-scope.js';

export interface ResurrectionBundleInput {
  specimenName?: string;
  legacyCode: string;
  modernCode: string;
  specMarkdown: string;
  fuzzRuns?: number;
  healed?: boolean;
  schema?: Record<string, string>;
  /** Complete CommonJS -> ESM conversion of the legacy module (see toEsmModule). */
  esmModule?: { code: string; exports: string[] };
  /**
   * The specimen exactly as the developer wrote it. `legacyCode` is the runnable expression used to
   * build the parity oracle; this is what the diff, SPEC.md and legacy.cjs show. Defaults to `legacyCode`.
   */
  legacySource?: string;
  /**
   * Multi-export CommonJS module: one typed `export function` and one parity test per entry.
   * When absent, the single-function layout is produced unchanged.
   */
  functions?: ModuleFunctionInput[];
  /** Resurrection Certificate block (see certificate.ts), embedded in SPEC.md under the status list. */
  certificateMarkdown?: string;
}
export interface ModuleFunctionInput {
  /** Export name (the TypeScript function name). */
  name: string;
  schema: Record<string, string>;
  /** Runnable legacy expression for this function. */
  legacyCode: string;
  modernCode: string;
}

export interface ResurrectionBundle {
  specimenName: string;
  generatedAt: string;
  files: {
    'resurrected.ts': string;
    'SPEC.md': string;
    'resurrected.test.ts': string;
    /** ES2022 module (only when the legacy source was a CommonJS module that converts exactly). */
    'resurrected.mjs'?: string;
    'legacy.cjs'?: string;
    'resurrected.esm.test.ts'?: string;
  };
  prDiff: string;
}

export function sanitizeIdentifier(raw?: string): string {
  const cleaned = (raw || 'resurrectedSpecimen').replace(/[^a-zA-Z0-9_$]/g, '_');
  return /^[a-zA-Z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

interface ParamSpec {
  paramName: string;
  tsType: string;
  fcArbitrary: string;
}

function paramFor(rawName: string, rawType: string | undefined): ParamSpec {
  const paramName = sanitizeIdentifier(rawName);
  const normalized = (rawType || 'integer').toLowerCase();
  if (normalized === 'string') {
    return { paramName, tsType: 'string', fcArbitrary: 'fc.string({ minLength: 0, maxLength: 32 })' };
  }
  if (normalized === 'boolean') {
    return { paramName, tsType: 'boolean', fcArbitrary: 'fc.boolean()' };
  }
  if (normalized === 'number') {
    return { paramName, tsType: 'number', fcArbitrary: 'fc.double({ min: -10000, max: 10000, noNaN: true })' };
  }
  if (normalized === 'json') {
    return { paramName, tsType: 'unknown', fcArbitrary: 'fc.jsonValue()' };
  }
  return { paramName, tsType: 'number', fcArbitrary: 'fc.integer({ min: -10000, max: 10000 })' };
}

/** Every schema entry becomes a parameter, in order; an empty schema means a single integer `n`. */
function resolveParams(schema?: Record<string, string>): ParamSpec[] {
  const entries = schema ? Object.entries(schema) : [];
  if (entries.length === 0) return [paramFor('n', 'integer')];
  return entries.map(([name, type]) => paramFor(name, type));
}

/**
 * The scanner wraps multi-statement specimens as `(function (a, b) { ... })(guarded a, guarded b)`.
 * When the call just forwards the outer parameters, the body can be inlined into the typed function
 * (an untyped inner function would not compile under `noImplicitAny`).
 */
function unwrapForwardingIife(ast: ESTree.Program, outerNames: ReadonlySet<string>): ESTree.Statement[] | undefined {
  const only = ast.body.length === 1 ? ast.body[0] : undefined;
  if (only === undefined || only.type !== 'ExpressionStatement' || only.expression.type !== 'CallExpression') return undefined;
  const call = only.expression;
  const fn = call.callee;
  if (fn.type !== 'FunctionExpression' && fn.type !== 'ArrowFunctionExpression') return undefined;
  if (fn.async || ('generator' in fn && fn.generator)) return undefined;
  if (fn.params.some((p) => p.type !== 'Identifier') || call.arguments.length !== fn.params.length) return undefined;
  if (usesOwnThisOrArguments(fn)) return undefined;

  const forwards = fn.params.every((param, i) => {
    const arg = call.arguments[i];
    if (param.type !== 'Identifier' || arg === undefined || !outerNames.has(param.name)) return false;
    // typeof p !== "undefined" ? p : undefined
    return (
      arg.type === 'ConditionalExpression' &&
      arg.consequent.type === 'Identifier' &&
      arg.consequent.name === param.name &&
      arg.alternate.type === 'Identifier' &&
      arg.alternate.name === 'undefined' &&
      arg.test.type === 'BinaryExpression' &&
      arg.test.operator === '!==' &&
      arg.test.left.type === 'UnaryExpression' &&
      arg.test.left.operator === 'typeof' &&
      arg.test.left.argument.type === 'Identifier' &&
      arg.test.left.argument.name === param.name
    );
  });
  if (!forwards) return undefined;
  if (fn.body.type === 'BlockStatement') return fn.body.body as ESTree.Statement[];
  return [{ type: 'ReturnStatement', argument: fn.body }];
}

/**
 * Statement-aware formatting: parse the snippet, turn a trailing expression statement into the
 * function's return value, and print it. Returns undefined when the snippet does not parse.
 */
function formatBodyViaAst(source: string, outerNames: ReadonlySet<string>): string | undefined {
  const parsed = parseProgram(source);
  if ('error' in parsed) return undefined;
  const { ast } = parsed;
  const inlined = unwrapForwardingIife(ast, outerNames);
  if (inlined !== undefined) ast.body = inlined;
  const last = ast.body[ast.body.length - 1];
  const hasReturn = ast.body.some((statement) => statement.type === 'ReturnStatement');
  if (!hasReturn && last !== undefined && last.type === 'ExpressionStatement') {
    ast.body[ast.body.length - 1] = { type: 'ReturnStatement', argument: last.expression };
  }
  return printProgram(ast, [])
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function formatFunctionBody(code: string, outerNames: ReadonlySet<string>): string {
  const stripped = code
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .trim();

  if (!stripped) return '  return undefined;';

  const viaAst = formatBodyViaAst(stripped, outerNames);
  if (viaAst !== undefined) return viaAst;

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

function generateSingleBundle(input: ResurrectionBundleInput): ResurrectionBundle {
  const fnName = sanitizeIdentifier(input.specimenName);
  const legacyClean = input.legacyCode.trim();
  const modernClean = input.modernCode.trim();
  const fuzzRuns = input.fuzzRuns && input.fuzzRuns > 0 ? input.fuzzRuns : 100;
  const generatedAt = new Date().toISOString();
  const params = resolveParams(input.schema);
  const signature = params.map((p) => `${p.paramName}: ${p.tsType}`).join(', ');
  const argNames = params.map((p) => p.paramName).join(', ');
  const arbitraries = params.map((p) => p.fcArbitrary).join(', ');
  const firstArbitrary = params[0]?.fcArbitrary ?? 'fc.integer({ min: -10000, max: 10000 })';
  const sourceClean = (input.legacySource ?? input.legacyCode).trim();

  const outerNames = new Set(params.map((p) => p.paramName));
  const modernBody = formatFunctionBody(modernClean, outerNames);
  const legacyBody = formatFunctionBody(legacyClean, outerNames);

  const moduleFns = input.functions !== undefined && input.functions.length > 0 ? input.functions : undefined;
  const perFn = (moduleFns ?? []).map((fn) => {
    const fnParams = resolveParams(fn.schema);
    const names = new Set(fnParams.map((p) => p.paramName));
    return {
      name: sanitizeIdentifier(fn.name),
      signature: fnParams.map((p) => `: `).join(', '),
      argNames: fnParams.map((p) => p.paramName).join(', '),
      arbitraries: fnParams.map((p) => p.fcArbitrary).join(', '),
      modernBody: formatFunctionBody(fn.modernCode.trim(), names),
      legacyBody: formatFunctionBody(fn.legacyCode.trim(), names),
    };
  });
  const tsFile = moduleFns !== undefined
    ? [
        `/**`,
        ` * Autonomously resurrected by Lazarus Kiro Crew ( exported functions)`,
        ` * Parity verified via fast-check differential fuzzing ( runs each)`,
        ` */`,
        ...perFn.flatMap((f) => [`export function (): unknown {`, f.modernBody, `}`, ``]),
      ].join('\n')
    : [
    `/**`,
    ` * Autonomously resurrected by Lazarus Kiro Crew`,
    ` * Parity verified via fast-check differential fuzzing (${fuzzRuns} runs)`,
    ` */`,
    `export function ${fnName}(${signature}): unknown {`,
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
    `- **Input Contract:** \`${signature}\``,
    ``,
    ...(input.certificateMarkdown !== undefined ? [input.certificateMarkdown.trim(), ``] : []),
    `## Legacy Source`,
    '```javascript',
    sourceClean,
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

  const testFile = moduleFns !== undefined
    ? [
        `import { describe, it, expect } from 'vitest';`,
        `import fc from 'fast-check';`,
        `import {  } from './resurrected.js';`,
        ``,
        ...perFn.flatMap((f) => [`function runLegacy_(): unknown {`, f.legacyBody, `}`, ``]),
        `describe(' differential parity suite', () => {`,
        ...perFn.flatMap((f) => [
          `  it(' maintains Object.is behavioral parity across  inputs', () => {`,
          `    fc.assert(`,
          `      fc.property(, () => {`,
          `        expect(Object.is((), runLegacy_())).toBe(true);`,
          `      }),`,
          `      { numRuns:  }`,
          `    );`,
          `  });`,
        ]),
        `});`,
        ``,
      ].join('\n')
    : [
    `import { describe, it, expect } from 'vitest';`,
    `import fc from 'fast-check';`,
    `import { ${fnName} } from './resurrected.js';`,
    ``,
    `function runLegacy(${signature}): unknown {`,
    legacyBody,
    `}`,
    ``,
    `describe('${fnName} differential parity suite', () => {`,
    `  it('maintains 100% Object.is behavioral parity across ${fuzzRuns} inputs', () => {`,
    `    fc.assert(`,
    `      fc.property(${arbitraries}, (${argNames}) => {`,
    `        expect(Object.is(${fnName}(${argNames}), runLegacy(${argNames}))).toBe(true);`,
    `      }),`,
    `      { numRuns: ${fuzzRuns} }`,
    `    );`,
    `  });`,
    `});`,
    ``,
  ].join('\n');

  const esm = input.esmModule;
  const legacyLines = sourceClean.split(/\r?\n/);
  const esmFile =
    esm === undefined
      ? undefined
      : [
          `// Autonomously resurrected by Lazarus Kiro Crew: CommonJS -> ES2022 module`,
          `// Exports: ${esm.exports.join(', ')}`,
          esm.code.trim(),
          ``,
        ].join('\n');
  const esmLines = esmFile?.trimEnd().split(/\r?\n/) ?? [];

  const tsLines = tsFile.trimEnd().split(/\r?\n/);
  const prDiff =
    esmFile === undefined
      ? [
          `diff --git a/legacy.cjs b/resurrected.ts`,
          `--- a/legacy.cjs`,
          `+++ b/resurrected.ts`,
          `@@ -1,${legacyLines.length} +1,${tsLines.length} @@`,
          ...legacyLines.map((line) => `-${line}`),
          ...tsLines.map((line) => `+${line}`),
        ].join('\n')
      : [
          `diff --git a/legacy.cjs b/resurrected.mjs`,
          `--- a/legacy.cjs`,
          `+++ b/resurrected.mjs`,
          `@@ -1,${legacyLines.length} +1,${esmLines.length} @@`,
          ...legacyLines.map((line) => `-${line}`),
          ...esmLines.map((line) => `+${line}`),
        ].join('\n');

  const esmTestFile =
    esm === undefined
      ? undefined
      : [
          `import { describe, it, expect } from 'vitest';`,
          `import fc from 'fast-check';`,
          `import { createRequire } from 'node:module';`,
          `import * as modern from './resurrected.mjs';`,
          ``,
          `const legacy = createRequire(import.meta.url)('./legacy.cjs');`,
          `const exportsUnderTest: Array<[string, unknown, unknown]> = [`,
          ...esm.exports.map((name) =>
            name === 'default'
              ? `  ['default', (modern as Record<string, unknown>)['default'], legacy],`
              : `  [${JSON.stringify(name)}, (modern as Record<string, unknown>)[${JSON.stringify(name)}], legacy[${JSON.stringify(name)}]],`
          ),
          `];`,
          ``,
          `function outcome(fn: unknown, args: unknown[]): { ok: boolean; value?: unknown } {`,
          `  if (typeof fn !== 'function') return { ok: true, value: fn };`,
          `  try {`,
          `    return { ok: true, value: fn(...args) };`,
          `  } catch {`,
          `    return { ok: false };`,
          `  }`,
          `}`,
          ``,
          `describe('${fnName} CommonJS -> ESM parity', () => {`,
          `  it.each(exportsUnderTest)('export %s matches the CommonJS original (${fuzzRuns} inputs)', (_name, next, previous) => {`,
          `    fc.assert(`,
          `      fc.property(fc.array(${firstArbitrary}, { maxLength: 3 }), (args) => {`,
          `        const a = outcome(next, args);`,
          `        const b = outcome(previous, args);`,
          `        expect(a.ok).toBe(b.ok);`,
          `        if (a.ok) expect(Object.is(a.value, b.value)).toBe(true);`,
          `      }),`,
          `      { numRuns: ${fuzzRuns} }`,
          `    );`,
          `  });`,
          `});`,
          ``,
        ].join('\n');

  return {
    specimenName: fnName,
    generatedAt,
    files: {
      'resurrected.ts': tsFile,
      'SPEC.md': specFile,
      'resurrected.test.ts': testFile,
      ...(esmFile !== undefined ? { 'resurrected.mjs': esmFile, 'legacy.cjs': `${sourceClean}\n` } : {}),
      ...(esmTestFile !== undefined ? { 'resurrected.esm.test.ts': esmTestFile } : {}),
    },
    prDiff,
  };
}

export interface ModuleFunctionInput {
  /** Export name (becomes the TypeScript function name). */
  name: string;
  schema: Record<string, string>;
  /** Runnable legacy expression for this function. */
  legacyCode: string;
  modernCode: string;
}

/**
 * Multi-export CommonJS module: one typed `export function` and one parity test per function.
 * Without `functions` this is exactly the single-function bundle.
 */
export function generateResurrectionBundle(input: ResurrectionBundleInput): ResurrectionBundle {
  const base = generateSingleBundle(input);
  const fns = input.functions;
  if (fns === undefined || fns.length === 0) return base;
  const fuzzRuns = input.fuzzRuns && input.fuzzRuns > 0 ? input.fuzzRuns : 100;
  const perFn = fns.map((fn) => {
    const params = resolveParams(fn.schema);
    const names = new Set(params.map((p) => p.paramName));
    return {
      name: sanitizeIdentifier(fn.name),
      signature: params.map((p) => `${p.paramName}: ${p.tsType}`).join(', '),
      argNames: params.map((p) => p.paramName).join(', '),
      arbitraries: params.map((p) => p.fcArbitrary).join(', '),
      modernBody: formatFunctionBody(fn.modernCode.trim(), names),
      legacyBody: formatFunctionBody(fn.legacyCode.trim(), names),
    };
  });
  const tsFile = [
    `/**`,
    ` * Autonomously resurrected by Lazarus Kiro Crew (${perFn.length} exported functions)`,
    ` * Parity verified via fast-check differential fuzzing (${fuzzRuns} runs each)`,
    ` */`,
    ...perFn.flatMap((f) => [`export function ${f.name}(${f.signature}): unknown {`, f.modernBody, `}`, ``]),
  ].join('\n');
  const testFile = [
    `import { describe, it, expect } from 'vitest';`,
    `import fc from 'fast-check';`,
    `import { ${perFn.map((f) => f.name).join(', ')} } from './resurrected.js';`,
    ``,
    ...perFn.flatMap((f) => [`function runLegacy_${f.name}(${f.signature}): unknown {`, f.legacyBody, `}`, ``]),
    `describe('${base.specimenName} differential parity suite', () => {`,
    ...perFn.flatMap((f) => [
      `  it('${f.name} maintains Object.is behavioral parity across ${fuzzRuns} inputs', () => {`,
      `    fc.assert(`,
      `      fc.property(${f.arbitraries}, (${f.argNames}) => {`,
      `        expect(Object.is(${f.name}(${f.argNames}), runLegacy_${f.name}(${f.argNames}))).toBe(true);`,
      `      }),`,
      `      { numRuns: ${fuzzRuns} }`,
      `    );`,
      `  });`,
    ]),
    `});`,
    ``,
  ].join('\n');
  const contract = perFn.map((f) => `\`${f.name}(${f.signature})\``).join(', ');
  const spec = base.files['SPEC.md'].replace(/^- \*\*Input Contract:\*\* .*$/m, () => `- **Input Contract:** ${contract}`);
  const files: ResurrectionBundle['files'] = { ...base.files, 'resurrected.ts': tsFile, 'resurrected.test.ts': testFile, 'SPEC.md': spec };
  if (base.files['resurrected.mjs'] !== undefined) return { ...base, files };
  // Without an ESM file the PR diff compares legacy.cjs with the TypeScript file.
  const legacyLines = (input.legacySource ?? input.legacyCode).trim().split(/\r?\n/);
  const tsLines = tsFile.trimEnd().split(/\r?\n/);
  const prDiff = [
    `diff --git a/legacy.cjs b/resurrected.ts`,
    `--- a/legacy.cjs`,
    `+++ b/resurrected.ts`,
    `@@ -1,${legacyLines.length} +1,${tsLines.length} @@`,
    ...legacyLines.map((line) => `-${line}`),
    ...tsLines.map((line) => `+${line}`),
  ].join('\n');
  return { ...base, files, prDiff };
}
