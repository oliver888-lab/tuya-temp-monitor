// GET /api/probe?key=<ADMIN_KEY>  → 取代 npm run probe：直接在瀏覽器檢查塗鴉連線。
// 列出每台裝置回傳的所有資料點與換算後的溫度。需在 Netlify 設定 ADMIN_KEY 才能使用。
import { getConfig, TuyaClient, pickTemperature, json } from '../lib/cloud.mjs';

export const config = { path: '/api/probe' };

export default async (req) => {
  const cfg = getConfig();
  if (!cfg.adminKey) return json({ error: '請先在 Netlify 環境變數設定 ADMIN_KEY' }, 403);
  if (new URL(req.url).searchParams.get('key') !== cfg.adminKey) return json({ error: 'key 錯誤' }, 403);

  const out = { baseUrl: cfg.tuya.baseUrl, hasAccessId: !!cfg.tuya.accessId, hasSecret: !!cfg.tuya.accessSecret, mock: cfg.mock };
  if (!cfg.tuya.accessId || !cfg.tuya.accessSecret) return json({ ...out, error: '未設定 TUYA_ACCESS_ID / TUYA_ACCESS_SECRET' }, 400);

  const tuya = new TuyaClient(cfg.tuya);
  try {
    await tuya.getToken();
    out.token = 'OK';
  } catch (err) {
    return json({ ...out, token: '失敗', error: err.message }, 502);
  }

  out.sensors = [];
  for (const s of cfg.sensors.filter((x) => x.deviceId)) {
    const row = { id: s.id, name: s.name, deviceId: s.deviceId };
    try {
      row.status = await tuya.getStatus(s.deviceId);
      row.temperature = pickTemperature(row.status, s.tempCode, s.divisor);
    } catch (err) {
      row.error = err.message;
    }
    try {
      const info = await tuya.authed(`/v1.0/devices/${encodeURIComponent(s.deviceId)}`);
      row.online = info.online;
      row.product = info.product_name;
    } catch (err) {
      row.infoError = err.message;
    }
    try {
      row.specifications = await tuya.getSpecifications(s.deviceId);
    } catch (err) {
      row.specError = err.message;
    }
    out.sensors.push(row);
  }
  try {
    const ids = out.sensors.map((x) => x.deviceId);
    if (ids.length) {
      await tuya.authed(`/v1.0/devices/status?device_ids=${ids.join(',')}`);
      out.batchEndpoint = '可用';
    }
  } catch (err) {
    out.batchEndpoint = `不可用（${err.message}），排程會自動逐台查詢`;
  }
  return json(out);
};
