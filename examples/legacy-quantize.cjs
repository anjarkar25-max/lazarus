// Legacy ES5 / CommonJS specimen: clamp to [-100, 100], then quantize into thirds.
// Resurrect it with:  npm run resurrect -- ./examples/legacy-quantize.cjs --out ./resurrected-out
module.exports = function quantizeClamp(n) {
  var clamped = n < -100 ? -100 : (n > 100 ? 100 : n);
  return (clamped / 3) | 0;
};
