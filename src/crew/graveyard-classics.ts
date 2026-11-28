// npm Graveyard Classics: a deterministic registry of five iconic legacy npm utilities.
//
// Each entry is a faithful ES5 / CommonJS snapshot of the package's entry file, with its input schema, license and provenance,
// and the legacy traps that make it a good specimen. The snapshots ship inside Lazarus, so a classic can always be resurrected
// without the network (the live CDN flow of src/importer/npm.ts stays the default for every other package). Two snapshots had a
// one-line dependency that the isolated sandbox cannot load (`require("kind-of")`, `require("repeat-string")`): that code is inlined
// verbatim-by-behaviour and the change is listed under `modifications`, never hidden.
import { createHash } from "node:crypto";
import type { InputSchema } from "../fuzzer/types.js";
import { scanLegacyAst } from "../sandbox/ast-scanner.js";

export interface GraveyardClassic {
  /** `name@x.y.z`, the exact spec the npm importer takes. */
  readonly spec: string;
  readonly name: string;
  readonly version: string;
  /** SPDX identifier of the package's license. */
  readonly license: string;
  /** The license notice kept in the snapshot header (copyright holder). */
  readonly author: string;
  readonly homepage: string;
  readonly repository: string;
  /** One line: what the package did and why it is famous. */
  readonly summary: string;
  /** The legacy traps a careless rewrite falls into. */
  readonly traps: readonly string[];
  /** The fuzz schema of the entry function (what the sandbox feeds it). */
  readonly schema: InputSchema;
  /** The entry file, as it ships (modulo `modifications`). */
  readonly source: string;
  /** Every deviation from the published entry file. Empty when the snapshot is byte-for-byte what the package ships. */
  readonly modifications: readonly string[];
}

