export interface ScannedFunction {
  name: string;
  params: string[];
  arity: number;
  isExported: boolean;
  legacyPatterns: string[];
  runnableExpression: string;
}

export interface AstScanResult {
  functions: ScannedFunction[];
  primaryExpression: string;
  detectedIdioms: string[];
}

export function scanLegacyAst(source: string): AstScanResult {
  const trimmed = source.trim();
  const detectedIdioms: string[] = [];

  if (/\bvar\b/.test(trimmed)) detectedIdioms.push('ES5 var declaration');
  if (/\|\s*0\b/.test(trimmed)) detectedIdioms.push('32-bit bitwise truncation (| 0)');
  if (/Math\.floor\s*\(/.test(trimmed)) detectedIdioms.push('Math.floor division');
  if (/module\.exports|exports\./.test(trimmed)) detectedIdioms.push('CommonJS export');
  if (/\.charCodeAt\s*\(/.test(trimmed)) detectedIdioms.push('ASCII charCodeAt loop');
  if (/\barguments\b/.test(trimmed)) detectedIdioms.push('ES5 arguments object');

  const functions: ScannedFunction[] = [];
  const fnRegex = /(?:(?:module\.exports\s*=\s*|exports\.([a-zA-Z_$][\w$]*)\s*=\s*)?function\s*([a-zA-Z_$][\w$]*)?\s*\(([^)]*)\)\s*\{([\s\S]*?)\})/g;

  let match: RegExpExecArray | null;
  while ((match = fnRegex.exec(trimmed)) !== null) {
    const exportedName = match[1];
    const declaredName = match[2];
    const name = exportedName || declaredName || 'anonymousSpecimen';
    const rawParams = (match[3] ?? '').trim();
    const params = rawParams ? rawParams.split(',').map((p) => p.trim()).filter(Boolean) : [];
    const body = (match[4] ?? '').trim();
    const isExported = Boolean(exportedName) || /module\.exports/.test(match[0] ?? '');

    const varReturnMatch = body.match(/^var\s+([a-zA-Z_$][\w$]*)\s*=\s*([\s\S]+?);\s*return\s+\1\s*;?$/);
    const directReturnMatch = body.match(/^return\s+([\s\S]+?)\s*;?$/);

    let runnableExpression: string;
    if (varReturnMatch && varReturnMatch[2]) {
      runnableExpression = varReturnMatch[2].trim();
    } else if (directReturnMatch && directReturnMatch[1]) {
      runnableExpression = directReturnMatch[1].trim();
    } else {
      runnableExpression = `(function(${params.join(', ')}){ ${body} })(typeof n !== "undefined" ? n : undefined)`;
    }

    functions.push({
      name,
      params,
      arity: params.length,
      isExported,
      legacyPatterns: [...detectedIdioms],
      runnableExpression,
    });
  }

  const firstFn = functions[0];
  const primaryExpression = firstFn
    ? firstFn.runnableExpression
    : trimmed.replace(/^module\.exports\s*=\s*/, '').replace(/;$/, '');

  return {
    functions,
    primaryExpression,
    detectedIdioms,
  };
}
