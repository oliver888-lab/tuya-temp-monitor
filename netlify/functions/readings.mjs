// GET /api/readings?range=today|yesterday|week (或舊相容 hours=24) [&line=<產線 id>]
// 只回傳記錄時段 (07:00~19:00) 的點位，並附帶上下限 (45~55°C) 與警示時段異常碼。
import { getConfig, store, dayKey, readJson, fromRow, compact, downsample, MinuteAggregator, isRecordTime, localDayStart, mockValue, MINUTE, json } from '../lib/cloud.mjs';

export const config = { path: '/api/readings' };

const DAY = 86_400_000;
const STALE_MS = 180_000;

function resolveWindow(url, now, retainDays) {
  const range = url.searchParams.get('range') || '';
  const today0 = localDayStart(now);
  if (range === 'today') {
    return { range: 'today', since: today0 + 7 * 3600_000, until: today0 + 19 * 3600_000, hours: 12, stepMin: 1 };
  }
  if (range === 'yesterday') {
    const y0 = today0 - DAY;
    return { range: 'yesterday', since: y0 + 7 * 3600_000, until: y0 + 19 * 3600_000, hours: 12, stepMin: 1 };
  }
  if (range === 'week') {
    const d = new Date(today0 + 12 * 3600_000);
    const dow = (d.getUTCDay() + 6) % 7; // 週一 = 0 ~ 週日 = 6
    const mon0 = today0 - dow * DAY;
    return { range: 'week', since: mon0 + 7 * 3600_000, until: mon0 + 6 * DAY + 19 * 3600_000, hours: 168, stepMin: 5 };
  }
  const hours = Math.min(Math.max(Number(url.searchParams.get('hours')) || 24, 0.25), Math.min(retainDays * 24, 168));
  return { range: '', since: now - hours * 3600_000, until: now, hours, stepMin: hours > 24 ? 5 : 1 };
}

function mockPoints(index, since, until, now, threshold) {
  const pts = [];
  const agg = new MinuteAggregator({ threshold, onFinalize: (p) => pts.push(p) });
  const end = Math.min(until, now);
  const start = Math.floor((since - MINUTE) / MINUTE) * MINUTE;
  for (let ts = start; ts <= end; ts += 30_000) {
    if (isRecordTime(ts)) agg.add(ts, mockValue(ts, index));
  }
  const cur = agg.peek();
  return {
    pts: pts.concat(cur ? [cur] : []).filter((p) => p.t >= since && p.t <= until && isRecordTime(p.t)),
    latest: { t: now, v: mockValue(now, index) },
  };
}

export default async (req) => {
  const cfg = getConfig();
  const url = new URL(req.url);
  const now = Date.now();
  const { range, since, until, hours, stepMin } = resolveWindow(url, now, cfg.retainDays);
  const lineId = url.searchParams.get('line');
  const lines = cfg.lines.filter((l) => !lineId || l.id === lineId);

  let days = [];
  let state = { sensors: {} };
  if (!cfg.mock) {
    const s = store();
    const keys = [];
    const endTs = Math.min(until, now);
    for (let d = Math.floor(since / DAY) * DAY; d <= endTs; d += DAY) keys.push(dayKey(d));
    [state, ...days] = await Promise.all([readJson(s, 'state', { sensors: {} }), ...keys.map((k) => readJson(s, k, {}))]);
    state.sensors ||= {};
  }

  const indexOf = new Map(cfg.sensors.map((x, i) => [x.id, i]));
  return json({
    title: cfg.title,
    mock: cfg.mock,
    pollSec: cfg.pollSec,
    serverTime: now,
    tzOffsetMin: cfg.tzOffsetMin,
    minTemp: cfg.minTemp,
    maxTemp: cfg.maxTemp,
    range,
    since,
    until,
    hours,
    stepMin,
    lines: lines.map((line) => ({
      id: line.id,
      name: line.name,
      sensors: line.sensors.map((sensor) => {
        let pts, latest, stale, lastAlarmAt;
        if (cfg.mock) {
          ({ pts, latest } = mockPoints(indexOf.get(sensor.id), since, until, now, sensor.threshold));
          stale = false;
          lastAlarmAt = null;
        } else {
          pts = days
            .flatMap((d) => d[sensor.id] || [])
            .filter((r) => r[0] >= since && r[0] <= until && isRecordTime(r[0]))
            .map((r) => fromRow(r, sensor));
          const st = state.sensors[sensor.id] || {};
          latest = st.latest || null;
          stale = !!sensor.deviceId && (!st.lastOkAt || now - st.lastOkAt > STALE_MS);
          lastAlarmAt = st.lastAlarmAt || null;
        }
        const ds = stepMin > 1 ? downsample(pts, stepMin * MINUTE) : pts;
        return {
          id: sensor.id,
          name: sensor.name,
          threshold: sensor.threshold,
          minTemp: sensor.minTemp,
          maxTemp: sensor.maxTemp,
          configured: cfg.mock || !!sensor.deviceId,
          stale,
          latest,
          lastAlarmAt,
          alarmCooldownMin: cfg.alarmCooldownMin,
          points: ds.map((p) => compact(p, sensor)),
        };
      }),
    })),
  }, 200, { 'Netlify-CDN-Cache-Control': 'public, s-maxage=30' });
};
