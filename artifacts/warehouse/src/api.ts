// 倉庫存貨 — direct-mode data layer (port of the Space's server actions).
//
// The Google Sheet "倉庫存貨 - Demo Co." IS the database. Every read is
// live; every write re-reads the Sheet first, finds the item's row BY ITS
// 貨品編號 Key in column A (never by a remembered row number — the row is
// only the physical write address after the Key match), and then writes only
// the cells that change, in ONE batchUpdate. There is no local copy and no
// offline fallback: if the Sheet cannot be reached, the call fails clearly.
//
// Sheet layout (FINAL):
//   Sheet1 (items)     A 貨品編號 · B 來源貨單 · C 英文名 · D 中文名 ·
//                      E 包裝/規格 · F 條碼 · G 數量 · H 單位 · I 儲存 ·
//                      J 低存量提示 · K 備註 · L 最後更新 · M 貨架狀態
//   出入記錄 (movements) A ID · B 日期 · C 貨品ID(存貨品編號) · D 貨品 ·
//                      E 變動 · F 種類 · G 備註 — append-only log
//   Space 更新狀態      A 項目 · B 內容 — status + hand-written handover doc;
//                      only the two live rows (最後更新時間 / 貨品總數) are
//                      ever touched, in place. Nothing else is rewritten.
//
// 貨品編號 Key rules: a real code is exactly 7 characters, or a TMP-001,
// TMP-002, … placeholder (allocated by scanning the Sheet's current keys).
// Keys are unique; add/update reject a code another item already uses.

import {
  a1,
  appendRows,
  batchUpdate,
  deleteRows,
  getTabs,
  getValues,
  writeRow,
  type Cell,
  type Tab,
} from "../../shared/sheets";

export const SPREADSHEET_ID = "DEMO_WAREHOUSE_SHEET_ID";
export const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/DEMO_WAREHOUSE_SHEET_ID/edit";
const ITEMS_TAB = "Sheet1";
const MOVEMENTS_TAB = "出入記錄";
const STATUS_TAB = "Space 更新狀態";
const ITEMS_READ_RANGE = a1(ITEMS_TAB, "A1:M2000");
const MOVEMENTS_READ_RANGE = a1(MOVEMENTS_TAB, "A1:G5000");
const MOVEMENT_IDS_RANGE = a1(MOVEMENTS_TAB, "A1:A5000");
const STATUS_READ_RANGE = a1(STATUS_TAB, "A1:B1000");

export type Unit = "Case" | "Pack" | "Box" | "KG" | "個";
export type Storage = "frozen" | "frozen_1f" | "frozen_2f" | "dry" | "fresh" | "unclassified";
export type ShelfStatus = "ok" | "need_refill";
export type MovementKind = "initial" | "in" | "out" | "adjust";

export type Item = {
  /** The Sheet row the item currently sits on — display/address only. */
  id: number;
  row_number: number;
  name_en: string;
  name_zh: string;
  packing: string;
  stock_code: string;
  barcode: string;
  unit: Unit;
  quantity: number;
  storage: Storage;
  low_stock: number | null;
  shelf_status: ShelfStatus;
  source_ref: string;
  notes: string;
  updated_at: string;
};

export type Movement = {
  id: number;
  stock_code: string;
  item_name: string;
  delta: number;
  kind: MovementKind;
  note: string;
  created_at: string;
};

const COL = {
  stockCode: 0,
  sourceRef: 1,
  nameEn: 2,
  nameZh: 3,
  packing: 4,
  barcode: 5,
  quantity: 6,
  unit: 7,
  storage: 8,
  lowStock: 9,
  notes: 10,
  updatedAt: 11,
  shelfStatus: 12,
} as const;

// --- 貨品編號 Key rules -------------------------------------------------------
const isTmpKey = (code: string) => /^TMP-\d{3,}$/.test(code);
const isValidKey = (code: string) => code.length === 7 || isTmpKey(code);
const formatTmpKey = (seq: number) => `TMP-${String(seq).padStart(3, "0")}`;
function nextTmpKey(used: Set<string>): string {
  let seq = 1;
  for (const code of used) {
    if (isTmpKey(code)) {
      const n = Number.parseInt(code.slice(4), 10);
      if (Number.isFinite(n) && n >= seq) seq = n + 1;
    }
  }
  while (used.has(formatTmpKey(seq))) seq += 1;
  return formatTmpKey(seq);
}

