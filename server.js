'use strict';
// 成型產線溫度監控：定時向塗鴉雲端取樣 → 每個感測點每分鐘彙整 → 提供 API 與網頁。
// 零外部套件，Node 18+ 直接 `node server.js`。產線與感測點定義在 devices.json。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { getConfig } = require('./lib/config');
const { TuyaClient, pickTemperature } = require('./lib/tuya');
const { MinuteAggregator, downsample, MINUTE } = require('./lib/aggregate');
const { Store } = require('./lib/store');
const { mockValue } = require('./lib/mock');

const cfg = getConfig(__dirname);
const tuya = cfg.mock ? null : new TuyaClient(cfg.tuya);

// 把每個感測點配上自己的儲存與彙整器
const sensors = [];
for (const line of cfg.lines) {
  for (const s of line.sensors) {
    const store = new Store({ dir: cfg.dataDir, name: s.id, retainDays: cfg.retainDays, persist: !cfg.mock });
    const last = store.last();
    const agg = new MinuteAggregator({
      threshold: s.threshold,
      prev: last ? { t: last.t, v: last.last ?? last.v } : null,
      onFinalize: (p) => store.add(p),
    });
    sensors.push(Object.assign(s, { index: sensors.length, store, agg, latest: null, lastOkAt: null, lastError: null }));
  }
}
const active = () => sensors.filter((s) => cfg.mock || s.deviceId);

if (cfg.mock) {
  // 示範模式：先補 7 天假歷史，圖表一打開就有東西
  const now = Date.now();
  const start = Math.floor((now - 7 * 86_400_000) / MINUTE) * MINUTE;
  for (const s of sensors) for (let ts = start; ts < now; ts += 30_000) s.agg.add(ts, mockValue(ts, s.index));
}

const DAY = 86_400_000;
const tzMs = (cfg.tzOffsetMin ?? 420) * 60_000;
const localDayStart = (ts) => Math.floor((ts + tzMs) / DAY) * DAY - tzMs;
const localMinOfDay = (ts) => Math.floor(((ts + tzMs) % DAY) / MINUTE);
const isRecordTime = (ts) => { const m = localMinOfDay(ts); return m >= 420 && m <= 1140; };
const isAlertTime = (ts) => { const m = localMinOfDay(ts); return (m >= 450 && m <= 680) || (m >= 750 && m <= 1110); };

function evalAnomalyCode(t, v, rawAnomaly, s) {
  if (!isAlertTime(t)) return 0;
  if (v < s.minTemp) return 3;
  if (v > s.maxTemp) return 4;
  return rawAnomaly === 'drop' ? 1 : rawAnomaly === 'spike' ? 2 : 0;
}

function record(s, now, value) {
  if (isRecordTime(now)) s.agg.add(now, value);
  s.latest = { t: now, v: value };
  s.lastOkAt = now;
  s.lastError = null;
}

function fail(s, message) {
  if (s.lastError !== message) console.error(`[${new Date().toISOString()}] ${s.id} 取樣失敗：${message}`);
  s.lastError = message;
}

async function sample() {
  const now = Date.now();
  const list = active();
  for (const s of list) s.agg.tick(now);
  if (cfg.mock) {
    for (const s of list) record(s, now, mockValue(now, s.index));
    return;
  }
  let statuses;
  try {
    statuses = await tuya.getStatusMany([...new Set(list.map((s) => s.deviceId))]);
  } catch (err) {
    for (const s of list) fail(s, err.message);
    return;
  }
  const at = Date.now();
  for (const s of list) {
    const st = statuses.get(s.deviceId);
    try {
      if (st instanceof Error) throw st;
      record(s, at, pickTemperature(st, s.tempCode, s.divisor).value);
    } catch (err) {
      fail(s, err.message);
    }
  }
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// 點的精簡格式：[t, 顯示值, 該分鐘最低, 該分鐘最高, 異常碼]，異常碼 0=無 1=驟降 2=驟升 3=過低 4=過高
const compact = (p, s) => [p.t, p.v, p.min, p.max, evalAnomalyCode(p.t, p.v, p.anomaly, s)];
const staleAfter = Math.max(3 * cfg.pollSec * 1000, 180_000);

function resolveWindow(url, now) {
  const range = url.searchParams.get('range') || '';
  const today0 = localDayStart(now);
  if (range === 'today') return { range: 'today', since: today0 + 7 * 3600_000, until: today0 + 19 * 3600_000, hours: 12, stepMin: 1 };
  if (range === 'yesterday') {
    const y0 = today0 - DAY;
    return { range: 'yesterday', since: y0 + 7 * 3600_000, until: y0 + 19 * 3600_000, hours: 12, stepMin: 1 };
  }
  if (range === 'week') {
    const d = new Date(today0 + 12 * 3600_000);
    const dow = (d.getUTCDay() + 6) % 7;
    const mon0 = today0 - dow * DAY;
    return { range: 'week', since: mon0 + 7 * 3600_000, until: mon0 + 6 * DAY + 19 * 3600_000, hours: 168, stepMin: 5 };
  }
  const hours = Math.min(Math.max(Number(url.searchParams.get('hours')) || 24, 0.25), Math.min(cfg.retainDays * 24, 168));
  return { range: '', since: now - hours * 3600_000, until: now, hours, stepMin: hours > 24 ? 5 : 1 };
}

function readings(url) {
  const now = Date.now();
  const { range, since, until, hours, stepMin } = resolveWindow(url, now);
  const lineId = url.searchParams.get('line');
  return {
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
    lines: cfg.lines.filter((line) => !lineId || line.id === lineId).map((line) => ({
      id: line.id,
      name: line.name,
      sensors: line.sensors.map((s) => {
        const configured = cfg.mock || !!s.deviceId;
        const cur = s.agg.peek();
        const pts = s.store.since(since).concat(cur ? [cur] : []).filter((p) => p.t >= since && p.t <= until && isRecordTime(p.t));
        return {
          id: s.id,
          name: s.name,
          threshold: s.threshold,
          minTemp: s.minTemp,
          maxTemp: s.maxTemp,
          configured,
          stale: configured && (!s.lastOkAt || now - s.lastOkAt > staleAfter),
          latest: s.latest,
          points: (stepMin > 1 ? downsample(pts, stepMin * MINUTE) : pts).map((p) => compact(p, s)),
        };
      }),
    })),
  };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const PUBLIC = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });

  if (url.pathname === '/api/readings') {
    return sendJson(res, 200, readings(url));
  }

  if (url.pathname === '/api/health') {
    const list = active();
    const failing = list.filter((s) => s.lastError).map((s) => s.id);
    return sendJson(res, failing.length ? 503 : 200, { ok: !failing.length, mock: cfg.mock, sensors: sensors.length, active: list.length, failing });
  }

  // 靜態檔
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(cfg.port, () => {
  const mode = cfg.mock ? '示範模式 — 假資料' : `塗鴉裝置 ${active().length} 台`;
  console.log(`溫度監控已啟動：http://localhost:${cfg.port}  (${cfg.lines.length} 條產線 / ${sensors.length} 個感測點，${mode}，每 ${cfg.pollSec} 秒取樣)`);
  sample();
  setInterval(sample, cfg.pollSec * 1000);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
