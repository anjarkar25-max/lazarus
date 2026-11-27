// The curated single-file presets of the Operating Table (public/index.html), as data for the benchmark.
// studio tests check that every entry here is byte-for-byte the preset the UI ships.
import type { InputSchema } from "./fuzzer/types.js";

export interface BenchmarkPreset {
  /** The preset's module name in the UI. */
  readonly name: string;
  readonly code: string;
  /** Flat schema, or per-export schemas for a multi-export module. */
  readonly schema: InputSchema | Record<string, InputSchema>;
  readonly module?: true;
  /** Node.js error-first callback module: resurrected by the async pass (async/await, both settlements fuzzed). */
  readonly async?: true;
}

export const BENCHMARK_PRESETS: readonly BenchmarkPreset[] = [
  { name: "legacy-int-halve", code: "var half = (n / 2) | 0; half;", schema: { n: "integer" } },
  { name: "fast-truncate-32", code: "var x = (a * 3) | 0; x;", schema: { a: "integer" } },
  { name: "es5-ascii-checksum", code: "var sum = 0; for (var i = 0; i < text.length; i++) { sum += text.charCodeAt(i); } sum;", schema: { text: "string" } },
  { name: "truncateHalf", code: "module.exports = function truncateHalf(n) {\n  var r = (n / 2) | 0;\n  return r;\n};", schema: { n: "integer" } },
  { name: "legacyLeftPad", code: 'var out = String(text); while (out.length < 8) { out = "0" + out; } out;', schema: { text: "string" } },
  {
    name: "quantizeClamp",
    code: "module.exports = function quantizeClamp(n) {\n  var clamped = n < -100 ? -100 : (n > 100 ? 100 : n);\n  return (clamped / 3) | 0;\n};",
    schema: { n: "integer" },
  },
  { name: "stringHash32", code: "var h = 0; for (var i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; } h;", schema: { text: "string" } },
  { name: "mixAB", code: "module.exports = function mix(a, b) {\n  var s = a * 3 + b;\n  return (s / 2) | 0;\n};", schema: { a: "integer", b: "integer" } },
  {
    name: "legacyCounterClass",
    code: "// ES5 constructor + prototype methods + static factory\nfunction Counter(start) {\n  this.n = start;\n}\nCounter.prototype.inc = function (step) {\n  this.n = this.n + step;\n  return this;\n};\nCounter.prototype.value = function () {\n  return this.n;\n};\nCounter.create = function (start) {\n  return new Counter(start);\n};\nvar counter = Counter.create(start);\ncounter.inc(step).inc(step);\ncounter.value();",
    schema: { start: "integer", step: "integer" },
  },
  {
    name: "cjsMathUtils",
    code: "// Three exports, resurrected one by one and bundled as named ES exports\nexports.clamp = function (n, lo, hi) {\n  return Math.min(hi, Math.max(lo, n));\n};\nexports.halve = function (n) {\n  return (n / 2) | 0;\n};\nexports.average = function (a, b) {\n  return (a + b) / 2;\n};",
    schema: { clamp: { n: "integer", lo: "integer", hi: "integer" }, halve: { n: "integer" }, average: { a: "integer", b: "integer" } },
    module: true,
  },
  {
    name: "legacyReadConfigCb",
    code: "// Legacy config reader (Node 0.10 era): \"port=8080\" or \"8080\" -> settings object, error-first callback.\nfunction parsePort(raw, cb) {\n  var text = String(raw).trim();\n  if (text.indexOf(\"port=\") === 0) text = text.slice(5);\n  var port = parseInt(text, 10);\n  if (isNaN(port)) return cb(new TypeError(\"Port must be a number: \" + JSON.stringify(raw)));\n  if (port < 1 || port > 65535) return cb(new RangeError(\"Port out of range: \" + port));\n  cb(null, port);\n}\n\nfunction legacyReadConfigCb(text, cb) {\n  if (typeof text !== \"string\") return cb(new TypeError(\"Config must be a string\"));\n  parsePort(text, function (err, port) {\n    if (err) return cb(err);\n    var config = { port: port, secure: port === 443 || port === 8443, source: \"legacy-ini\" };\n    setTimeout(function () {\n      cb(null, config);\n    }, 0);\n  });\n}\n\nmodule.exports = legacyReadConfigCb;",
    schema: { text: "string" },
    async: true,
  },
];
