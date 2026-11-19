'use strict';
// 把多次取樣彙整成「每分鐘一個點」，並判斷異常。
//
// 規則：
//   - 一般情況：該分鐘的顯示值 v = 該分鐘最後一次取樣。
//   - 若該分鐘最低值比上一分鐘顯示值低了 >= threshold → 驟降，v 取該分鐘「最低值」。
//   - 若該分鐘最高值比上一分鐘顯示值高了 >= threshold → 驟升，v 取該分鐘「最高值」。
//   - 兩者同時成立時取偏離較大的一邊。
//   - 與上一點相隔超過 GAP_MS (資料中斷) 時不做比較。

const MINUTE = 60_000;
const GAP_MS = 5 * MINUTE;
const round = (x) => Math.round(x * 100) / 100;

function finalize(bucket, prev, threshold) {
  let v = bucket.last;
  let anomaly = null;
  if (prev && bucket.t - prev.t <= GAP_MS) {
    const drop = prev.v - bucket.min;
    const rise = bucket.max - prev.v;
    if (drop >= threshold || rise >= threshold) {
      if (drop >= rise) {
        v = bucket.min;
        anomaly = 'drop';
      } else {
        v = bucket.max;
        anomaly = 'spike';
      }
    }
  }
  return {
    t: bucket.t,
    v: round(v),
    min: round(bucket.min),
    max: round(bucket.max),
    last: round(bucket.last),
    avg: round(bucket.sum / bucket.n),
    n: bucket.n,
    anomaly,
  };
}

class MinuteAggregator {
  constructor({ threshold, onFinalize, prev = null }) {
    this.threshold = threshold;
    this.onFinalize = onFinalize || (() => {});
    this.prev = prev; // 上一個已完成的分鐘點 { t, v }
    this.current = null;
  }

  // 時間前進到 ts：若目前的分鐘已結束就結算
  tick(ts) {
    if (this.current && Math.floor(ts / MINUTE) * MINUTE !== this.current.t) this.flush();
  }

  add(ts, value) {
    this.tick(ts);
    const c = this.current;
    if (!c) {
      this.current = { t: Math.floor(ts / MINUTE) * MINUTE, min: value, max: value, last: value, sum: value, n: 1 };
    } else {
      c.min = Math.min(c.min, value);
      c.max = Math.max(c.max, value);
      c.last = value;
      c.sum += value;
      c.n += 1;
    }
  }

  flush() {
    if (!this.current) return null;
    const p = finalize(this.current, this.prev, this.threshold);
    // 下一分鐘的比較基準用「最後一筆取樣」而非顯示的極值，這樣驟降後回到正常不會被誤判成驟升
    this.prev = { t: p.t, v: this.current.last };
    this.current = null;
    this.onFinalize(p);
    return p;
  }

  // 進行中的這一分鐘 (尚未結算) 的暫定結果
  peek() {
    return this.current ? finalize(this.current, this.prev, this.threshold) : null;
  }
}

// 長區間 (例如 7 天) 用：把分鐘點合併成每 stepMs 一個點，保留區間內的最低/最高與異常。
// 區間內有異常時顯示值取異常點的極值 (驟降優先取最低者，否則取驟升最高者)，確保異常不會被合併掉。
function downsample(points, stepMs) {
  const out = [];
  let g = null;
  for (const p of points) {
    const t = Math.floor(p.t / stepMs) * stepMs;
    if (!g || g.t !== t) {
      g = { t, v: p.v, min: p.min, max: p.max, anomaly: null };
      out.push(g);
    }
    g.min = Math.min(g.min, p.min);
    g.max = Math.max(g.max, p.max);
    if (p.anomaly === 'low' || p.anomaly === 'drop') {
      if ((g.anomaly !== 'low' && g.anomaly !== 'drop') || p.v < g.v) g.v = p.v;
      g.anomaly = p.anomaly === 'low' || g.anomaly === 'low' ? 'low' : 'drop';
    } else if ((p.anomaly === 'high' || p.anomaly === 'spike') && g.anomaly !== 'low' && g.anomaly !== 'drop') {
      if ((g.anomaly !== 'high' && g.anomaly !== 'spike') || p.v > g.v) g.v = p.v;
      g.anomaly = p.anomaly === 'high' || g.anomaly === 'high' ? 'high' : 'spike';
    } else if (!g.anomaly) {
      g.v = p.v;
    }
  }
  return out;
}

module.exports = { MinuteAggregator, finalize, downsample, MINUTE };
