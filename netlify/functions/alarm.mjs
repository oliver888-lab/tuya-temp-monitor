// GET / POST /api/alarm?sensor=<感測點 id>&action=beep|mute[&key=<ADMIN_KEY>]
// 讓使用者在網頁上或測試時可以手動觸發某台溫度計「響 3 聲 (3.5 秒) 後自動消音」，或強制靜音並進入 30 分鐘冷卻。
import { getConfig, store, readJson, TuyaClient, pickTemperature, pulseDeviceAlarm, muteDeviceAlarm, json } from '../lib/cloud.mjs';

export const config = { path: '/api/alarm' };

export default async (req) => {
  const cfg = getConfig();
  const url = new URL(req.url);
  const sensorId = url.searchParams.get('sensor') || '';
  const action = url.searchParams.get('action') || 'beep';

  const sensor = cfg.sensors.find((x) => x.id === sensorId) || cfg.sensors.find((x) => x.deviceId);
  if (!sensor || !sensor.deviceId) return json({ ok: false, error: '此感測點尚未設定塗鴉 Device ID' }, 400);
  if (cfg.mock) return json({ ok: true, mock: true, sensor: sensor.id, action, message: '示範模式：已模擬警報指令' });

  const s = store();
  const state = await readJson(s, 'state', { sensors: {} });
  state.sensors ||= {};
  const st = (state.sensors[sensor.id] ||= {});

  const tuya = new TuyaClient(cfg.tuya);
  tuya.token = state.token || null;
  tuya.tokenExpiresAt = state.tokenExpiresAt || 0;

  let curTemp = st.latest ? st.latest.v : 26;
  try {
    const status = await tuya.getStatus(sensor.deviceId);
    curTemp = pickTemperature(status, sensor.tempCode, sensor.divisor).value;
  } catch (e) { /* 使用最近一次溫度 */ }

  let log;
  const now = Date.now();
  if (action === 'mute') {
    log = await muteDeviceAlarm(tuya, sensor.deviceId, sensor.divisor);
    st.lastAlarmAt = now; // 進入 30 分鐘靜音冷卻期
  } else {
    log = await pulseDeviceAlarm(tuya, sensor.deviceId, curTemp, sensor.divisor, cfg.alarmPulseMs);
    st.lastAlarmAt = now; // 響完後同樣進入 30 分鐘冷卻期
  }
  st.lastAlarmLog = log;
  state.token = tuya.token;
  state.tokenExpiresAt = tuya.tokenExpiresAt;
  await s.setJSON('state', state);

  return json({
    ok: true,
    sensor: sensor.id,
    name: sensor.name,
    deviceId: sensor.deviceId,
    action,
    currentTemp: curTemp,
    cooldownMin: cfg.alarmCooldownMin,
    nextAlarmAfter: new Date(now + cfg.alarmCooldownMin * 60_000).toISOString(),
    log,
  });
};