const LEFT_PAD = String.raw`'use strict';
module.exports = leftPad;

var cache = [
  '',
  ' ',
  '  ',
  '   ',
  '    ',
  '     ',
  '      ',
  '       ',
  '        ',
  '         '
];

function leftPad (str, len, ch) {
  // convert \`str\` to a \`string\`
  str = str + '';
  // \`len\` is the \`pad\`'s length now
  len = len - str.length;
  // doesn't need to pad
  if (len <= 0) return str;
  // \`ch\` defaults to \`' '\`
  if (!ch && ch !== 0) ch = ' ';
  // convert \`ch\` to a \`string\` cuz it could be a number
  ch = ch + '';
  // cache common use cases
  if (ch === ' ' && len < 10) return cache[len] + str;
  // \`pad\` starts with an empty string
  var pad = '';
  // loop
  while (true) {
    // add \`ch\` to \`pad\` if \`len\` is odd
    if (len & 1) pad += ch;
    // divide \`len\` by 2, ditch the remainder
    len >>= 1;
    // "double" the \`ch\` so this operation count grows logarithmically on \`len\`
    // each time \`ch\` is "doubled", the \`len\` would need to be "doubled" too
    // similar to finding a value in binary search tree, hence O(log(n))
    if (len) ch += ch;
    // \`len\` is 0, exit the loop
    else break;
  }
  // pad \`str\`!
  return pad + str;
}
`.replace(/\\`/g, "`");

const IS_NUMBER = String.raw`/*!
 * is-number <https://github.com/jonschlinkert/is-number>
 *
 * Copyright (c) 2014-2016, Jon Schlinkert.
 * Licensed under the MIT License.
 */

'use strict';

// Vendored from kind-of (MIT, Jon Schlinkert): the sandbox cannot load modules, so the one function is inlined.
function typeOf(val) {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  var type = typeof val;
  if (type === 'boolean') return 'boolean';
  if (type === 'string') return 'string';
  if (type === 'number') return 'number';
  if (Array.isArray(val)) return 'array';
  return 'object';
}

module.exports = function isNumber(num) {
  var type = typeOf(num);

  if (type === 'string') {
    if (!num.trim()) return false;
  } else if (type !== 'number') {
    return false;
  }

  return (num - num + 1) >= 0;
};
`;

const MS = String.raw`/**
 * Helpers.
 */

var s = 1000;
var m = s * 60;
var h = m * 60;
var d = h * 24;
var y = d * 365.25;

/**
 * Parse or format the given \`val\`.
 *
 * Options:
 *
 *  - \`long\` verbose formatting [false]
 *
 * @param {String|Number} val
 * @param {Object} options
 * @throws {Error} throw an error if val is not a non-empty string or a number
 * @return {String|Number}
 * @api public
 */

module.exports = function(val, options) {
  options = options || {};
  var type = typeof val;
  if (type === 'string' && val.length > 0) {
    return parse(val);
  } else if (type === 'number' && isNaN(val) === false) {
    return options.long ?
			fmtLong(val) :
			fmtShort(val);
  }
  throw new Error('val is not a non-empty string or a valid number. val=' + JSON.stringify(val));
};

/**
 * Parse the given \`str\` and return milliseconds.
 *
 * @param {String} str
 * @return {Number}
 * @api private
 */

function parse(str) {
  str = String(str);
  if (str.length > 10000) {
    return;
  }
  var match = /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(str);
  if (!match) {
    return;
  }
  var n = parseFloat(match[1]);
  var type = (match[2] || 'ms').toLowerCase();
  switch (type) {
    case 'years':
    case 'year':
    case 'yrs':
    case 'yr':
    case 'y':
      return n * y;
    case 'days':
    case 'day':
    case 'd':
      return n * d;
    case 'hours':
    case 'hour':
    case 'hrs':
    case 'hr':
    case 'h':
      return n * h;
    case 'minutes':
    case 'minute':
    case 'mins':
    case 'min':
    case 'm':
      return n * m;
    case 'seconds':
    case 'second':
    case 'secs':
    case 'sec':
    case 's':
      return n * s;
    case 'milliseconds':
    case 'millisecond':
    case 'msecs':
    case 'msec':
    case 'ms':
      return n;
    default:
      // No default case
  }
}

/**
 * Short format for \`ms\`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtShort(ms) {
  if (ms >= d) {
    return Math.round(ms / d) + 'd';
  }
  if (ms >= h) {
    return Math.round(ms / h) + 'h';
  }
  if (ms >= m) {
    return Math.round(ms / m) + 'm';
  }
  if (ms >= s) {
    return Math.round(ms / s) + 's';
  }
  return ms + 'ms';
}

/**
 * Long format for \`ms\`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtLong(ms) {
  return plural(ms, d, 'day') ||
    plural(ms, h, 'hour') ||
    plural(ms, m, 'minute') ||
    plural(ms, s, 'second') ||
    ms + ' ms';
}

/**
 * Pluralization helper.
 */

function plural(ms, n, name) {
  if (ms < n) {
    return;
  }
  if (ms < n * 1.5) {
    return Math.floor(ms / n) + ' ' + name;
  }
  return Math.ceil(ms / n) + ' ' + name + 's';
}
`.replace(/\\`/g, "`");

const DECAMELIZE = String.raw`'use strict';
module.exports = function (str, sep) {
	if (typeof str !== 'string') {
		throw new TypeError('Expected a string');
	}

	sep = typeof sep === 'undefined' ? '_' : sep;

	return str
		.replace(/([a-z\d])([A-Z])/g, '$1' + sep + '$2')
		.replace(/([A-Z]+)([A-Z][a-z\d]+)/g, '$1' + sep + '$2')
		.toLowerCase();
};
`;

const PAD_LEFT = String.raw`/*!
 * pad-left <https://github.com/jonschlinkert/pad-left>
 *
 * Copyright (c) 2014-2015, Jon Schlinkert.
 * Licensed under the MIT license.
 */

'use strict';

// Vendored from repeat-string@1.6.1 (MIT, Jon Schlinkert): the sandbox cannot load modules, so the one function is inlined.
var res = '';
var cache;

function repeat(str, num) {
  if (typeof str !== 'string') {
    throw new TypeError('expected a string');
  }

  // cover common, quick use cases
  if (num === 1) return str;
  if (num === 2) return str + str;

  var max = str.length * num;
  if (cache !== str || typeof cache === 'undefined') {
    cache = str;
    res = '';
  } else if (res.length >= max) {
    return res.substr(0, max);
  }

  while (max > res.length && num > 1) {
    if (num & 1) {
      res += str;
    }

    num >>= 1;
    str += str;
  }

  res += str;
  res = res.substr(0, max);
  return res;
}

module.exports = function padLeft(str, num, ch) {
  str = str.toString();

  if (typeof num === 'undefined') {
    return str;
  }

  if (ch === 0) {
    ch = '0';
  } else if (ch) {
    ch = ch.toString();
  } else {
    ch = ' ';
  }

  return repeat(ch, num - str.length) + str;
};
`;

export const GRAVEYARD_CLASSICS: readonly GraveyardClassic[] = [
  {
    spec: "left-pad@1.3.0",
    name: "left-pad",
    version: "1.3.0",
    license: "WTFPL",
    author: "azer (Azer Koçulu)",
    homepage: "https://www.npmjs.com/package/left-pad/v/1.3.0",
    repository: "https://github.com/left-pad/left-pad",
    summary: "The 11-line string padder whose unpublishing broke the npm ecosystem in 2016.",
    traps: [
      "string coercion: `str + ''`, and a numeric `ch` such as 0 is a valid pad character",
      "bitwise halving: `len & 1` and `len >>= 1` run in int32, so a length of 2^31 or more wraps",
      "padding boundaries: a length at or below the string's own length returns it untouched",
    ],
    schema: { str: "string", len: "integer", ch: "string" },
    source: LEFT_PAD,
    modifications: [],
  },
  {
    spec: "is-number@3.0.0",
    name: "is-number",
    version: "3.0.0",
    license: "MIT",
    author: "Jon Schlinkert",
    homepage: "https://www.npmjs.com/package/is-number/v/3.0.0",
    repository: "https://github.com/jonschlinkert/is-number",
    summary: "The numeric-type check used by thousands of packages, including toString-able number strings.",
    traps: [
      "numeric coercion: `(num - num + 1) >= 0` is false for NaN and Infinity because `Infinity - Infinity` is NaN",
      "string handling: a blank string is not a number, but `'0x1F'` and `' 12 '` are",
      "type check: booleans, null and arrays are rejected before any arithmetic",
    ],
    schema: { num: "json" },
    source: IS_NUMBER,
    modifications: ["`require('kind-of')` replaced by an inlined `typeOf` covering the JSON value types (the sandbox cannot load modules)"],
  },
  {
    spec: "ms@0.7.1",
    name: "ms",
    version: "0.7.1",
    license: "MIT",
    author: "Guillermo Rauch (Zeit)",
    homepage: "https://www.npmjs.com/package/ms/v/0.7.1",
    repository: "https://github.com/vercel/ms",
    summary: "Tiny millisecond converter behind debug and countless CLIs: parses '2 days' and formats 172800000.",
    traps: [
      "regex boundaries: the unit alternation is case-insensitive, optional, and guarded by a 10 000 character cap against ReDoS",
      "numeric edge cases: Math.round, Math.ceil and Math.floor decide where '1 day' becomes '2 days', and negative values fall through to 'ms'",
      "error path: anything but a non-empty string or a valid number throws",
    ],
    schema: { val: "json", options: "json" },
    source: MS,
    modifications: [],
  },
  {
    spec: "decamelize@1.2.0",
    name: "decamelize",
    version: "1.2.0",
    license: "MIT",
    author: "Sindre Sorhus",
    homepage: "https://www.npmjs.com/package/decamelize/v/1.2.0",
    repository: "https://github.com/sindresorhus/decamelize",
    summary: "fooBar to foo_bar: the camelCase splitter used by yargs and a long tail of CLIs.",
    traps: [
      "regex backreferences: `'$1' + sep + '$2'` treats a `$` in the separator as a replacement pattern",
      "uppercase runs: the second pattern splits `XMLHttp` into `xml_http` only before a lower-case letter or digit",
      "type guard: a non-string throws a TypeError, an undefined separator defaults to `_`",
    ],
    schema: { str: "string", sep: "string" },
    source: DECAMELIZE,
    modifications: [],
  },
  {
    spec: "pad-left@2.1.0",
    name: "pad-left",
    version: "2.1.0",
    license: "MIT",
    author: "Jon Schlinkert",
    homepage: "https://www.npmjs.com/package/pad-left/v/2.1.0",
    repository: "https://github.com/jonschlinkert/pad-left",
    summary: "The padding helper that delegates to repeat-string and its module-level cache.",
    traps: [
      "string coercion: `str.toString()`, and `ch === 0` becomes the character '0' while other falsy values become a space",
      "padding boundaries: `num - str.length` can be zero or negative, and `num === 1` / `num === 2` take a shortcut",
      "bitwise halving: repeat-string's `num & 1` and `num >>= 1` wrap beyond 32 bits, and it keeps a module-level cache",
    ],
    schema: { str: "string", num: "integer", ch: "string" },
    source: PAD_LEFT,
    modifications: ["`require('repeat-string')` replaced by the inlined repeat-string@1.6.1 function (the sandbox cannot load modules)"],
  },
];

/** The classic for an exact `name@x.y.z` spec, or undefined. */
export function findClassic(spec: string): GraveyardClassic | undefined {
  return GRAVEYARD_CLASSICS.find((c) => c.spec === spec);
}

export const sha256Of = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** What GET /api/graveyard-classics lists for one classic (no source: that is what the import returns). */
export interface ClassicSummary {
  readonly spec: string;
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly author: string;
  readonly homepage: string;
  readonly repository: string;
  readonly summary: string;
  readonly traps: readonly string[];
  readonly schema: InputSchema;
  readonly byteLength: number;
  readonly sha256: string;
  readonly modifications: readonly string[];
  readonly functionName: string | undefined;
}

export function summarizeClassic(c: GraveyardClassic): ClassicSummary {
  const scan = scanLegacyAst(c.source);
  return {
    spec: c.spec,
    name: c.name,
    version: c.version,
    license: c.license,
    author: c.author,
    homepage: c.homepage,
    repository: c.repository,
    summary: c.summary,
    traps: c.traps,
    schema: c.schema,
    byteLength: Buffer.byteLength(c.source, "utf8"),
    sha256: sha256Of(c.source),
    modifications: c.modifications,
    functionName: scan.primary?.name,
  };
}
