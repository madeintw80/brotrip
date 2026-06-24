# 🔒 BroTrip 隱私說明

> 寫給朋友看的誠實版。沒有公司、沒有律師詞，只有實話。
>
> 最後更新：2026-05-28 (v3.8.x)

---

## TL;DR（最重要的 3 點）

1. **沒有 server**：BroTrip 是純 client 端 PWA，你的 Google token 只存在你手機 localStorage，**Wei 也看不到**。
2. **只動 BroTrip/ 資料夾**：技術上有「全 Drive 權限」，但實際上 code 只動你 Drive 內 `BroTrip/<群組>/` 那個資料夾，其他檔案動都不會動。
3. **AI 看不到你的 Drive**：Wei 用 Claude (AI) 開發 BroTrip，但 AI 只看 Wei 的指令、寫 code。**「跑」是在你手機上跑，AI 沒有任何 user OAuth token**，看不到你或朋友的 Drive。

不放心 → 隨時撤銷：https://myaccount.google.com/permissions → BroTrip → 移除

---

## 1. BroTrip 是什麼樣的 app？

**純 client 端的 PWA**（漸進式網頁應用）：
- 程式碼跑在你的手機 / 電腦 browser
- 沒有 server（除了 Cloudflare Workers 短碼服務，僅存 `groupId → sheetId` 對應）
- 沒有資料庫（資料全部存在你 Drive 內共用 Google Sheet）
- 沒有「BroTrip 後台」可以看你的東西

可以想成：BroTrip = 一個專門給「5 男出遊紀錄」介面的 Google Sheets 客戶端。
跟你自己打開 Google Sheets app 看是一樣的，只是介面為這個 use case 設計。

---

## 2. 為什麼要求「全 Drive 權限」？

Google 對 Drive API 有幾種 scope（權限範圍）：

| Scope | BroTrip 需要嗎 | 原因 |
|-------|---------------|------|
| `drive` (全部) | ✅ 用這個 | 下面三件事都要 |
| `drive.file` (只 app 建的檔案) | ❌ 不夠 | 拿不到「朋友 share 給我的群組」 |
| `drive.appdata` (app 隱藏資料夾) | ❌ 不夠 | 需要使用者看得到的資料夾 |

**BroTrip 必須用 `drive` (全部) 的真實原因**：

### 原因 1：在你 Drive 建群組資料夾
建群組時，BroTrip 要在你的 `我的雲端硬碟/BroTrip/<群組名>/` 建：
- 一個共用資料夾
- 內含 `BroTrip-Data` Google Sheet（記帳/日記/願望都存這裡）
- 內含 `photos/` 子資料夾（照片）

→ 這需要在你 Drive **根目錄**操作的權限。

### 原因 2：找朋友 share 給你的群組（autoDetect）
當朋友邀請你加群組 → Wei 用 Drive API 把該群組資料夾分享給你的 Gmail → 你的 BroTrip **自動搜尋**「分享給我」的 `BroTrip-Data` Sheet → 自動把該群組顯示出來。

→ 這需要「跨資料夾搜尋」權限（Drive search API）。

### 原因 3：退出群組時撤銷自己的權限
你「退出群組」時，BroTrip 自動把你自己從該群組的 Drive ACL 移除。

→ 這需要「修改 Drive 權限」的能力。

**沒有這三個能力，BroTrip 的核心功能（多群組 / 自動同步 / 自我管理）都做不到**。

---

## 3. BroTrip 實際上**會**做什麼

