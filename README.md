> 這是 **菜行** 專用的版本（Firebase 專案 `caihang-order`）。蒜頭行的版本在另一個資料夾，兩邊各改各的。

# 蒜頭叫貨系統（LINE 官方帳號 × Firebase）

店家在 LINE 點「我要叫貨」，打開叫貨單選品項和數量（**看不到價格**），截單前都能自己改。後台依角色分權限，用來看採買總表、補當日單價、處理依配送路線排的出貨單、做月結對帳，也在這裡管理品項、店家和帳號。

| 網址 | 用途 |
|---|---|
| `https://caihang-order.web.app/?t=…` | 店家叫貨頁（從 LINE 機器人給的連結開） |
| `https://caihang-order.web.app/admin` | 後台，用 Google 帳號登入 |
| `https://caihang-order.web.app/api/webhook` | 填到 LINE Developers 的 Webhook URL |

## 架構

| 部分 | 用途 |
|---|---|
| Firebase Hosting | `public/`：叫貨頁、後台 |
| Cloud Functions（asia-east1 台灣） | `functions/`：API、LINE webhook |
| Firestore | 所有資料（各集合的說明在 `functions/lib/shop.js` 開頭） |
| Firebase Authentication | 後台帳號 |
| Secret Manager | LINE 金鑰、NVIDIA AI 金鑰 |

## 功能

| 分頁 | 內容 |
|---|---|
| 採買總表 | 這天所有店家加總、還沒叫貨的店家（可一鍵 LINE 提醒） |
| 單價 | 只列當天有人叫的品項，填**基本價**和**進價**（進價用來算毛利） |
| 出貨單 | 依路線排序；框裡填**實際秤出的量**（0＝缺貨），金額照實出量算；LINE 傳電子收據；司機手機簽收；列印（A4／80mm）；匯出 Excel |
| 對帳 | 月結明細、收款明細（分次付、現金／匯款／支票／折讓）、LINE 傳對帳單、匯出 Excel |
| 報表 | 營收、進貨成本、毛利、出貨重量、記帳（支出明細，老闆的 LINE 打「油錢 500」也能記）、自訂成本項目（每天／每月）、應收帳齡與 LINE 催款、匯出 Excel |
| 品項 | 品名、分類、單位（可自訂，斤可叫幾斤幾兩）、上下架 |
| 店家 | 店家、路線站號、開通申請、**報價組**（打折／每單位減／個別固定價） |
| AI 紀錄 | 店家打字、傳照片叫貨的內容；看照片改單、教 AI 認新叫法 |
| 設定 | 配色、截單和補單、單位、員工 Google 帳號與角色 |

LINE 端：圖文選單（`scripts/richmenu/setup.mjs` 建立）、叫貨頁、我的訂單、**AI 叫貨**（直接打字或傳手寫單照片，AI 整理後請店家按「確認送出」）。

## 後台角色

| 角色 | 可以做 |
|---|---|
| 老闆 | 全部，包含店家開通和帳號管理。用 `OWNER_EMAILS` 指定 |
| 會計 | 單價、對帳、報表、品項、改出貨數量、傳收據／對帳單／催款 |
| 理貨 | 採買總表、出貨單、改實出量、簽收、提醒叫貨。**看不到單價** |
| 司機 | 看採買總表和出貨單、簽收 |

老闆登入後，在「設定」分頁新增員工：填他的 Gmail、選角色，不用設密碼，員工用自己的 Google 帳號登入。

## 第一次上線

### 1. Firebase Console（console.firebase.google.com → caihang-order）
1. **升級 Blaze 方案**：左下角「升級」。Cloud Functions 要呼叫 LINE，一定要用 Blaze，以這個規模費用大多落在免費額度內。可以順便在 Google Cloud 設預算提醒。
2. **Firestore Database** → 建立資料庫：位置選 **asia-east1（台灣）**，模式選「正式版」。
3. **Authentication** → 開始使用 → 登入方式 → 啟用「**Google**」。
4. **專案設定** → 一般 → 你的應用程式 → 新增「**網頁**」應用程式，名稱隨意。後台登入需要它。

