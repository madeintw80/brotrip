# BroTrip 邀請短碼 — Cloudflare Workers 部署 Guide

> 給 Wei 一步一步跟著做。**全程用 web dashboard**，不需要裝任何 CLI 工具。
> ⏱️ 預估時間：20 分鐘

---

## Step 1：註冊 Cloudflare 帳號（5 分鐘）

1. 開 https://dash.cloudflare.com/sign-up
2. 用 email + 密碼註冊（不需要 credit card）
3. 收 email 點驗證連結

---

## Step 2：建 KV Namespace（3 分鐘）

KV 是 CF 提供的 key-value 儲存，免費 100k reads / 1k writes 每天。

1. 登入 dashboard：https://dash.cloudflare.com
2. 左側選單 → **Storage & databases**（在 Compute 下面、Media 上面）→ 展開 → **KV**
   - ⚠️ KV 不在 Compute 下！CF 2024 改版過，現在歸 Storage & databases 分類
3. 按右上 **「Create a namespace」**
4. Namespace name 輸入：`brotrip-invites`
5. 按 Add，會看到清單多一筆 `brotrip-invites`，**複製它的 ID**（之後用得到）

---

## Step 3：建 Worker（5 分鐘）

1. 左側選單 → **Workers & Pages** → **Overview**
2. 按右上 **「Create」**
3. 選 **「Hello World」** template → 按 **「Get started」**
4. Worker name 輸入：`brotrip-invite` （這會變成你的 subdomain 例 `brotrip-invite.<你的帳號>.workers.dev`）
5. 按 **「Deploy」**（先部署 Hello World 看到能跑）
6. 之後會跳「Continue to project」按下去進 Worker 編輯頁

---

## Step 4：綁定 KV 給 Worker（2 分鐘）

1. 在 Worker 頁面 → **Settings** tab → **Variables and Secrets**
2. 滾到 **「KV Namespace Bindings」** 區
3. 按 **「Add binding」**
4. Variable name 輸入：`INVITES`（**一字不差大寫**，code 內就靠這個名字找 KV）
5. KV namespace 下拉選剛建的 `brotrip-invites`
6. 按 **Save**

---

## Step 5：貼 Worker code（5 分鐘）

1. 在 Worker 頁面 → **「Edit code」**（右上）→ 進線上 code editor
2. 左邊看到 `worker.js`，把整個內容**全選刪掉**
3. 打開這個 repo 的 [worker.js](./worker.js)
4. **整段複製 → 貼進 Worker editor 取代**
5. 按右上 **「Deploy」**
6. 等部署完成（~10 秒）

---

## Step 6：驗證部署成功（2 分鐘）

開瀏覽器測試：

```
https://brotrip-invite.<你的帳號>.workers.dev/health
```

（把 `<你的帳號>` 換成你的 CF account subdomain）

應該看到一個白頁顯示 **`ok`** → 部署成功 ✅

如果看到「Worker threw exception」之類錯誤 → 檢查 KV binding 是否取名 `INVITES`（大寫）。

---

## Step 7：把 URL 給 Wei

把你的 Worker URL 給我，例如：

```
https://brotrip-invite.cynthia-test.workers.dev
```

我會把 BroTrip 的 `config.js` 設這個 endpoint，push v3.6.1。完成！

---

## 🆘 卡住問題

### 「找不到 Worker & Pages」
→ 左側選單可能要展開「Workers」分類，或從首頁找到「Workers」字樣的卡片。

### 「免費 plan 還是要 credit card?」
→ 不要！如果 CF 要你輸入 card，表示你不小心進到付費頁。**Workers Free 永久免費，純註冊不需要 card**。

### 「Deploy 失敗」
→ 多半是 code 貼漏字。直接整段重貼一次。

### 「health 顯示其他 error」
→ 截圖給我，多半是 KV binding 設定問題。

---

## 📊 KV 內容檢查（debug 用）

部署完後，CF dashboard：
- Workers & Pages → KV → `brotrip-invites` → **KV pairs**
- 用 BroTrip 邀請朋友後，這裡會看到 `code:XXXXXXXX` 的 entry 多起來

---

## 💰 費用 reminder

- Free plan：每天 100k requests + 100k KV reads + 1k KV writes
- BroTrip 估計每天 < 50 requests
- **永遠 hit 不到付費門檻**

如果 CF 哪天通知你「超量」絕對是 bug 或被攻擊，告訴我立刻處理。
