// 排程函式：每分鐘向塗鴉批次讀取所有感測點，每個感測點寫入一個分鐘點。
// 只在工廠記錄時段 (07:00 ~ 19:00) 寫入歷史點位；警示時段內判斷上下限 (45~55°C) 與驟變。
import { getConfig, store, dayKey, readJson, toRow, finalize, evalAnomalyCode, isRecordTime, TuyaClient, pickTemperature, MINUTE } from '../lib/cloud.mjs';

export const config = { schedule: '* * * * *' };

const DAY = 86_400_000;

export default async () => {
  const cfg = getConfig();
  if (cfg.mock) return; // 示範模式：資料由 readings 即時產生，不需取樣

  const now = Date.now();
  const t = Math.floor(now / MINUTE) * MINUTE;
  const inRecordWindow = isRecordTime(t);

  const s = store();
  const state = await readJson(s, 'state', {});
  state.sensors ||= {};

  const tuya = new TuyaClient(cfg.tuya);
  tuya.token = state.token || null; // 沿用上次的 token，省下每分鐘一次的 token 呼叫
  tuya.tokenExpiresAt = state.tokenExpiresAt || 0;

  const active = cfg.sensors.filter((x) => x.deviceId);
  let statuses = null;
  let batchError = null;
  try {
    statuses = await tuya.getStatusMany([...new Set(active.map((x) => x.deviceId))]);
  } catch (err) {
    batchError = err.message;
  }

  const key = dayKey(t);
  const day = inRecordWindow ? await readJson(s, key, {}) : null;
  const at = Date.now();
  for (const sensor of active) {
    const st = (state.sensors[sensor.id] ||= {});
    try {
      if (batchError) throw new Error(batchError);
      const status = statuses.get(sensor.deviceId);
      if (status instanceof Error) throw status;
      const value = pickTemperature(status, sensor.tempCode, sensor.divisor).value;
      if (inRecordWindow) {
        // 同一分鐘被觸發兩次時，用這一分鐘之前的基準比較，並覆蓋同一點
        if (!st.prev || st.prev.t !== t) st.base = st.prev || null;
        const p = finalize({ t, min: value, max: value, last: value, sum: value, n: 1 }, st.base, sensor.threshold);
        const code = evalAnomalyCode(t, p.v, p.anomaly, sensor);
        const rows = (day[sensor.id] ||= []);
        if (rows.length && rows[rows.length - 1][0] === t) rows[rows.length - 1] = toRow(p, code);
        else rows.push(toRow(p, code));
        st.prev = { t, v: value };
      }
      st.latest = { t: at, v: value };
      st.lastOkAt = at;
      st.lastError = null;
    } catch (err) {
      if (st.lastError !== err.message) console.error(`${sensor.id} 取樣失敗：${err.message}`);
      st.lastError = err.message;
    }
  }

  state.token = tuya.token;
  state.tokenExpiresAt = tuya.tokenExpiresAt;

  // 每天清一次超過保留天數的資料
  const today = key.slice(4);
  if (state.lastCleanupDay !== today) {
    const cutoff = 'day/' + new Date(now - cfg.retainDays * DAY).toISOString().slice(0, 10);
    const { blobs } = await s.list({ prefix: 'day/' });
    await Promise.all(blobs.filter((b) => b.key < cutoff).map((b) => s.delete(b.key)));
    state.lastCleanupDay = today;
  }

  const saves = [s.setJSON('state', state)];
  if (inRecordWindow) saves.push(s.setJSON(key, day));
  await Promise.all(saves);
};
