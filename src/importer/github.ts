import { scanLegacyAst } from '../sandbox/ast-scanner.js';

export const MAX_SPECIMEN_BYTES = 32 * 1024;

export interface UrlValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  error?: string;
}

export function validateAndNormalizeGitHubUrl(rawUrl: string): UrlValidationResult {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { valid: false, error: 'URL must not be empty.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Invalid URL format.' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'Only HTTPS GitHub URLs are allowed.' };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: 'Credentials in URLs are not allowed.' };
  }

  const host = parsed.hostname.toLowerCase();
  const allowedHosts = new Set([
    'github.com',
    'raw.githubusercontent.com',
    'gist.githubusercontent.com',
  ]);

  if (!allowedHosts.has(host)) {
    return { valid: false, error: 'Host must be github.com or raw.githubusercontent.com.' };
  }

  let normalizedPath = parsed.pathname;
  let targetHost = host;

  if (host === 'github.com') {
    const parts = normalizedPath.split('/').filter(Boolean);
    if (parts.length < 5 || parts[2] !== 'blob') {
      return { valid: false, error: 'GitHub repo URL must point to a file (/blob/<branch>/<path>.js).' };
    }
    const [owner, repo, , branch, ...fileParts] = parts;
    targetHost = 'raw.githubusercontent.com';
    normalizedPath = `/${[owner, repo, branch, ...fileParts].join('/')}`;
  }

  if (!/\.(c?js)$/i.test(normalizedPath)) {
    return { valid: false, error: 'Target file must be a .js or .cjs JavaScript file.' };
  }

  return {
    valid: true,
    normalizedUrl: `https://${targetHost}${normalizedPath}`,
  };
}

export function enforcePayloadCap(content: string, maxBytes: number = MAX_SPECIMEN_BYTES): {
  ok: boolean;
  byteLength: number;
  error?: string;
} {
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength === 0) {
    return { ok: false, byteLength: 0, error: 'Fetched file is empty.' };
  }
  if (byteLength > maxBytes) {
    return {
      ok: false,
      byteLength,
      error: `Payload exceeds maximum cap of ${maxBytes} bytes (got ${byteLength} bytes).`,
    };
  }
  return { ok: true, byteLength };
}

export async function fetchGitHubSpecimen(rawUrl: string): Promise<{
  source: string;
  normalizedUrl: string;
  byteLength: number;
  extractedExpression: string;
  detectedIdioms: string[];
}> {
  const validation = validateAndNormalizeGitHubUrl(rawUrl);
  if (!validation.valid || !validation.normalizedUrl) {
    throw new Error(validation.error || 'Invalid GitHub URL');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(validation.normalizedUrl, {
      signal: controller.signal,
      headers: { Accept: 'text/plain' },
    });
    if (!response.ok) {
      throw new Error(`GitHub fetch failed with HTTP ${response.status}`);
    }
    const source = await response.text();
    const cap = enforcePayloadCap(source);
    if (!cap.ok) {
      throw new Error(cap.error);
    }
    const ast = scanLegacyAst(source);
    return {
      source,
      normalizedUrl: validation.normalizedUrl,
      byteLength: cap.byteLength,
      extractedExpression: ast.primaryExpression,
      detectedIdioms: ast.detectedIdioms,
    };
  } finally {
    clearTimeout(timer);
  }
}
