// GET /api/health  → 各感測點最近一次取樣是否成功
import { getConfig, store, readJson, json } from '../lib/cloud.mjs';

export const config = { path: '/api/health' };

export default async () => {
  const cfg = getConfig();
  const active = cfg.sensors.filter((s) => cfg.mock || s.deviceId);
  if (cfg.mock) return json({ ok: true, mock: true, sensors: cfg.sensors.length, active: active.length, failing: [] });
  const state = await readJson(store(), 'state', { sensors: {} });
  const now = Date.now();
  const failing = active
    .filter((s) => {
      const st = (state.sensors || {})[s.id] || {};
      return st.lastError || !st.lastOkAt || now - st.lastOkAt > 180_000;
    })
    .map((s) => ({ id: s.id, error: ((state.sensors || {})[s.id] || {}).lastError || '尚無成功取樣' }));
  return json({ ok: !failing.length, mock: false, sensors: cfg.sensors.length, active: active.length, failing }, failing.length ? 503 : 200);
};
