# 成型產線溫度監控

公開網頁顯示鞋廠成型產線上塗鴉 (Tuya) 溫度感測器的每分鐘溫度曲線（預設 3 條線 × 3 個感測點），溫度驟變時顯示該分鐘的最高/最低值並標記。

```bash
npm start              # 未設定金鑰 → 示範模式，開 http://localhost:3000
cp .env.example .env   # 填入塗鴉金鑰與資料中心
                       # 在 devices.json 填各感測點的名稱與 Device ID
npm run probe          # 檢查連線與溫度換算
npm test
```

需要 Node 18 以上，無其他相依套件。架構、現況與待辦見 `HANDOFF.md`；`PROJECT_BRIEF.md` 是給 Claude 專案說明用的精簡版。
