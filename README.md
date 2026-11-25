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
