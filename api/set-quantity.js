// POST /api/set-quantity { code, qty, note? } — stocktake correction.
// Sets the on-hand qty directly; the difference is logged to 出入記錄
// as a 盤點調整 (kind=adjust) movement. Blocks negative qty.
// Always requires a session (both auth modes).
const { requireAuth, readJsonBody } = require('./_lib/auth');
const lib = require('./_lib/sheets');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    if (!requireAuth(req, res)) return;
    const body = await readJsonBody(req);
    const code = String(body.code || '').trim();
    const qty = Number(body.qty);
    if (!code) return res.status(400).json({ ok: false, error: 'missing_code' });
    if (!Number.isFinite(qty) || qty < 0) {
      return res.status(400).json({ ok: false, error: 'invalid_qty', message: '數量唔可以係負數' });
    }
    const items = await lib.listItems(); // re-read before every write
    const found = items.find((it) => it.code === code);
    if (!found) return res.status(404).json({ ok: false, error: 'not_found', message: `搵唔到 ${code}` });
    const diff = qty - found.qty;
    const sheets = lib.getSheetsClient();
    const row = found._row;
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: lib.SHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `${lib.ITEMS_SHEET}!G${row}`, values: [[String(qty)]] },
          { range: `${lib.ITEMS_SHEET}!L${row}`, values: [[lib.winnipegNow()]] },
        ],
      },
    });
    if (diff !== 0) {
      await lib.appendMovement({ code, name: lib.displayName(found), delta: diff, kind: 'adjust', note: body.note || '盤點調整' });
    }
    await lib.updateStatusTabBestEffort(items.length);
    return res.status(200).json({ ok: true, code, qty });
  } catch (e) {
    console.error('set-quantity error:', e);
    return res.status(502).json({ ok: false, error: 'sheet_unreachable', message: '寫唔到 Google Sheet' });
  }
};
