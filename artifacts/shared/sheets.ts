// Google Sheets access for the artifact pages.
//
// The original Muse Spaces talked to Google Sheets through a server-side
// `hatch_gws_cli`. An artifact page has no server, so it calls the viewer's
// own "Google Sheets" claude.ai connector instead (`mcp` capability). All
// reads are live; all writes go through ONE spreadsheets.batchUpdate call
// built from `updateCells` / `appendCells` / `deleteDimension` requests, so
// values are stored exactly as typed (stringValue stays text — a barcode
// with a leading zero is never turned into a number) and a multi-cell
// change lands atomically.

import { t as tr } from "./i18n";

export type Cell = string | number | null;

const SERVER = "Google Sheets";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

declare global {
  interface Window {
    claude?: { use(name: string): Promise<any> };
  }
}

let mcpPromise: Promise<any> | null = null;
function getMcp(): Promise<any> {
  if (!mcpPromise) {
    mcpPromise = (async () => {
      const t0 = Date.now();
      while (!window.claude?.use && Date.now() - t0 < 10000) await sleep(100);
      if (!window.claude?.use) return null;
      return await window.claude.use("mcp");
    })();
  }
  return mcpPromise;
}

function friendly(e: any): string {
  switch (e?.code) {
    case "server_not_connected":
    case "selection_required":
    case "server_not_found":
      return tr("未連接 Google Sheets — 請喺 claude.ai「設定 → Connectors」加入 Google Sheets，再重新載入呢頁。", "Google Sheets isn't connected — add Google Sheets in claude.ai Settings → Connectors, then reload this page.");
    case "needs_reauth":
      return tr("Google Sheets 登入過期 — 請喺 claude.ai「設定 → Connectors」重新連接 Google Sheets。", "Google Sheets sign-in expired — reconnect Google Sheets in claude.ai Settings → Connectors.");
    case "not_in_manifest":
    case "consent_required":
    case "approval_required":
    case "not_granted":
      return tr("未獲准使用 Google Sheets — 請喺彈出嘅提示撳「允許」，然後再試。", "Not allowed to use Google Sheets — tap \"Allow\" in the prompt, then try again.");
    case "blocked_by_policy":
      return tr("你嘅組織唔俾呢個頁面用 Google Sheets。", "Your organization doesn't allow this page to use Google Sheets.");
    case "capability_disabled":
    case "capability_removed":
      return tr("呢個檢視方式用唔到 Google Sheets — 請喺 claude.ai 入面開返呢個頁面。", "Google Sheets isn't available in this view — open this page inside claude.ai.");
    case "server_unavailable":
    case "upstream_error":
      return tr("連唔到 Google Sheet — 而家係直連模式，冇本機副本，連返線先至用到。請檢查網絡再試。", "Can't reach the Google Sheet — this is direct mode with no offline copy, so it only works online. Please check your connection and try again.");
    case "tool_error":
      return tr("Google Sheets 回應錯誤：", "Google Sheets error: ") + String(e?.message ?? "").slice(0, 200);
    default:
      return tr("連唔到 Google Sheet — 而家係直連模式，冇本機副本，連返線先至用到。請檢查網絡再試。", "Can't reach the Google Sheet — this is direct mode with no offline copy, so it only works online. Please check your connection and try again.");
  }
}

function unwrap(result: any): any {
  let p = result?.payload ?? result?.structuredContent;
  if (p === undefined) {
    const text = result?.content?.find?.((b: any) => b?.type === "text")?.text;
    p = text;
  }
  if (typeof p === "string") {
    try {
      p = JSON.parse(p);
    } catch {
      /* keep string */
    }
  }
  // Some tools wrap their answer as {content: {...}}.
  if (p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).length === 1 && "content" in p) {
    p = p.content;
  }
  return p;
}

// --- Web (Vercel) transport ---------------------------------------------------
// The web build (`__WEB__`) has no claude.ai connector: it POSTs each tool call
// to this site's own /api/sheets, which checks ?key= and talks to the Google
// Sheets API with a service account. Same tools, same answer shapes.

function webFriendly(status: number, e: any): string {
  switch (e?.code) {
    case "bad_key":
      return tr("冇權限 — 請用返正確嘅連結再開過呢頁。", "No access — open this page again with the correct link.");
    case "not_configured":
      return tr("伺服器未設定好 Google Sheets（Vercel 環境變數 GOOGLE_SERVICE_ACCOUNT_JSON）。", "The server isn't set up for Google Sheets (Vercel env var GOOGLE_SERVICE_ACCOUNT_JSON).");
    case "no_access":
      return String(e?.message ?? tr("Service account 冇權限開呢個 Google Sheet。", "The service account can't open this Google Sheet."));
    case "read_only":
      return String(e?.message ?? tr("你只有閱讀權限，改唔到 Sheet。", "You have read-only access and can't change the Sheet."));
    case "tool_error":
      return tr("Google Sheets 回應錯誤：", "Google Sheets error: ") + String(e?.message ?? "").slice(0, 200);
    default:
      return status === 401
        ? tr("冇權限 — 請用返正確嘅連結再開過呢頁。", "No access — open this page again with the correct link.")
        : tr("連唔到 Google Sheet — 而家係直連模式，冇本機副本，連返線先至用到。請檢查網絡再試。", "Can't reach the Google Sheet — this is direct mode with no offline copy, so it only works online. Please check your connection and try again.");
  }
}