打開 [BroTrip GitHub source code](https://github.com/madeintw80/brotrip)，你可以親自審計。實際上 BroTrip code 內：

✅ **讀寫 `BroTrip/<群組名>/` 內的 Sheet**（記帳/日記/願望等）
✅ **上傳照片到 `BroTrip/<群組名>/photos/`**（你發日記時）
✅ **搜尋「分享給我」的 `BroTrip-Data` Sheet**（自動偵測加入的群組）
✅ **撤銷你自己對群組資料夾的權限**（退出群組時）

**就這四件事**。

---

## 4. BroTrip **不會** 做什麼

❌ 讀取 `BroTrip/` 以外的任何檔案
❌ 寫入 `BroTrip/` 以外的任何資料夾
❌ 把 Drive 內容傳到任何第三方
❌ 上傳任何資料到「BroTrip 後台」（**根本沒有後台**）
❌ 把資料傳給 AI 訓練 / 分析
❌ Wei 個人能看到你的 Drive（**他連自己都看不到別人的**，OAuth 設計就是這樣）
❌ 偷偷在背景跑（PWA 沒在你 app switcher 內 = 完全停止）

---

## 5. 關於 AI 開發的疑慮

Wei 用 Claude（Anthropic 出的 AI）幫他寫 BroTrip 的程式碼。但是：

**AI 在「寫 code」這個階段是有用的**：
- Claude 幫 Wei 寫 JS/HTML/CSS
- 像「請寫一段 fetch API 的程式」這種

**AI 在「跑 code」這個階段完全沒有 user 資料**：
- BroTrip 跑在你手機 browser
- 你的 OAuth token 存在你手機 localStorage
- Claude 沒有你的 token、沒有 Drive 存取權
- Claude 不在你手機上跑

**用 AI 寫的 code 安全嗎？**：
- BroTrip 程式碼是 open source 在 GitHub，**任何人可審計**
- 不安全的話 Wei 自己會死
- AI 寫的程式碼跟人寫的差別不在「會不會偷資料」，而在「是不是 bug 少」

換句話說：「Wei 用 Claude 寫 BroTrip」≠「Claude 能看到你的 Drive」。

---

## 6. 你的資料實際存在哪？

| 資料類型 | 存在哪 | 誰能看 |
|---------|--------|--------|
| 記帳、日記、願望（文字）| 你 Drive 內群組 Sheet | 你 + 同群組成員 + Google |
| 照片 | 你 Drive 內 `photos/` 資料夾 | 同上 |
| 你的 OAuth token | 你手機 localStorage | 只有你的 browser |
| 你的暱稱、UI 偏好 | 你手機 localStorage | 只有你的 browser |
| 邀請短碼 → sheetId 對應 | Cloudflare Workers KV | Wei 的 CF account (但他看了沒用，sheetId 沒給 ACL 也讀不到) |

**沒有任何資料**存在「BroTrip 自己的伺服器」，因為**根本沒有**。

---

## 7. 我擔心 BroTrip 哪天被駭 / Wei 跑路怎麼辦？

- **BroTrip 沒有 server 可被駭**（沒攻擊面）
- **Wei 沒有任何朋友的 Drive 存取權**（他要看也看不到）
- 萬一 Wei 真的不爽不更新了：
  - 你的群組資料**還在你自己 Drive 裡**（資料是你的，BroTrip 只是介面）
  - 你直接打開 Google Sheets app 就能繼續看 / 改
  - 程式碼是 open source，任何人都能 fork 自己 host

---

## 8. 怎麼隨時撤銷 BroTrip 權限？

兩種方法：

### 方法 1：在 BroTrip 內登出
- ⚙ 設定 → ⏏ 登出
- 這只是 BroTrip 本機登出，token 還在 Google account

### 方法 2：在 Google 帳戶完全撤銷（推薦）
1. 開 https://myaccount.google.com/permissions
2. 找「BroTrip」這個 app
3. 點「移除存取權」→ 確認
4. **完全撤銷**，BroTrip 之後任何嘗試都會 403

---

## 9. 開源透明

整個 BroTrip 程式碼都在這裡，你可以親自看：

📦 GitHub: https://github.com/madeintw80/brotrip

主要檔案：
- [js/auth.js](https://github.com/madeintw80/brotrip/blob/main/js/auth.js) — OAuth 怎麼跟 Google 互動
- [js/api.js](https://github.com/madeintw80/brotrip/blob/main/js/api.js) — Drive/Sheets API 呼叫
- [js/groups.js](https://github.com/madeintw80/brotrip/blob/main/js/groups.js) — 群組建立/加入/退出邏輯
- [workers/invite-shortcode/worker.js](https://github.com/madeintw80/brotrip/blob/main/workers/invite-shortcode/worker.js) — Cloudflare Workers 短碼後端

不會看 code 沒關係，找你會 code 的朋友幫你看，或在 GitHub 開 issue 問 Wei。

---

## 10. 還是不放心怎麼辦？

完全 OK，BroTrip 不適合每個人。可以：

1. **不裝 BroTrip**，從 LINE 群看朋友轉貼出遊更新就好
2. **裝但不開定位/通知**：設定 tab 內可分別關閉
3. **裝但少用 Google 帳號**（建一個專門的 Gmail 給 BroTrip 用，不放重要的東西）
4. **撤銷權限，繼續看別人寫的內容**（但不能 commit 自己的）

**沒有任何強制要求**。朋友間互動，舒服最重要。

---

## 📞 有問題找誰？

- **技術問題 / 對 code 有疑慮**：GitHub issue / LINE 問 Wei
- **想知道 Wei 個人有沒有看你的東西**：他真的看不到，但可以問他

🐾 **BroTrip 是 Wei 自己開發的，沒有公司、不收費、不賣資料、沒有後台、AI 看不到。你的 Drive 100% 是你的。**
