# BroTrip 🍺

五人好友出遊紀錄專屬 app。記帳、照片日記、每趟獨立 trip。
純前端 PWA，資料存在 Google Drive / Sheets，無需後端 server。

## 功能

- **記帳**：誰付了什麼，分帳人可指定、可設不同比例，自動算「誰欠誰多少」
- **照片日記**：上傳照片到 Drive、寫文字心情、按時間軸顯示
- **多 Trip**：每趟出遊獨立 trip_id，可切換看歷史
- **登入**：Google OAuth，五人各用自己 Google 帳號

## 架構

- 純前端 HTML / CSS / Vanilla JavaScript
- Google Identity Services (GIS) for OAuth
- Google Sheets API 存資料
- Google Drive API 存照片
- PWA（可安裝到手機桌面）

## 本機開發

```bash
# 任何靜態 server 都可：
python -m http.server 8080
# 或
npx serve .
```

打開 http://localhost:8080

## 部署到 GitHub Pages

1. 把這個資料夾 push 到 GitHub repo（例：`brotrip`）
2. GitHub repo → Settings → Pages → Source: `main` branch, root → Save
3. 等 1-2 分鐘 → 網址：`https://<username>.github.io/brotrip/`
4. **重要**：回 Google Cloud Console → 憑證 → 編輯 OAuth Client，把 GitHub Pages 網址加進「已授權的 JavaScript 來源」
5. 把 Drive `BroTrip/` 資料夾分享給五位朋友（角色：編輯者）
6. 把 `BroTrip-Data` Sheet 分享給五位朋友（角色：編輯者）

## 設定

`js/config.js` 內含：
- `CLIENT_ID` — Google OAuth Client ID（public，可 commit）
- `SHEET_ID` — 資料試算表 ID
- `ROOT_FOLDER_ID` / `PHOTOS_FOLDER_ID` — Drive 資料夾 ID

## 資料結構

Google Sheet `BroTrip-Data` 共 4 個分頁：

| 分頁 | 欄位 |
|------|------|
| Trips | trip_id, name, start_date, end_date, members, created_by, created_at |
| Expenses | id, trip_id, date, payer, amount, currency, category, description, splits, photo_url, created_at |
| Diaries | id, trip_id, date, author, content, mood, photo_ids, location, created_at |
| Members | email, display_name, joined_at |

照片存在 Drive 的 `BroTrip/photos/<trip_id>/<date>/`。

## 安全性

- 純前端，無後端 server
- Client ID 公開沒問題（OAuth 本來就 public）
- OAuth 限制：只有 Google Cloud Console 「測試使用者」白名單能登入
- 資料權限：由 Drive owner 控制分享範圍
