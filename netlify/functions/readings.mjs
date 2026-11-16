// GET /api/readings?hours=8[&line=<產線 id>]
// 回傳格式與 Node 版 server.js 相同，public/index.html 不用改。
import { getConfig, store, dayKey, readJson, fromRow, compact, downsample, MinuteAggregator, mockValue, MINUTE, json } from '../lib/cloud.mjs';

export const config = { path: '/api/readings' };

const DAY = 86_400_000;
const STALE_MS = 180_000;

function mockPoints(index, since, now, threshold) {
  const pts = [];
  const agg = new MinuteAggregator({ threshold, onFinalize: (p) => pts.push(p) });
  const start = Math.floor((since - MINUTE) / MINUTE) * MINUTE;
  for (let ts = start; ts <= now; ts += 30_000) agg.add(ts, mockValue(ts, index));
  const cur = agg.peek();
  return { pts: pts.concat(cur ? [cur] : []).filter((p) => p.t >= since), latest: { t: now, v: mockValue(now, index) } };
}

export default async (req) => {
  const cfg = getConfig();
  const url = new URL(req.url);
  const hours = Math.min(Math.max(Number(url.searchParams.get('hours')) || 8, 0.25), Math.min(cfg.retainDays * 24, 168));
  const lineId = url.searchParams.get('line');
  const now = Date.now();
  const since = now - hours * 3600_000;
  const stepMin = hours > 24 ? 5 : 1;
  const lines = cfg.lines.filter((l) => !lineId || l.id === lineId);

  let days = [];
  let state = { sensors: {} };
  if (!cfg.mock) {
    const s = store();
    const keys = [];
    for (let d = Math.floor(since / DAY) * DAY; d <= now; d += DAY) keys.push(dayKey(d));
    [state, ...days] = await Promise.all([readJson(s, 'state', { sensors: {} }), ...keys.map((k) => readJson(s, k, {}))]);
    state.sensors ||= {};
  }

  const indexOf = new Map(cfg.sensors.map((x, i) => [x.id, i]));
  return json({
    title: cfg.title,
    mock: cfg.mock,
    pollSec: cfg.pollSec,
    serverTime: now,
    hours,
    stepMin,
    lines: lines.map((line) => ({
      id: line.id,
      name: line.name,
      sensors: line.sensors.map((sensor) => {
        let pts, latest, stale;
        if (cfg.mock) {
          ({ pts, latest } = mockPoints(indexOf.get(sensor.id), since, now, sensor.threshold));
          stale = false;
        } else {
          pts = days.flatMap((d) => d[sensor.id] || []).filter((r) => r[0] >= since).map(fromRow);
          const st = state.sensors[sensor.id] || {};
          latest = st.latest || null;
          stale = !!sensor.deviceId && (!st.lastOkAt || now - st.lastOkAt > STALE_MS);
        }
        return {
          id: sensor.id,
          name: sensor.name,
          threshold: sensor.threshold,
          configured: cfg.mock || !!sensor.deviceId,
          stale,
          latest,
          points: (stepMin > 1 ? downsample(pts, stepMin * MINUTE) : pts).map(compact),
        };
      }),
    })),
  }, 200, { 'Netlify-CDN-Cache-Control': 'public, s-maxage=30' }); // 多人同時開網頁時，30 秒內共用同一份回應，省函式額度
};