// --- Sheet cell parsing -------------------------------------------------------
const STORAGE_FROM_SHEET: Record<string, Storage> = {
  frozen: "frozen",
  "冷凍": "frozen",
  frozen_1f: "frozen_1f",
  "frozen 1f": "frozen_1f",
  "冷凍 1f": "frozen_1f",
  "冷凍1f": "frozen_1f",
  "1f": "frozen_1f",
  frozen_2f: "frozen_2f",
  "frozen 2f": "frozen_2f",
  "冷凍 2f": "frozen_2f",
  "冷凍2f": "frozen_2f",
  "2f": "frozen_2f",
  dry: "dry",
  "乾貨": "dry",
  fresh: "fresh",
  "新鮮": "fresh",
  unclassified: "unclassified",
  "未分類": "unclassified",
};
// What is written back to column I: the two floors use the readable Chinese
// labels; the rest keep their existing English codes (the parser accepts both).
const STORAGE_TO_SHEET: Record<Storage, string> = {
  frozen: "frozen",
  frozen_1f: "冷凍 1F",
  frozen_2f: "冷凍 2F",
  dry: "dry",
  fresh: "fresh",
  unclassified: "unclassified",
};
const UNIT_FROM_SHEET: Record<string, Unit> = {
  case: "Case",
  pack: "Pack",
  box: "Box",
  kg: "KG",
  "箱": "Case",
  "包": "Pack",
  "盒": "Box",
  "公斤": "KG",
  "個": "個",
};
const SHELF_FROM_SHEET: Record<string, ShelfStatus> = {
  ok: "ok",
  "正常": "ok",
  "貨架正常": "ok",
  // Legacy values all read as the single merged need_refill state.
  shelf_empty: "need_refill",
  "貨架空": "need_refill",
  "空": "need_refill",
  need_refill: "need_refill",
  "要補貨": "need_refill",
  "補貨架": "need_refill",
  "待補貨": "need_refill",
};
const SHELF_TO_SHEET: Record<ShelfStatus, string> = { ok: "", need_refill: "補貨架" };
const KIND_FROM_SHEET: Record<string, MovementKind> = {
  initial: "initial",
  "期初": "initial",
  in: "in",
  "入貨": "in",
  out: "out",
  "出貨": "out",
  adjust: "adjust",
  "盤點調整": "adjust",
  "調整": "adjust",
};

