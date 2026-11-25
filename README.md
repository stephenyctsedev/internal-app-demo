# Internal App Demo — 倉庫存貨 · 團購記錄（Claude Artifacts）

呢個 repo 放 Demo Co. 倉庫同團購兩個 **Claude Artifact** 嘅 source
（一個 HTML 檔，喺 claude.ai 入面行，資料喺 Google Sheet）：

| Artifact | 資料夾 | 做咩用 | 資料來源（Google Sheet） |
| --- | --- | --- | --- |
| **倉庫存貨** | [`artifacts/warehouse/`](artifacts/warehouse/) | 倉庫庫存：睇貨、入貨／出貨、盤點、補貨架標記、出入記錄 | 「倉庫存貨 - Demo Co.」 |
| **團購記錄** | [`artifacts/groupbuy/`](artifacts/groupbuy/) | 每星期團購取貨櫃檯：搵單、剔「已領取」 | 「團購記錄 - Demo Co.」 |

兩個都係**直連模式**：Google Sheet 就係資料庫，冇本地副本、冇同步。每次讀寫都即時搵 Sheet，
連唔到就直接報錯。頁面用 `mcp` capability 叫用家自己嘅 claude.ai **Google Sheets connector**，
所以 repo 入面冇任何 credentials。Build／test 方法見 [`artifacts/README.md`](artifacts/README.md)。

> 之前嘅 Muse Space 版本（`warehouse-space/`、`group-buy-space/`，連 `AGENTS.md`、`DATA-PLAN.md`）
> 已經由呢個 branch 移走，仍然保留喺 `muse-space` branch 嘅 git history。

## Vercel 網頁版（一個 server 兩個 app）

同一套 source 亦可以 deploy 上 Vercel，做一個唔使開 claude.ai 都用到嘅網頁版。功能同 UI 同兩個 Artifact 一樣，
唯一分別係 Google Sheet 經 server（Google service account）讀寫，而唔係經用家自己嘅 claude.ai connector。

### 鑰匙：每人一條，兩個 app 分開批

每個人有**自己一條 key**，你喺一張私人 Google Sheet（**鑰匙簿**）剔咗先用得；倉庫同團購分開剔。
**邀請邊個 app 由你決定**：每個 app 有自己嘅邀請碼，同事唔可以自己揀。
Sheet 只記 key 嘅 SHA-256 指紋，**唔記 key 本身**；條 key 只會喺申請人部手機出現一次。

| 網址 | 係咩 |
| --- | --- |
| `https://<你個域名>/?invite=<邀請碼>` | 申請表：淨係填名（申請邊個 app 跟邀請碼）→ 攞到自己條 key |
| `https://<你個域名>/?key=<佢條key>` | 「我的鑰匙」頁：睇自己批咗邊個 app、撳「開啟」 |
| `https://<你個域名>/?app=stock&key=<佢條key>` | 倉庫存貨（要剔咗「倉庫」） |
| `https://<你個域名>/?app=groupbuy&key=<佢條key>` | 團購記錄（要剔咗「團購」） |

**流程**

1. 你揀返想佢用邊個 app，喺鑰匙簿「設定」tab 抄嗰個邀請碼，砌成 `/?invite=<邀請碼>` WhatsApp 畀佢：
   - 「倉庫邀請碼」→ 只申請倉庫
   - 「團購邀請碼」→ 只申請團購
   - 「倉庫＋團購邀請碼」→ 兩個都申請
2. 同事填名（申請表會顯示佢申請緊邊個 app，佢改唔到）→ 去咗自己嘅「我的鑰匙」頁，顯示「等緊批准」。
   鑰匙簿「鑰匙」tab 加咗一行，你收到一封 email。
3. 你喺佢嗰行剔「倉庫」／「團購」= 批准（最多 30 秒生效）。佢嘅頁面每 20 秒自己 check，批咗會自動更新。
4. 同事撳「開啟」→ 喺 Safari「分享 → 加入主畫面」。捷徑記住嘅係**佢自己條 key**。
5. 之後想佢加用另一個 app：你直接喺佢嗰行剔埋就得（唔使佢申請、唔使新 key），佢個鑰匙頁會多咗嗰個 app。

**鑰匙簿點管**

| 你想 | 喺 Sheet 做 |
| --- | --- |
| 批准某人用某個 app | 剔佢嗰行嘅「倉庫」／「團購」（佢冇申請嗰個都可以剔） |
| 收返某個 app 嘅權限 | 取消剔（佢仲見到自己個鑰匙頁，但開唔到 app） |
| 成條 key 作廢（例如換手機、離職、甩咗條連結） | 刪咗佢嗰行（條連結即刻變死網頁）；要再用就再填一次申請 |
| 暫停某種邀請 | 清空「設定」tab 嗰個邀請碼 |
| 舊邀請連結作廢 | 將嗰個邀請碼改做一串新嘅（隨便打，愈長愈好） |

