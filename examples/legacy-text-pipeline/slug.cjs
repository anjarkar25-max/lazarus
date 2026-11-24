// URL slugs for the CMS: lower-case ASCII letters and digits, single dashes, padded to a width.
var trim = require('./trim.cjs');
var padLeft = require('./pad.cjs').padLeft;

function slugify(title, width) {
  var t = trim.trimSpaces(title).toLowerCase();
  var out = "";
  for (var i = 0; i < t.length; i++) {
    var c = t.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      out += t.charAt(i);
    } else if (out.length > 0 && out.charAt(out.length - 1) != "-") {
      out += "-";
    }
  }
  return padLeft(out, width);
}

module.exports = slugify;
