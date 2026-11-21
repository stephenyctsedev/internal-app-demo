# 倉庫存貨 — Demo Stock

獨立倉庫存貨網頁，後台係同一張 Google Sheet「倉庫存貨 - Demo Co.」，
同 Muse 入面個「倉庫存貨」Space 睇同一份數據。最後會放上 Vercel host。

> ⚠️ GitHub Pages  alone 用唔到呢個 app：登入檢查同讀寫 Sheet 要靠
> Vercel serverless API（`api/`）。個 repo 係 source code，放上 Vercel
> 先至係完整嘅網頁。GitHub Pages 只可以 serve 靜態檔案，跑唔到 API。

## 認證模式 AUTH_MODE（預設一定係 gate）

| 模式 | 未登入 | 入密碼之後 |
| --- | --- | --- |
| `gate`（**預設**） | 乜都睇唔到，只見登入畫面 | 睇得、改得 |
| `readonly`（後備） | 睇得庫存、出入記錄同狀態，改唔得；會見到「入密碼先可以改」掣 | 睇得、改得 |

切換方法：喺 Vercel → Project Settings → Environment Variables 改
`AUTH_MODE` 做 `gate` 或者 `readonly`，再 Redeploy。唔使改 code。

**重點：** 兩種模式之下，所有寫入（加貨、編輯、刪除、入貨/出貨、
盤點、改貨架狀態、改出入記錄）後端都一定要有效 session cookie，
冇 cookie 就回 401。唔係淨係前端收埋個掣。

登入係一個簡單密碼（`APP_PASSWORD`），第一次入要打密碼，登入成功會
set 一個 httpOnly cookie `demo_session`，有效 30 日，所以第二次
入唔使再問密碼。密碼本身唔會存喺 localStorage 或者 cookie 入面。

## 快速上手（Setup）

### 1. 開 Google service account（只需做一次）

1. 去 [Google Cloud Console](https://console.cloud.google.com/) 開一個 project（或者用現有嘅）。
2. Enable **Google Sheets API**。
3. Credentials → Create Credentials → Service account，開一個 service account，
   下載佢嘅 JSON key。
4. 打開 Google Sheet「倉庫存貨 - Demo Co.」，Share 畀呢個 service
   account 嘅 email，權限 **Editor**。如果唔 share，API 會讀唔到個 Sheet。

### 2. 推上 GitHub

```bash
cd demo-stock
git init
git add .
git commit -m "Demo Stock warehouse app"
git branch -M main
git remote add origin https://github.com/stephenyctsedev/demo-stock.git
git push -u origin main
```

（呢個 repo 係 private、本身係空嘅，`main` branch。）

### 3. Vercel → Import Git Repository

1. 去 [Vercel](https://vercel.com/) → Add New → Project → Import
   `stephenyctsedev/demo-stock`。
2. Framework Preset：**Other**（唔使 build step，前端係靜態檔案）。
3. 唔使改 build command。

### 4. 喺 Vercel 設定環境變數

Project Settings → Environment Variables，逐個加（Production + Preview + Development 都加）：

| 變數 | 值 | 必填 |
| --- | --- | --- |
| `SHEET_ID` | `DEMO_WAREHOUSE_SHEET_ID`（code 入面已有呢個 default，唔 set 都得） | 否 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 成個 service account JSON，一行過貼上 | 二揀一 |
| `GOOGLE_CLIENT_EMAIL` | service account email（唔用上面嗰個先用呢個） | 二揀一 |
| `GOOGLE_PRIVATE_KEY` | private key，`\n` 要保留（同 email 一齊用） | 二揀一 |
| `APP_PASSWORD` | 你揀嘅簡單登入密碼 | **是** |
| `SESSION_SECRET` | 長隨機字串，用嚟簽 session cookie（例如 `openssl rand -hex 32`） | **是** |
| `AUTH_MODE` | `gate`（預設，唔 set 都係 gate）或者 `readonly` | 否 |

### 5. Deploy，第一次登入

Deploy 完打開個 Vercel 網址，用 `APP_PASSWORD` 登入一次，之後 30 日唔使再入。

## 檔案結構

```text
index.html      靜態前端（廣東話 UI，手機優先）
styles.css      樣式
app.js          前端邏輯：搜尋、掃碼、雙篩選、編輯、改數量、出入記錄
api/
  _lib/auth.js    登入 / session cookie / AUTH_MODE（gate / readonly）
  _lib/sheets.js  Google Sheets 讀寫（永遠用 A 欄編號搵行、寫之前重讀）
  login.js        POST /api/login
  logout.js       POST /api/logout
  me.js           GET  /api/me → { authenticated, canEdit, authMode }
  items.js        GET  /api/items · POST /api/items（加貨）
  update-item.js  PUT  /api/update-item
  delete-item.js  DELETE /api/delete-item
  adjust.js       POST /api/adjust（入貨 / 出貨）
  set-quantity.js POST /api/set-quantity（盤點）
  shelf-status.js POST /api/shelf-status（ok / 補貨架）
  movements.js    GET  /api/movements[?code=]
  update-movement.js PUT /api/update-movement
  status.js       GET  /api/status
package.json     googleapis dependency
vercel.json      Vercel 設定
.env.example     環境變數範本（得 placeholder，冇真密碼 / key）
```

## 重要規則（唔好改）

- 永遠用 **A 欄 貨品編號**搵行，唔可以用行號；每次寫之前重讀一次 Sheet。
- 數量永遠唔可以變負數，後端會擋。
- 編輯貨品一定要傳返現有編號（`code`），就算冇改過都要傳。
- 條碼可以重複，唔好當錯。
- 新貨預設儲存係 **冷凍 1F**。
- 貨架狀態得兩種：`ok` / `補貨架`（舊嘅 要補貨 / 貨架空 當 補貨架）。
- 補貨架掣只標記唔扣數；撳「已補好」先扣 1，加出貨記錄；0 箱唔扣到負數。
- 「Space 更新狀態」tab 入面嘅交接文字唔好郁，寫入之後只會 best-effort
  更新「最後更新時間」同「貨品總數」兩行。
- 唔好將真密碼、key、token 或者 Sheet 入面嘅私人數據 commit 入 repo。

## 本地測試

```bash
cp .env.example .env   # 填真值（.env 已喺 .gitignore，唔會 commit）
npm install
npx vercel dev         # 或者 npx vercel --prod 部署
```

---

## Setup (English summary)

1. Create a Google Cloud service account, enable the Sheets API, and share
   the Sheet "倉庫存貨 - Demo Co." with the service account email as Editor.
2. Push this repo to `github.com/stephenyctsedev/demo-stock` (private, `main`).
3. Vercel → Import Git Repository, Framework Preset: Other.
4. Set env vars in Vercel: `GOOGLE_SERVICE_ACCOUNT_JSON` (or
   `GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY`), `APP_PASSWORD`,
   `SESSION_SECRET`, optional `SHEET_ID` and `AUTH_MODE=gate` (default).
5. Deploy and log in once with `APP_PASSWORD`; the session cookie lasts 30 days.

GitHub Pages alone cannot run this app — the login check and Sheet
read/write need the Vercel serverless API in `api/`.
