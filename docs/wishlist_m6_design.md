# BroTrip M6 — Wishlist 三階段 lifecycle 完整設計

> **版本**：design v1（2026-05-28，待 review）
> **狀態**：未實作；設計待用戶 review → 確認後拆 milestone 動工
> **目標**：把出國旅遊「想去 / 排進路線 / 去過了」三個狀態整合成一個 lifecycle，三個 tab（Wishlist / Itinerary / Diary）互通。

---

## 1. 核心 Model

把 Wishlist / Itinerary / Diary 視為**同一個地點的三個生命週期狀態**：

```
🌱 Wishlist              🚶 Itinerary           📓 Diary
   想去（candidate）           排進路線（planned）         去過了（visited）
   半透明 marker                實心主色 marker            灰色 ✓ marker
        ↓                            ↓                          ↑
     promote                     到當地                location 自動帶
   到 itinerary                  打開 Diary
        └─────── 寫 Diary 時自動標 visited ──────────┘
```

關鍵：**place_id (Google Maps) 是三個系統的共用主鍵**，所以同一個地點在三邊都認得彼此。

---

## 2. Schema 設計

### 2.1 新增 Sheet tab: `Wishlist`

```
id | trip_id | place_id | name | address | lat | lng | type | added_by | source_note
   | status | rejected_votes | created_at | promoted_at | visited_at
```

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | string | UUID-ish，前端產 |
| `trip_id` | string | 關聯到 Trips sheet（每個 trip 各自的 wishlist） |
| `place_id` | string | Google Maps place_id（autocomplete 拿到） |
| `name` | string | 地點名稱（如「Magnolia 拉麵」） |
| `address` | string | 完整地址 |
| `lat` / `lng` | number | 地理座標 |
| `type` | enum | `restaurant` / `attraction` / `cafe` / `experience` / `shopping` / `other` |
| `added_by` | string | email |
| `source_note` | string | free text「Paul 推薦」「IG @kanahei」「米其林必比登」 |
| `status` | enum | `planned`（預設） / `promoted`（已進 itinerary） / `visited`（已寫日記） / `rejected`（被否決） |
| `rejected_votes` | string | JSON array of emails `["a@x.com","b@x.com"]` |
| `created_at` / `promoted_at` / `visited_at` | ISO string | 各 lifecycle 時間戳 |

### 2.2 改 `Itineraries` schema

加 `wishlist_id` 欄位（optional）— 表示「這個 waypoint 是從哪個 wish promote 來的」。
反向 lookup 用：當 itinerary 被刪除，可以 reset 對應 wish 的 status 回 `planned`。

### 2.3 改 `Diaries` schema

加 `wishlist_id` 欄位（optional）— 表示「這篇日記是去這個 wish 的紀錄」。
寫日記時 location 從 wishlist 選 → 自動填這欄 + 把該 wish 標 visited。

---

## 3. UI 設計

### 3.1 新增 Tab：💡 Wishlist

底部導覽列加第 5 個 tab：💰 記帳 / 📓 日記 / 🗺️ 地圖 / **💡 願望** / ⚙ 設定
（如果太擠就把日記移到 + menu，看實際畫面決定）

**Wishlist tab 主畫面**：

```
┌───────────────────────────────────────┐
│  💡 Wishlist · 好香歐                 │
│  ┌───┬─────┬───┬─────┬─────┐         │
│  │全部│🍜餐廳│景點│☕咖啡│✨體驗│ 切換type │
│  └───┴─────┴───┴─────┴─────┘         │
│  排序：[最近加的 ▾]  我的(2)/全部(8) │
│ ─────────────────────────────────────│
│  🍜 Magnolia 拉麵           👎 0/4    │
│  📍 新宿區歌舞伎町 1-2-3              │
│  💬 Paul 推薦                         │
│  [➕ 加進今天行程] [✓ 已去過] [⋯]   │
│ ─────────────────────────────────────│
│  🏛️ 淺草寺                  👎 2/4 ⚠️│
│  📍 台東區淺草 2-3-1                  │
│  💬 經典必去                          │
│  [➕ 加進今天行程] [✓ 已去過] [⋯]   │
│ ─────────────────────────────────────│
│  ✓ 🍣 鮨さいとう（已去過）          │
│    📝 link → 2026-06-09 的日記        │
└───────────────────────────────────────┘

[+ 浮動按鈕 → 新增 wish]
```

**新增 wish modal**：
- Google Maps Place Autocomplete（用現有 itinerary 的同樣 widget）
- Type 下拉：餐廳/景點/咖啡/體驗/購物/其他
- Source note free text（選填）
- 「為哪個 trip 加？」dropdown（預設當前 active trip）

### 3.2 改地圖 tab

