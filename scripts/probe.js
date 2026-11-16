'use strict';
// 連線檢查：對 devices.json 裡每個已填 deviceId 的感測點，印出塗鴉回傳的資料點與換算後的溫度。
// 用來確認金鑰、資料中心、Device ID、TEMP_CODE、TEMP_DIVISOR。用法：npm run probe
const path = require('node:path');
const { getConfig } = require('../lib/config');
const { TuyaClient, pickTemperature } = require('../lib/tuya');

(async () => {
  const cfg = getConfig(path.join(__dirname, '..'));
  if (!(cfg.tuya.accessId && cfg.tuya.accessSecret)) {
    console.error('請先在 .env 填好 TUYA_ACCESS_ID / TUYA_ACCESS_SECRET');
    process.exit(1);
  }
  const list = cfg.lines.flatMap((l) => l.sensors.filter((s) => s.deviceId).map((s) => ({ line: l.name, ...s })));
  if (!list.length) {
    console.error('devices.json 裡還沒有任何感測點填入 deviceId');
    process.exit(1);
  }
  console.log('資料中心：', cfg.tuya.baseUrl);
  const statuses = await new TuyaClient(cfg.tuya).getStatusMany([...new Set(list.map((s) => s.deviceId))]);
  for (const s of list) {
    console.log(`\n=== ${s.line} / ${s.name}  (${s.deviceId}) ===`);
    const st = statuses.get(s.deviceId);
    if (st instanceof Error) {
      console.log('失敗：', st.message);
      continue;
    }
    console.table(st);
    try {
      const r = pickTemperature(st, s.tempCode, s.divisor);
      console.log(`溫度資料點 ${r.code}：原始值 ${r.raw} ÷ ${s.divisor} = ${r.value} °C`);
    } catch (err) {
      console.log(err.message);
    }
  }
  console.log('\n若溫度與 App 顯示不符，請調整 TEMP_DIVISOR (常見 1、10、100) 或在 devices.json 個別設定 divisor。');
})().catch((err) => {
  console.error('失敗：', err.message);
  console.error('常見原因：1004 簽名錯誤(金鑰打錯) / 1106 無權限(裝置未連結到雲端專案) / 28841xxx 資料中心不符或 API 未訂閱');
  process.exit(1);
});
