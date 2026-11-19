// GET /api/movements[?code=...] — newest first.
// Read: requireRead (gate needs session, readonly allows anyone).
const { requireRead } = require('./_lib/auth');
const lib = require('./_lib/sheets');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    if (!requireRead(req, res)) return;
    const url = new URL(req.url, 'http://localhost');
    const code = url.searchParams.get('code') || '';
    const movements = await lib.listMovements(code);
    return res.status(200).json({ ok: true, movements, total: movements.length });
  } catch (e) {
    console.error('movements error:', e);
    return res.status(502).json({ ok: false, error: 'sheet_unreachable', message: '讀唔到 Google Sheet' });
  }
};
