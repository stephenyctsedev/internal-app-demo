// PUT /api/update-movement { id, delta, kind, note } — edit one movement.
// Re-reads the 出入記錄, finds the row by movement ID, rewrites that row
// only. When the delta changes, the item's on-hand qty is adjusted by the
// difference; a resulting negative qty is blocked. Always requires a session.
const { requireAuth, readJsonBody } = require('./_lib/auth');
const lib = require('./_lib/sheets');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'PUT' && req.method !== 'PATCH') {
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }
    if (!requireAuth(req, res)) return;
    const body = await readJsonBody(req);
    const id = String(body.id || '').trim();
    const delta = Number(body.delta);
    if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });
    if (!Number.isFinite(delta)) return res.status(400).json({ ok: false, error: 'invalid_delta' });
    const movements = await lib.listMovements(); // re-read (newest first)
    const mv = movements.find((m) => m.id === id);
    if (!mv) return res.status(404).json({ ok: false, error: 'not_found', message: `搵唔到呢筆記錄 ${id}` });
    const items = await lib.listItems();
    const item = items.find((it) => it.code === mv.code);
    const diff = delta - mv.delta;
    if (item && item.qty + diff < 0) {
      return res.status(400).json({ ok: false, error: 'negative_qty', message: '改完之後數量會變負數，唔改得' });
    }
    const sheets = lib.getSheetsClient();
    const kind = String(body.kind || mv.kind).trim();
    const note = String(body.note ?? mv.note);
    await sheets.spreadsheets.values.update({
      spreadsheetId: lib.SHEET_ID, range: `${lib.MOVEMENTS_SHEET}!A${mv._row}:G${mv._row}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[mv.id, mv.date, mv.code, mv.name, String(delta), kind, note]] },
    });
    if (item && diff !== 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: lib.SHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${lib.ITEMS_SHEET}!G${item._row}`, values: [[String(item.qty + diff)]] },
            { range: `${lib.ITEMS_SHEET}!L${item._row}`, values: [[lib.winnipegNow()]] },
          ],
        },
      });
    }
    return res.status(200).json({ ok: true, id, delta, kind });
  } catch (e) {
    console.error('update-movement error:', e);
    return res.status(502).json({ ok: false, error: 'sheet_unreachable', message: '寫唔到 Google Sheet' });
  }
};
