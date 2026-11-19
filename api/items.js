// GET  /api/items -> list all items (requireRead: gate needs session,
//        readonly allows anyone).
// POST /api/items -> add one item (requireAuth in BOTH modes).
const { requireAuth, requireRead, readJsonBody } = require('./_lib/auth');
const lib = require('./_lib/sheets');

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      if (!requireRead(req, res)) return;
      const items = await lib.listItems();
      return res.status(200).json({ ok: true, items, total: items.length });
    }
    if (req.method === 'POST') {
      if (!requireAuth(req, res)) return; // writes always need a session
      const body = await readJsonBody(req);
      const items = await lib.listItems(); // re-read before every write
      let code = String(body.code || '').trim();
      if (!code) code = lib.nextTmpCode(items);
      if (items.some((it) => it.code === code)) {
        return res.status(409).json({ ok: false, error: 'code_exists', message: `貨品編號 ${code} 已經存在` });
      }
      const qty = body.qty === undefined || body.qty === '' ? 0 : Number(body.qty);
      if (!Number.isFinite(qty) || qty < 0) {
        return res.status(400).json({ ok: false, error: 'invalid_qty', message: '數量唔可以係負數' });
      }
      const item = {
        code,
        source: String(body.source || '').trim(),
        enName: String(body.enName || '').trim(),
        zhName: String(body.zhName || '').trim(),
        packing: String(body.packing || '').trim(),
        barcode: String(body.barcode || '').trim(), // may duplicate — never flag
        qty,
        unit: String(body.unit || '').trim(),
        storage: String(body.storage || '冷凍 1F').trim() || '冷凍 1F', // default 1F
        lowStock: body.lowStock === undefined || body.lowStock === '' ? null : Number(body.lowStock),
        remark: String(body.remark || '').trim(),
        lastUpdated: lib.winnipegNow(),
        shelfStatus: lib.normaliseShelf(body.shelfStatus || 'ok'),
      };
      const sheets = lib.getSheetsClient();
      await sheets.spreadsheets.values.append({
        spreadsheetId: lib.SHEET_ID, range: lib.ITEMS_RANGE,
        valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [lib.itemToRow(item)] },
      });
      if (qty > 0) {
        await lib.appendMovement({ code, name: lib.displayName(item), delta: qty, kind: 'initial', note: body.note || '' });
      }
      await lib.updateStatusTabBestEffort(items.length + 1);
      return res.status(201).json({ ok: true, item });
    }
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (e) {
    console.error('items error:', e);
    return res.status(502).json({ ok: false, error: 'sheet_unreachable', message: '讀唔到 Google Sheet，請檢查網絡 / 服務帳戶授權' });
  }
};
