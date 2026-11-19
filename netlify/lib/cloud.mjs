// Netlify 版共用程式：讀設定 (環境變數 + devices.json)、Netlify Blobs 存取、工廠時段與異常規則。
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

// 工廠時區與時段規則 (預設 UTC+7 越南時間)
export const TZ_OFFSET_MIN = num('TZ_OFFSET_MIN', 420);
export const TZ_MS = TZ_OFFSET_MIN * 60_000;
const DAY_MS = 86_400_000;

// 取得 ts 在工廠時區當天 00:00 的毫秒時間戳與當天第幾分鐘 (0~1439)
export const localDayStart = (ts) => Math.floor((ts + TZ_MS) / DAY_MS) * DAY_MS - TZ_MS;
export const localMinOfDay = (ts) => Math.floor(((ts + TZ_MS) % DAY_MS) / MINUTE);

// 1. 記錄時段：07:00 (420) ~ 19:00 (1140)
export const isRecordTime = (ts) => {
  const m = localMinOfDay(ts);
  return m >= 420 && m <= 1140;
};

// 2. 警示時段：07:30 (450) ~ 11:20 (680) 及 12:30 (750) ~ 18:30 (1110)
export const isAlertTime = (ts) => {
  const m = localMinOfDay(ts);
  return (m >= 450 && m <= 680) || (m >= 750 && m <= 1110);
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
      minTemp: s.minTemp !== undefined && s.minTemp !== '' && Number.isFinite(Number(s.minTemp)) ? Number(s.minTemp) : defaults.minTemp,
      maxTemp: s.maxTemp !== undefined && s.maxTemp !== '' && Number.isFinite(Number(s.maxTemp)) ? Number(s.maxTemp) : defaults.maxTemp,
    })),
  }));
}

export function getConfig() {
  const cfg = {
    title: env('SITE_TITLE') || '成型產線溫度監控',
    pollSec: 60, // Netlify 排程最短每分鐘一次
    threshold: num('ANOMALY_THRESHOLD_C', 1.0),
    minTemp: num('TEMP_MIN_C', 45),
    maxTemp: num('TEMP_MAX_C', 55),
    tzOffsetMin: TZ_OFFSET_MIN,
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
    minTemp: cfg.minTemp,
    maxTemp: cfg.maxTemp,
  });
  cfg.sensors = cfg.lines.flatMap((l) => l.sensors);
  const anyDevice = cfg.sensors.some((s) => s.deviceId);
  cfg.mock = env('MOCK') === '1' || !(cfg.tuya.accessId && cfg.tuya.accessSecret && anyDevice);
  return cfg;
}

// 依據警示時段與上下限 (45~55°C) 重新評估點位異常：
// 非警示時段 (烘箱不開，低溫正常) → 一律不標記異常 (0)
// 警示時段內：低於下限 → 3 (過低)，高於上限 → 4 (過高)，否則保留驟降(1) / 驟升(2)
export function evalAnomalyCode(t, v, rawAnomaly, sensor) {
  if (!isAlertTime(t)) return 0;
  if (v < sensor.minTemp) return 3;
  if (v > sensor.maxTemp) return 4;
  if (rawAnomaly === 'drop' || rawAnomaly === 1) return 1;
  if (rawAnomaly === 'spike' || rawAnomaly === 2) return 2;
  return 0;
}

// ---- 儲存 ----
// readings 這個 store 裡：
//   day/YYYY-MM-DD → { <感測點 id>: [[t, v, min, max, 異常碼, last], ...] }   (UTC 日期)
//   state          → { token, tokenExpiresAt, lastCleanupDay, sensors: { <id>: { prev, latest, lastOkAt, lastError } } }
export const store = () => getStore({ name: 'readings', consistency: 'strong' });
export const dayKey = (ts) => 'day/' + new Date(ts).toISOString().slice(0, 10);

export const CODE = { drop: 1, spike: 2, low: 3, high: 4 };
export const toRow = (p, code) => [p.t, p.v, p.min, p.max, code ?? (CODE[p.anomaly] || 0), p.last];
export const fromRow = (r, sensor) => {
  const code = evalAnomalyCode(r[0], r[1], r[4], sensor);
  const anomaly = code === 3 ? 'low' : code === 4 ? 'high' : code === 1 ? 'drop' : code === 2 ? 'spike' : null;
  return { t: r[0], v: r[1], min: r[2], max: r[3], anomaly, code, last: r[5] };
};
export const compact = (p, sensor) => [
  p.t,
  p.v,
  p.min,
  p.max,
  p.code !== undefined ? p.code : evalAnomalyCode(p.t, p.v, p.anomaly, sensor),
];

export async function readJson(s, key, fallback) {
  const v = await s.get(key, { type: 'json' });
  return v ?? fallback;
}

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
