// DELETE /api/delete-item { code } — delete exactly that row.
// Matches by column A code, never by row number. Past movements stay
// in 出入記錄 (append-only history). Always requires a session.
const { requireAuth, readJsonBody } = require('./_lib/auth');
const lib = require('./_lib/sheets');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'DELETE' && req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }
    if (!requireAuth(req, res)) return;
    const body = await readJsonBody(req);
    const code = String(body.code || '').trim();
    if (!code) return res.status(400).json({ ok: false, error: 'missing_code' });
    const items = await lib.listItems(); // re-read before every write
    const found = items.find((it) => it.code === code);
    if (!found) return res.status(404).json({ ok: false, error: 'not_found', message: `搵唔到 ${code}` });
    const sheets = lib.getSheetsClient();
    const meta = await sheets.spreadsheets.get({ spreadsheetId: lib.SHEET_ID });
    const sheetMeta = (meta.data.sheets || []).find((s) => s.properties.title === lib.ITEMS_SHEET);
    if (!sheetMeta) return res.status(502).json({ ok: false, error: 'sheet_unreachable' });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: lib.SHEET_ID,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: { sheetId: sheetMeta.properties.sheetId, dimension: 'ROWS', startIndex: found._row - 1, endIndex: found._row },
          },
        }],
      },
    });
    await lib.updateStatusTabBestEffort(items.length - 1);
    return res.status(200).json({ ok: true, deleted: code });
  } catch (e) {
    console.error('delete-item error:', e);
    return res.status(502).json({ ok: false, error: 'sheet_unreachable', message: '寫唔到 Google Sheet' });
  }
};
