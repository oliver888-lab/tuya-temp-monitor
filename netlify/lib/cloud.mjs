// Netlify 版共用程式：讀設定 (環境變數 + devices.json)、Netlify Blobs 存取。
// 塗鴉簽名、溫度換算、異常判斷、降採樣直接沿用 lib/ 裡的原始程式。
import { getStore } from '@netlify/blobs';
import devicesRaw from '../../devices.json';
import aggregateLib from '../../lib/aggregate.js';
import tuyaLib from '../../lib/tuya.js';
import mockLib from '../../lib/mock.js';

export const { finalize, downsample, MinuteAggregator, MINUTE } = aggregateLib;
export const { TuyaClient, pickTemperature } = tuyaLib;
export const { mockValue } = mockLib;

const env = (k) => (typeof Netlify !== 'undefined' ? Netlify.env.get(k) : process.env[k]) ?? '';
const num = (k, d) => {
  const raw = env(k);
  const v = Number(raw);
  return raw !== '' && Number.isFinite(v) ? v : d;
};

function normalizeLines(raw, defaults) {
  return (raw.lines || []).map((line, li) => ({
    id: String(line.id || `line${li + 1}`),
    name: line.name || `產線 ${li + 1}`,
    sensors: (line.sensors || []).map((s, si) => ({
      id: String(s.id || `line${li + 1}-s${si + 1}`),
      name: s.name || `感測點 ${si + 1}`,
      deviceId: (s.deviceId || '').trim(),
      tempCode: s.tempCode || defaults.tempCode,
      divisor: Number(s.divisor) || defaults.divisor,
      threshold: s.threshold !== undefined && s.threshold !== '' && Number.isFinite(Number(s.threshold)) ? Number(s.threshold) : defaults.threshold,
    })),
  }));
}

export function getConfig() {
  const cfg = {
    title: env('SITE_TITLE') || '成型產線溫度監控',
    pollSec: 60, // Netlify 排程最短每分鐘一次
    threshold: num('ANOMALY_THRESHOLD_C', 1.0),
    retainDays: num('RETAIN_DAYS', 30),
    adminKey: env('ADMIN_KEY'),
    tuya: {
      accessId: env('TUYA_ACCESS_ID'),
      accessSecret: env('TUYA_ACCESS_SECRET'),
      baseUrl: (env('TUYA_BASE_URL') || 'https://openapi-sg.iotbing.com').replace(/\/+$/, ''),
    },
  };
  cfg.lines = normalizeLines(devicesRaw, {
    tempCode: env('TEMP_CODE'),
    divisor: num('TEMP_DIVISOR', 10) || 1,
    threshold: cfg.threshold,
  });
  cfg.sensors = cfg.lines.flatMap((l) => l.sensors);
  const anyDevice = cfg.sensors.some((s) => s.deviceId);
  cfg.mock = env('MOCK') === '1' || !(cfg.tuya.accessId && cfg.tuya.accessSecret && anyDevice);
  return cfg;
}

// ---- 儲存 ----
// readings 這個 store 裡：
//   day/YYYY-MM-DD → { <感測點 id>: [[t, v, min, max, 異常碼, last], ...] }   (UTC 日期)
//   state          → { token, tokenExpiresAt, lastCleanupDay, sensors: { <id>: { prev, latest, lastOkAt, lastError } } }
export const store = () => getStore({ name: 'readings', consistency: 'strong' });
export const dayKey = (ts) => 'day/' + new Date(ts).toISOString().slice(0, 10);

export const CODE = { drop: 1, spike: 2 };
export const toRow = (p) => [p.t, p.v, p.min, p.max, CODE[p.anomaly] || 0, p.last];
export const fromRow = (r) => ({ t: r[0], v: r[1], min: r[2], max: r[3], anomaly: r[4] === 1 ? 'drop' : r[4] === 2 ? 'spike' : null, last: r[5] });
export const compact = (p) => [p.t, p.v, p.min, p.max, CODE[p.anomaly] || 0];

export async function readJson(s, key, fallback) {
  const v = await s.get(key, { type: 'json' });
  return v ?? fallback;
}

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
