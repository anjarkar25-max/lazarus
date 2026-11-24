// Sales tax in basis points (8.25%), rounded toward zero.
var money = require('./money.cjs');

var RATE_BPS = 825;

function taxFor(cents) {
  var tax = (cents * RATE_BPS / 10000) | 0;
  return tax;
}

exports.taxFor = taxFor;

exports.withTax = function (cents) {
  return money.addCents(cents, taxFor(cents));
};
