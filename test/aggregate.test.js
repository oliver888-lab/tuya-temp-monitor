'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MinuteAggregator, MINUTE } = require('../lib/aggregate');

function run(samples, threshold = 1) {
  const out = [];
  const agg = new MinuteAggregator({ threshold, onFinalize: (p) => out.push(p) });
  for (const [ts, v] of samples) agg.add(ts, v);
  agg.flush();
  return out;
}

test('平穩時每分鐘取最後一筆，無異常', () => {
  const out = run([[0, 25], [30_000, 25.2], [MINUTE, 25.3], [MINUTE + 30_000, 25.1]]);
  assert.deepStrictEqual(out.map((p) => [p.v, p.anomaly]), [[25.2, null], [25.1, null]]);
});

test('分鐘內驟降後回升：顯示該分鐘最低值並標記 drop', () => {
  const out = run([[0, 25], [MINUTE, 25], [MINUTE + 20_000, 21.5], [MINUTE + 40_000, 24.9]]);
  assert.strictEqual(out[1].v, 21.5);
  assert.strictEqual(out[1].anomaly, 'drop');
  assert.strictEqual(out[1].max, 25);
});

test('驟升：顯示該分鐘最高值並標記 spike', () => {
  const out = run([[0, 25], [MINUTE, 25], [MINUTE + 20_000, 28], [MINUTE + 40_000, 25]]);
  assert.strictEqual(out[1].v, 28);
  assert.strictEqual(out[1].anomaly, 'spike');
});

test('變化小於門檻不算異常', () => {
  const out = run([[0, 25], [MINUTE, 24.2]]);
  assert.strictEqual(out[1].anomaly, null);
});

test('資料中斷超過 5 分鐘後不與舊值比較', () => {
  const out = run([[0, 25], [10 * MINUTE, 20]]);
  assert.strictEqual(out[1].anomaly, null);
});

test('peek 回傳進行中分鐘的暫定值且不結算', () => {
  const agg = new MinuteAggregator({ threshold: 1 });
  agg.add(0, 25);
  agg.add(MINUTE, 22);
  assert.strictEqual(agg.peek().anomaly, 'drop');
  assert.ok(agg.current);
});

test('驟降後下一分鐘回到正常，不會被誤判為驟升', () => {
  const out = run([[0, 25], [MINUTE, 25], [MINUTE + 20_000, 21.5], [MINUTE + 40_000, 24.9], [2 * MINUTE, 25]]);
  assert.deepStrictEqual(out.map((p) => p.anomaly), [null, 'drop', null]);
});

test('持續低溫只在第一分鐘標記一次', () => {
  const out = run([[0, 25], [MINUTE, 21], [2 * MINUTE, 21], [3 * MINUTE, 21.1]]);
  assert.deepStrictEqual(out.map((p) => p.anomaly), [null, 'drop', null, null]);
});

test('downsample：合併成 5 分鐘一點，保留最低/最高與異常極值', () => {
  const { downsample } = require('../lib/aggregate');
  const pts = [0, 1, 2, 3, 4, 5].map((i) => ({ t: i * MINUTE, v: 25, min: 24.9, max: 25.1, anomaly: null }));
  pts[2] = { t: 2 * MINUTE, v: 21, min: 21, max: 25, anomaly: 'drop' };
  const out = downsample(pts, 5 * MINUTE);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual([out[0].v, out[0].min, out[0].max, out[0].anomaly], [21, 21, 25.1, 'drop']);
  assert.strictEqual(out[1].anomaly, null);
});
