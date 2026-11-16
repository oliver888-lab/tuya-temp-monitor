'use strict';
// 示範模式用的假溫度：每個感測點有不同的基準溫度、緩慢起伏，並不定時出現約 20 秒的驟降。
function mockValue(ts, i = 0) {
  const minute = Math.floor(ts / 60_000);
  const sec = Math.floor(ts / 1000) % 60;
  const base = 52 + (i % 3) * 5 + Math.floor(i / 3);
  let v = base + 1.5 * Math.sin(ts / ((18 + i) * 60_000) + i) + 0.05 * Math.sin(ts / 7000 + i);
  if ((minute + i * 7) % (37 + i * 5) === 0 && sec >= 20 && sec < 40) v -= 4;
  return Math.round(v * 10) / 10;
}

module.exports = { mockValue };
