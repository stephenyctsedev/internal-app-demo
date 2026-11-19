// POST /api/adjust { code, delta, kind?, note? } — in/out stock.
// Re-reads, finds row by code, blocks a resulting negative qty, writes
// qty (G) + 最後更新 (L) only, appends one 出入記錄 row.
// Always requires a session (both auth modes).
const { requireAuth, readJsonBody } = require('./_lib/auth');
const lib = require('./_lib/sheets');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    if (!requireAuth(req, res)) return;
    const body = await readJsonBody(req);
    const code = String(body.code || '').trim();
    const delta = Number(body.delta);
    if (!code) return res.status(400).json({ ok: false, error: 'missing_code' });
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ ok: false, error: 'invalid_delta', message: '變動數量唔可以係 0' });
    }
    const items = await lib.listItems(); // re-read before every write
    const found = items.find((it) => it.code === code);
    if (!found) return res.status(404).json({ ok: false, error: 'not_found', message: `搵唔到 ${code}` });
    const newQty = found.qty + delta;
    if (newQty < 0) {
      return res.status(400).json({ ok: false, error: 'negative_qty', message: `數量唔可以變負數（而家 ${found.qty}，想減 ${-delta}）` });
    }
    const kind = String(body.kind || (delta > 0 ? 'in' : 'out')).trim();
    const sheets = lib.getSheetsClient();
    const row = found._row;
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: lib.SHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `${lib.ITEMS_SHEET}!G${row}`, values: [[String(newQty)]] },
          { range: `${lib.ITEMS_SHEET}!L${row}`, values: [[lib.winnipegNow()]] },
        ],
      },
    });
    await lib.appendMovement({ code, name: lib.displayName(found), delta, kind, note: body.note || '' });
    await lib.updateStatusTabBestEffort(items.length);
    return res.status(200).json({ ok: true, code, qty: newQty });
  } catch (e) {
    console.error('adjust error:', e);
    return res.status(502).json({ ok: false, error: 'sheet_unreachable', message: '寫唔到 Google Sheet' });
  }
};
