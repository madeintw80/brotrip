# BroTrip ✈️

**和好友一起記錄出遊**的 PWA。記帳、照片日記、行程地圖，每趟獨立 trip。

純前端 PWA，資料存在每位群組擁有者的 Google Drive / Sheets，無需後端伺服器。

> v3.0 起為**多群組自助模式**：任何 Google 用戶都能建立自己的群組、邀請朋友加入、自由管理。原本的「寫死 5 個朋友」白名單已移除。

---

## 🎯 主要功能

### 群組管理
- **建立群組**：在你 Drive 自動建 `BroTrip/<群組名>/` 資料夾 + Sheet + photos 子資料夾
- **邀請朋友**：產生邀請連結，朋友點開就會自動跳「加入群組」對話框
- **權限管理**：owner 可踢人，成員可退出，刪除群組會清掉整個 Drive 資料夾
- **多群組切換**：右上 dropdown 切換不同群組（出遊朋友圈 / 家人 / 同事旅遊...）
- **跨裝置同步**：owner 在 desktop 建群組，手機/平板登入會自動偵測

### 業務功能
- **記帳**：誰付了什麼、分帳人可指定、可設不同金額、自動算「誰欠誰多少」
- **照片日記**：上傳照片到 Drive、寫文字心情、按時間軸顯示、@mention 朋友
- **行程地圖**：把每趟 trip 的地點存起來，地圖顯示 + 路線規劃
- **結算**：A 標記「已付給 B」→ B 確認 → 抵銷債務（peer-to-peer）
- **多 Trip**：每趟出遊獨立 trip_id，可切換看歷史

---

## 🏗️ 架構

- 純前端 HTML / CSS / Vanilla JavaScript（無框架，無 build step）
- Google Identity Services (GIS) for OAuth 2.0
- Google Sheets API 存表格資料
- Google Drive API 存照片 + 群組資料夾
- PWA（可安裝到手機桌面，離線快取）

### 資料儲存模型（BYOD — Bring Your Own Drive）

每個**群組擁有者**的 Drive 結構：

```
[Owner's Drive Root]
└── 📁 BroTrip/                    (私人父資料夾，不分享)
    ├── 📁 <Group A>/              (群組子資料夾，分享給該群成員)
    │   ├── 📊 BroTrip-Data Sheet
    │   └── 📁 photos/
    │       └── 📁 <trip_id>/
    │           └── 📁 <date>-<diary_id>/
    │               └── 📷 photo files
    └── 📁 <Group B>/
        └── ...
```

- **BroTrip/ 父資料夾**：只有 owner 看得到
- **群組子資料夾**：owner 透過 Drive ACL 分享給該群組成員（編輯權）
- 不同群組互不知道彼此存在

---

## 💻 本機開發

```bash
# 任何靜態 server 都可：
python -m http.server 8080
# 或
npx serve .
```

打開 http://localhost:8080 → 用 Google 登入 → 建立群組或用邀請連結加入。

---

## 🚀 部署到 GitHub Pages

1. 把這個資料夾 push 到 GitHub repo（例：`brotrip`）
2. GitHub repo → Settings → Pages → Source: `main` branch, root → Save
3. 等 1-2 分鐘 → 網址：`https://<username>.github.io/brotrip/`
4. **重要**：回 Google Cloud Console → 憑證 → 編輯 OAuth Client：
   - 加入「已授權的 JavaScript 來源」：`https://<username>.github.io`
5. **更新 `js/config.js`**：把 `CLIENT_ID` 改成你自己申請的 OAuth Client ID
6. **App publish 設定**（避免 OAuth refresh token 7 天到期）：
   - Google Auth Platform → 目標對象 → **發布應用程式**
   - User type 維持「外部」
   - 跳出警告選 OK（個人用 unverified production 也夠用）

---

## ⚙️ 設定

`js/config.js`：
- `CLIENT_ID` — 你的 Google OAuth Client ID（public，可 commit）
- `MAPS_API_KEY` — Google Maps API Key（給 Places Autocomplete 用，可選）

（v3.0 起不再需要 `SHEET_ID` / `ROOT_FOLDER_ID` 等，群組資訊由用戶執行時動態建立）

---

## 📊 資料結構

每個群組的 `BroTrip-Data` Sheet 有 **9 個分頁**：

| 分頁 | 欄位 |
|------|------|
| Trips | trip_id, name, start_date, end_date, members, created_by, created_at |
| Expenses | id, trip_id, date, payer, amount, currency, category, description, splits, photo_url, created_at, payers, settled |
| Diaries | id, trip_id, date, author, content, mood, photo_ids, location, created_at, pinned, drive_folder_url, mentions |
| Members | email, display_name, joined_at |
| Nicknames | target_email, nickname, updated_by, updated_at |
| Comments | id, diary_id, author, content, created_at, mentions |
| Notifications | id, target_email, type, diary_id, comment_id, from_email, created_at |
| Itineraries | id, trip_id, name, waypoints, travel_mode, author, created_at |
| Settlements | id, trip_id, from_email, to_email, amount, currency, status, note, created_at, confirmed_at |

照片存在 `BroTrip/<group>/photos/<trip_id>/<date>-<diary_id>/`。

---

## 🔒 安全性 / 隱私

- **純前端**，無後端伺服器，不會收集你的資料
- **Client ID 公開**沒問題（OAuth 本來就 public）
- **資料權限**：完全由 Drive owner 控制，app 只是 UI 層
- **App publish 模式**：v3.0 移除白名單，任何 Google 帳號可登入 → 但**看不到其他人的資料**（Drive ACL 控制）
- **邀請碼不算機密**：只是位置指針，沒 Drive 分享也讀不到資料
- **退出群組**：member 自我移除 Drive 權限可能失敗（Drive API 限制），UI 會引導手動到 Drive 點「移除我」

---

## 📚 用戶流程

### 建立群組（第一次用）
1. 登入 → 看到「無群組」歡迎畫面
2. 點「➕ 建立新群組」→ 輸入名稱（例「大學同學會」）
3. App 跑 9 步驟自動建 Drive 結構（~10 秒）
4. 顯示邀請連結 → 點「📤 分享」→ 跳 native share sheet（手機）或複製到剪貼簿（桌機）
5. 把連結貼到 LINE / iMessage 給朋友

### 加入群組（朋友收到連結）
1. 點朋友傳來的連結 → 跳到 BroTrip 登入頁
2. 用 Google 登入 → 自動跳「加入群組」對話框（邀請碼已預填）
3. 點「加入」→ 如果沒 Drive 權限會自動開 Drive 頁面 → 點 Google 跳出的「**要求存取權**」
4. 群組擁有者收 email → 一鍵 Approve
5. 朋友回 BroTrip 點「✅ 我已經有權限了，重試」→ 設定顯示名稱 → 完成

### 日常使用
- 切換群組：右上角 `🏠 <群組名> ▾` pill
- 設定 tab 有完整管理：建立 / 加入 / 重新命名 / 改顯示名稱 / 管理成員 / 封存 / 刪除
- 統計 dashboard：總 Trips / 成員 / 花費 / 日記 一目了然

---

## 🛠️ 開發 / 貢獻

詳細的內部設計、權限模型、跨裝置同步策略，請參考 [project_brotrip_phase2.md](https://github.com/madeintw80/brotrip-internal-docs/...) （內部文件）。

歡迎 issue / PR：
- 邀請碼短碼版（目前長 base64）
- 多裝置 member 跨裝置同步
- 群組頭像 emoji 選擇器
- 商轉 Pro 功能

---

## 📜 License

MIT
