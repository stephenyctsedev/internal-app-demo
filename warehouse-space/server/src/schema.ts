// Drizzle schema for the warehouse inventory artifact.
//
// items: one row per stocked SKU (transcribed from the user's delivery
// orders, or added by hand). quantity is the current on-hand count in the
// item's stock unit (Case / Pack / 個).
// movements: append-only log of every quantity change (initial / in / out /
// adjust) so stock history is preserved.

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const items = sqliteTable("items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  nameEn: text("name_en").notNull(),
  nameZh: text("name_zh").notNull().default(""),
  packing: text("packing").notNull().default(""),
  stockCode: text("stock_code").notNull().default(""),
  barcode: text("barcode").notNull().default(""),
  unit: text("unit", { enum: ["Case", "Pack", "Box", "KG", "個"] })
    .notNull()
    .default("Case"),
  quantity: real("quantity").notNull().default(0),
  storage: text("storage", {
    enum: ["frozen", "dry", "fresh", "unclassified"],
  })
    .notNull()
    .default("frozen"),
  lowStock: real("low_stock"),
  // Shelf state (user, 2026-11-18: 「見到貨架空，mark 低佢要喺貨倉度拎
  // 出嚟加貨」): "ok" = shelf stocked / nothing to do; "shelf_empty" =
  // the shop shelf was seen empty; "need_refill" = marked to be pulled
  // from the warehouse to refill the shelf. Independent of `quantity`
  // (the warehouse count) — an item can have warehouse stock and still
  // have an empty shelf. Synced to the Sheet as column N (貨架狀態).
  shelfStatus: text("shelf_status", {
    enum: ["ok", "shelf_empty", "need_refill"],
  })
    .notNull()
    .default("ok"),
  // 1 when this row has local changes not yet confirmed written to the
  // Google Sheet; the two-way sync keeps dirty rows (Space wins) and pushes
  // them instead of letting a Sheet pull overwrite or delete them.
  sheetDirty: integer("sheet_dirty").notNull().default(0),
  sourceRef: text("source_ref").notNull().default(""),
  notes: text("notes").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Key/value state for the Google Sheets two-way sync (e.g. the tombstone
// list of item IDs deleted in the Space whose Sheet rows still need
// removing). Not user data — sync bookkeeping only.
export const syncMeta = sqliteTable("sync_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default(""),
});

export const movements = sqliteTable("movements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  itemId: integer("item_id")
    .notNull()
    .references(() => items.id),
  delta: real("delta").notNull(),
  kind: text("kind", { enum: ["initial", "in", "out", "adjust"] }).notNull(),
  note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