### 2. 電腦上（只要做一次）
```bash
npm install -g firebase-tools
firebase login
cd functions && npm install && cd ..
cp functions/.env.example functions/.env   # 填 OWNER_EMAILS（你自己的 Email）、SHOP_NAME 等
firebase functions:secrets:set LINE_CHANNEL_SECRET
firebase functions:secrets:set LINE_CHANNEL_ACCESS_TOKEN
firebase functions:secrets:set NVIDIA_API_KEY      # AI 叫貨用（build.nvidia.com）
npm run deploy          # 部署到 caihang-order
```

### 3. 老闆帳號
`OWNER_EMAILS` 填你自己的 Gmail，部署後用這個 Google 帳號登入 `/admin` 就是老闆。

### 4. LINE 設定
1. **LINE Developers** → Messaging API：Webhook URL 填 `https://caihang-order.web.app/api/webhook`，按 Verify，再打開 **Use webhook**。
2. **官方帳號管理後台** → 回應設定：「聊天」打開、「Webhook」打開、「自動回應訊息」關掉。
3. 用你自己的 LINE 傳「我的ID」給機器人，把回覆的 userId 填到 `functions/.env` 的 `ADMIN_LINE_USER_IDS`，再跑一次 `firebase deploy --only functions`。之後有店家申請開通時，你會收到通知。
4. **圖文選單**：`node scripts/richmenu/render.mjs veg` 產生圖片，再 `LINE_CHANNEL_ACCESS_TOKEN=… node scripts/richmenu/setup.mjs <專案>` 建立。店家選單（我要叫貨、拍照叫貨、我的訂單、聯絡老闆）是所有人預設；老闆選單（記帳、還要買、本月支出、開後台、今日支出）只套用在 ADMIN_LINE_USER_IDS；打「店家選單」「老闆選單」切換。

## 資料保存與備份

- **資料永久保存，不自動刪除**。依商業會計法，會計憑證至少要保存 5 年，帳簿和報表至少 10 年。這個規模 10 年的資料量也遠低於 Firestore 免費的 1 GB。
- **每日自動備份**：已設定，每天一次、保留 14 週（`firebase firestore:backups:schedules:list` 可以查看）。
- **匯出 Excel**：出貨單、對帳、報表分頁都有「匯出 Excel」。

## 叫貨流程和截單

- 每家店每個配送日一張訂單，配送日前一天截單（預設 22:00）。截單時間、公休日、補單截止在後台「設定」改（存在 `settings/rules`，`CUTOFF_HOUR`、`CLOSED_WEEKDAYS` 只是第一次的預設值）。
- 截單後，或原本的單已經被確認，店家可以自己「補單」，另開一張，跟原本的單分開。
- 單價：「單價」頁只列出當天有人叫的品項，先帶入上次的價格，確認後套用到當天所有出貨單和對帳。
- 「斤」的品項可以叫幾斤幾兩（1 斤 = 16 兩）；單位可以在「品項」分頁自己新增。

## 本機開發（Firebase 模擬器，不花錢、不動正式資料）

需要 Java 21 以上（模擬器要用）。
```bash
cd functions && npm install && cd ..
# functions/.secret.local 放 LINE_CHANNEL_SECRET=…，以及 LINE_CHANNEL_ACCESS_TOKEN=dry-run（不真的送 LINE）
# functions/.env.local 放 OWNER_EMAILS=owner@test.com
npm run emulators      # 另開一個視窗：
npm run seed           # 寫入示範資料和測試帳號（Google 登入視窗按 Add new account，輸入 owner@test.com 等）
npm run link -- 4      # 印出第 4 家店的叫貨連結
```
- 後台：http://localhost:5050/admin
- 模擬器管理介面（可以直接看資料庫）：http://127.0.0.1:4000

## 訊息額度

回覆（reply）不算額度，**主動推播（push）會算**，台灣免費方案每月 200 則。會用到推播的：開通通知、開通申請通知（給老闆）、店家補單通知（給老闆）、提醒叫貨、傳收據、傳對帳單、催款、AI 出錯通知（一天最多一次）。每個綁定的 LINE 帳號各算 1 則。

## 安全

- 金鑰只放在 Secret Manager 和 `functions/.secret.local`（不進 git），**不要寫進程式碼**。
- Firestore 規則禁止瀏覽器直接讀寫，所有資料都經過 Cloud Functions 檢查權限。
- 叫貨連結 7 天有效，只出現在店家自己的 LINE 對話裡。綁定的帳號在後台「店家」可以隨時解除。
