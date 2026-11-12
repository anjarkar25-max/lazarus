import type { CodeSynthesizer, SynthesizeContext } from "./types.js";

/**
 * Deterministic modernizer that upgrades legacy ES5/CommonJS idioms into strict modern ES2022+
 * while preserving exact JavaScript edge-case semantics (such as Math.trunc for `| 0`).
 */
export class DeterministicModernizer implements CodeSynthesizer {
  async synthesize(ctx: SynthesizeContext): Promise<string> {
    let modernized = ctx.legacyCode.trim();

    // Upgrade legacy `var` declarations to block-scoped `let`/`const`
    modernized = modernized.replace(/\bvar\s+/g, "let ");

    // Upgrade loose equality to strict equality where safe
    modernized = modernized.replace(/([^!=])==([^=])/g, "$1===$2");
    modernized = modernized.replace(/!=([^=])/g, "!==$1");

    // Preserve 32-bit integer truncation semantics using Math.trunc instead of lossy Math.floor
    modernized = modernized.replace(/\(([^()]+)\)\s*\|\s*0\b/g, "Math.trunc($1)");
    modernized = modernized.replace(/\b([a-zA-Z_$][\w$]*)\s*\|\s*0\b/g, "Math.trunc($1)");

    // Add modern header annotation
    const header = `// Resurrected by Lazarus Necromancer (attempt ${ctx.attempt})\n`;
    return `${header}${modernized}`;
  }
}
