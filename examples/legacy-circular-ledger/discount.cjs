// Discount side of the ledger: take the loyalty discount, then hand the total back to tax.cjs for the next round.
var tax = require('./tax.cjs');

var DISCOUNT_PERCENT = 15;
var MAX_ROUNDS = 12;

function discountOf(cents) {
  return ((cents * DISCOUNT_PERCENT) / 100) | 0;
}

exports.discountOf = discountOf;

exports.settle = function (cents, rounds) {
  var left = rounds | 0;
  if (left > MAX_ROUNDS) left = MAX_ROUNDS;
  var total = cents | 0;
  if (left <= 0) return total;
  return tax.settle((total - discountOf(total)) | 0, left - 1);
};
