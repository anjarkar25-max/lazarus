// Invoice totals: quantity x unit price, plus tax, formatted for the PDF renderer.
var money = require('./money.cjs');
var tax = require('./tax.cjs');

var MAX_LINES = 50;

function invoiceTotal(unitCents, qty) {
  var subtotal = 0;
  for (var i = 0; i < qty && i < MAX_LINES; i++) {
    subtotal = money.addCents(subtotal, unitCents);
  }
  var total = tax.withTax(subtotal);
  return money.formatCents(total);
}

module.exports = { invoiceTotal: invoiceTotal };