async function webCall(tool: string, input: unknown, write: boolean): Promise<any> {
  const q = new URLSearchParams(location.search);
  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch("/api/sheets", {
        method: "POST",
        headers: { "content-type": "application/json", "x-app-key": q.get("key") ?? "" },
        body: JSON.stringify({ app: q.get("app") ?? "", tool, input }),
        cache: "no-store",
      });
    } catch {
      if (!write && attempt === 0) {
        attempt += 1;
        await sleep(1200 + Math.random() * 400);
        continue;
      }
      throw new Error(webFriendly(0, null));
    }
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    if (res.ok) return body;
    // Retry only reads, only on rate limits / transient errors, once.
    if (!write && attempt === 0 && (res.status === 429 || res.status >= 500) && body?.error?.code !== "not_configured") {
      attempt += 1;
      await sleep(1200 + Math.random() * 400);
      continue;
    }
    throw new Error(webFriendly(res.status, body?.error));
  }
}

async function rawCall(tool: string, input: unknown, write: boolean): Promise<any> {
  if (__WEB__) return webCall(tool, input, write);
  const mcp = await getMcp();
  if (!mcp) {
    throw new Error(tr("呢個檢視方式用唔到 Google Sheets — 請喺 claude.ai 入面開返呢個頁面。", "Google Sheets isn't available in this view — open this page inside claude.ai."));
  }
  let attempt = 0;
  for (;;) {
    try {
      const res = await mcp.callTool(SERVER, tool, input, { cache: false });
      return unwrap(res);
    } catch (e: any) {
      // Retry only reads, only when the platform says it is safe, once.
      if (!write && e?.retryable && attempt === 0) {
        attempt += 1;
        await sleep((e.retryAfterMs ?? 1200) + Math.random() * 400);
        continue;
      }
      throw new Error(friendly(e));
    }
  }
}

// The first call may open a consent prompt: run it alone, then release the
// rest, so parallel first calls don't fight over that one prompt.
let gate: Promise<unknown> | null = null;
async function call(tool: string, input: unknown, write = false): Promise<any> {
  if (!gate) {
    const p = rawCall(tool, input, write);
    gate = p.catch(() => undefined);
    return p;
  }
  await gate;
  return rawCall(tool, input, write);
}

/** A1 range for a tab, quoted so names with spaces / dashes work. */
export function a1(tab: string, range: string): string {
  return `'${tab.replace(/'/g, "''")}'!${range}`;
}

export async function getValues(spreadsheetId: string, range: string): Promise<string[][]> {
  const p = await call("get_values", { spreadsheetId, range });
  const values = p?.values;
  if (!Array.isArray(values)) return [];
  return values.map((row: unknown) =>
    Array.isArray(row) ? row.map((c) => (c == null ? "" : String(c))) : [],
  );
}

export type Tab = { sheetId: number; title: string };

export async function getTabs(spreadsheetId: string): Promise<Tab[]> {
  const p = await call("get_spreadsheet", {
    spreadsheetId,
    fields: ["sheets.properties.sheetId", "sheets.properties.title"],
  });
  const out: Tab[] = [];
  for (const s of p?.sheets ?? []) {
    const props = s?.properties;
    if (props && typeof props.title === "string" && typeof props.sheetId === "number") {
      out.push({ sheetId: props.sheetId, title: props.title });
    }
  }
  return out;
}

// --- batchUpdate request builders --------------------------------------------

function cellData(v: Cell): Record<string, unknown> {
  if (v === null || v === "") return {}; // empty CellData + fields:userEnteredValue clears the cell
  if (typeof v === "number") return { userEnteredValue: { numberValue: v } };
  return { userEnteredValue: { stringValue: v } };
}

/** Writes a run of cells in one row starting at (1-based row, 0-based col). */
export function writeRow(sheetId: number, row1: number, col0: number, values: Cell[]) {
  return {
    updateCells: {
      start: { sheetId, rowIndex: row1 - 1, columnIndex: col0 },
      rows: [{ values: values.map(cellData) }],
      fields: "userEnteredValue",
    },
  };
}

/** Appends whole rows after the last row with data (grows the grid if needed). */
export function appendRows(sheetId: number, rows: Cell[][]) {
  return {
    appendCells: {
      sheetId,
      rows: rows.map((r) => ({ values: r.map(cellData) })),
      fields: "userEnteredValue",
    },
  };
}

export function deleteRows(sheetId: number, row1: number) {
  return {
    deleteDimension: {
      range: { sheetId, dimension: "ROWS", startIndex: row1 - 1, endIndex: row1 },
    },
  };
}

export async function batchUpdate(spreadsheetId: string, requests: unknown[]): Promise<void> {
  if (requests.length === 0) return;
  await call("update_spreadsheet", { spreadsheetId, requests }, true);
}
