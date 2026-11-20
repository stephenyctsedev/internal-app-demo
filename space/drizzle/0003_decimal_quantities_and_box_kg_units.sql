PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en TEXT NOT NULL,
  name_zh TEXT NOT NULL DEFAULT '',
  packing TEXT NOT NULL DEFAULT '',
  stock_code TEXT NOT NULL DEFAULT '',
  barcode TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'Case',
  quantity REAL NOT NULL DEFAULT 0,
  storage TEXT NOT NULL DEFAULT 'frozen',
  low_stock REAL,
  source_ref TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
INSERT INTO items_new (id, name_en, name_zh, packing, stock_code, barcode, unit, quantity, storage, low_stock, source_ref, notes, sort_order, created_at, updated_at)
SELECT id, name_en, name_zh, packing, stock_code, barcode, unit, quantity, storage, low_stock, source_ref, notes, sort_order, created_at, updated_at FROM items;
--> statement-breakpoint
DROP TABLE items;
--> statement-breakpoint
ALTER TABLE items_new RENAME TO items;
--> statement-breakpoint
CREATE TABLE movements_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  delta REAL NOT NULL,
  kind TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
INSERT INTO movements_new (id, item_id, delta, kind, note, created_at)
SELECT id, item_id, delta, kind, note, created_at FROM movements;
--> statement-breakpoint
DROP TABLE movements;
--> statement-breakpoint
ALTER TABLE movements_new RENAME TO movements;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
