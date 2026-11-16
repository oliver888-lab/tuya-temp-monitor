'use strict';
const fs = require('node:fs');
const path = require('node:path');

// 極簡 .env 讀取 (不依賴 dotenv)。已存在的環境變數優先。
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const val = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

// 讀 devices.json → [{ id, name, sensors: [{ id, name, deviceId, tempCode, divisor, threshold }] }]
function loadLines(file, defaults) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const seen = new Set();
  return (raw.lines || []).map((line, li) => ({
    id: String(line.id || `line${li + 1}`),
    name: line.name || `產線 ${li + 1}`,
    sensors: (line.sensors || []).map((s, si) => {
      const id = String(s.id || `line${li + 1}-s${si + 1}`);
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`devices.json：感測點 id「${id}」只能用英數字、- 和 _`);
      if (seen.has(id)) throw new Error(`devices.json：感測點 id「${id}」重複`);
      seen.add(id);
      return {
        id,
        name: s.name || `感測點 ${si + 1}`,
        deviceId: (s.deviceId || '').trim(),
        tempCode: s.tempCode || defaults.tempCode,
        divisor: Number(s.divisor) || defaults.divisor,
        threshold: Number.isFinite(Number(s.threshold)) && s.threshold !== undefined && s.threshold !== '' ? Number(s.threshold) : defaults.threshold,
      };
    }),
  }));
}

function getConfig(root) {
  loadEnv(path.join(root, '.env'));
  const e = process.env;
  const num = (k, d) => {
    const v = Number(e[k]);
    return e[k] !== undefined && e[k] !== '' && Number.isFinite(v) ? v : d;
  };
  const cfg = {
    port: num('PORT', 3000),
    title: e.SITE_TITLE || '成型產線溫度監控',
    pollSec: Math.max(5, num('POLL_INTERVAL_SEC', 60)),
    threshold: num('ANOMALY_THRESHOLD_C', 1.0),
    retainDays: num('RETAIN_DAYS', 30),
    dataDir: path.join(root, 'data'),
    tuya: {
      accessId: e.TUYA_ACCESS_ID || '',
      accessSecret: e.TUYA_ACCESS_SECRET || '',
      baseUrl: (e.TUYA_BASE_URL || 'https://openapi-sg.iotbing.com').replace(/\/+$/, ''),
    },
  };
  cfg.lines = loadLines(path.join(root, e.DEVICES_FILE || 'devices.json'), {
    tempCode: e.TEMP_CODE || '',
    divisor: num('TEMP_DIVISOR', 10) || 1,
    threshold: cfg.threshold,
  });
  const anyDevice = cfg.lines.some((l) => l.sensors.some((s) => s.deviceId));
  cfg.mock = e.MOCK === '1' || !(cfg.tuya.accessId && cfg.tuya.accessSecret && anyDevice);
  return cfg;
}

module.exports = { getConfig, loadEnv, loadLines };
