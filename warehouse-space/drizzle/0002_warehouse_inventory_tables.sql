DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en TEXT NOT NULL,
  name_zh TEXT NOT NULL DEFAULT '',
  packing TEXT NOT NULL DEFAULT '',
  stock_code TEXT NOT NULL DEFAULT '',
  barcode TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'Case',
  quantity INTEGER NOT NULL DEFAULT 0,
  storage TEXT NOT NULL DEFAULT 'frozen',
  low_stock INTEGER,
  source_ref TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  delta INTEGER NOT NULL,
  kind TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
