# Internal App Demo — 兩個 Muse Space

呢個 repo 放 Demo Co. 倉庫同團購兩個 Muse TypeScript Space 嘅 source：

| Space | 資料夾 | slug | 做咩用 | 資料來源（Google Sheet） |
| --- | --- | --- | --- | --- |
| **倉庫存貨** | [`warehouse-space/`](warehouse-space/) | `cang-ku-cun-huo` | 倉庫庫存：睇貨、入貨／出貨、盤點、補貨架標記、出入記錄 | 「倉庫存貨 - Demo Co.」 |
| **團購記錄** | [`group-buy-space/`](group-buy-space/) | `tuan-gou-ji-lu` | 每星期團購取貨櫃檯：搵單、剔「已領取」 | 「團購記錄 - Demo Co.」 |

兩個 Space 都係**直連模式（direct mode）**：Google Sheet 就係資料庫，Space冇本地副本、冇同步。每次讀寫都即時搵 Sheet；連唔到 Sheet 就直接報錯，唔會fallback 去本機。同事喺 Sheet 度直接改嘢，Space 下次載入就睇到。


> **Claude Artifact 版本**：兩個 Space 都有一份喺 claude.ai 入面行嘅 Artifact 版本，source 喺 [`artifacts/`](artifacts/)（見裡面 README）。

## 點樣運作

```text
瀏覽器 ──► Space client (React)
              │  server actions (zod 驗證)
              ▼
         Space server ──► privileged handlers ──► hatch_gws_cli ──► Google Sheets
```

- **Client**：React 19 + TanStack Query + Tailwind，`client/src/App.tsx` 係成個 UI。
- **Server**：`server/src/actions.ts` 放所有 action；`server/src/privileged.ts`
  係唯一會 call `/opt/hatch/bin/hatch_gws_cli` 嘅地方。
- **認證**：repo 入面冇任何 credentials。Google 登入由 host 上面嘅 Google
  Workspace CLI 處理（用 host 上面已連接嘅 Google 帳戶），所以兩個 Space 都唔使
  密碼同 key。
- **`drizzle/`**：Muse scaffold 留低嘅 migration，**兩個 Space 而家都冇用本地
  資料庫**（倉庫 Space 舊嘅 `items`／`movements`／`sync_meta` 表仲喺，但冇 action
  讀寫）。

## 點樣 build／deploy（重要）

兩個 Space 都只可以經 Muse 嘅 **web-artifact tools** build、audit、ship。

- ❌ 唔好喺度行 `bun run build`——佢唔會 publish。
- ❌ 唔好手改 `~/workspace/ts-spaces/<slug>/.space-build/` 入面嘅 bundle。
- ❌ 唔好用 sqlite 或者 script 直接掂 `app.db`。
- ✅ 要改嘢：喺 Muse 揾 builder，描述想改乜（佢會跟返 `AGENTS.md`）。
- ✅ 本地可以行 `bun run typecheck`（client + server 兩邊 `tsc --noEmit`）。

每個資料夾嘅 `AGENTS.md` 係俾 AI／builder 睇嘅規則；`DATA-PLAN.md` 係**完整嘅
資料設計同改動歷史**（每次改動點解、點改、邊度冇郁），改行為之前請先睇。

## 倉庫存貨 Space（`warehouse-space/`）

**Sheet 結構**（排位已經定死，唔會再改）：

- 主 tab `Sheet1`，13 欄：A 貨品編號（**Key**）· B 來源貨單 · C 英文名 · D 中文名 ·
  E 包裝/規格 · F 條碼 · G 數量 · H 單位 · I 儲存 · J 低存量提示 · K 備註 ·
  L 最後更新 · M 貨架狀態
- `出入記錄` tab：ID／日期／貨品ID（存 貨品編號）／貨品／變動／種類／備註，只 append
- `Space 更新狀態` tab：最尾一版，有手寫嘅交接文件，見下面規則

**功能**

- 貨品清單（list view）：搜尋（名／編號／條碼）、**掃碼**（相機，用 `BarcodeDetector`，
  冇就用 ZXing；亦可以影相解碼）、位置 × 狀態兩行 filter（AND）
- 位置：冷凍 1F／冷凍 2F／冷凍（未定）／未分類（乾貨、新鮮喺 form 同 filter 收埋，
  數據層仲支援）；全部 view 按儲存分組，可收埋
- 新增／編輯／刪除貨品；入貨／出貨／直接改數量（每次改數量都 append 一行出入記錄）
- **補貨架**標記同 **已補好**：純狀態轉換，**唔扣數**
- **多選**批量操作：儲存位置、貨架狀態、入貨／出貨、單位、低存量提示、刪除
- 出入記錄可以編輯（數量、種類、備註）；改數量差額會同步調整貨品庫存
- 低存量提示：`quantity <= low_stock`（0 都算）；貨品 0 件顯示缺貨

**唔好改嘅規則**（詳情喺 `DATA-PLAN.md`）

- 永遠用 **A 欄 貨品編號**搵行，唔用行數、唔用 ID；每次寫之前重讀一次 Sheet。
- 貨品編號係 7 個字，或者 `TMP-001` 呢種臨時代號；留空會自動派下一個 TMP；
  唔啱長度就唔儲存。條碼可以重複。
- 數量永遠唔可以變負數（包括批量同改出入記錄）。
- 補貨架／已補好只轉 M 欄狀態，唔掂數量、唔寫出入記錄；數量要另外入貨／出貨。
- 批量寫入一定要用**成欄一次寫**（唔好逐行 call CLI——每次約 1.7 秒，會 timeout）。
- 新貨預設儲存係 `unclassified`，1F／2F 一律人手判斷（自動分類已經刪咗）。
- 「Space 更新狀態」tab：**淨係**更新「最後更新時間」同「貨品總數」兩行（喺原位寫
  B 欄），絕對唔可以成版覆蓋或者刪行——上面手寫交接內容要原封不動。

