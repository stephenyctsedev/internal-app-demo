// PUT /api/update-item — edit one item. Always requires a session.
// Body MUST include the explicit current `code` even if unchanged, plus
// all fields to save; `newCode` only when the code itself is being changed.
// Matches the row by column A code, never by row number; writes that row only.
const { requireAuth, readJsonBody } = require('./_lib/auth');
const lib = require('./_lib/sheets');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'PUT' && req.method !== 'PATCH') {
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }
    if (!requireAuth(req, res)) return;
    const body = await readJsonBody(req);
    const code = String(body.code || '').trim(); // current code — required, explicit
    if (!code) return res.status(400).json({ ok: false, error: 'missing_code', message: '一定要傳返現有貨品編號' });
    const newCode = String(body.newCode || code).trim();
    const items = await lib.listItems(); // re-read before every write
    const idx = items.findIndex((it) => it.code === code);
    if (idx === -1) return res.status(404).json({ ok: false, error: 'not_found', message: `搵唔到 ${code}` });
    if (newCode !== code && items.some((it) => it.code === newCode)) {
      return res.status(409).json({ ok: false, error: 'code_exists', message: `貨品編號 ${newCode} 已經存在` });
    }
    const qty = body.qty === undefined || body.qty === '' ? items[idx].qty : Number(body.qty);
    if (!Number.isFinite(qty) || qty < 0) {
      return res.status(400).json({ ok: false, error: 'invalid_qty', message: '數量唔可以係負數' });
    }
    const updated = {
      ...items[idx],
      code: newCode,
      source: String(body.source ?? items[idx].source),
      enName: String(body.enName ?? items[idx].enName),
      zhName: String(body.zhName ?? items[idx].zhName),
      packing: String(body.packing ?? items[idx].packing),
      barcode: String(body.barcode ?? items[idx].barcode),
      qty,
      unit: String(body.unit ?? items[idx].unit),
      storage: String(body.storage ?? items[idx].storage),
      lowStock: body.lowStock === undefined || body.lowStock === '' ? items[idx].lowStock : Number(body.lowStock),
      remark: String(body.remark ?? items[idx].remark),
      lastUpdated: lib.winnipegNow(),
      shelfStatus: lib.normaliseShelf(body.shelfStatus ?? items[idx].shelfStatus),
    };
    const sheets = lib.getSheetsClient();
    const row = items[idx]._row;
    await sheets.spreadsheets.values.update({
      spreadsheetId: lib.SHEET_ID, range: `${lib.ITEMS_SHEET}!A${row}:M${row}`,
      valueInputOption: 'USER_ENTERED', requestBody: { values: [lib.itemToRow(updated)] },
    });
    await lib.updateStatusTabBestEffort(items.length);
    return res.status(200).json({ ok: true, item: updated });
  } catch (e) {
    console.error('update-item error:', e);
    return res.status(502).json({ ok: false, error: 'sheet_unreachable', message: '寫唔到 Google Sheet' });
  }
};