- 預設：itinerary 路線 + waypoints（實心主色）
- 右上 toggle 按鈕：☑ **顯示 Wishlist** → 多顯示 wishlist marker
- Marker 色彩：
  - **Wishlist planned**: 半透明 + 虛線圈（candidate）
  - **Itinerary** (含 promoted from wish): 實心主色
  - **Wishlist visited**: 灰色 ✓
  - **Wishlist rejected**: 不顯示（藏在 Wishlist tab 的「已隱藏」expander）
- 點 wishlist marker → 跳 bottom sheet：
  - 名稱 / type / 誰加的 / source_note
  - [📌 加進今天行程] [✓ 標已去過] [👎 投否決票] [✕]

### 3.3 改行程 (Itinerary) tab

- itinerary 列表下方加 collapsible：「💡 候選地點 (N)」
- 展開列同 trip 的 `Wishlist where status = planned` items
- 每筆有「➕ 加進路線」→ 開現有 itinerary 新增 modal、預填該 place

### 3.4 改日記 (Diary) tab

- 新增日記 modal 的 location 欄位下方加 chip：「📍 從 Wishlist 選 (3)」
- 點開 → 跳 list 選一個 wishlist 地點 → 自動帶 location + 名稱
- 儲存日記時 → 該 wishlist 的 `status` 自動改 `visited` + `visited_at` 寫入 + `wishlist_id` 寫進 diary row

---

## 4. 拒絕投票（Rejection Voting）

**目的**：避免某人硬要加大家不想去的地點。

**規則**：
- 每個成員（除了加這 wish 的人本人）可以對某 wish 按 👎
- 投票 threshold：`(成員數 - 1) / 2` 票（無條件捨去），達標 → 自動標 `rejected`
  - 5 人成員 → (5-1)/2 = 2 票
  - 4 人成員 → (4-1)/2 = 1 票
  - 3 人成員 → 1 票
- Rejected items 從 Wishlist 主列表隱藏，收到「🙈 已隱藏 (N)」expander 下，可手動恢復
- 反悔機制：投票者可「⚡ 取消我的否決」清掉自己這票
- 加 wish 的人可以「💪 強行覆寫」恢復（但所有人會收到通知）

**通知**：
- 你加的 wish 第一次被投票 → push 通知「Paul 對你加的「Magnolia」投了否決」
- 你加的 wish 被否決達標 → push「⚠️ Magnolia 被否決了 (2/4)，討論一下？」
- 通知用現有 Notifications.js sheet-based system（不是 browser push，避免 permission 問題）

---

## 5. 🔔 附近 500m 推播

> **2026-05-28 用戶決定**：要做「app 沒在用時也能推」。
> **iOS PWA 平台限制 → 採方案 A**（M6.3 動工）：
> - Foreground watchPosition + **ServiceWorker showNotification()**（即使 app 被切到背景但沒被 kill 也能推系統通知）
> - 完全 background / app killed 場景：iOS PWA 純 client 端做不到（要 backend Web Push，留 M7+ 評估）



**目的**：旅遊中走在路上，剛好經過某個 wishlist 地點 → 即時提醒「欸這附近有你想去的」。

### 5.1 Permission flow

第一次進 Wishlist tab 時跳 onboarding modal：
```
🔔 要不要開「附近 wishlist 提醒」？
  旅遊中走在路上經過 wishlist 地點時推給你
  ✅ 開啟（會請求定位 + 通知權限）
  ⏸️ 之後再決定
  🚫 不要，我會自己看
```
拒絕後存 settings：`brotrip_geo_notify = 'declined'`，不再 nag。

### 5.2 技術細節

- **Geo API**: `navigator.geolocation.watchPosition(callback, errCb, { enableHighAccuracy: false, maximumAge: 30000 })`
  - `enableHighAccuracy: false` 省電（500m 範圍不需要 GPS 精度）
  - 每 30 秒 check 一次（瀏覽器自動 throttle）
- **Notification API**: `new Notification(title, { body, icon })`
- **觸發條件**：
  - 當前位置跟某 wishlist item 的 lat/lng 距離 < 500m（haversine 公式）
  - 該 wish status = planned（不是 visited/rejected）
- **防 spam**：
  - 同一個 wish 30 分鐘內只通知一次（localStorage `brotrip_geo_notif_<wish_id>`）
  - 同一 session 最多 5 次推播
  - app 在 foreground 時用 in-app toast 而非 browser notification
- **電量考量**：
  - 只在 Wishlist / 地圖 / Itinerary tab 為 active 時啟用 watchPosition
  - 切到其他 tab → `clearWatch()`
  - app 進 background → 自動停（瀏覽器本來就會停）

### 5.3 推播內容

```
🍜 附近有個 wishlist
Magnolia 拉麵 (Paul 推薦)
距離 380m · 點開看地圖
```

