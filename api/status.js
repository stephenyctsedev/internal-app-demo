// GET /api/status — is the Sheet reachable, how many items, last update.
// Never throws: an unreachable Sheet returns connected:false (direct mode
// has no local fallback to show instead). Read: requireRead.
const { requireRead } = require('./_lib/auth');
const lib = require('./_lib/sheets');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  if (!requireRead(req, res)) return;
  try {
    const items = await lib.listItems();
    let lastUpdated = '';
    try {
      const values = await lib.readValues(`${lib.STATUS_SHEET}!A:B`);
      for (const row of values) {
        if (String(row[0] || '').trim() === '最後更新時間') lastUpdated = String(row[1] || '').trim();
      }
    } catch { /* best-effort */ }
    return res.status(200).json({ ok: true, connected: true, total: items.length, lastUpdated });
  } catch (e) {
    console.error('status error:', e);
    return res.status(200).json({ ok: false, connected: false, total: 0, lastUpdated: '', error: 'sheet_unreachable' });
  }
};
