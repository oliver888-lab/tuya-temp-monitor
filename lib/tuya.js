'use strict';
// 塗鴉雲端 OpenAPI 用戶端 (僅 GET)。
// 簽名規則：sign = HMAC-SHA256(client_id + [access_token] + t + nonce + stringToSign, secret) 轉大寫
// stringToSign = METHOD \n SHA256(body) \n (signature headers, 這裡為空) \n path?query
const crypto = require('node:crypto');

const EMPTY_BODY_HASH = crypto.createHash('sha256').update('').digest('hex');
const TEMP_CODES = ['va_temperature', 'temp_current', 'temperature', 'temp_value'];

class TuyaClient {
  constructor({ accessId, accessSecret, baseUrl }) {
    this.accessId = accessId;
    this.accessSecret = accessSecret;
    this.baseUrl = baseUrl;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  sign(method, pathWithQuery, t, nonce, token = '') {
    const stringToSign = [method, EMPTY_BODY_HASH, '', pathWithQuery].join('\n');
    return crypto
      .createHmac('sha256', this.accessSecret)
      .update(this.accessId + token + t + nonce + stringToSign)
      .digest('hex')
      .toUpperCase();
  }

  async request(pathWithQuery, token = '') {
    const t = Date.now().toString();
    const nonce = crypto.randomUUID();
    const headers = {
      client_id: this.accessId,
      sign: this.sign('GET', pathWithQuery, t, nonce, token),
      t,
      nonce,
      sign_method: 'HMAC-SHA256',
    };
    if (token) headers.access_token = token;
    let res;
    try {
      res = await fetch(this.baseUrl + pathWithQuery, { headers, signal: AbortSignal.timeout(10000) });
    } catch (err) {
      // 網路層失敗 (DNS、防火牆、逾時)：把底層原因帶出來，方便判斷是不是內網擋住
      throw new Error(`連不到 ${this.baseUrl}（${(err.cause && (err.cause.code || err.cause.message)) || err.name || err.message}）`);
    }
    const json = await res.json();
    if (!json.success) {
      const err = new Error(`Tuya API ${json.code}: ${json.msg}`);
      err.code = json.code;
      throw err;
    }
    return json.result;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const r = await this.request('/v1.0/token?grant_type=1');
    this.token = r.access_token;
    this.tokenExpiresAt = Date.now() + (r.expire_time - 60) * 1000;
    return this.token;
  }

  // 帶 token 呼叫；token 失效 (1010/1011) 時重新取得後重試一次
  async authed(pathWithQuery) {
    try {
      return await this.request(pathWithQuery, await this.getToken());
    } catch (err) {
      if (err.code !== 1010 && err.code !== 1011) throw err;
      this.token = null;
      return this.request(pathWithQuery, await this.getToken());
    }
  }

  // 單一裝置。回傳 [{ code, value }, ...]
  getStatus(deviceId) {
    return this.authed(`/v1.0/devices/${encodeURIComponent(deviceId)}/status`);
  }

  // 多台裝置。回傳 Map<deviceId, status 陣列 | Error>。
  // 先用批次端點 (一次呼叫最多 20 台，省 API 額度)；批次失敗就退回逐台查詢。
  async getStatusMany(deviceIds) {
    const out = new Map();
    try {
      for (let i = 0; i < deviceIds.length; i += 20) {
        const chunk = deviceIds.slice(i, i + 20);
        const result = await this.authed(`/v1.0/devices/status?device_ids=${chunk.join(',')}`);
        for (const d of result || []) out.set(d.id, d.status);
        for (const id of chunk) if (!out.has(id)) out.set(id, new Error('塗鴉未回傳此裝置 (Device ID 錯誤或未連結到雲端專案)'));
      }
      return out;
    } catch (batchErr) {
      if (!this.batchWarned) console.warn(`批次查詢失敗 (${batchErr.message})，改為逐台查詢`);
      this.batchWarned = true;
      const results = await Promise.allSettled(deviceIds.map((id) => this.getStatus(id)));
      deviceIds.forEach((id, i) => out.set(id, results[i].status === 'fulfilled' ? results[i].value : results[i].reason));
      return out;
    }
  }
}

// 從 status 陣列挑出溫度並換算成 °C
function pickTemperature(status, code, divisor) {
  const list = Array.isArray(status) ? status : [];
  const item = code ? list.find((s) => s.code === code) : TEMP_CODES.map((c) => list.find((s) => s.code === c)).find(Boolean);
  if (!item || typeof item.value !== 'number') {
    throw new Error(`找不到溫度資料點 (${code || TEMP_CODES.join('/')})，實際回傳：${list.map((s) => s.code).join(', ')}`);
  }
  return { code: item.code, raw: item.value, value: item.value / divisor };
}

module.exports = { TuyaClient, pickTemperature, TEMP_CODES };
