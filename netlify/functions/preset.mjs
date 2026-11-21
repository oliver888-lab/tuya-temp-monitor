// GET / POST /api/preset
// 用途 1 (網頁設定每條產線的目前鞋型與溫度上下限，或新增鞋型配方)：
//   /api/preset?action=setLine&line=line2&shoeName=Nike-001&minTemp=48&maxTemp=56&cardUid=8A3F91C2
//   /api/preset?action=saveShoe&id=s1&name=Nike-001&minTemp=48&maxTemp=56&cardUid=8A3F91C2
//   /api/preset?action=deleteShoe&id=s1
// 用途 2 (榮士 IC-19FT-HTTP Wi-Fi 讀卡機刷卡自動切換鞋型)：
//   讀卡機可設定目標網址為 /api/preset?line=line2 (或讀卡機傳來的 info/card/uid/serial 參數)
//   刷卡時自動比對 shoeCatalog 中的 cardUid，切換該產線的鞋型與標準溫度，並回傳榮士 TTS 中文語音指令！
import { getConfig, store, readJson, json } from '../lib/cloud.mjs';

export const config = { path: '/api/preset' };

export default async (req) => {
  const cfg = getConfig();
  const url = new URL(req.url);
  let params = Object.fromEntries(url.searchParams.entries());
  if (req.method === 'POST') {
    try {
      const ct = req.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        params = { ...params, ...(await req.json()) };
      } else {
        const text = await req.text();
        for (const [k, v] of new URLSearchParams(text)) params[k] = v;
      }
    } catch (e) { /* ignore parse errors */ }
  }

  const s = store();
  const state = cfg.mock ? { linePresets: {}, shoeCatalog: [] } : await readJson(s, 'state', { sensors: {}, linePresets: {}, shoeCatalog: [] });
  state.linePresets ||= {};
  state.shoeCatalog ||= [];
  const now = Date.now();

  const action = params.action || '';
  // 若帶有讀卡機常見卡號欄位 (card / uid / cardno / info)，視為 RFID 刷卡事件
  const rawCard = (params.card || params.uid || params.cardno || params.cardUid || '').trim().toUpperCase();

  if (action === 'saveShoe') {
    const id = params.id || 'shoe_' + now.toString(36);
    const name = (params.name || '').trim();
    if (!name) return json({ ok: false, error: '請輸入鞋型名稱' }, 400);
    const minTemp = Number.isFinite(Number(params.minTemp)) && params.minTemp !== '' ? Number(params.minTemp) : cfg.minTemp;
    const maxTemp = Number.isFinite(Number(params.maxTemp)) && params.maxTemp !== '' ? Number(params.maxTemp) : cfg.maxTemp;
    const item = { id, name, minTemp, maxTemp, cardUid: rawCard };
    const idx = state.shoeCatalog.findIndex((x) => x.id === id || (rawCard && x.cardUid === rawCard));
    if (idx >= 0) state.shoeCatalog[idx] = item;
    else state.shoeCatalog.push(item);
    if (!cfg.mock) await s.setJSON('state', state);
    return json({ ok: true, shoeCatalog: state.shoeCatalog, linePresets: state.linePresets });
  }

  if (action === 'deleteShoe') {
    state.shoeCatalog = state.shoeCatalog.filter((x) => x.id !== params.id);
    if (!cfg.mock) await s.setJSON('state', state);
    return json({ ok: true, shoeCatalog: state.shoeCatalog, linePresets: state.linePresets });
  }

  if (action === 'setLine') {
    const lineId = params.line || 'line2';
    const shoeName = (params.shoeName || '').trim();
    const minTemp = Number.isFinite(Number(params.minTemp)) && params.minTemp !== '' ? Number(params.minTemp) : cfg.minTemp;
    const maxTemp = Number.isFinite(Number(params.maxTemp)) && params.maxTemp !== '' ? Number(params.maxTemp) : cfg.maxTemp;
    state.linePresets[lineId] = { shoeName, minTemp, maxTemp, cardUid: rawCard, updatedAt: now };
    // 若有填鞋型名稱，順便同步到常用鞋型清單，方便下次下拉直接選
    if (shoeName) {
      const idx = state.shoeCatalog.findIndex((x) => x.name === shoeName || (rawCard && x.cardUid === rawCard));
      const item = { id: idx >= 0 ? state.shoeCatalog[idx].id : 'shoe_' + now.toString(36), name: shoeName, minTemp, maxTemp, cardUid: rawCard || (idx >= 0 ? state.shoeCatalog[idx].cardUid : '') };
      if (idx >= 0) state.shoeCatalog[idx] = item;
      else state.shoeCatalog.push(item);
    }
    if (!cfg.mock) await s.setJSON('state', state);
    return json({ ok: true, lineId, preset: state.linePresets[lineId], shoeCatalog: state.shoeCatalog });
  }

  // RFID 讀卡機自動刷卡觸發 (預設綁定 A2 線 = line2，也可在網址帶 ?line=line1)
  if (rawCard) {
    const lineId = params.line || 'line2';
    const lineObj = cfg.lines.find((l) => l.id === lineId) || { id: lineId, name: lineId };
    const matched = state.shoeCatalog.find((x) => (x.cardUid || '').toUpperCase() === rawCard);
    state.lastRfid = { cardUid: rawCard, lineId, at: now, matchedShoe: matched ? matched.name : null };
    let ttsText;
    if (matched) {
      state.linePresets[lineId] = {
        shoeName: matched.name,
        minTemp: matched.minTemp,
        maxTemp: matched.maxTemp,
        cardUid: rawCard,
        updatedAt: now,
      };
      ttsText = `${lineObj.name}已切換為 ${matched.name}，標準溫度 ${matched.minTemp} 到 ${matched.maxTemp} 度`;
    } else {
      ttsText = `收到新卡號 ${rawCard.slice(-4)}，請在網頁綁定鞋型`;
    }
    if (!cfg.mock) await s.setJSON('state', state);
    // 同時相容一般 JSON 與榮士 HTTP 讀卡機回傳格式 (Strings / tts)
    return new Response(
      `Strings=${ttsText}&tts=${ttsText}&json=` + JSON.stringify({ ok: true, cardUid: rawCard, lineId, matched, tts: ttsText }),
      { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }
    );
  }

  return json({ ok: true, linePresets: state.linePresets, shoeCatalog: state.shoeCatalog, lastRfid: state.lastRfid || null });
};
