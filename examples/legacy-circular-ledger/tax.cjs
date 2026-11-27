// Tax side of the ledger. Settling a bill alternates with discount.cjs: add tax, then hand the total to the discount
// side for the next round. The two modules require each other (a CommonJS cycle).
var discount = require('./discount.cjs');

var RATE_PERCENT = 8;
var MAX_ROUNDS = 12;

function taxOf(cents) {
  return ((cents * RATE_PERCENT) / 100) | 0;
}

exports.taxOf = taxOf;

exports.settle = function (cents, rounds) {
  var left = rounds | 0;
  if (left > MAX_ROUNDS) left = MAX_ROUNDS;
  var total = cents | 0;
  if (left <= 0) return total;
  return discount.settle((total + taxOf(total)) | 0, left - 1);
};
