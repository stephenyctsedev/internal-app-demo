# Claude Artifacts 版本（倉庫存貨 · 團購記錄）

呢個資料夾係兩個 Space 嘅 **Claude Artifact 版本**（功能、UI、Google Sheet 都跟返原本 Muse 版），
俾人喺 claude.ai 入面用。原本嘅 Muse 版本（`warehouse-space/`、`group-buy-space/`）已經由呢個 branch 移走，
仍然喺 `muse-space` branch。

| Artifact | 資料夾 | Google Sheet |
| --- | --- | --- |
| 倉庫存貨 | [`warehouse/`](warehouse/) | 「倉庫存貨 - Demo Co.」 |
| 團購記錄 | [`groupbuy/`](groupbuy/) | 「團購記錄 - Demo Co.」 |

## 同原本 Muse 版本嘅分別

- 冇 server：Artifact 頁面透過 `mcp` capability 直接叫**用家自己嘅 claude.ai Google Sheets connector**
  （只用 `get_values`、`get_spreadsheet`、`update_spreadsheet` 三個 tool）。第一次開會問你允許。
- 全部寫入都係**一個 `batchUpdate`**（`updateCells` / `appendCells` / `deleteDimension`），只寫有改嘅儲存格，
  文字用 `stringValue` 存，所以條碼開頭嘅 0 唔會冇。
- 規則唔變：用 A 欄貨品編號 Key／訂單編號搵行、寫之前重讀、數量唔會變負數、補貨架純狀態轉換、
  「Space 更新狀態」淨係更新兩行。完整規則見上一層 [README](../README.md)。
- 條碼掃描：Artifact 入面開唔到即時相機，所以用「影相／揀相掃碼」。
- 倉庫存貨之後加咗：搜尋分兩格（左邊淨係數字編號 Key；右邊搵名／條碼／備註）、每件貨可以打開睇自己嘅出入記錄。

## Build

```bash
cd artifacts
npm install --legacy-peer-deps
node build.mjs warehouse "倉庫存貨"   # → dist/warehouse.html（單一 HTML 檔）
node build.mjs groupbuy  "團購記錄"   # → dist/groupbuy.html
npx tsc -p tsconfig.json              # typecheck
```

出嚟嘅 `dist/*.html` 就係成個 Artifact（JS + CSS 全部 inline）。發佈後要宣告 capability：

```json
{ "mcp": { "servers": [ { "server": "Google Sheets",
  "tools": ["get_values", "get_spreadsheet", "update_spreadsheet"] } ] } }
```

## Test

`test/mock.js` 係一個假 Google Sheets connector（記憶體入面嘅 Sheet），用 Playwright 開 `dist/*.html`
行 UI 流程，再檢查寫咗去 Sheet 嘅儲存格：

```bash
pip install playwright && playwright install chromium
cd test && python3 run_gb.py && python3 run_wh.py && python3 run_wh2.py
```
