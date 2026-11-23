// Actions for the warehouse inventory artifact — DIRECT mode.
//
// The Google Sheet "倉庫存貨 - Demo Co." IS the database now (user,
// 2026-11-18: 「改為直連個table，唔用同步模式」; offline mode is given up:
// 「離線模式可以犧牲」; the Sheet's column layout is final and will not
// change again: 「跟住table嘅排位定應該唔會再改」). There is no local
// items/movements copy, no sync engine, no sheet_dirty / pending /
// conflict / protected / tombstone concepts anymore:
//
//   - Every read (listItems / listMovements / getSheetStatus) reads the
//     Sheet live, so a colleague editing the Sheet directly is visible
//     the next time the Space loads — nothing to sync.
//   - Every write re-reads the Sheet first, finds the item's row BY ITS
//     貨品編號 Key in column A (never by a remembered row position —
//     the row number is only the physical write address AFTER the Key
//     match), then writes only that row (adjustQuantity / setQuantity /
//     setShelfStatus / updateItem), appends one row (addItem), or
//     deletes that row (deleteItem). Quantity changes also append one
//     row to the 出入記錄 tab.
//   - If the Sheet is unreachable, reads and writes fail with a clear
//     error — there is deliberately no local fallback anymore.
//   - After every successful write, the 「Space 更新狀態」 tab (the last
//     tab) gets a SURGICAL refresh only: the two live status rows
//     (最後更新時間 (Winnipeg), 貨品總數) are updated in place, in
//     whichever rows already carry those labels. The tab also carries
//     a long hand-written handover document maintained by hand — the
//     refresh NEVER rewrites the tab as a block, never reorders rows,
//     and never deletes or blanks any other row, recognised or not
//     (user, 2026-11-18: 「淨係更新狀態行，唔好成版覆蓋，唔好刪走上面
//     手寫嘅交接內容」). The only other writes are appends at the very
//     end of the tab: a status row whose label is missing entirely,
//     and the standing dated history rows, each appended only when its
//     label is not already present anywhere on the tab. Status-tab
//     refresh is best-effort: the item write has already landed, so a
//     status failure never fails the mutation.
//
// Sheet layout (FINAL, verified live 2026-11-18):
//   Sheet1 (items)     A 貨品編號 · B 來源貨單 · C 英文名 · D 中文名 ·
//                      E 包裝/規格 · F 條碼 · G 數量 · H 單位 · I 儲存 ·
//                      J 低存量提示 · K 備註 · L 最後更新 · M 貨架狀態
//   出入記錄 (movements) A ID · B 日期 · C 貨品ID · D 貨品 · E 變動 ·
//                      F 種類 · G 備註 — append-only log; new rows store
//                      the item's 貨品編號 in column C.
//   Space 更新狀態      A 項目 · B 內容 — human-readable status page.
//
// 貨品編號 Key rules (unchanged): a real code is exactly 7 characters;
// an item whose code has not been scanned yet carries a TMP-001,
// TMP-002, … placeholder, allocated by scanning the Sheet's current
// keys so placeholders never repeat. Keys are unique: addItem /
// updateItem reject a code another item already uses.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { privileged } from "@space/privileged";

const unitEnum = z.enum(["Case", "Pack", "Box", "KG", "個"]);
// Storage split by freezer floor (user, 2026-11-19: 「儲存可唔可以分做
// 冷凍 1f 同2f？包、餃子、雪糕、蛋糕類全部2f，春卷皮、餃子皮、雞鴨係1f，
// 其他未定」): frozen_1f / frozen_2f are the two freezer floors; plain
// `frozen` remains for frozen items whose floor is not decided yet.
// dry / fresh / unclassified are unchanged.
const storageEnum = z.enum(["frozen", "frozen_1f", "frozen_2f", "dry", "fresh", "unclassified"]);
// Shelf status merged to a single flag (user, 2026-11-18: 「貨架空同要補貨
// 兩粒掣合併做一個就得」): only ok (shelf fine) and need_refill （補貨架 —
// shelf needs pulling from the warehouse; renamed from 要補貨 on
// 2026-11-19 per user: 「要補貨改做補貨架好似好啲」). Legacy Sheet values
// 貨架空 / shelf_empty / 要補貨 are read as need_refill (see
// SHELF_FROM_SHEET).
const shelfStatusEnum = z.enum(["ok", "need_refill"]);

const itemShape = z.object({
  /** The Sheet row the item currently sits on — a display/address
   *  value only; identity is `stock_code`. */
  id: z.number(),
  row_number: z.number(),
  name_en: z.string(),
  name_zh: z.string(),
  packing: z.string(),
  stock_code: z.string(),
  barcode: z.string(),
  unit: unitEnum,
  quantity: z.number(),
  storage: storageEnum,
  low_stock: z.number().nullable(),
  shelf_status: shelfStatusEnum,
  source_ref: z.string(),
  notes: z.string(),
  updated_at: z.string(),
});

const okResponse = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------------------
// Sheet constants (layout is final — see header comment)
// ---------------------------------------------------------------------------
const SPREADSHEET_ID = "DEMO_WAREHOUSE_SHEET_ID";
const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/DEMO_WAREHOUSE_SHEET_ID/edit";
const ITEMS_TAB = "Sheet1";
const ITEMS_SHEET_ID = 0;
const MOVEMENTS_TAB = "出入記錄";
const STATUS_TAB = "Space 更新狀態";
const ITEMS_READ_RANGE = "Sheet1!A1:M1000";
const MOVEMENTS_READ_RANGE = "出入記錄!A1:G2000";
const STATUS_READ_RANGE = "Space 更新狀態!A1:B1000";
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

type CellValue = string | number;
type UnitT = z.infer<typeof unitEnum>;
type StorageT = z.infer<typeof storageEnum>;
type ShelfT = z.infer<typeof shelfStatusEnum>;
type MovementKind = "initial" | "in" | "out" | "adjust";

const SHEET_CONTRACTS = [
  privileged.sheetsReadRange,
  privileged.sheetsWriteRange,
  privileged.sheetsBatchUpdate,
];

// --- 貨品編號 Key rules ------------------------------------------------------
function isTmpKey(code: string): boolean {
  return /^TMP-\d{3,}$/.test(code);
}
function isValidKey(code: string): boolean {
  return code.length === 7 || isTmpKey(code);
}
function formatTmpKey(seq: number): string {
  return `TMP-${String(seq).padStart(3, "0")}`;
}
/** Next TMP placeholder, derived from the keys currently in the Sheet
 *  so it never collides with an existing one. */
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

