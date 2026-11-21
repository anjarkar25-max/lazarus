/**
 * Legacy CommonJS numeric clamp & 32-bit quantizer utility
 */
module.exports = function quantizeClamp(n) {
  var clamped = n < -100 ? -100 : (n > 100 ? 100 : n);
  return (clamped / 3) | 0;
};