## 團購記錄 Space（`group-buy-space/`）

**Sheet 結構**：每個星期一個 tab，tab 名係嗰個星期一嘅日期（例如 `2026-11-23`），
第 1 行係凍結 header：

| A 訂單編號 | B 姓名 | C 客人備註 | D 貨品 | E 數量 | F 單位 | G 備註 | H 已領取 | I 領取日期時間 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

一張單由幾行連續、同一個訂單編號嘅行組成；**H 已領取 checkbox 只放喺每組第一行**。

**功能**

- 星期選擇（新 tab 自動出現，預設最新一週）、已領取進度條、「開 Google Sheet」連結
- 單卡片：姓名、客人備註、貨品同數量；「標記已領取」／「改返未領取」寫 H（同 I）
- 兩個搜尋格：窄嘅淨係搵訂單編號（數字鍵盤），闊嘅搵姓名／貨品
- Filter：全部／未領取／已領取、多選貨品（OR）、撳客人名只睇佢所有單；全部疊加，
  轉星期就清除
- 揀咗貨品會顯示「未領取仲有幾多」總數（按單位）
- 「↻ 載入」重新讀 Sheet，載入緊會顯示「載入緊…」

**唔好改嘅規則**

- 寫入前重讀 tab，用**訂單編號**搵該組第一行，只寫嗰行嘅 H／I，唔用記住嘅行數。
- 剔已領取會寫 I = Winnipeg 時間 `YYYY-MM-DD HH:mm`，改返未領取會清走 I。
- Winnipeg 時間用**固定 UTC−5**（Manitoba 由 2026-11-01 起長期用夏令時間），**唔好**用 `America/Winnipeg` 時區名——server runtime 嘅 tz database 仲係舊 DST 規則，會慢一個鐘。喺呢個修正之前已經寫入嘅時間冇改過，仲係慢一個鐘。
- 每張單嘅資料只喺 Sheet 度，Space 唔會寫任何本地資料。

## 目錄結構

```text
warehouse-space/            倉庫存貨 Space（團購記錄 Space 結構一樣）
  AGENTS.md                 俾 builder／AI 嘅規則（唔好手動 build）
  DATA-PLAN.md              資料設計 + 完整改動歷史
  space.json                runtime、slug、名
  package.json  bun.lock    依賴（@hatch/space-sdk 由 host 提供）
  client/
    src/App.tsx             成個 UI
    src/api.ts              action 嘅 client 包裝
    src/BarcodeScanner.tsx  掃碼（只喺倉庫 Space）
    src/theme.css
  server/
    src/actions.ts          所有 server action（直接讀寫 Sheet）
    src/privileged.ts       call hatch_gws_cli 嘅 host handlers
    src/schema.ts           scaffold 留低嘅 schema（直連模式冇用）
    .generated/             自動生成，唔好手改
  drizzle/                  scaffold migrations（冇用）

group-buy-space/            （同上，冇 BarcodeScanner，action 得三個）
```

**Server actions**

- 倉庫存貨：`listItems` · `listMovements` · `updateMovement` · `getSheetStatus` ·
  `refreshSheetStatus` · `adjustQuantity` · `setQuantity` · `setShelfStatus` ·
  `addItem` · `updateItem` · `deleteItem` · `bulkUpdateItems` ·
  `bulkAdjustQuantity` · `bulkDeleteItems`
- 團購記錄：`listWeeks` · `getWeek` · `setPickedUp`

## 改嘢之前

1. 先睇對應資料夾嘅 `DATA-PLAN.md`，尤其係「Rejected approaches」同最近嘅改動。
2. 改 Sheet 欄位排位（尤其倉庫 A:M）會令 action 讀錯欄；兩個 Space 都有 header
   檢查（倉庫 A1 要係「貨品編號」），排位唔啱會直接拒絕寫入，唔會亂寫。
3. 任何新改動都要喺 `DATA-PLAN.md` 加一段（點解改、改咗乜、冇郁乜）。
4. 唔好將 Sheet 入面嘅私人數據、token 或者 key commit 入 repo。

## 已知小問題

- [`group-buy-space/README.md`](group-buy-space/README.md) 話倉庫 Space 喺 `space/`，
  其實資料夾已經改名做 `warehouse-space/`。

---

## English summary

This repo holds two Muse TypeScript Spaces for Demo Co.:

- **`warehouse-space/`** (`cang-ku-cun-huo`) — warehouse stock: items, in/out
  movements, stock-takes, shelf-refill flag, multi-select bulk edits, barcode
  scanning. Backed by the Google Sheet "倉庫存貨 - Demo Co.".
- **`group-buy-space/`** (`tuan-gou-ji-lu`) — weekly group-buy pickup counter:
  find an order, tick 已領取 (with a Winnipeg pickup timestamp). Backed by the
  Google Sheet "團購記錄 - Demo Co." (one tab per week).

Both run in **direct mode**: the Sheet is the database, there is no local copy
and no sync. Reads and writes go through `hatch_gws_cli` on the Muse host, so
the repo holds no credentials. Rows are always located by key (warehouse: 貨品編號
in column A; group buy: 訂單編號) after a fresh read, never by remembered row
position.

Build, audit and ship **only** through Muse's web-artifact tools — don't run
`bun run build` and don't edit the built bundle. `bun run typecheck` is fine
locally. See each folder's `AGENTS.md` for builder rules and `DATA-PLAN.md` for
the full data design and change history. The earlier Vercel + `api/` version of
this repo is gone from the working tree and survives only in git history.