- 「鑰匙」tab：A 名 · B 倉庫 ☐ · C 團購 ☐ · D 申請 · E 申請時間（Winnipeg）· F Key 指紋。
  **唔好改 F 欄**，改咗條 key 就用唔到。排序、加備註欄喺 G 欄之後都冇問題。
- 「設定」tab：A 欄係名（「倉庫邀請碼」／「團購邀請碼」／「倉庫＋團購邀請碼」），B 欄係碼。
  靠 A 欄個名搵，所以行嘅次序可以郁，但**唔好改 A 欄啲名**。
- 兩個 tab 第一次用嗰陣自動開（唔會掂你本身嘅 tab），三個邀請碼都係自動生。
- 冇剔任何 app 嘅行超過 20 行，就暫停接受新申請（防止有人狂撳），刪走唔要嘅行就得返。

**仍然係死網頁、一隻字都冇**：`app`／`key`／`invite` 空白或者唔啱、條 key 嘅行刪咗、邀請碼唔啱或者清空咗、
`invite` 同 `app`／`key` 一齊出現。
錯誤畫面連 tab 標題都冇，淨係一張「死咗嘅網頁」圖，唔會講係邊樣錯。
頁面本身唔係公開嘅 static file：`/` rewrite 去 `api/app.js`，對過 key 先至回傳 HTML。
每次讀寫 Sheet 都 POST 去 `api/sheets.js`，佢會再 check 一次條 key 有冇剔嗰個 app，
而且每個 `app` 只可以掂自己嗰個 Sheet，只准 `updateCells`／`appendCells`／`deleteDimension` 三種寫入（同 Artifact 版一樣）。

**舊嘅共用密碼**（`STOCK_KEY`／`GROUPBUY_KEY`）暫時仲用得，等大家轉晒自己條 key 之後，
喺 Vercel 刪走呢兩個環境變數就完全停用。

**App icon**：倉庫係橙色底＋貨架同紙箱，團購係綠色底＋打咗剔嘅購物袋（顏色跟返兩個 app 嘅主色）。
喺手機「加入主畫面」會用呢兩個 icon，捷徑會記住條連結（連 `?app=` 同自己條 `?key=`）。
Source 喺 [`artifacts/icons/make-icons.mjs`](artifacts/icons/make-icons.mjs)，改完行
`node artifacts/icons/make-icons.mjs` 重出 `public/icons/`（要 Playwright，所以 PNG 係 commit 咗入 repo）。
錯誤畫面唔會用任何 icon。

**Vercel 設定**

1. Import 呢個 repo，Root Directory 用 repo 根目錄（`vercel.json` 已經設好 install／build）。
2. 開一張新 Google Sheet 做**鑰匙簿**（例如叫「鑰匙簿 - Demo Co.」），
   **只** share 畀 service account（編輯者），唔好 share 畀同事。
