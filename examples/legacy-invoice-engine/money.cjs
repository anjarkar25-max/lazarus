// Integer-cent money helpers (ES5, 2009-era). Amounts are 32-bit integer cents.
function toCents(amount) {
  return Math.round(amount * 100) | 0;
}

function addCents(a, b) {
  var sum = a + b;
  return sum | 0;
}

function formatCents(cents) {
  var sign = cents < 0 ? "-" : "";
  var abs = Math.abs(cents);
  var whole = (abs / 100) | 0;
  var rest = abs % 100;
  return sign + "$" + whole + "." + (rest < 10 ? "0" + rest : "" + rest);
}

module.exports = {
  toCents: toCents,
  addCents: addCents,
  formatCents: formatCents
};
