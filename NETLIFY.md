# Netlify 部署（測試版）

網頁、API、每分鐘取樣都放在 Netlify，**不需要一台常開的電腦**，塗鴉金鑰存在 Netlify 環境變數，網頁拿不到。

```
Netlify 排程函式 poll（每分鐘）──> 塗鴉 OpenAPI（批次查全部裝置）
        │
        └─> Netlify Blobs（readings store：day/YYYY-MM-DD、state）
                 ▲
瀏覽器 public/index.html ──GET /api/readings──> 函式 readings（CDN 快取 30 秒）
```

| 檔案 | 作用 |
|---|---|
| `netlify.toml` | 發佈 `public/`，函式在 `netlify/functions/` |
| `netlify/functions/poll.mjs` | 排程 `* * * * *`：取樣 → 異常判斷 → 寫入 Blobs；每天清掉超過 `RETAIN_DAYS` 的資料 |
| `netlify/functions/readings.mjs` | `/api/readings`，格式與 Node 版相同，前端不用改；沒有金鑰時自動產生示範資料 |
| `netlify/functions/health.mjs` | `/api/health` |
| `netlify/functions/probe.mjs` | `/api/probe?key=<ADMIN_KEY>`：取代 `npm run probe`，在瀏覽器看塗鴉連線、資料點代碼、換算溫度、上線狀態 |
| `netlify/lib/cloud.mjs` | 共用設定與儲存；簽名、異常判斷、降採樣沿用 `lib/` 的原始程式 |

## 和 Node 版的差異
- Netlify 排程最短每分鐘一次，所以**每分鐘只取樣一次**，該分鐘的最高/最低就是該次讀值。異常判斷仍是「與上一分鐘相差 ≥ 門檻」。要抓分鐘內的極值需改用塗鴉訊息推播（HANDOFF 第 6 節第 4 項）。
- 改 `devices.json`（新增感測點）後要重新部署才生效。
- Node 版 (`server.js`) 保留，兩者共用 `lib/`、`public/`、`devices.json`。

## 部署步驟

> [!IMPORTANT]
> Netlify 的「拖拉上傳 (Netlify Drop)」**不會部署函式**，一定要用下面兩種方式之一。

**方式 A：GitHub（電腦不用裝 Node）**
1. 把這個資料夾推到一個 GitHub repo（私人 repo 即可；`.env` 已被 `.gitignore` 排除）。
2. Netlify → Add new project → Import from GitHub → 選該 repo，設定全部用預設（`netlify.toml` 已寫好）。
3. 填環境變數（見下方）→ Deploy。之後在 GitHub 改 `devices.json` 就會自動重新部署。

**方式 B：Netlify CLI（需要 Node 18+）**
```bash
npm install
npx netlify-cli login        # 開瀏覽器授權
npx netlify-cli init         # 建立網站
npx netlify-cli deploy --prod
```

## 環境變數（Netlify → Project configuration → Environment variables）

| 名稱 | 值 |
|---|---|
| `TUYA_ACCESS_ID` | 塗鴉 Access ID（**必填**，與 `.env` 相同） |
| `TUYA_ACCESS_SECRET` | 塗鴉 Access Secret（**必填**，建議先到塗鴉後台重設一組） |
| `TUYA_BASE_URL` | `https://openapi-sg.iotbing.com` |
| `ADMIN_KEY` | 自訂一組亂碼，用於 `/api/probe?key=...` |
| `TEMP_CODE` / `TEMP_DIVISOR` | 選填，看完 probe 結果再決定（預設自動偵測 / 10） |
| `ANOMALY_THRESHOLD_C` / `RETAIN_DAYS` / `SITE_TITLE` | 選填，預設 1.0 / 30 / 成型產線溫度監控 |

改完環境變數要重新部署一次才會生效。

## 部署後檢查
1. 打開 `https://<網站>.netlify.app/api/probe?key=<ADMIN_KEY>`：`token` 要是 `OK`，A1 線「活化」要有 `temperature.value`，且與塗鴉 App 顯示的溫度一致。
2. 等 2～3 分鐘後打開首頁，A1 線「活化」卡片應該開始有曲線；其他 8 張卡片顯示「尚未設定裝置」。
3. `/api/health` 回 200 代表取樣正常。

## 額度
- 每分鐘一次排程 ≈ 每月 43,200 次函式呼叫（加上網頁瀏覽），Netlify 免費方案用於測試足夠；網頁 API 有 30 秒 CDN 快取，多人同時看不會加倍。
- 塗鴉端每分鐘 1 次批次查詢（token 會沿用，不會每分鐘重拿）。
