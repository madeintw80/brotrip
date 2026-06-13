# BroTrip 邀請短碼 — Cloudflare Workers 部署 Guide

> 給 Wei 一步一步跟著做。**全程用 web dashboard**，不需要裝任何 CLI 工具。
> ⏱️ 預估時間：20 分鐘
>
> 📅 對齊 CF dashboard 2025 改版後介面（Workers 在 Compute / KV 在 Storage & databases / Namespace 改名 Instance）

---

## Step 1：註冊 Cloudflare 帳號（5 分鐘）

1. 開 https://dash.cloudflare.com/sign-up
2. 用 email + 密碼註冊（**不需要 credit card**）
3. 收 email 點驗證連結
4. 登入後右上會看到你的 email + 一個 subdomain（例 `madeintw80.workers.dev`）
   - 這個 subdomain 就是之後 Worker URL 的後綴

---

## Step 2：建 KV Instance（3 分鐘）

KV 是 CF 提供的 key-value 儲存，免費 100k reads / 1k writes 每天。

1. 登入 dashboard：https://dash.cloudflare.com
2. 左側選單 → **Storage & databases**（在 Build 分類下）→ 展開 → **Workers KV**
   - ⚠️ KV 不在 Compute 下！CF 改版後 KV 改歸 Storage & databases
3. 按右上 **「+ Create Instance」**（舊版叫 Create namespace，現在改名 Instance，東西一樣）
4. Name 輸入：`brotrip-invites`
5. 確認建立
6. 列表會出現 `brotrip-invites` + 一串 ID（例 `d70369c113334feebf473ff5b63d4fbc`）— 記得 ID 之後好用但不一定要

---

## Step 3：建 Worker（5 分鐘）

1. 左側選單 → **Compute** → **Workers & Pages**
2. 按右上 **「+ Create」** 或 **「Create application」**
3. 選 **「Start with Hello World!」** 或 **「Create Worker」** template
4. **Worker name** 輸入：`brotrip-invite`
   - ⚠️ 這名字會變成你的 Worker URL：`https://brotrip-invite.<你的 subdomain>.workers.dev`
5. 按 **「Deploy」**（先部署 Hello World 看到能跑）
6. 部署完跳「View code」或「Continue to project」按下去進 Worker 詳細頁

---

## Step 4：綁定 KV 給 Worker（2 分鐘）

讓 Worker 內部能讀寫剛建的 `brotrip-invites` KV。

1. 在 Worker 詳細頁 → **Settings**（或 **設定**）tab
2. 找到 **「Bindings」** 或 **「Variables and Secrets」** 區
3. 找 **「KV Namespace Bindings」** subsection → 按 **「+ Add」** 或 **「Add binding」**
4. 跳出 form：
   - **Type**：選 `KV namespace`（若有問）
   - **Variable name**：輸入 `INVITES`（**全大寫，一字不差**，code 內就靠這個名字找 KV）
   - **KV namespace**：下拉選 `brotrip-invites`
5. 按 **Save / Deploy**
6. 看到 Bindings 區出現一筆 `INVITES → brotrip-invites` 就 OK

⚠️ 這步驟超關鍵 — 如果 binding name 不是 `INVITES`（大寫），Worker 跑 code 會 throw error 找不到 KV。

---

## Step 5：貼 Worker code（5 分鐘）

1. 在 Worker 詳細頁 → 找 **「Edit code」**（藍色按鈕）→ 進線上 code editor（會開新 tab）
2. 左邊看到一個檔案 `worker.js`（內容是預設的 Hello World）
3. **滑鼠點 editor → Ctrl+A 全選 → Delete 全部刪掉**
4. 打開這個 repo 的 [worker.js](./worker.js)（在 GitHub 上）
5. **整段 raw code 複製 → 貼進 Worker editor**
6. 按右上 **「Deploy」**
7. 等部署完成（~10 秒，會看到綠色 ✅ 訊息）

---

## Step 6：驗證部署成功（2 分鐘）

開瀏覽器測試（手機/電腦都行）：

```
https://brotrip-invite.<你的 subdomain>.workers.dev/health
```

⚠️ **`<你的 subdomain>` 是你 CF 帳號的 workers subdomain**（不是「你的帳號」字面）。從 Worker 詳細頁右上會看到 Worker 的完整 URL，那就是 base，後面加 `/health`。

例如我看你截圖你的 subdomain 是 `madeintw80.workers.dev`，所以你的 URL 是：
```
https://brotrip-invite.madeintw80.workers.dev/health
```

應該看到一個白頁顯示 **`ok`** → 部署成功 ✅

如果看到「Worker threw exception」或 1101 error → KV binding 沒設好（檢查 Step 4，name 必須是 `INVITES` 大寫）。

---

## Step 7：把 URL 給 Wei

把你的 Worker URL **去掉 `/health`** 的 base URL 給我，例如：

```
https://brotrip-invite.madeintw80.workers.dev
```

我會把 BroTrip 的 `config.js` 設這個 endpoint，push v3.6.1。完成！

---

## 🆘 卡住問題

### 「找不到 Workers & Pages」
→ 左側選單往下滾，**Build → Compute** 分類底下有 Workers & Pages。

### 「找不到 Workers KV」
→ **Storage & databases**（不是 Compute）底下，CF 改版過。

### 「Create namespace 找不到」
→ 改名了！現在叫 **「Create Instance」**（同樣的東西）。

### 「免費 plan 還是要 credit card?」
→ 不要！如果 CF 要你輸入 card，表示你不小心進到付費頁或加購頁。**Workers Free + KV Free 永久免費，純註冊不需要 card**。

### 「Deploy 失敗 / code 紅字錯誤」
→ 多半是 code 沒整段貼乾淨。確認：
  - Editor 內容 100% 等於 worker.js raw code
  - 沒漏字、沒多字、沒前置空格
  - 整個檔案以 `export default {` 為主結構

### 「/health 顯示 1101 error」
→ KV binding 沒設好。回 Step 4 確認 variable name 是 `INVITES`（大寫）。

### 「/health 顯示其他 error / 截圖看不懂」
→ 截圖給我！或在 Worker 詳細頁 → **Logs** tab 看實際錯誤訊息。

---

## 📊 KV 內容檢查（debug 用）

部署完後，回 CF dashboard：
- **Storage & databases → Workers KV → brotrip-invites → KV pairs** tab
- 用 BroTrip 邀請朋友後，這裡會看到 `code:XXXXXXXX` 的 entry 多起來
- 點 entry 可看到內容 (sheetId / folderId / name)

---

## 💰 費用 reminder

- Free plan：每天 **100k requests** + KV **100k reads / 1k writes**
- BroTrip 估計每天 < 50 requests
- **永遠 hit 不到付費門檻**

如果 CF 哪天通知你「超量」絕對是 bug 或被攻擊，告訴我立刻處理。