3. Environment Variables：
   - `GOOGLE_SERVICE_ACCOUNT_JSON` — Google Cloud service account 嘅 JSON key 成個貼入去
     （要開 Google Sheets API）。或者分開用 `GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY`。
   - `ACCESS_SHEET_ID` — 鑰匙簿嘅 Sheet ID（網址 `/d/` 同 `/edit` 中間嗰串）。冇設 = 冇人用得自己條 key。
   - `NOTIFY_EMAIL` — 有新申請就 email 去呢度。
   - `RESEND_API_KEY` — 用 [Resend](https://resend.com) 寄 email（免費 plan 夠用）。
     用**同 `NOTIFY_EMAIL` 一樣嘅 email** 註冊 Resend，就可以直接用預設寄件人 `onboarding@resend.dev`；
     如果喺 Resend 驗證咗自己個域名，可以加 `NOTIFY_FROM`（例如 `鑰匙簿 <keys@你個域名>`）。
     冇設呢兩個就唔寄 email，申請照樣會入鑰匙簿；email 寄唔到都唔會影響申請。
   - （過渡用，可以唔設）`STOCK_KEY`／`GROUPBUY_KEY` — 舊嘅共用密碼。
4. 喺倉庫同團購兩個 Google Sheet 撳「共用」，加 service account 個 email 做**編輯者**。
5. Deploy 完，開一次 `https://<你個域名>/?invite=x`（會見到死網頁，正常）——鑰匙簿就會自動開好
   「鑰匙」同「設定」兩個 tab。去「設定」抄返你要嘅邀請碼，砌好邀請連結。

**本機試**

```bash
npm --prefix artifacts ci --legacy-peer-deps
npm run build                                  # → api/_pages.js（唔 commit）
ACCESS_SHEET_ID=… GOOGLE_SERVICE_ACCOUNT_JSON="$(cat sa.json)" npm run dev   # http://localhost:3000/?invite=…
node artifacts/test/web_e2e.mjs                # 假 Google + 假 email，測 key 關卡、兩個 app、分 app 邀請／批准／停用
```

## 倉庫存貨（`artifacts/warehouse/`）

**Sheet 結構**（排位已經定死，唔會再改）：

- 主 tab `Sheet1`，13 欄：A 貨品編號（**Key**）· B 來源貨單 · C 英文名 · D 中文名 ·
  E 包裝/規格 · F 條碼 · G 數量 · H 單位 · I 儲存 · J 低存量提示 · K 備註 ·
  L 最後更新 · M 貨架狀態
- `出入記錄` tab：ID／日期／貨品ID（存 貨品編號）／貨品／變動／種類／備註，只 append
- `Space 更新狀態` tab：最尾一版，有手寫嘅交接文件，見下面規則

**功能**

- 貨品清單（list view）：搜尋分兩格（左邊淨係數字編號 Key；右邊搵名／條碼／備註）、
  每件貨可以打開睇自己嘅出入記錄、**掃碼**（Artifact 入面開唔到即時相機，用影相／揀相解碼）、位置 × 狀態兩行 filter（AND）
- 位置：冷凍 1F／冷凍 2F／冷凍（未定）／未分類（乾貨、新鮮喺 form 同 filter 收埋，
  數據層仲支援）；全部 view 按儲存分組，可收埋
- 新增／編輯／刪除貨品；入貨／出貨／直接改數量（每次改數量都 append 一行出入記錄）
- **補貨架**標記同 **已補好**：純狀態轉換，**唔扣數**
- **多選**批量操作：儲存位置、貨架狀態、入貨／出貨、單位、低存量提示、刪除
- 出入記錄可以編輯（數量、種類、備註）；改數量差額會同步調整貨品庫存
- 「出入記錄」tab 撳貨品名，會打開嗰件貨嘅出入記錄詳細（同存貨 tab 用同一個 popup）
- 低存量提示：`quantity <= low_stock`（0 都算）；貨品 0 件顯示缺貨

**唔好改嘅規則**

- 永遠用 **A 欄 貨品編號**搵行，唔用行數、唔用 ID；每次寫之前重讀一次 Sheet。
- 貨品編號係 7 個字，或者 `TMP-001` 呢種臨時代號；留空會自動派下一個 TMP；
  唔啱長度就唔儲存。條碼可以重複。
- 數量永遠唔可以變負數（包括批量同改出入記錄）。
- 補貨架／已補好只轉 M 欄狀態，唔掂數量、唔寫出入記錄；數量要另外入貨／出貨。
- 批量寫入一定要**一次 `batchUpdate`**（唔好逐行寫）。
- 新貨預設儲存係 `unclassified`，1F／2F 一律人手判斷（自動分類已經刪咗）。
- 「Space 更新狀態」tab：**淨係**更新「最後更新時間」同「貨品總數」兩行（喺原位寫
  B 欄），絕對唔可以成版覆蓋或者刪行——上面手寫交接內容要原封不動。

## 團購記錄（`artifacts/groupbuy/`）

**Sheet 結構**：每個星期一個 tab，tab 名係嗰個星期一嘅日期（例如 `2026-11-23`），
第 1 行係凍結 header：

| A 訂單編號 | B 姓名 | C 客人備註 | D 貨品 | E 數量 | F 單位 | G 備註 | H 已領取 | I 領取日期時間 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

一張單由幾行連續、同一個訂單編號嘅行組成；**H 已領取 checkbox 只放喺每組第一行**。

**功能**

- 星期選擇（新 tab 自動出現，預設最新一週）、已領取進度條、「開 Google Sheet」連結
- 單卡片：姓名、客人備註、貨品同數量；「標記已領取」要**向右掃**拉桿、「改返未領取」要**向左掃**（拉桿由右邊起步）寫 H（同 I）；掃到 93% 以上先生效，短撳或者掃一半都唔會寫
- 兩個搜尋格：窄嘅淨係搵訂單編號（數字鍵盤），闊嘅搵姓名／貨品
- Filter：全部／未領取／已領取、多選貨品（OR）、撳客人名只睇佢所有單；全部疊加，
  轉星期就清除
- 揀咗貨品會顯示「未領取仲有幾多」總數（按單位）
- 「↻ 載入」重新讀 Sheet，載入緊會顯示「載入緊…」

**唔好改嘅規則**

- 寫入前重讀 tab，用**訂單編號**搵該組第一行，只寫嗰行嘅 H／I，唔用記住嘅行數。
- 剔已領取會寫 I = Winnipeg 時間 `YYYY-MM-DD HH:mm`，改返未領取會清走 I。
- Winnipeg 時間用**固定 UTC−5**（Manitoba 由 2026-11-01 起長期用夏令時間），**
- 每張單嘅資料只喺 Sheet 度，唔會寫任何本地資料。

## 改嘢之前

1. 改 Sheet 欄位排位（尤其倉庫 A:M）會令讀寫錯欄；兩個都有 header 檢查（倉庫 A1 要係「貨品編號」），
   排位唔啱會直接拒絕寫入，唔會亂寫。
2. 唔好將 Sheet 入面嘅私人數據、token 或者 key commit 入 repo。
