# Claude Artifact 版本（倉庫存貨 · 團購記錄）

[English](README.md) · **中文**

這個資料夾存放兩個 Space 的 **Claude Artifact 版本**（功能、介面、Google Sheet 都與原本的 Muse 版相同），
供人在 claude.ai 內使用。原本的 Muse 版本（`warehouse-space/`、`group-buy-space/`）已經移除，
仍然保留在 git 歷史中。

| Artifact | 資料夾 | Google Sheet |
| --- | --- | --- |
| 倉庫存貨 | [`warehouse/`](warehouse/) | 「倉庫存貨 - Demo Co.」 |
| 團購記錄 | [`groupbuy/`](groupbuy/) | 「團購記錄 - Demo Co.」 |

## 與原本 Muse 版本的分別

- 沒有伺服器：Artifact 頁面透過 `mcp` capability 直接呼叫**使用者自己的 claude.ai Google Sheets connector**
  （只使用 `get_values`、`get_spreadsheet`、`update_spreadsheet` 三個工具）。第一次打開時會要求你允許。
- 所有寫入都是**一個 `batchUpdate`**（`updateCells` / `appendCells` / `deleteDimension`），只寫入有改動的儲存格，
  文字以 `stringValue` 儲存，所以條碼開頭的 0 不會消失。
- 規則不變：用 A 欄貨品編號 Key／訂單編號找行、寫入前重新讀取、數量不會變成負數、補貨架是純狀態轉換、
  「Space 更新狀態」只更新兩行。完整規則見上一層的 [README](../README.zh-HK.md)。
- 條碼掃描：Artifact 內無法開啟即時相機，所以改用「拍照／選取相片掃碼」。
- 倉庫存貨之後新增了：兩個搜尋格（左邊只搜數字貨品編號 Key；右邊搜名稱／條碼／備註）、每件貨品可打開查看自己的出入記錄。

## Build

```bash
cd artifacts
npm install --legacy-peer-deps
node build.mjs warehouse "倉庫存貨"   # → dist/warehouse.html（單一 HTML 檔）
node build.mjs groupbuy  "團購記錄"   # → dist/groupbuy.html
npx tsc -p tsconfig.json              # 型別檢查
```

產生的 `dist/*.html` 就是整個 Artifact（JS + CSS 全部 inline）。發佈時要宣告 capability：

```json
{ "mcp": { "servers": [ { "server": "Google Sheets",
  "tools": ["get_values", "get_spreadsheet", "update_spreadsheet"] } ] } }
```

## 測試

`test/mock.js` 是一個假的 Google Sheets connector（Sheet 存放在記憶體中），用 Playwright 打開 `dist/*.html`
執行介面操作流程，再檢查寫入 Sheet 的儲存格：

```bash
pip install playwright && playwright install chromium
cd test && python3 run_gb.py && python3 run_wh.py && python3 run_wh2.py
```