const cellAt = (row: string[] | undefined, idx: number) => (row?.[idx] ?? "").trim();
function numCell(row: string[] | undefined, idx: number): number | null {
  const raw = cellAt(row, idx);
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
/** Quantities are written without float noise (0.1 + 0.2 → 0.3). */
const clean = (n: number) => Math.round(n * 1e6) / 1e6;

function assertLayout(headerRow: string[] | undefined): void {
  const a1v = (headerRow?.[COL.stockCode] ?? "").trim();
  if (a1v !== "貨品編號") {
    throw new Error(
      `Sheet 佈局唔啱：A1 而家係「${a1v || "（空白）"}」，唔係「貨品編號」 — 已停手，冇讀冇寫，請先將 Sheet 第一欄改返做貨品編號`,
    );
  }
}

type SheetItem = {
  rowNumber: number;
  /** The raw cells of the row as read (formatted text), for minimal diffs. */
  raw: string[];
  stockCode: string;
  sourceRef: string;
  nameEn: string;
  nameZh: string;
  packing: string;
  barcode: string;
  quantity: number;
  unit: Unit;
  storage: Storage;
  lowStock: number | null;
  notes: string;
  shelfStatus: ShelfStatus;
  updatedAt: string;
};

function parseItems(values: string[][]): SheetItem[] {
  const out: SheetItem[] = [];
  values.forEach((row, i) => {
    if (i === 0) return;
    const nameEn = cellAt(row, COL.nameEn);
    const nameZh = cellAt(row, COL.nameZh);
    if (!nameEn && !nameZh) return;
    out.push({
      rowNumber: i + 1,
      raw: row,
      stockCode: cellAt(row, COL.stockCode),
      sourceRef: cellAt(row, COL.sourceRef),
      nameEn,
      nameZh,
      packing: cellAt(row, COL.packing),
      barcode: cellAt(row, COL.barcode),
      quantity: numCell(row, COL.quantity) ?? 0,
      unit:
        UNIT_FROM_SHEET[cellAt(row, COL.unit).toLowerCase()] ?? UNIT_FROM_SHEET[cellAt(row, COL.unit)] ?? "Case",
      storage:
        STORAGE_FROM_SHEET[cellAt(row, COL.storage).toLowerCase()] ??
        STORAGE_FROM_SHEET[cellAt(row, COL.storage)] ??
        "unclassified",
      lowStock: numCell(row, COL.lowStock),
      notes: cellAt(row, COL.notes),
      shelfStatus:
        SHELF_FROM_SHEET[cellAt(row, COL.shelfStatus).toLowerCase()] ??
        SHELF_FROM_SHEET[cellAt(row, COL.shelfStatus)] ??
        "ok",
      updatedAt: cellAt(row, COL.updatedAt),
    });
  });
  return out;
}

const itemDisplayName = (it: Pick<SheetItem, "nameEn" | "nameZh">) =>
  it.nameZh ? `${it.nameZh} · ${it.nameEn}` : it.nameEn;

function toItem(it: SheetItem): Item {
  return {
    id: it.rowNumber,
    row_number: it.rowNumber,
    name_en: it.nameEn,
    name_zh: it.nameZh,
    packing: it.packing,
    stock_code: it.stockCode,
    barcode: it.barcode,
    unit: it.unit,
    quantity: it.quantity,
    storage: it.storage,
    low_stock: it.lowStock,
    shelf_status: it.shelfStatus,
    source_ref: it.sourceRef,
    notes: it.notes,
    updated_at: it.updatedAt,
  };
}

/** Full 13-cell row for a brand-new item. */
function newItemRow(it: Omit<SheetItem, "rowNumber" | "raw">): Cell[] {
  return [
    it.stockCode,
    it.sourceRef,
    it.nameEn,
    it.nameZh,
    it.packing,
    it.barcode,
    it.quantity,
    it.unit,
    STORAGE_TO_SHEET[it.storage],
    it.lowStock,
    it.notes,
    it.updatedAt,
    SHELF_TO_SHEET[it.shelfStatus],
  ];
}

// --- Sheet context ----------------------------------------------------------
let tabsPromise: Promise<Tab[]> | null = null;
function loadTabs(): Promise<Tab[]> {
  if (!tabsPromise) {
    tabsPromise = getTabs(SPREADSHEET_ID).catch((e) => {
      tabsPromise = null;
      throw e;
    });
  }
  return tabsPromise;
}
async function tabId(title: string, required: boolean): Promise<number | null> {
  const tabs = await loadTabs();
  const found = tabs.find((t) => t.title === title);
  if (found) return found.sheetId;
  if (required) throw new Error(`Sheet 入面搵唔到「${title}」呢個 tab — 請檢查 Sheet 有冇被改名或者刪咗。`);
  return null;
}

type Ctx = {
  values: string[][];
  items: SheetItem[];
  itemsSheetId: number;
  /** 出入記錄 tab (only loaded when the action appends movements). */
  movementsSheetId: number | null;
  maxMovementId: number;
  /** 「Space 更新狀態」 tab, or null when missing / unreadable (best effort). */
  statusSheetId: number | null;
  statusValues: string[][] | null;
};

/** Reads everything one write needs, in parallel, so a write is one round of
 *  reads followed by one batchUpdate. */
async function loadCtx(opts: { movements?: boolean } = {}): Promise<Ctx> {
  const itemsP = getValues(SPREADSHEET_ID, ITEMS_READ_RANGE);
  const tabsP = loadTabs();
  const movIdsP = opts.movements ? getValues(SPREADSHEET_ID, MOVEMENT_IDS_RANGE) : Promise.resolve(null);
  const statusP = getValues(SPREADSHEET_ID, STATUS_READ_RANGE).catch(() => null);
  const [values, , movIds, statusValues] = await Promise.all([itemsP, tabsP, movIdsP, statusP]);
  assertLayout(values[0]);
  let maxMovementId = 0;
  if (movIds) {
    for (let i = 1; i < movIds.length; i++) {
      const id = numCell(movIds[i], 0);
      if (id != null && id > maxMovementId) maxMovementId = id;
    }
  }
  const itemsSheetId = (await tabId(ITEMS_TAB, false)) ?? 0;
  return {
    values,
    items: parseItems(values),
    itemsSheetId,
    movementsSheetId: opts.movements ? await tabId(MOVEMENTS_TAB, true) : null,
    maxMovementId,
    statusSheetId: statusValues ? await tabId(STATUS_TAB, false) : null,
    statusValues,
  };
}

function findByKey(items: SheetItem[], stockCode: string): SheetItem {
  const found = items.find((it) => it.stockCode === stockCode);
  if (!found) {
    throw new Error(
      `喺 Sheet 入面搵唔到貨品編號 ${stockCode} 嗰行 — 可能已經俾人喺 Sheet 改咗編號或者刪咗，請重新載入再試`,
    );
  }
  return found;
}

function resolveSelected(items: SheetItem[], stockCodes: string[]): SheetItem[] {
  const byCode = new Map(items.map((it) => [it.stockCode, it]));
  const out: SheetItem[] = [];
  const missing: string[] = [];
  for (const code of stockCodes) {
    const found = byCode.get(code);
    if (found) out.push(found);
    else missing.push(code);
  }
  if (missing.length > 0) {
    throw new Error(
      `喺 Sheet 入面搵唔到呢啲貨品編號：${missing.join("、")} — 可能已經俾人改咗編號或者刪咗，請重新載入再試`,
    );
  }
  return out;
}

/** Writes the given (column, value) cells of one item row, merging adjacent
 *  columns into a single run. Cells not listed are never touched. */
function rowEdits(sheetId: number, row1: number, entries: Array<[number, Cell]>) {
  const sorted = [...entries].sort((a, b) => a[0] - b[0]);
  const reqs: unknown[] = [];
  let run: Cell[] = [];
  let start = -1;
  let prev = -2;
  for (const [col, val] of sorted) {
    if (col !== prev + 1) {
      if (run.length) reqs.push(writeRow(sheetId, row1, start, run));
      run = [];
      start = col;
    }
    run.push(val);
    prev = col;
  }
  if (run.length) reqs.push(writeRow(sheetId, row1, start, run));
  return reqs;
}

// --- 「Space 更新狀態」 tab -----------------------------------------------------
/** Manitoba stays on UTC−5 all year since 2026-11-01. */
function winnipegStamp(d: Date = new Date()): string {
  const s = new Date(d.getTime() - 5 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())} ${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())} CDT`;
}

/** Surgical refresh of ONLY the two live status rows (最後更新時間 and
 *  貨品總數), in place, in whichever rows already carry those labels. A row
 *  whose label is missing entirely is appended at the very end. The tab's
 *  hand-written handover document is never rewritten, reordered or blanked. */
function statusRequests(ctx: Ctx, itemCount: number): unknown[] {
  if (ctx.statusSheetId == null || ctx.statusValues == null) return [];
  const existing = ctx.statusValues;
  const findRow = (pred: (label: string) => boolean): number => {
    for (let i = 0; i < existing.length; i++) if (pred(cellAt(existing[i], 0))) return i + 1;
    return 0;
  };
  const reqs: unknown[] = [];
  const appends: Cell[][] = [];
  if (existing.length === 0) appends.push(["項目", "內容"]);
  const timeRow = findRow((l) => l.startsWith("最後更新時間"));
  if (timeRow > 0) reqs.push(writeRow(ctx.statusSheetId, timeRow, 1, [winnipegStamp()]));
  else appends.push(["最後更新時間 (Winnipeg)", winnipegStamp()]);
  const countRow = findRow((l) => l === "貨品總數");
  if (countRow > 0) reqs.push(writeRow(ctx.statusSheetId, countRow, 1, [String(itemCount)]));
  else appends.push(["貨品總數", String(itemCount)]);
  if (appends.length) reqs.push(appendRows(ctx.statusSheetId, appends));
  return reqs;
}

function parseMovements(values: string[][]): Movement[] {
  const out: Movement[] = [];
  values.forEach((row, i) => {
    if (i === 0) return;
    const id = numCell(row, 0);
    const delta = numCell(row, 4);
    if (id == null || delta == null) return;
    out.push({
      id,
      stock_code: cellAt(row, 2),
      item_name: cellAt(row, 3),
      delta,
      kind: KIND_FROM_SHEET[cellAt(row, 5).toLowerCase()] ?? KIND_FROM_SHEET[cellAt(row, 5)] ?? "adjust",
      note: cellAt(row, 6),
      created_at: cellAt(row, 1),
    });
  });
  return out;
}

const CONNECT_ERR =
  "連唔到 Google Sheet — 而家係直連模式，冇本機副本，連返線先至用到。請檢查網絡再試。";

export const api = {
  async listItems(_: Record<string, never> = {}): Promise<{ items: Item[] }> {
    const values = await getValues(SPREADSHEET_ID, ITEMS_READ_RANGE);
    assertLayout(values[0]);
    return { items: parseItems(values).map(toItem) };
  },

  async listMovements(args: { stockCode?: string; limit?: number } = {}): Promise<{ movements: Movement[] }> {
    const values = await getValues(SPREADSHEET_ID, MOVEMENTS_READ_RANGE);
    const out = parseMovements(values).filter((m) => !args.stockCode || m.stock_code === args.stockCode);
    out.sort((a, b) => b.id - a.id);
    return { movements: out.slice(0, args.limit ?? 60) };
  },

  /** Every movement of ONE item, newest first. Rows are matched by the
   *  item's 貨品編號 Key (column C). Older rows written before Key became the
   *  identity hold a numeric item ID there instead; those are matched by the
   *  exact item name — but only when that name belongs to a single item, so
   *  variants sharing a name (e.g. four 春卷皮 sizes) are never mixed up. */
  async listItemMovements(args: { stockCode: string }): Promise<{ movements: Movement[] }> {
    const [mv, itemValues] = await Promise.all([
      getValues(SPREADSHEET_ID, MOVEMENTS_READ_RANGE),
      getValues(SPREADSHEET_ID, ITEMS_READ_RANGE),
    ]);
    assertLayout(itemValues[0]);
    const items = parseItems(itemValues);
    const item = items.find((i) => i.stockCode === args.stockCode);
    const name = item ? itemDisplayName(item) : "";
    const nameIsUnique = item ? items.filter((i) => itemDisplayName(i) === name).length === 1 : false;
    const out = parseMovements(mv).filter(
      (m) =>
        m.stock_code === args.stockCode ||
        (nameIsUnique && !isValidKey(m.stock_code) && m.item_name === name),
    );
    out.sort((a, b) => b.id - a.id);
    return { movements: out };
  },

  /** Reachability + what the status tab last recorded. Never throws. */
  async getSheetStatus(_: Record<string, never> = {}) {
    try {
      let lastUpdated = "";
      let count = 0;
      try {
        const status = await getValues(SPREADSHEET_ID, STATUS_READ_RANGE);
        for (const row of status) {
          if (cellAt(row, 0).startsWith("最後更新時間")) lastUpdated = cellAt(row, 1);
          if (cellAt(row, 0) === "貨品總數") count = Number(cellAt(row, 1)) || 0;
        }
      } catch {
        // Status tab unreadable: still "connected" if the items tab reads.
        await getValues(SPREADSHEET_ID, a1(ITEMS_TAB, "A1:A1"));
      }
      return { connected: true, item_count: count, last_updated_at: lastUpdated, sheet_url: SHEET_URL };
    } catch {
      return { connected: false, item_count: 0, last_updated_at: "", sheet_url: SHEET_URL };
    }
  },

  async adjustQuantity(args: { stockCode: string; delta: number; kind: "in" | "out" | "adjust"; note: string }) {
    if (args.delta === 0) throw new Error("數量冇變動");
    const ctx = await loadCtx({ movements: true });
    const item = findByKey(ctx.items, args.stockCode);
    const next = clean(item.quantity + args.delta);
    if (next < 0) throw new Error("存量唔可以少過 0");
    const now = new Date().toISOString();
    await batchUpdate(SPREADSHEET_ID, [
      ...rowEdits(ctx.itemsSheetId, item.rowNumber, [
        [COL.quantity, next],
        [COL.updatedAt, now],
      ]),
      appendRows(ctx.movementsSheetId!, [
        [ctx.maxMovementId + 1, now, item.stockCode, itemDisplayName(item), args.delta, args.kind, args.note],
      ]),
      ...statusRequests(ctx, ctx.items.length),
    ]);
    return { ok: true as const, quantity: next };
  },

  async setQuantity(args: { stockCode: string; quantity: number; note: string }) {
    const ctx = await loadCtx({ movements: true });
    const item = findByKey(ctx.items, args.stockCode);
    const delta = clean(args.quantity - item.quantity);
    if (delta !== 0) {
      const now = new Date().toISOString();
      await batchUpdate(SPREADSHEET_ID, [
        ...rowEdits(ctx.itemsSheetId, item.rowNumber, [
          [COL.quantity, args.quantity],
          [COL.updatedAt, now],
        ]),
        appendRows(ctx.movementsSheetId!, [
          [ctx.maxMovementId + 1, now, item.stockCode, itemDisplayName(item), delta, "adjust", args.note || "盤點調整"],
        ]),
        ...statusRequests(ctx, ctx.items.length),
      ]);
    }
    return { ok: true as const, quantity: args.quantity };
  },

  /** Pure status change: only the shelf flag (and 最後更新) is written — the
   *  quantity is untouched and no movement is appended. */
  async setShelfStatus(args: { stockCode: string; status: ShelfStatus }) {
    const ctx = await loadCtx();
    const item = findByKey(ctx.items, args.stockCode);
    await batchUpdate(SPREADSHEET_ID, [
      ...rowEdits(ctx.itemsSheetId, item.rowNumber, [
        [COL.updatedAt, new Date().toISOString()],
        [COL.shelfStatus, SHELF_TO_SHEET[args.status]],
      ]),
      ...statusRequests(ctx, ctx.items.length),
    ]);
    return { ok: true as const, shelf_status: args.status, quantity: item.quantity };
  },

  async addItem(args: {
    nameEn: string;
    nameZh: string;
    packing: string;
    stockCode: string;
    barcode: string;
    unit: Unit;
    quantity: number;
    storage: Storage;
    lowStock: number | null;
    notes: string;
  }) {
    const ctx = await loadCtx({ movements: args.quantity > 0 });
    const used = new Set(ctx.items.map((it) => it.stockCode).filter(Boolean));
    const rawCode = args.stockCode.trim();
    let key = "";
    if (rawCode) {
      if (!isValidKey(rawCode)) {
        throw new Error(
          "貨品編號 Key 要啱啱七個字（或者 TMP-001 呢種臨時代號）；唔啱長度嘅編號唔會儲存，留空就會自動俾臨時代號",
        );
      }
      key = rawCode;
      if (used.has(key)) throw new Error(`貨品編號 ${key} 已經有另一樣貨用緊 — 編號係 Key，唔可以重複`);
    } else {
      key = nextTmpKey(used);
    }
    const now = new Date().toISOString();
    const newItem = {
      stockCode: key,
      sourceRef: "手動新增",
      nameEn: args.nameEn,
      nameZh: args.nameZh,
      packing: args.packing,
      barcode: args.barcode,
      quantity: args.quantity,
      unit: args.unit,
      storage: args.storage,
      lowStock: args.lowStock,
      notes: args.notes,
      shelfStatus: "ok" as ShelfStatus,
      updatedAt: now,
    };
    const requests: unknown[] = [appendRows(ctx.itemsSheetId, [newItemRow(newItem)])];
    if (args.quantity > 0) {
      requests.push(
        appendRows(ctx.movementsSheetId!, [
          [ctx.maxMovementId + 1, now, key, itemDisplayName(newItem), args.quantity, "initial", "期初存量"],
        ]),
      );
    }
    requests.push(...statusRequests(ctx, ctx.items.length + 1));
    await batchUpdate(SPREADSHEET_ID, requests);
    return { ok: true as const, stock_code: key };
  },

  async updateItem(args: {
    stockCode: string;
    nameEn: string;
    nameZh: string;
    packing: string;
    newStockCode: string;
    barcode: string;
    unit: Unit;
    storage: Storage;
    lowStock: number | null;
    notes: string;
  }) {
    const ctx = await loadCtx();
    const item = findByKey(ctx.items, args.stockCode);
    const rawNew = args.newStockCode.trim();
    let key = item.stockCode;
    if (rawNew) {
      if (!isValidKey(rawNew)) {
        throw new Error(
          "貨品編號 Key 要啱啱七個字（或者 TMP-001 呢種臨時代號）；唔啱長度嘅編號唔會儲存，留空就會自動俾臨時代號",
        );
      }
      key = rawNew;
      if (key !== item.stockCode && ctx.items.some((it) => it.rowNumber !== item.rowNumber && it.stockCode === key)) {
        throw new Error(`貨品編號 ${key} 已經有另一樣貨用緊 — 編號係 Key，唔可以重複`);
      }
    } else {
      // Cleared code field: allocate a fresh TMP placeholder, never keyless.
      key = nextTmpKey(new Set(ctx.items.map((it) => it.stockCode).filter(Boolean)));
    }
    // Write only the cells whose value actually changes, so untouched cells
    // (barcode, code, notes…) are never re-typed.
    const entries: Array<[number, Cell]> = [];
    const text = (col: number, next: string) => {
      if (cellAt(item.raw, col) !== next) entries.push([col, next]);
    };
    text(COL.stockCode, key);
    text(COL.nameEn, args.nameEn);
    text(COL.nameZh, args.nameZh);
    text(COL.packing, args.packing);
    text(COL.barcode, args.barcode);
    text(COL.unit, args.unit);
    text(COL.storage, STORAGE_TO_SHEET[args.storage]);
    text(COL.notes, args.notes);
    if (numCell(item.raw, COL.lowStock) !== args.lowStock) entries.push([COL.lowStock, args.lowStock]);
    entries.push([COL.updatedAt, new Date().toISOString()]);
    await batchUpdate(SPREADSHEET_ID, [
      ...rowEdits(ctx.itemsSheetId, item.rowNumber, entries),
      ...statusRequests(ctx, ctx.items.length),
    ]);
    return { ok: true as const };
  },

  async deleteItem(args: { stockCode: string }) {
    const ctx = await loadCtx();
    const item = findByKey(ctx.items, args.stockCode);
    await batchUpdate(SPREADSHEET_ID, [
      deleteRows(ctx.itemsSheetId, item.rowNumber),
      ...statusRequests(ctx, ctx.items.length - 1),
    ]);
    return { ok: true as const };
  },

  /** Multi-select edit. Only the fields present change; quantities and
   *  movements are untouched. lowStock: null clears the threshold. */
  async bulkUpdateItems(args: {
    stockCodes: string[];
    storage?: Storage;
    shelfStatus?: ShelfStatus;
    unit?: Unit;
    lowStock?: number | null;
  }) {
    if (
      args.storage === undefined &&
      args.shelfStatus === undefined &&
      args.unit === undefined &&
      args.lowStock === undefined
    ) {
      throw new Error("冇揀要改咩 — 請揀最少一樣要批量改嘅嘢（儲存／貨架／單位／低存量提示）");
    }
    const ctx = await loadCtx();
    const selected = resolveSelected(ctx.items, [...new Set(args.stockCodes)]);
    const now = new Date().toISOString();
    const requests: unknown[] = [];
    for (const it of selected) {
      const entries: Array<[number, Cell]> = [[COL.updatedAt, now]];
      if (args.storage !== undefined) entries.push([COL.storage, STORAGE_TO_SHEET[args.storage]]);
      if (args.unit !== undefined) entries.push([COL.unit, args.unit]);
      if (args.lowStock !== undefined) entries.push([COL.lowStock, args.lowStock]);
      if (args.shelfStatus !== undefined) entries.push([COL.shelfStatus, SHELF_TO_SHEET[args.shelfStatus]]);
      requests.push(...rowEdits(ctx.itemsSheetId, it.rowNumber, entries));
    }
    requests.push(...statusRequests(ctx, ctx.items.length));
    await batchUpdate(SPREADSHEET_ID, requests);
    return { ok: true as const, updated: selected.length };
  },

  /** Same quantity change for many items (multi-select 入貨／出貨); one
   *  出入記錄 row per item. Nothing changes if any item would drop below 0. */
  async bulkAdjustQuantity(args: {
    stockCodes: string[];
    delta: number;
    kind: "in" | "out" | "adjust";
    note: string;
  }) {
    if (args.delta === 0) throw new Error("數量冇變動");
    const ctx = await loadCtx({ movements: true });
    const codes = [...new Set(args.stockCodes)];
    const selected = resolveSelected(ctx.items, codes);
    for (const it of selected) {
      if (it.quantity + args.delta < 0) {
        throw new Error(
          `「${it.nameZh || it.nameEn}」現有存量 ${it.quantity}，唔夠出 ${Math.abs(args.delta)} —成批冇改到，請先處理呢項再試`,
        );
      }
    }
    const now = new Date().toISOString();
    const requests: unknown[] = [];
    const movementRows: Cell[][] = [];
    selected.forEach((it, i) => {
      requests.push(
        ...rowEdits(ctx.itemsSheetId, it.rowNumber, [
          [COL.quantity, clean(it.quantity + args.delta)],
          [COL.updatedAt, now],
        ]),
      );
      movementRows.push([ctx.maxMovementId + 1 + i, now, it.stockCode, itemDisplayName(it), args.delta, args.kind, args.note]);
    });
    requests.push(appendRows(ctx.movementsSheetId!, movementRows));
    requests.push(...statusRequests(ctx, ctx.items.length));
    await batchUpdate(SPREADSHEET_ID, requests);
    return { ok: true as const, updated: selected.length };
  },

  /** Deletes the selected rows (bottom-up, in one batch). Past movements
   *  stay in the append-only 出入記錄 log. */
  async bulkDeleteItems(args: { stockCodes: string[] }) {
    const ctx = await loadCtx();
    const selected = resolveSelected(ctx.items, [...new Set(args.stockCodes)]);
    const rows = selected.map((it) => it.rowNumber).sort((a, b) => b - a);
    await batchUpdate(SPREADSHEET_ID, [
      ...rows.map((r) => deleteRows(ctx.itemsSheetId, r)),
      ...statusRequests(ctx, ctx.items.length - selected.length),
    ]);
    return { ok: true as const, deleted: selected.length };
  },

  /** Edits one 出入記錄 row (delta / kind / note). When the delta changes, the
   *  item's on-hand quantity is adjusted by the difference; refused when that
   *  would push it below 0. */
  async updateMovement(args: { movementId: number; delta: number; kind: MovementKind; note: string }) {
    if (args.delta === 0) throw new Error("數量變動唔可以係 0");
    if ((args.kind === "in" || args.kind === "initial") && args.delta < 0) {
      throw new Error("入貨／期初嘅數量變動要係正數");
    }
    if (args.kind === "out" && args.delta > 0) throw new Error("出貨嘅數量變動要係負數");
    const [movements, ctx, movSheetId] = await Promise.all([
      getValues(SPREADSHEET_ID, MOVEMENTS_READ_RANGE),
      loadCtx(),
      tabId(MOVEMENTS_TAB, true),
    ]);
    let rowIdx = -1;
    for (let i = 1; i < movements.length; i++) {
      if (numCell(movements[i], 0) === args.movementId) {
        rowIdx = i;
        break;
      }
    }
    if (rowIdx < 0) {
      throw new Error("喺出入記錄入面搵唔到呢筆記錄 — 可能已經俾人喺 Sheet 改咗或者刪咗，請重新載入再試");
    }
    const row = movements[rowIdx];
    const oldDelta = numCell(row, 4) ?? 0;
    const stockCode = cellAt(row, 2);
    const diff = clean(args.delta - oldDelta);
    const requests: unknown[] = [];
    let newQuantity: number | null = null;
    const item = ctx.items.find((it) => it.stockCode === stockCode);
    if (item) {
      newQuantity = item.quantity;
      if (diff !== 0) {
        const next = clean(item.quantity + diff);
        if (next < 0) {
          throw new Error(
            `改咗之後「${item.nameZh || item.nameEn}」存量會變負數（而家 ${item.quantity}，呢筆記錄變動 ${diff > 0 ? "+" : ""}${diff}）— 請改返數量，或者先處理存量再試`,
          );
        }
        requests.push(
          ...rowEdits(ctx.itemsSheetId, item.rowNumber, [
            [COL.quantity, next],
            [COL.updatedAt, new Date().toISOString()],
          ]),
        );
        newQuantity = next;
      }
    }
    // Only E:G (變動 / 種類 / 備註) change; ID, date, code and name stay.
    requests.push(writeRow(movSheetId!, rowIdx + 1, 4, [args.delta, args.kind, args.note]));
    requests.push(...statusRequests(ctx, ctx.items.length));
    await batchUpdate(SPREADSHEET_ID, requests);
    return { ok: true as const, quantity: newQuantity };
  },
};

export { CONNECT_ERR, isTmpKey };
