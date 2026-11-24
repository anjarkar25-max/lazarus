// Space trimming that predates String.prototype.trim support in the target browsers.
function trimSpaces(str) {
  var s = String(str);
  var start = 0, end = s.length;
  while (start < end && s.charAt(start) == " ") start++;
  while (end > start && s.charAt(end - 1) == " ") end--;
  return s.substring(start, end);
}

exports.trimSpaces = trimSpaces;
