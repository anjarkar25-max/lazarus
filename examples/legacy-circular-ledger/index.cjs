// Ledger entry points: run a bill through alternating tax and discount rounds.
var tax = require('./tax.cjs');
var discount = require('./discount.cjs');

exports.ledgerTotal = function (cents, rounds) {
  return tax.settle(cents, rounds);
};

exports.ledgerNet = function (cents, rounds) {
  return discount.settle(cents, rounds);
};
