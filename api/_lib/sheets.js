// Google Sheets access for Demo stock app.
// Single source of truth: the Google Sheet "倉庫存貨 - Demo Co.".
// Critical rules (from past incidents — do not relax them):
//  - ALWAYS match rows by column A 貨品編號, NEVER by row number.
//  - Re-read the Sheet before EVERY write.
//  - Qty must never go negative.
//  - When editing an item, ALWAYS send the explicit current code even if
//    unchanged (omitting it once auto-changed codes to TMP-024/TMP-025).
//  - Barcodes may duplicate — never flag them as errors.
//  - New items default to 冷凍 1F unless Stephen says otherwise.
const { google } = require('googleapis');

const DEFAULT_SHEET_ID = 'DEMO_WAREHOUSE_SHEET_ID';
const SHEET_ID = process.env.SHEET_ID || DEFAULT_SHEET_ID;

const ITEMS_RANGE = 'Sheet1!A:M';
const ITEMS_SHEET = 'Sheet1';
const MOVEMENTS_RANGE = '出入記錄!A:G';
const MOVEMENTS_SHEET = '出入記錄';
const STATUS_SHEET = 'Space 更新狀態';

let sheetsClient = null;

function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  let auth;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  } else if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    const creds = {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
    auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  } else {
    throw new Error('Google service account not configured: set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY');
  }
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

async function readValues(range) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  return res.data.values || [];
}

function toNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Normalise the old shelf values to the current two states.
function normaliseShelf(v) {
  const s = String(v || '').trim();
  if (s === '補貨架' || s === '要補貨' || s === '貨架空' || s === 'need_refill') return '補貨架';
  return 'ok';
}

function rowToItem(row, rowNumber) {
  const r = row || [];
  const qty = toNumber(r[6]);
  return {
    code: String(r[0] || '').trim(),          // A 貨品編號 — the unique key
    source: String(r[1] || '').trim(),        // B 來源貨單
    enName: String(r[2] || '').trim(),        // C 英文名
    zhName: String(r[3] || '').trim(),        // D 中文名
    packing: String(r[4] || '').trim(),       // E 包裝/規格
    barcode: String(r[5] || '').trim(),       // F 條碼 (may duplicate)
    qty: qty === null ? 0 : qty,              // G 數量 (decimals allowed)
    unit: String(r[7] || '').trim(),          // H 單位
    storage: String(r[8] || '').trim(),       // I 儲存
    lowStock: toNumber(r[9]),                 // J 低存量提示
    remark: String(r[10] || '').trim(),       // K 備註
    lastUpdated: String(r[11] || '').trim(),  // L 最後更新
    shelfStatus: normaliseShelf(r[12]),       // M 貨架狀態 ok / 補貨架
    _row: rowNumber, // sheet row number, for debugging only — never match on this
  };
}

function itemToRow(item) {
  // Columns A-M, frozen order — do not reorder.
  return [
    item.code || '',
    item.source || '',
    item.enName || '',
    item.zhName || '',
    item.packing || '',
    item.barcode || '',
    item.qty === undefined || item.qty === null ? '' : String(item.qty),
    item.unit || '',
    item.storage || '冷凍 1F',
    item.lowStock === undefined || item.lowStock === null || item.lowStock === '' ? '' : String(item.lowStock),
    item.remark || '',
    item.lastUpdated || '',
    item.shelfStatus || 'ok',
  ];
}

function winnipegNow() {
  return new Date().toLocaleString('en-CA', {
    timeZone: 'America/Winnipeg', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

async function listItems() {
  const values = await readValues(ITEMS_RANGE);
  // Row 1 is the frozen header.
  const items = [];
  for (let i = 1; i < values.length; i++) {
    const item = rowToItem(values[i], i + 1);
    if (!item.code && !item.zhName && !item.enName) continue; // skip blank rows
    items.push(item);
  }
  return items;
}

function nextTmpCode(items) {
  let max = 0;
  for (const it of items) {
    const m = /^TMP-(\d+)$/.exec(it.code || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `TMP-${String(max + 1).padStart(3, '0')}`;
}

function displayName(item) {
  return item.zhName || item.enName || item.code;
}

async function appendMovement({ code, name, delta, kind, note }) {
  const sheets = getSheetsClient();
  const id = `M${Date.now()}`;
  const date = winnipegNow();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: MOVEMENTS_RANGE,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[id, date, code, name, String(delta), kind, note || '']] },
  });
  return id;
}

async function updateStatusTabBestEffort(total) {
  // Best-effort only: never fail a write because this fails, and never
  // overwrite the handover text on the status tab — only the two live rows.
  try {
    const sheets = getSheetsClient();
    const values = await readValues(`${STATUS_SHEET}!A:B`);
    const now = winnipegNow();
    const updates = [];
    values.forEach((row, i) => {
      const label = String(row[0] || '').trim();
      if (label === '最後更新時間') updates.push({ range: `${STATUS_SHEET}!B${i + 1}`, values: [[now]] });
      if (label === '貨品總數') updates.push({ range: `${STATUS_SHEET}!B${i + 1}`, values: [[String(total)]] });
    });
    for (const u of updates) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: u.range,
        valueInputOption: 'USER_ENTERED', requestBody: { values: u.values },
      });
    }
  } catch (e) {
    console.error('status tab update failed (best-effort, ignored):', e.message);
  }
}

async function listMovements(code) {
  const values = await readValues(MOVEMENTS_RANGE);
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i] || [];
    if (!r[0] && !r[2]) continue;
    out.push({
      id: String(r[0] || '').trim(),
      date: String(r[1] || '').trim(),
      code: String(r[2] || '').trim(),
      name: String(r[3] || '').trim(),
      delta: toNumber(r[4]) ?? 0,
      kind: String(r[5] || '').trim(),
      note: String(r[6] || '').trim(),
      _row: i + 1,
    });
  }
  const filtered = code ? out.filter((m) => m.code === code) : out;
  return filtered.reverse(); // newest first
}

module.exports = {
  SHEET_ID,
  getSheetsClient,
  readValues,
  toNumber,
  normaliseShelf,
  rowToItem,
  itemToRow,
  winnipegNow,
  listItems,
  nextTmpCode,
  displayName,
  appendMovement,
  updateStatusTabBestEffort,
  listMovements,
  ITEMS_RANGE,
  ITEMS_SHEET,
  MOVEMENTS_RANGE,
  MOVEMENTS_SHEET,
  STATUS_SHEET,
};