// --- Sheet cell parsing ------------------------------------------------------
const STORAGE_FROM_SHEET: Record<string, StorageT> = {
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
// What is written back to Sheet column I. The two floors write the
// readable Chinese labels so a colleague reading the Sheet sees
// 「冷凍 1F」/「冷凍 2F」 directly; plain frozen keeps its existing
// English code (rows already in the Sheet use it, and the parser
// accepts both forms).
const STORAGE_TO_SHEET: Record<StorageT, string> = {
  frozen: "frozen",
  frozen_1f: "冷凍 1F",
  frozen_2f: "冷凍 2F",
  dry: "dry",
  fresh: "fresh",
  unclassified: "unclassified",
};

const UNIT_FROM_SHEET: Record<string, UnitT> = {
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
const SHELF_FROM_SHEET: Record<string, ShelfT> = {
  ok: "ok",
  "正常": "ok",
  "貨架正常": "ok",
  // Legacy values from before the merge — 貨架空 meant the same
  // practical thing (go pull stock from the warehouse), so they all
  // read as the single merged need_refill state.
  shelf_empty: "need_refill",
  "貨架空": "need_refill",
  "空": "need_refill",
  need_refill: "need_refill",
  // 要補貨 is the pre-2026-11-19 name of this same flag — rows still
  // carrying it read as need_refill and are rewritten as 補貨架 the
  // next time that row is written.
  "要補貨": "need_refill",
  "補貨架": "need_refill",
  "待補貨": "need_refill",
};
const SHELF_TO_SHEET: Record<ShelfT, string> = {
  ok: "",
  need_refill: "補貨架",
};
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

function cellAt(row: string[], idx: number): string {
  return (row[idx] ?? "").trim();
}
function numCell(row: string[], idx: number): number | null {
  const raw = cellAt(row, idx);
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Layout guard: column A of the items tab must be the 貨品編號 column.
 *  The layout is final, so this should never trigger — but if the Sheet
 *  is ever rearranged by hand, reading it under the wrong layout would
 *  corrupt data, so every entry point refuses instead. */
function assertLayout(headerRow: string[] | undefined): void {
  const a1 = (headerRow?.[COL.stockCode] ?? "").trim();
  if (a1 !== "貨品編號") {
    throw new Error(
      `Sheet 佈局唔啱：A1 而家係「${a1 || "（空白）"}」，唔係「貨品編號」 — 已停手，冇讀冇寫，請先將 Sheet 第一欄改返做貨品編號`,
    );
  }
}

type SheetItem = {
  rowNumber: number;
  stockCode: string;
  sourceRef: string;
  nameEn: string;
  nameZh: string;
  packing: string;
  barcode: string;
  quantity: number;
  unit: UnitT;
  storage: StorageT;
  lowStock: number | null;
  notes: string;
  shelfStatus: ShelfT;
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
      stockCode: cellAt(row, COL.stockCode),
      sourceRef: cellAt(row, COL.sourceRef),
      nameEn,
      nameZh,
      packing: cellAt(row, COL.packing),
      barcode: cellAt(row, COL.barcode),
      quantity: numCell(row, COL.quantity) ?? 0,
      unit:
        UNIT_FROM_SHEET[cellAt(row, COL.unit).toLowerCase()] ??
        UNIT_FROM_SHEET[cellAt(row, COL.unit)] ??
        "Case",
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

function itemToSheetRow(it: SheetItem): CellValue[] {
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
    it.lowStock ?? "",
    it.notes,
    it.updatedAt,
    SHELF_TO_SHEET[it.shelfStatus],
  ];
}

function itemDisplayName(it: Pick<SheetItem, "nameEn" | "nameZh">): string {
  return it.nameZh ? `${it.nameZh} · ${it.nameEn}` : it.nameEn;
}

function toItem(it: SheetItem) {
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

// --- Sheet IO helpers --------------------------------------------------------
async function readRange(ctx: Ctx, range: string): Promise<string[][]> {
  const res = await ctx.executePrivileged(privileged.sheetsReadRange, {
    spreadsheetId: SPREADSHEET_ID,
    range,
  });
  return res.values;
}

async function writeRange(ctx: Ctx, range: string, values: CellValue[][]): Promise<void> {
  await ctx.executePrivileged(privileged.sheetsWriteRange, {
    spreadsheetId: SPREADSHEET_ID,
    range,
    values,
  });
}

/** Reads the items tab live and parses it. Throws a clear error when
 *  the Sheet is unreachable — direct mode has no local fallback. */
async function loadItems(ctx: Ctx): Promise<{ values: string[][]; items: SheetItem[] }> {
  let values: string[][];
  try {
    values = await readRange(ctx, ITEMS_READ_RANGE);
  } catch {
    throw new Error(
      "連唔到 Google Sheet — 而家係直連模式，冇本機副本，連返線先至用到。請檢查網絡再試。",
    );
  }
  assertLayout(values[0]);
  return { values, items: parseItems(values) };
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

async function appendMovement(
  ctx: Ctx,
  args: { stockCode: string; itemName: string; delta: number; kind: MovementKind; note: string },
): Promise<void> {
  const values = await readRange(ctx, MOVEMENTS_READ_RANGE);
  let maxId = 0;
  for (let i = 1; i < values.length; i++) {
    const id = numCell(values[i] ?? [], 0);
    if (id != null && id > maxId) maxId = id;
  }
  const rowNumber = values.length + 1;
  await writeRange(ctx, `${MOVEMENTS_TAB}!A${rowNumber}:G${rowNumber}`, [
    [
      maxId + 1,
      new Date().toISOString(),
      args.stockCode,
      args.itemName,
      args.delta,
      args.kind,
      args.note,
    ],
  ]);
}

// --- Bulk (multi-select) helpers ---------------------------------------------
// Bulk writes NEVER loop per row (that pattern timed out during the
// frozen-floor classification — see CLASSIFY_COMPLETE_HISTORY_ROW).
// Instead each changed column is written back in ONE range write:
// selected rows get the new value, every other row gets its just-read
// cell value written back verbatim, so no other cell can change.
const COL_LETTER: Record<string, string> = {
  quantity: "G",
  unit: "H",
  storage: "I",
  lowStock: "J",
  updatedAt: "L",
  shelfStatus: "M",
};

/** Builds one column's values (rows 2..lastRow) for a bulk write:
 *  rows whose stock code is in `selected` get `newValueFor(item)`,
 *  all other rows keep their current cell text verbatim. */
function bulkColumnValues(
  values: string[][],
  items: SheetItem[],
  colIdx: number,
  selected: Set<string>,
  newValueFor: (item: SheetItem) => CellValue,
): CellValue[][] {
  const byRow = new Map(items.map((it) => [it.rowNumber, it]));
  const out: CellValue[][] = [];
  for (let r = 2; r <= values.length; r++) {
    const item = byRow.get(r);
    if (item && selected.has(item.stockCode)) {
      out.push([newValueFor(item)]);
    } else {
      out.push([cellAt(values[r - 1] ?? [], colIdx)]);
    }
  }
  return out;
}

async function writeBulkColumn(
  ctx: Ctx,
  colIdx: number,
  values: string[][],
  items: SheetItem[],
  selected: Set<string>,
  newValueFor: (item: SheetItem) => CellValue,
): Promise<void> {
  if (values.length < 2) return;
  const letter = COL_LETTER[Object.keys(COL).find((k) => COL[k as keyof typeof COL] === colIdx) ?? ""];
  if (!letter) throw new Error("內部錯誤：唔識寫呢一欄");
  await writeRange(ctx, `${ITEMS_TAB}!${letter}2:${letter}${values.length}`, bulkColumnValues(values, items, colIdx, selected, newValueFor));
}

/** Appends many movement rows in ONE block write (bulk quantity changes). */
async function appendMovementsBulk(
  ctx: Ctx,
  rows: Array<{ stockCode: string; itemName: string; delta: number; kind: MovementKind; note: string }>,
): Promise<void> {
  if (rows.length === 0) return;
  const values = await readRange(ctx, MOVEMENTS_READ_RANGE);
  let maxId = 0;
  for (let i = 1; i < values.length; i++) {
    const id = numCell(values[i] ?? [], 0);
    if (id != null && id > maxId) maxId = id;
  }
  const startRow = values.length + 1;
  const stamp = new Date().toISOString();
  const block: CellValue[][] = rows.map((r, i) => [
    maxId + 1 + i,
    stamp,
    r.stockCode,
    r.itemName,
    r.delta,
    r.kind,
    r.note,
  ]);
  await writeRange(ctx, `${MOVEMENTS_TAB}!A${startRow}:G${startRow + block.length - 1}`, block);
}

/** Resolves the selected items for a bulk action, rejecting unknown codes. */
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

async function deleteSheetItemRow(ctx: Ctx, rowNumber: number): Promise<void> {
  await ctx.executePrivileged(privileged.sheetsBatchUpdate, {
    spreadsheetId: SPREADSHEET_ID,
    requests: [
      {
        deleteDimension: {
          range: {
            sheetId: ITEMS_SHEET_ID,
            dimension: "ROWS",
            startIndex: rowNumber - 1,
            endIndex: rowNumber,
          },
        },
      },
    ],
  });
}

// --- 「Space 更新狀態」 tab ----------------------------------------------------
function winnipegStamp(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Winnipeg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")} ${get("timeZoneName")}`;
}

const DIRECT_MODE_HISTORY_ROW: CellValue[] = [
  "2026-11-18 改動（直連）",
  "Space 改做直連 Google Sheet：唔再用同步模式、唔再用本地資料庫做主檔，讀寫直接打 Sheet；離線模式已經犧牲（連唔到 Sheet 就用唔到）；貨品編號喺 Sheet A 欄做主 Key，對位只認編號唔認行數；Sheet 欄位排位（A:M）已經定死，唔會再改",
];

const SHELF_MERGED_HISTORY_ROW: CellValue[] = [
  "2026-11-18 改動（貨架狀態合併）",
  "貨架狀態合併做一個：唔再分「貨架空」同「要補貨」，得返一個「要補貨」標記（要喺貨倉拎貨出嚟補上貨架）；補好就撳「已補好」清返做正常。Sheet M 欄舊有嘅「貨架空」會自動當做「要補貨」讀，下次寫入嗰行就會改寫做「要補貨」",
];

const SHELF_RENAMED_HISTORY_ROW: CellValue[] = [
  "2026-11-19 改動（補貨架改名）",
  "貨架狀態標記改名：「要補貨」改做「補貨架」（意思不變：要喺貨倉拎貨出嚟補上貨架；補好就撳「已補好」清返做正常）。Sheet M 欄新寫入會用「補貨架」；舊有嘅「要補貨」會自動當做「補貨架」讀，下次寫入嗰行就會改寫做「補貨架」",
];

const FROZEN_FLOOR_HISTORY_ROW: CellValue[] = [
  "2026-11-19 改動（冷凍分層）",
  "儲存分做冷凍 1F / 冷凍 2F：包、餃子、雪糕、冰棒、蛋糕類全部歸 2F；春卷皮、餃子皮（連雲吞皮等皮類）、雞、鴨歸 1F。餃子皮優先過餃子（皮係 1F，餃子本身係 2F）；雞鴨餃子／包以餃子／包優先歸 2F。其他未定嘅保持「冷凍」（未分層），等 Stephen 再睇。Sheet I 欄新寫入會用「冷凍 1F」／「冷凍 2F」",
];

const ICE_BAR_HISTORY_ROW: CellValue[] = [
  "2026-11-19 改動（冰棒歸 2F）",
  "冰棒類補返歸 2F：之前雪糕類規則漏咗冰棒同 ice bar，冰極韓國冰棒 6 款同小美冰棒未分到層；而家分類規則加返「冰棒」同「ice bar」入 2F（同雪糕同一組），再行一次分類補返嗰幾款。其他分類規則不變",
];

const CLASSIFY_COMPLETE_HISTORY_ROW: CellValue[] = [
  "2026-11-19 改動（冷凍分層補完）",
  "冷凍分層補完：之前幾次分類係逐行寫入 Sheet（一行一個寫入，成百行要幾分鐘），未行到表尾就俾執行時限中斷咗，所以表尾嗰批（金樂包系列、龍江蝦餃／小籠包／鍋貼、雙喜餃子皮／雲吞皮、雙葉冰棒等）一直未分到層，唔係分類規則認唔到。而家改做成欄一次過寫入（只寫 I 欄儲存同 L 欄最後更新），成表一次分完；規則本身冇變。未分類中嘅貨維持「冷凍」（未定），等 Stephen 再睇",
];

const BULK_OPS_HISTORY_ROW: CellValue[] = [
  "2026-11-19 改動（多選批量操作）",
  "Space 加咗多選模式：可以一次過揀多項貨品，批量改儲存位置（冷凍 1F／2F／未定、乾貨、新鮮、未分類）、貨架狀態（補貨架／已補好）、單位、低存量提示、數量入貨／出貨（每項同一個數量變動，會逐項寫入出入記錄），同埋批量刪除（出入記錄保留做歷史）。批量寫入係成欄一次過寫 Sheet，唔係逐行寫，唔會好似之前分類咁俾時限中斷",
];

const MOVEMENT_EDIT_HISTORY_ROW: CellValue[] = [
  "2026-11-19 改動（出入記錄可編輯）",
  "Space 嘅出入記錄版加咗「編輯」掣：每筆記錄嘅數量變動、種類（入貨／出貨／盤點調整／期初）同備註都改得。改咗數量變動嗰陣，嗰項貨品喺 Sheet 嘅現有存量會按差額同步加減（例如記錄由 +4 改做 +6，存量加 2）；改到存量會變負數就唔俾儲存。如果嗰項貨品已經唔喺存貨表（俾人刪咗），記錄照改得，存量就唔郁",
];

const REFILL_DEDUCT_HISTORY_ROW: CellValue[] = [
  "2026-11-20 改動（補貨掣自動扣減）",
  "Space 每項貨品嗰粒「補貨架」掣而家會自動喺倉存數量扣 1：撳「補貨架 · -1」嗰陣，嗰項貨品嘅倉存會即刻減 1（由倉庫拎 1 去補貨架），同時寫一筆出貨記錄（-1，備註「補貨架：由倉庫拎去貨架」）入出入記錄，再標記做補貨架。撳「已補好」淨係清返個標記，唔會再扣。倉存唔夠 1（例如已經係 0）嗰陣照標記補貨架，但唔會扣到負數。多選批量標記補貨架唔會自動扣存量，淨係改標記",
];

const REFILL_DEDUCT_ON_DONE_HISTORY_ROW: CellValue[] = [
  "2026-11-20 改動（扣數改喺已補好）",
  "補貨架扣數時機改咗：撳「補貨架」淨係標記要補貨架，唔再扣倉存；補好之後撳「已補好」先至喺倉存扣 1，同時寫一筆出貨記錄（-1，備註「補貨架：由倉庫拎去貨架」）入出入記錄，再清返個標記。倉存唔夠 1（例如已經係 0）嗰陣照清標記，但唔會扣到負數。多選批量標記繼續淨係改標記，唔扣存量",
];

const REFILL_DEDUCT_REVERTED_HISTORY_ROW: CellValue[] = [
  "2026-11-20 改動（還原：扣數改返喺補貨架）",
  "補貨架扣數時機還原返：撳「補貨架」嗰陣標記要補貨架，同時喺倉存扣 1，寫一筆出貨記錄（-1，備註「補貨架：由倉庫拎去貨架」）入出入記錄；撳「已補好」淨係清返個標記，唔再扣。咁做係因為同事可能已經幫手補咗貨、減咗倉庫數量，但件貨嘅狀態仲未變返——扣數同清標記分開，可以減咗數量先再 unmark，唔會扣多咗。倉存唔夠 1（例如已經係 0）嗰陣照標記補貨架，但唔會扣到負數。多選批量標記繼續淨係改標記，唔扣存量",
];

const REFILL_NO_DEDUCT_HISTORY_ROW: CellValue[] = [
  "2026-11-20 改動（補貨架唔再扣數）",
  "補貨架掣最終改做純粹轉換貨架狀態：撳「補貨架」淨係標記要補貨架，撳「已補好」淨係清返個標記，兩邊都唔再扣倉存、唔再寫出入記錄。數量要改就另外用加減數量嗰啲掣處理，同貨架狀態完全分開。多選批量標記一樣淨係改標記，唔扣存量",
];

/**
 * Refreshes ONLY the two live status rows on the 「Space 更新狀態」 tab
 * after a direct write (and on demand via refreshSheetStatus): the
 * 最後更新時間 (Winnipeg) value and the 貨品總數 value are written into
 * the value cell of whichever existing row already carries that label,
 * wherever the row sits on the tab (user, 2026-11-18: 「淨係更新狀態行
 * （最後更新時間、貨品總數），唔好成版覆蓋，唔好刪走上面手寫嘅交接內容」).
 *
 * The tab also carries a long hand-written handover document (system
 * overview, hard rules, incident history, open items) that people and
 * other agents maintain by hand. This function must NEVER rebuild the
 * tab as a block: it does not reorder rows, does not rewrite any other
 * row's label or content, and does not blank trailing rows — every
 * other row, recognised or not, stays exactly as it is. The only other
 * writes allowed are appends at the very END of the tab: a status row
 * whose label is missing entirely, and the standing dated history
 * rows (direct-mode change, shelf-status merge, 補貨架 rename), each
 * appended only when its label is not already present anywhere on the tab.
 * Best-effort by design: callers wrap it so a status failure never
 * fails a write that has already landed in the items tab.
 */
async function updateStatusTab(ctx: Ctx, itemCount: number): Promise<void> {
  let existing: string[][] = [];
  try {
    existing = await readRange(ctx, STATUS_READ_RANGE);
  } catch {
    existing = [];
  }
  const labelOf = (i: number): string => cellAt(existing[i] ?? [], 0);
  /** 1-based Sheet row number of the first row whose label matches, or 0. */
  const findRow = (pred: (label: string) => boolean): number => {
    for (let i = 0; i < existing.length; i++) {
      if (pred(labelOf(i))) return i + 1;
    }
    return 0;
  };
  const hasLabel = (label: CellValue): boolean =>
    existing.some((_, i) => labelOf(i) === label);

  // Rows queued for append at the end of the tab. Queued rows are also
  // pushed into `existing` so later presence checks see them.
  const appends: CellValue[][] = [];
  const queueAppend = (row: CellValue[]): void => {
    appends.push(row);
    existing.push([String(row[0] ?? ""), String(row[1] ?? "")]);
  };

  if (existing.length === 0) {
    queueAppend(["項目", "內容"]);
  }

  // 最後更新時間 — update the existing row's value cell in place; only
  // append a new row when no row carries the label at all.
  const timeRow = findRow((l) => l.startsWith("最後更新時間"));
  if (timeRow > 0) {
    await writeRange(ctx, `${STATUS_TAB}!B${timeRow}`, [[winnipegStamp()]]);
  } else {
    queueAppend(["最後更新時間 (Winnipeg)", winnipegStamp()]);
  }

  // 貨品總數 — same treatment, in place.
  const countRow = findRow((l) => l === "貨品總數");
  if (countRow > 0) {
    await writeRange(ctx, `${STATUS_TAB}!B${countRow}`, [[String(itemCount)]]);
  } else {
    queueAppend(["貨品總數", String(itemCount)]);
  }

  // Standing dated history rows: append once each, only when the label
  // is genuinely absent — never duplicated, never moved.
  if (!hasLabel(DIRECT_MODE_HISTORY_ROW[0] ?? "")) {
    queueAppend([...DIRECT_MODE_HISTORY_ROW]);
  }
  if (!hasLabel(SHELF_MERGED_HISTORY_ROW[0] ?? "")) {
    queueAppend([...SHELF_MERGED_HISTORY_ROW]);
  }
  if (!hasLabel(SHELF_RENAMED_HISTORY_ROW[0] ?? "")) {
    queueAppend([...SHELF_RENAMED_HISTORY_ROW]);
  }
  if (!hasLabel(FROZEN_FLOOR_HISTORY_ROW[0] ?? "")) {
    queueAppend([...FROZEN_FLOOR_HISTORY_ROW]);
  }
  if (!hasLabel(ICE_BAR_HISTORY_ROW[0] ?? "")) {
    queueAppend([...ICE_BAR_HISTORY_ROW]);
  }
  if (!hasLabel(CLASSIFY_COMPLETE_HISTORY_ROW[0] ?? "")) {
    queueAppend([...CLASSIFY_COMPLETE_HISTORY_ROW]);
  }
  if (!hasLabel(BULK_OPS_HISTORY_ROW[0] ?? "")) {
    queueAppend([...BULK_OPS_HISTORY_ROW]);
  }
  if (!hasLabel(MOVEMENT_EDIT_HISTORY_ROW[0] ?? "")) {
    queueAppend([...MOVEMENT_EDIT_HISTORY_ROW]);
  }
  if (!hasLabel(REFILL_DEDUCT_HISTORY_ROW[0] ?? "")) {
    queueAppend([...REFILL_DEDUCT_HISTORY_ROW]);
  }
  if (!hasLabel(REFILL_DEDUCT_ON_DONE_HISTORY_ROW[0] ?? "")) {
    queueAppend([...REFILL_DEDUCT_ON_DONE_HISTORY_ROW]);
  }
  if (!hasLabel(REFILL_DEDUCT_REVERTED_HISTORY_ROW[0] ?? "")) {
    queueAppend([...REFILL_DEDUCT_REVERTED_HISTORY_ROW]);
  }
  if (!hasLabel(REFILL_NO_DEDUCT_HISTORY_ROW[0] ?? "")) {
    queueAppend([...REFILL_NO_DEDUCT_HISTORY_ROW]);
  }

  if (appends.length > 0) {
    const startRow = existing.length - appends.length + 1;
    await writeRange(
      ctx,
      `${STATUS_TAB}!A${startRow}:B${existing.length}`,
      appends,
    );
  }
}

/** Best-effort status refresh: the item write has already landed. */
async function refreshStatusQuietly(ctx: Ctx, itemCount: number): Promise<void> {
  try {
    await updateStatusTab(ctx, itemCount);
  } catch {
    // The next successful write (or refreshSheetStatus) rewrites it.
  }
}

const sheetStatusResponse = z.object({
  connected: z.boolean(),
  item_count: z.number(),
  last_updated_at: z.string(),
  sheet_url: z.string(),
});

export const Actions = {
  listItems: defineAction({
    description:
      "Lists all warehouse inventory items by reading the Google Sheet's items tab (Sheet1) live — direct mode: there is no local copy and no sync, so what the Sheet holds right now is what is returned, in Sheet row order. Fails with a clear error when the Sheet is unreachable.",
    request: z.object({}),
    response: z.object({ items: z.array(itemShape) }),
    privileged: SHEET_CONTRACTS,
    async handler(ctx) {
      const { items } = await loadItems(ctx);
      return { items: items.map(toItem) };
    },
  }),

  listMovements: defineAction({
    description:
      "Lists recent stock movements (newest first) by reading the Google Sheet's 出入記錄 tab live. Optionally filtered to one item by its 貨品編號 stock_code.",
    request: z.object({
      stockCode: z.string().max(60).optional(),
      limit: z.number().int().positive().max(200).default(60),
    }),
    response: z.object({
      movements: z.array(
        z.object({
          id: z.number(),
          stock_code: z.string(),
          item_name: z.string(),
          delta: z.number(),
          kind: z.enum(["initial", "in", "out", "adjust"]),
          note: z.string(),
          created_at: z.string(),
        }),
      ),
    }),
    privileged: SHEET_CONTRACTS,
    async handler(ctx, args) {
      let values: string[][];
      try {
        values = await readRange(ctx, MOVEMENTS_READ_RANGE);
      } catch {
        throw new Error(
          "連唔到 Google Sheet — 而家係直連模式，冇本機副本，連返線先至用到。請檢查網絡再試。",
        );
      }
      type Mov = {
        id: number; stock_code: string; item_name: string; delta: number;
        kind: MovementKind; note: string; created_at: string;
      };
      const out: Mov[] = [];
      values.forEach((row, i) => {
        if (i === 0) return;
        const id = numCell(row, 0);
        const delta = numCell(row, 4);
        if (id == null || delta == null) return;
        const stockCode = cellAt(row, 2);
        if (args.stockCode && stockCode !== args.stockCode) return;
        out.push({
          id,
          stock_code: stockCode,
          item_name: cellAt(row, 3),
          delta,
          kind:
            KIND_FROM_SHEET[cellAt(row, 5).toLowerCase()] ??
            KIND_FROM_SHEET[cellAt(row, 5)] ??
            "adjust",
          note: cellAt(row, 6),
          created_at: cellAt(row, 1),
        });
      });
      out.sort((a, b) => b.id - a.id);
      return { movements: out.slice(0, args.limit) };
    },
  }),

  updateMovement: defineAction({
    description:
      "Edits one existing movement (出入記錄） row in the Google Sheet: finds the row by its movement ID in the 出入記錄 tab and rewrites that row only with the new signed delta, kind and note. When the delta changes, the item's on-hand quantity in the items tab is adjusted by the difference (found by the movement's 貨品編號 Key, column A) so the stock count stays consistent with the corrected record; the edit is refused when that adjustment would push the item's quantity below 0. If the item no longer exists in the items tab, the movement is still edited and the quantity is left alone (returned as null). Fails when the Sheet is unreachable or the movement ID is not found.",
    request: z.object({
      movementId: z.number().int().positive(),
      delta: z.number().min(-100000).max(100000),
      kind: z.enum(["initial", "in", "out", "adjust"]),
      note: z.string().max(200).default(""),
    }),
    response: z.object({ ok: z.literal(true), quantity: z.number().nullable() }),
    privileged: SHEET_CONTRACTS,
    async handler(
      ctx,
      args,
    ): Promise<{ ok: true; quantity: number | null }> {
      if (args.delta === 0) throw new Error("數量變動唔可以係 0");
      if ((args.kind === "in" || args.kind === "initial") && args.delta < 0) {
        throw new Error("入貨／期初嘅數量變動要係正數");
      }
      if (args.kind === "out" && args.delta > 0) {
        throw new Error("出貨嘅數量變動要係負數");
      }
      let values: string[][];
      try {
        values = await readRange(ctx, MOVEMENTS_READ_RANGE);
      } catch {
        throw new Error(
          "連唔到 Google Sheet — 而家係直連模式，冇本機副本，連返線先至用到。請檢查網絡再試。",
        );
      }
      let rowIdx = -1;
      for (let i = 1; i < values.length; i++) {
        if (numCell(values[i] ?? [], 0) === args.movementId) {
          rowIdx = i;
          break;
        }
      }
      if (rowIdx < 0) {
        throw new Error(
          "喺出入記錄入面搵唔到呢筆記錄 — 可能已經俾人喺 Sheet 改咗或者刪咗，請重新載入再試",
        );
      }
      const row = values[rowIdx] ?? [];
      const oldDelta = numCell(row, 4) ?? 0;
      const createdAt = cellAt(row, 1);
      const stockCode = cellAt(row, 2);
      const itemName = cellAt(row, 3);
      const diff = args.delta - oldDelta;

      // Keep the item's on-hand quantity consistent with the corrected
      // record: apply only the difference between old and new delta.
      const { items } = await loadItems(ctx);
      let newQuantity: number | null = null;
      const item = items.find((it) => it.stockCode === stockCode);
      if (item) {
        newQuantity = item.quantity;
        if (diff !== 0) {
          const next = item.quantity + diff;
          if (next < 0) {
            throw new Error(
              `改咗之後「${item.nameZh || item.nameEn}」存量會變負數（而家 ${item.quantity}，呢筆記錄變動 ${diff > 0 ? "+" : ""}${diff}）— 請改返數量，或者先處理存量再試`,
            );
          }
          const updated: SheetItem = {
            ...item,
            quantity: next,
            updatedAt: new Date().toISOString(),
          };
          await writeRange(ctx, `${ITEMS_TAB}!A${item.rowNumber}:M${item.rowNumber}`, [
            itemToSheetRow(updated),
          ]);
          newQuantity = next;
        }
      }

      await writeRange(ctx, `${MOVEMENTS_TAB}!A${rowIdx + 1}:G${rowIdx + 1}`, [
        [args.movementId, createdAt, stockCode, itemName, args.delta, args.kind, args.note],
      ]);
      await refreshStatusQuietly(ctx, items.length);
      ctx.invalidateQueries();
      return { ok: true, quantity: newQuantity };
    },
  }),

  getSheetStatus: defineAction({
    description:
      "Reports the direct-connection state: whether the Google Sheet is reachable right now, how many items it holds, and the last-update time recorded on the 「Space 更新狀態」 tab. Never throws — an unreachable Sheet returns connected:false (direct mode has no local fallback to show instead).",
    request: z.object({}),
    response: sheetStatusResponse,
    privileged: SHEET_CONTRACTS,
    async handler(ctx): Promise<z.infer<typeof sheetStatusResponse>> {
      try {
        const { items } = await loadItems(ctx);
        let lastUpdated = "";
        try {
          const status = await readRange(ctx, STATUS_READ_RANGE);
          for (const row of status) {
            if (cellAt(row, 0).startsWith("最後更新時間")) {
              lastUpdated = cellAt(row, 1);
              break;
            }
          }
        } catch {
          lastUpdated = "";
        }
        if (!lastUpdated) {
          lastUpdated = items.reduce(
            (max, it) => (it.updatedAt > max ? it.updatedAt : max),
            "",
          );
        }
        return {
          connected: true,
          item_count: items.length,
          last_updated_at: lastUpdated,
          sheet_url: SHEET_URL,
        };
      } catch {
        return {
          connected: false,
          item_count: 0,
          last_updated_at: "",
          sheet_url: SHEET_URL,
        };
      }
    },
  }),

  refreshSheetStatus: defineAction({
    description:
      "Refreshes the Google Sheet's last tab, 「Space 更新狀態」, surgically: updates ONLY the two live status rows — 最後更新時間 (Winnipeg) and 貨品總數 — in place, in whichever rows already carry those labels, and appends the standing dated history rows (2026-11-18 direct-mode change, 2026-11-18 shelf-status merge, 2026-11-19 補貨架 rename, 2026-11-19 冷凍分層, 2026-11-19 冰棒歸 2F, 2026-11-19 冷凍分層補完, 2026-11-19 多選批量操作, 2026-11-19 出入記錄可編輯, 2026-11-20 補貨掣自動扣減, 2026-11-20 扣數改喺已補好, 2026-11-20 還原扣數改返喺補貨架, 2026-11-20 補貨架唔再扣數) at the end of the tab only when their labels are not already present. It never rewrites the tab as a block and never deletes, reorders or blanks any other row: the tab's hand-written handover document (overview, hard rules, incident history, open items) is preserved exactly as written. Runs automatically after every direct write; call it directly to refresh the two status values on demand.",
    request: z.object({}),
    response: z.object({
      ok: z.literal(true),
      item_count: z.number(),
      updated_at: z.string(),
    }),
    privileged: SHEET_CONTRACTS,
    async handler(ctx): Promise<{ ok: true; item_count: number; updated_at: string }> {
      const { items } = await loadItems(ctx);
      await updateStatusTab(ctx, items.length);
      ctx.invalidateQueries();
      return { ok: true, item_count: items.length, updated_at: winnipegStamp() };
    },
  }),

  adjustQuantity: defineAction({
    description:
      "Adds or removes stock for one item, directly in the Google Sheet: re-reads the items tab, finds the row by the item's 貨品編號 (stock_code, column A), writes the new quantity to that row only, and appends the movement to the 出入記錄 tab. Fails when the Sheet is unreachable — nothing is saved locally.",
    request: z.object({
      stockCode: z.string().trim().min(1).max(60),
      delta: z.number().min(-100000).max(100000),
      kind: z.enum(["in", "out", "adjust"]),
      note: z.string().max(200).default(""),
    }),
    response: z.object({ ok: z.literal(true), quantity: z.number() }),
    privileged: SHEET_CONTRACTS,
    async handler(ctx, args): Promise<{ ok: true; quantity: number }> {
      if (args.delta === 0) throw new Error("數量冇變動");
      const { items } = await loadItems(ctx);
      const item = findByKey(items, args.stockCode);
      const next = item.quantity + args.delta;
      if (next < 0) throw new Error("存量唔可以少過 0");
      const updated: SheetItem = {
        ...item,
        quantity: next,
        updatedAt: new Date().toISOString(),
      };
      await writeRange(ctx, `${ITEMS_TAB}!A${item.rowNumber}:M${item.rowNumber}`, [
        itemToSheetRow(updated),
      ]);
      await appendMovement(ctx, {
        stockCode: item.stockCode,
        itemName: itemDisplayName(item),
        delta: args.delta,
        kind: args.kind,
        note: args.note,
      });
      await refreshStatusQuietly(ctx, items.length);
      ctx.invalidateQueries();
      return { ok: true, quantity: next };
    },
  }),

  setQuantity: defineAction({
    description:
      "Sets an item's on-hand quantity directly (stocktake correction) in the Google Sheet: re-reads the items tab, finds the row by 貨品編號 (stock_code, column A), writes that row only, and appends the difference to the 出入記錄 tab as a 盤點調整 movement. Fails when the Sheet is unreachable.",
    request: z.object({
      stockCode: z.string().trim().min(1).max(60),
      quantity: z.number().min(0).max(1000000),
      note: z.string().max(200).default(""),
    }),
    response: z.object({ ok: z.literal(true), quantity: z.number() }),
    privileged: SHEET_CONTRACTS,
    async handler(ctx, args): Promise<{ ok: true; quantity: number }> {
      const { items } = await loadItems(ctx);
      const item = findByKey(items, args.stockCode);
      const delta = args.quantity - item.quantity;
      if (delta !== 0) {
        const updated: SheetItem = {
          ...item,
          quantity: args.quantity,
          updatedAt: new Date().toISOString(),
        };
        await writeRange(ctx, `${ITEMS_TAB}!A${item.rowNumber}:M${item.rowNumber}`, [
          itemToSheetRow(updated),
        ]);
        await appendMovement(ctx, {
          stockCode: item.stockCode,
          itemName: itemDisplayName(item),
          delta,
          kind: "adjust",
          note: args.note || "盤點調整",
        });
        await refreshStatusQuietly(ctx, items.length);
      }
      ctx.invalidateQueries();
      return { ok: true, quantity: args.quantity };
    },
  }),

  setShelfStatus: defineAction({
    description:
      "Sets an item's shelf status directly in the Google Sheet's 貨架狀態 column (M): ok (shelf stocked / blank) or need_refill （補貨架 — the single merged shelf flag, renamed from 要補貨 on 2026-11-19; the old 貨架空 state was merged into it). Re-reads the Sheet and finds the row by 貨品編號 (stock_code, column A). This action is a pure status change (user, 2026-11-20 final decision): marking need_refill （補貨架） only sets the flag and clearing back to ok （已補好） only clears it — NEITHER direction changes the warehouse quantity and NEITHER appends a movement to 出入記錄. Quantity changes are handled separately with the quantity controls (quickAdjust / updateItem / bulk quantity ops). Bulk shelf marking (bulkUpdateItems) is likewise flag-only.",
    request: z.object({
      stockCode: z.string().trim().min(1).max(60),
      status: shelfStatusEnum,
    }),
    response: z.object({
      ok: z.literal(true),
      shelf_status: shelfStatusEnum,
      quantity: z.number(),
    }),
    privileged: SHEET_CONTRACTS,
    async handler(
      ctx,
      args,
    ): Promise<{
      ok: true;
      shelf_status: z.infer<typeof shelfStatusEnum>;
      quantity: number;
    }> {
      const { items } = await loadItems(ctx);
      const item = findByKey(items, args.stockCode);
      // Pure status change: only the shelf flag (and the row's
      // 最後更新 stamp) is written. The quantity is carried through
      // untouched and no movement is appended — quantities are
      // adjusted separately via the quantity controls.
      const updated: SheetItem = {
        ...item,
        shelfStatus: args.status,
        updatedAt: new Date().toISOString(),
      };
      await writeRange(ctx, `${ITEMS_TAB}!A${item.rowNumber}:M${item.rowNumber}`, [
        itemToSheetRow(updated),
      ]);
      await refreshStatusQuietly(ctx, items.length);
      ctx.invalidateQueries();
      return {
        ok: true,
        shelf_status: args.status,
        quantity: item.quantity,
      };
    },
  }),

  addItem: defineAction({
    description:
      "Adds a new inventory item by appending one row to the Google Sheet's items tab (and an opening movement to 出入記錄 when the quantity is above 0). The 貨品編號 is the item's Key and must be unique in the Sheet; leaving it blank assigns the next TMP placeholder (TMP-001, TMP-002, …) scanned from the Sheet's current keys. Fails when the Sheet is unreachable.",
    request: z.object({
      nameEn: z.string().trim().min(1).max(200),
      nameZh: z.string().trim().max(200).default(""),
      packing: z.string().trim().max(120).default(""),
      stockCode: z.string().trim().max(60).default(""),
      barcode: z.string().trim().max(60).default(""),
      unit: unitEnum.default("Case"),
      quantity: z.number().min(0).max(1000000).default(0),
      storage: storageEnum.default("unclassified"),
      lowStock: z.number().min(0).max(100000).nullable().default(null),
      notes: z.string().trim().max(500).default(""),
    }),
    response: z.object({ ok: z.literal(true), stock_code: z.string() }),
    privileged: SHEET_CONTRACTS,
    async handler(ctx, args): Promise<{ ok: true; stock_code: string }> {
      const { values, items } = await loadItems(ctx);
      const used = new Set(items.map((it) => it.stockCode).filter(Boolean));
      const rawCode = args.stockCode.trim();
      let key = "";
      if (rawCode) {
        if (!isValidKey(rawCode)) {
          throw new Error(
            "貨品編號 Key 要啱啱七個字（或者 TMP-001 呢種臨時代號）；唔啱長度嘅編號唔會儲存，留空就會自動俾臨時代號",
          );
        }
        key = rawCode;
        if (used.has(key)) {
          throw new Error(
            `貨品編號 ${key} 已經有另一樣貨用緊 — 編號係 Key，唔可以重複`,
          );
        }
      } else {
        key = nextTmpKey(used);
      }
      const newItem: SheetItem = {
        rowNumber: values.length + 1,
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
        shelfStatus: "ok",
        updatedAt: new Date().toISOString(),
      };
      await writeRange(
        ctx,
        `${ITEMS_TAB}!A${newItem.rowNumber}:M${newItem.rowNumber}`,
        [itemToSheetRow(newItem)],
      );
      if (args.quantity > 0) {
        await appendMovement(ctx, {
          stockCode: key,
          itemName: itemDisplayName(newItem),
          delta: args.quantity,
          kind: "initial",
          note: "期初存量",
        });
      }
      await refreshStatusQuietly(ctx, items.length + 1);
      ctx.invalidateQueries();
      return { ok: true, stock_code: key };
    },
  }),

  updateItem: defineAction({
    description:
      "Edits an item's details directly in the Google Sheet: re-reads the items tab, finds the row by its CURRENT 貨品編號 (stockCode, column A), and rewrites that row only. The code itself can be changed here (this is how a TMP placeholder is replaced by the real 7-character code); the new code must not belong to another item. Quantity and shelf status are preserved. Fails when the Sheet is unreachable.",
    request: z.object({
      stockCode: z.string().trim().min(1).max(60),
      nameEn: z.string().trim().min(1).max(200),
      nameZh: z.string().trim().max(200).default(""),
      packing: z.string().trim().max(120).default(""),
      newStockCode: z.string().trim().max(60).default(""),
      barcode: z.string().trim().max(60).default(""),
      unit: unitEnum,
      storage: storageEnum,
      lowStock: z.number().min(0).max(100000).nullable().default(null),
      notes: z.string().trim().max(500).default(""),
    }),
    response: okResponse,
    privileged: SHEET_CONTRACTS,
    async handler(ctx, args): Promise<{ ok: true }> {
      const { items } = await loadItems(ctx);
      const item = findByKey(items, args.stockCode);
      const rawNew = args.newStockCode.trim();
      let key = item.stockCode;
      if (rawNew) {
        if (!isValidKey(rawNew)) {
          throw new Error(
            "貨品編號 Key 要啱啱七個字（或者 TMP-001 呢種臨時代號）；唔啱長度嘅編號唔會儲存，留空就會自動俾臨時代號",
          );
        }
        key = rawNew;
        if (
          key !== item.stockCode &&
          items.some((it) => it.rowNumber !== item.rowNumber && it.stockCode === key)
        ) {
          throw new Error(
            `貨品編號 ${key} 已經有另一樣貨用緊 — 編號係 Key，唔可以重複`,
          );
        }
      } else {
        // Cleared code field: allocate a fresh TMP placeholder rather
        // than leaving the item keyless.
        key = nextTmpKey(new Set(items.map((it) => it.stockCode).filter(Boolean)));
      }
      const updated: SheetItem = {
        ...item,
        stockCode: key,
        nameEn: args.nameEn,
        nameZh: args.nameZh,
        packing: args.packing,
        barcode: args.barcode,
        unit: args.unit,
        storage: args.storage,
        lowStock: args.lowStock,
        notes: args.notes,
        updatedAt: new Date().toISOString(),
      };
      await writeRange(ctx, `${ITEMS_TAB}!A${item.rowNumber}:M${item.rowNumber}`, [
        itemToSheetRow(updated),
      ]);
      await refreshStatusQuietly(ctx, items.length);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteItem: defineAction({
    description:
      "Deletes an inventory item directly from the Google Sheet: re-reads the items tab, finds the row by 貨品編號 (stock_code, column A), and deletes exactly that row. The item's past movements stay in the 出入記錄 log (it is append-only history). Fails when the Sheet is unreachable.",
    request: z.object({ stockCode: z.string().trim().min(1).max(60) }),
    response: okResponse,
    privileged: SHEET_CONTRACTS,
    async handler(ctx, args): Promise<{ ok: true }> {
      const { items } = await loadItems(ctx);
      const item = findByKey(items, args.stockCode);
      await deleteSheetItemRow(ctx, item.rowNumber);
      await refreshStatusQuietly(ctx, items.length - 1);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  bulkUpdateItems: defineAction({
    description:
      "Bulk-edits fields of many items at once (multi-select): re-reads the Google Sheet, matches every row by its 貨品編號 (stock_code, column A), and writes each changed column (儲存 I / 單位 H / 低存量提示 J / 貨架狀態 M, plus 最後更新 L) back in one range write per column — never one write per row. Only the fields present in the request change: storage, shelfStatus, unit, and lowStock (send lowStock as null to clear the low-stock threshold; omit it to leave thresholds untouched). Quantities and movements are untouched. Fails when the Sheet is unreachable or any code is not found.",
    request: z.object({
      stockCodes: z.array(z.string().trim().min(1).max(60)).min(1).max(500),
      storage: storageEnum.optional(),
      shelfStatus: shelfStatusEnum.optional(),
      unit: unitEnum.optional(),
      lowStock: z.number().min(0).max(100000).nullable().optional(),
    }),
    response: z.object({ ok: z.literal(true), updated: z.number() }),
    privileged: SHEET_CONTRACTS,
    async handler(
      ctx,
      args,
    ): Promise<{ ok: true; updated: number }> {
      if (
        args.storage === undefined &&
        args.shelfStatus === undefined &&
        args.unit === undefined &&
        args.lowStock === undefined
      ) {
        throw new Error("冇揀要改咩 — 請揀最少一樣要批量改嘅嘢（儲存／貨架／單位／低存量提示）");
      }
      const { values, items } = await loadItems(ctx);
      const codes = [...new Set(args.stockCodes)];
      const selectedItems = resolveSelected(items, codes);
      const selected = new Set(selectedItems.map((it) => it.stockCode));
      const now = new Date().toISOString();
      if (args.storage !== undefined) {
        const storage = args.storage;
        await writeBulkColumn(ctx, COL.storage, values, items, selected, () => STORAGE_TO_SHEET[storage]);
      }
      if (args.unit !== undefined) {
        const unit = args.unit;
        await writeBulkColumn(ctx, COL.unit, values, items, selected, () => unit);
      }
      if (args.lowStock !== undefined) {
        const low = args.lowStock;
        await writeBulkColumn(ctx, COL.lowStock, values, items, selected, () => low ?? "");
      }
      if (args.shelfStatus !== undefined) {
        const shelf = args.shelfStatus;
        await writeBulkColumn(ctx, COL.shelfStatus, values, items, selected, () => SHELF_TO_SHEET[shelf]);
      }
      await writeBulkColumn(ctx, COL.updatedAt, values, items, selected, () => now);
      await refreshStatusQuietly(ctx, items.length);
      ctx.invalidateQueries();
      return { ok: true, updated: selectedItems.length };
    },
  }),

  bulkAdjustQuantity: defineAction({
    description:
      "Applies the same quantity change to many items at once (multi-select 入貨／出貨）: re-reads the Google Sheet, matches rows by 貨品編號 (stock_code, column A), writes the 數量 column (G) and 最後更新 column (L) back in one range write each, and appends one 出入記錄 row per item in a single block write. Fails without changing anything when any selected item would drop below 0, when a code is not found, or when the Sheet is unreachable.",
    request: z.object({
      stockCodes: z.array(z.string().trim().min(1).max(60)).min(1).max(500),
      delta: z.number().min(-100000).max(100000),
      kind: z.enum(["in", "out", "adjust"]),
      note: z.string().max(200).default(""),
    }),
    response: z.object({ ok: z.literal(true), updated: z.number() }),
    privileged: SHEET_CONTRACTS,
    async handler(
      ctx,
      args,
    ): Promise<{ ok: true; updated: number }> {
      if (args.delta === 0) throw new Error("數量冇變動");
      const { values, items } = await loadItems(ctx);
      const codes = [...new Set(args.stockCodes)];
      const selectedItems = resolveSelected(items, codes);
      for (const it of selectedItems) {
        if (it.quantity + args.delta < 0) {
          throw new Error(
            `「${it.nameZh || it.nameEn}」現有存量 ${it.quantity}，唔夠出 ${Math.abs(args.delta)} —成批冇改到，請先處理呢項再試`,
          );
        }
      }
      const selected = new Set(selectedItems.map((it) => it.stockCode));
      const byCode = new Map(selectedItems.map((it) => [it.stockCode, it]));
      const now = new Date().toISOString();
      await writeBulkColumn(ctx, COL.quantity, values, items, selected, (it) => it.quantity + args.delta);
      await writeBulkColumn(ctx, COL.updatedAt, values, items, selected, () => now);
      await appendMovementsBulk(
        ctx,
        codes.map((code) => {
          const it = byCode.get(code);
          return {
            stockCode: code,
            itemName: it ? itemDisplayName(it) : code,
            delta: args.delta,
            kind: args.kind,
            note: args.note,
          };
        }),
      );
      await refreshStatusQuietly(ctx, items.length);
      ctx.invalidateQueries();
      return { ok: true, updated: selectedItems.length };
    },
  }),

  bulkDeleteItems: defineAction({
    description:
      "Deletes many items at once (multi-select) from the Google Sheet: re-reads the items tab, matches rows by 貨品編號 (stock_code, column A), and rewrites the items tab without the selected rows (remaining rows keep their original cell values verbatim), blanking the tail. The items' past movements stay in the 出入記錄 log as append-only history. Fails when the Sheet is unreachable or any code is not found.",
    request: z.object({
      stockCodes: z.array(z.string().trim().min(1).max(60)).min(1).max(500),
    }),
    response: z.object({ ok: z.literal(true), deleted: z.number() }),
    privileged: SHEET_CONTRACTS,
    async handler(
      ctx,
      args,
    ): Promise<{ ok: true; deleted: number }> {
      const { values, items } = await loadItems(ctx);
      const codes = [...new Set(args.stockCodes)];
      const selectedItems = resolveSelected(items, codes);
      const deleteRows = new Set(selectedItems.map((it) => it.rowNumber));
      const header = values[0] ?? [];
      const kept: CellValue[][] = [header.map((c) => c)];
      for (let r = 2; r <= values.length; r++) {
        if (deleteRows.has(r)) continue;
        const row = values[r - 1] ?? [];
        const padded: CellValue[] = [];
        for (let c = 0; c < 13; c++) padded.push(row[c] ?? "");
        kept.push(padded);
      }
      await writeRange(ctx, `${ITEMS_TAB}!A1:M${kept.length}`, kept);
      if (kept.length < values.length) {
        const blanks: CellValue[][] = [];
        for (let r = kept.length; r < values.length; r++) {
          blanks.push(["", "", "", "", "", "", "", "", "", "", "", "", ""]);
        }
        await writeRange(ctx, `${ITEMS_TAB}!A${kept.length + 1}:M${values.length}`, blanks);
      }
      await refreshStatusQuietly(ctx, items.length - selectedItems.length);
      ctx.invalidateQueries();
      return { ok: true, deleted: selectedItems.length };
    },
  }),
} satisfies ActionsModule;
