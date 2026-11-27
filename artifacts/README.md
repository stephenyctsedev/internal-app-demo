# Claude Artifact versions (Warehouse Stock · Group Buy Pickup)

**English** · [中文](README.zh-HK.md)

This folder holds the **Claude Artifact versions** of the two Spaces (features, UI and Google Sheets are
the same as the original Muse versions), for use inside claude.ai. The original Muse versions
(`warehouse-space/`, `group-buy-space/`) have been removed; they are still in the git history.

| Artifact | Folder | Google Sheet |
| --- | --- | --- |
| Warehouse Stock (`倉庫存貨`) | [`warehouse/`](warehouse/) | `倉庫存貨 - Demo Co.` |
| Group Buy Pickup (`團購記錄`) | [`groupbuy/`](groupbuy/) | `團購記錄 - Demo Co.` |

## Differences from the original Muse versions

- No server: the Artifact page uses the `mcp` capability to call **the viewer's own claude.ai Google
  Sheets connector** directly (only three tools: `get_values`, `get_spreadsheet`, `update_spreadsheet`).
  The first time it opens, it asks for your permission.
- Every write is **one `batchUpdate`** (`updateCells` / `appendCells` / `deleteDimension`) that writes only
  the changed cells. Text is stored as `stringValue`, so leading zeros in barcodes are kept.
- The rules don't change: find rows by the column A item code / order number, re-read before writing,
  quantities never go negative, shelf refill is a pure status change, and the `Space 更新狀態` tab only
  ever has two rows updated. The full rules are in the top-level [README](../README.md).
- Barcode scanning: an Artifact can't open a live camera, so it scans from a photo taken or picked.
- Added to Warehouse Stock since: two search boxes (left: numeric item code only; right: name / barcode /
  notes), and each item can open its own movement history.

## Build

```bash
cd artifacts
npm install --legacy-peer-deps
node build.mjs warehouse "倉庫存貨"   # → dist/warehouse.html (a single HTML file)
node build.mjs groupbuy  "團購記錄"   # → dist/groupbuy.html
npx tsc -p tsconfig.json              # typecheck
```

The resulting `dist/*.html` is the whole Artifact (all JS and CSS inline). When publishing it, declare the capability:

```json
{ "mcp": { "servers": [ { "server": "Google Sheets",
  "tools": ["get_values", "get_spreadsheet", "update_spreadsheet"] } ] } }
```

## Test

`test/mock.js` is a fake Google Sheets connector (Sheets held in memory). Playwright opens `dist/*.html`,
runs through the UI, then checks the cells that were written to the Sheet:

```bash
pip install playwright && playwright install chromium
cd test && python3 run_gb.py && python3 run_wh.py && python3 run_wh2.py
```
