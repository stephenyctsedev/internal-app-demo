# 團購記錄 Space

A Muse TypeScript web Space (slug `tuan-gou-ji-lu`) — the pickup counter for the
weekly Demo Co. group buy. It is built, audited and shipped only through
the web-artifact tools; do not `bun run build` from here.

## Data source — direct mode, no local copy

Google Sheet「團購記錄 - Demo Co.」is the database. The Sheet ID is in
`server/src/actions.ts` (same pattern as the warehouse Space in `space/`).
Every read hits the Sheet live; the only writes are on the first row of an
order group: column H 已領取 (TRUE/FALSE) and column I 領取日期時間
(Winnipeg `YYYY-MM-DD HH:mm`, cleared again when an order is marked back to
not picked up). No credentials live in this folder — auth stays in the
Google Workspace CLI on the host.

Sheet layout — one tab per week, named by that week's Monday date
(e.g. `2026-11-23`); row 1 is the frozen header:

| A 訂單編號 | B 姓名 | C 客人備註 | D 貨品 | E 數量 | F 單位 | G 備註 | H 已領取 | I 領取日期時間 |
|---|---|---|---|---|---|---|---|---|

One order spans several consecutive rows sharing the same 訂單編號; the H
checkbox exists only on the group's first row.

## Features

- Week picker (newest week first, new tabs appear automatically) and a
  picked-up progress bar with an 「開 Google Sheet」link.
- Order cards grouped by 訂單編號 with name, customer note, item lines and
  quantities; 「標記已領取」/「改返未領取」writes H (+ I) on the group's
  first row, found by 訂單編號 after a fresh read. Picked-up cards show
  「領取時間：…」.
- Two search inputs side by side: a narrow one for 訂單編號 only (numeric
  keyboard), and a wider one for 姓名／貨品.
- Filters: 全部／未領取／已領取, a multi-select product filter (tap a product
  name on a card or use the 「按貨品篩選」panel; OR across selected products),
  and a customer filter (tap a name on a card to show only that customer's
  orders, exact name match). All stack together; switching week clears them.
- When products are selected, a summary panel shows each selected product's
  still-unpicked total quantity (未領取 orders only, by unit).
- The 「↻ 載入」button refetches the week list and current week, showing
  「載入緊…」 and disabling while in flight.

See `DATA-PLAN.md` for the full data plan and change history.

## Layout

- `client/` — React client (`src/App.tsx` is the whole UI).
- `server/src/actions.ts` — `listWeeks`, `getWeek`, `setPickedUp`.
- `server/src/privileged.ts` — host handlers shelling out to `hatch_gws_cli`.
- `drizzle/` — scaffold migrations only; the Space stores nothing locally.
