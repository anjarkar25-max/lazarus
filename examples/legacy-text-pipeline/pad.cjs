// Left padding with dots, capped at 64 columns.
var trim = require('./trim.cjs');

exports.padLeft = function (str, len) {
  var s = trim.trimSpaces(str);
  var n = len | 0;
  if (n > 64) n = 64;
  while (s.length < n) s = "." + s;
  return s;
};
