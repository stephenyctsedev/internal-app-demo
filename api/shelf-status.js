// POST /api/shelf-status { code, shelfStatus } — ok / 補貨架.
// Writes 貨架狀態 (M) + 最後更新 (L) only. Always requires a session.
const { requireAuth, readJsonBody } = require('./_lib/auth');
const lib = require('./_lib/sheets');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    if (!requireAuth(req, res)) return;
    const body = await readJsonBody(req);
    const code = String(body.code || '').trim();
    const shelfStatus = lib.normaliseShelf(body.shelfStatus);
    if (!code) return res.status(400).json({ ok: false, error: 'missing_code' });
    if (body.shelfStatus !== 'ok' && body.shelfStatus !== '補貨架') {
      return res.status(400).json({ ok: false, error: 'invalid_shelf', message: '貨架狀態只可以係 ok 或者 補貨架' });
    }
    const items = await lib.listItems(); // re-read before every write
    const found = items.find((it) => it.code === code);
    if (!found) return res.status(404).json({ ok: false, error: 'not_found', message: `搵唔到 ${code}` });
    const sheets = lib.getSheetsClient();
    const row = found._row;
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: lib.SHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `${lib.ITEMS_SHEET}!M${row}`, values: [[shelfStatus]] },
          { range: `${lib.ITEMS_SHEET}!L${row}`, values: [[lib.winnipegNow()]] },
        ],
      },
    });
    await lib.updateStatusTabBestEffort(items.length);
    return res.status(200).json({ ok: true, code, shelfStatus });
  } catch (e) {
    console.error('shelf-status error:', e);
    return res.status(502).json({ ok: false, error: 'sheet_unreachable', message: '寫唔到 Google Sheet' });
  }
};