點通知 → 開 BroTrip → 跳到地圖 tab + 該 wishlist marker 高亮 + 顯示路線。

### 5.4 Fallback

- 不支援 Geo API 的瀏覽器 → onboarding modal 不出現，功能隱藏
- Permission denied → 不再 nag，settings tab 可以重新啟用
- 在室內 GPS 漂移嚴重時：500m threshold 已經夠寬鬆，不會誤觸

---

## 6. 跨系統 sync 邏輯（重要）

### Promote (Wishlist → Itinerary)

1. UI: Wishlist tab 點「➕ 加進今天行程」
2. 跳現有 Itinerary 新增 modal，預填 place（place_id / name / address / lat / lng）
3. 用戶補：trip / day / order / travel_mode → submit
4. 寫入 Itineraries row（含 `wishlist_id` 欄）
5. 該 wishlist 的 `status` 改 `promoted` + `promoted_at` 寫入
6. UI 立即反映：Wishlist 卡片變灰、地圖 marker 變實心

### Visit (Itinerary or Wishlist → Diary)

1. UI: 寫新日記時 location 從 Wishlist 選
2. Diary row 寫入（含 `wishlist_id`）
3. 對應 Wishlist `status` → `visited`、`visited_at` 寫入
4. 如果該 wish 之前是 `promoted` → 對應 Itinerary waypoint **不刪**（路線歷史保留）

### Reset (誤操作回退)

- 刪 Itinerary waypoint → 如果該 waypoint 有 `wishlist_id` → 對應 wish `status` 改回 `planned`
- 刪 Diary → 如果該 diary 有 `wishlist_id` → 對應 wish `status` 改回 `promoted`（如果原本是）或 `planned`

### Race condition

- 多人同時操作同一 wish（A promote、B 標 visited）→ 後寫贏（last-write-wins）
- 影響不大，trip 場景人不多、操作不密集

---

## 7. Migration

- 既有群組第一次進 Wishlist tab → 自動建 Wishlist sheet tab + headers（同 M2 建群組那套）
- 不需要 backfill — 沒人會幫過去的 trip 補 wishlist
- Itineraries / Diaries 的 `wishlist_id` 欄位 → 新建 trip 才會用到，舊資料保持 empty

---

## 8. Milestone 拆分

| Milestone | 內容 | 預估時程 | Critical files |
|-----------|------|---------|----------------|
| **M6.1 核心** | Wishlist sheet + tab + CRUD + 卡片 UI + 地圖 marker | ~5 天 | 新增 `js/wishlist.js`；改 `index.html` (Tab) + `app.js` (render) + `groups.js` (sheet migration) + `api.js` (CRUD) |
| **M6.2 整合** | promote 互通 + 日記 location 從 wishlist 選 + visited 自動標 | ~3 天 | 改 `itineraries.js` + `diaries.js` + `wishlist.js` 加 sync hooks |
| **M6.3 推播** | 附近 500m geo notify + onboarding modal + settings toggle | ~5 天 | 新增 `js/geo_notify.js`；改 `app.js` (init) + `settings tab` |
| **M6.4 否決** | 拒絕投票 + 通知 + UI | ~3 天 | 改 `wishlist.js` (vote API) + 既有 `notifications.js` |

**總時程約 2-3 週**（若一週兼著做別的事）。

---

## 9. 風險 & 待決定

| 議題 | 我的建議 | 待決 |
|------|---------|------|
| Tab 太多塞不下 | 把「日記」移到「+ 更多」selector，主 tab 留：記帳/地圖/Wishlist/設定 | 用戶決定 tab 順序 |
| Wishlist Trip-scoped 還是 Group-scoped | Trip-scoped（每 trip 各自的願望，因為東京願望去韓國沒用） | OK |
| 否決票應該 anonymous 還是 named | Named（讓投票者要負責，避免亂投） | OK |
| Geo notify 在 iOS PWA 能跑嗎 | iOS 14+ 支援 watchPosition，但 background 完全不行（只能 foreground 用，這設計可接受） | 真機實測 |
| `place_id` 萬一 Google 換 ID 怎麼辦 | 罕見場景；備援用 lat/lng + name fuzzy match | 不急著處理 |

---

## 10. 下一步

當用戶 review 完此設計 → 確認方向後：
1. 開 M6.1 milestone（先做核心 Wishlist sheet + tab + CRUD + 地圖顯示）
2. 上線 dogfood 2 週看實際使用模式
3. 視回饋決定 M6.2/M6.3/M6.4 順序與細節

---

**設計者**：妮妮 🐱（with 用戶 brainstorm 2026-05-28）
**檔案位置**：`~/projects/BroTrip/docs/wishlist_m6_design.md`
