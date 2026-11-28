// 團購記錄 — direct-mode data layer (port of the Space's server actions).
//
// The Google Sheet「團購記錄 - Demo Co.」IS the database. Each tab is
// one week; new weeks are added as the rightmost tab:
//   A 訂單編號 · B 姓名 · C 客人備註 · D 貨品 · E 數量 · F 單位 · G 備註 ·
//   H 已領取 · I 領取日期時間 · J 員工備註
// One order spans several consecutive rows sharing a 訂單編號; H (checkbox
// text TRUE/FALSE), I (pickup date-time) and J (staff note, written from the
// app) live ONLY on the group's first row. Writes re-read the tab first and find the group's first row BY ITS
// 訂單編號 — the row number is only the write address after the key match.

import { a1, batchUpdate, getTabs, getValues, writeRow, type Tab } from "../../shared/sheets";
import { t as tr } from "../../shared/i18n";

export const SPREADSHEET_ID = "DEMO_GROUPBUY_SHEET_ID";
export const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/DEMO_GROUPBUY_SHEET_ID/edit";

const COL = {
  orderNo: 0,
  name: 1,
  customerNote: 2,
  product: 3,
  qty: 4,
  unit: 5,
  note: 6,
  pickedUp: 7,
  pickedAt: 8,
  staffNote: 9,
} as const;

const STAFF_NOTE_HEADER = "員工備註";
/** Longest staff note the app will write (characters). */
export const STAFF_NOTE_MAX = 500;

export type OrderItem = { product: string; qty: string; unit: string; note: string };
export type Order = {
  order_no: string;
  name: string;
  customer_note: string;
  picked_up: boolean;
  /** Pickup date-time as stored in column I ("YYYY-MM-DD HH:mm", Winnipeg). */
  picked_at: string;
  /** Staff note from column J of the group's first row ("" when none). */
  staff_note: string;
  items: OrderItem[];
};

/** Current Winnipeg date-time "YYYY-MM-DD HH:mm". Manitoba stays on UTC−5
 *  all year since 2026-11-01, and tz databases may still apply the old DST
 *  rules, so use a fixed UTC−5 offset instead of the named zone. */
export function nowWinnipeg(): string {
  const shifted = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

function cellAt(row: string[] | undefined, idx: number): string {
  return (row?.[idx] ?? "").trim();
}

function assertLayout(header: string[] | undefined): void {
  const expected = ["訂單編號", "姓名", "客人備註", "貨品", "數量", "單位", "備註", "已領取"];
  if (!expected.every((label, i) => cellAt(header, i) === label)) {
    throw new Error(
      tr(
        "Sheet 欄位同預期唔同（A 訂單編號 · B 姓名 · C 客人備註 · D 貨品 · E 數量 · F 單位 · G 備註 · H 已領取 · I 領取日期時間），唔敢亂讀，請先檢查 Sheet 第一行。",
        "The Sheet columns aren't as expected (A 訂單編號 · B 姓名 · C 客人備註 · D 貨品 · E 數量 · F 單位 · G 備註 · H 已領取 · I 領取日期時間), so nothing was read. Please check the Sheet's first row.",
      ),
    );
  }
  const pickedAtHeader = cellAt(header, COL.pickedAt);
  if (pickedAtHeader !== "" && pickedAtHeader !== "領取日期時間") {
    throw new Error(
      tr(
        "Sheet I 欄表頭唔係「領取日期時間」，唔敢亂讀，請先檢查 Sheet 第一行。",
        "The Sheet's column I header isn't 「領取日期時間」, so nothing was read. Please check the Sheet's first row.",
      ),
    );
  }
}

/** Column J is the staff-note column when its header is「員工備註」or still
 *  blank (the app writes the header on the first save). Any other header
 *  means someone uses J for something else: notes are then neither shown
 *  nor written, but the rest of the app keeps working. */
function staffNoteColumnState(header: string[] | undefined): "ready" | "blank" | "taken" {
  const h = cellAt(header, COL.staffNote);
  return h === STAFF_NOTE_HEADER ? "ready" : h === "" ? "blank" : "taken";
}

function parseOrders(values: string[][]): { orders: Order[]; firstRowByOrder: Map<string, number> } {
  const useStaffNote = staffNoteColumnState(values[0]) !== "taken";
  const orders: Order[] = [];
  const firstRowByOrder = new Map<string, number>();
  let current: Order | null = null;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const orderNo = cellAt(row, COL.orderNo);
    const product = cellAt(row, COL.product);
    if (!orderNo && !product) continue; // blank separator row
    if (!current || orderNo !== current.order_no) {
      current = {
        order_no: orderNo,
        name: cellAt(row, COL.name),
        customer_note: cellAt(row, COL.customerNote),
        picked_up: cellAt(row, COL.pickedUp).toUpperCase() === "TRUE",
        picked_at: cellAt(row, COL.pickedAt),
        staff_note: useStaffNote ? (row?.[COL.staffNote] ?? "").trim() : "",
        items: [],
      };
      orders.push(current);
      if (!firstRowByOrder.has(orderNo)) firstRowByOrder.set(orderNo, i + 1);
    } else {
      if (!current.name) current.name = cellAt(row, COL.name);
      if (!current.customer_note) current.customer_note = cellAt(row, COL.customerNote);
    }
    if (product) {
      current.items.push({
        product,
        qty: cellAt(row, COL.qty),
        unit: cellAt(row, COL.unit),
        note: cellAt(row, COL.note),
      });
    }
  }
  return { orders, firstRowByOrder };
}

/** Week tabs newest-first. A new week's tab is always added on the right of
 *  the Sheet, so the rightmost tab is the latest week: the Sheet's tab order
 *  is simply reversed, whatever the tab names look like. */
function sortTabs(tabs: Tab[]): Tab[] {
  return [...tabs].reverse();
}

async function loadWeek(tab: string) {
  const [tabs, values] = await Promise.all([
    getTabs(SPREADSHEET_ID),
    getValues(SPREADSHEET_ID, a1(tab, "A1:J2000")),
  ]);
  const found = tabs.find((t) => t.title === tab);
  if (!found) throw new Error(tr(`Sheet 入面冇「${tab}」呢個 tab，請重新載入再揀過。`, `The Sheet has no tab "${tab}". Please reload and choose again.`));
  assertLayout(values[0]);
  return {
    sheetId: found.sheetId,
    ...parseOrders(values),
    hasPickedAtHeader: cellAt(values[0], COL.pickedAt) === "領取日期時間",
    staffNoteColumn: staffNoteColumnState(values[0]),
  };
}

function orderNotFound(tab: string, orderNo: string): Error {
  return new Error(
    tr(
      `喺「${tab}」入面搵唔到訂單編號 ${orderNo} — 可能已經俾人喺 Sheet 改咗，請重新載入再試。`,
      `Order ${orderNo} isn't in "${tab}" — someone may have changed it in the Sheet. Please reload and try again.`,
    ),
  );
}

async function writeOrFail(requests: unknown[]): Promise<void> {
  try {
    await batchUpdate(SPREADSHEET_ID, requests);
  } catch (e) {
    throw new Error(
      e instanceof Error && e.message
        ? tr(`寫唔到去 Google Sheet：${e.message}`, `Couldn't write to the Google Sheet: ${e.message}`)
        : tr("寫唔到去 Google Sheet，請檢查網絡再試。", "Couldn't write to the Google Sheet. Please check your connection and try again."),
    );
  }
}

/** Thrown when the staff note in the Sheet is no longer what the editor
 *  started from (a colleague saved one meanwhile). Nothing was written. */
export class StaleNoteError extends Error {
  constructor(readonly current: string) {
    super(
      current
        ? tr(
            `同事啱啱改咗呢張單嘅員工備註，而家係「${current}」。你寫嘅未儲存 — 睇返先再儲存。`,
            `A colleague just changed this order's staff note to "${current}". Yours wasn't saved — check it, then save again.`,
          )
        : tr(
            "同事啱啱清咗呢張單嘅員工備註。你寫嘅未儲存 — 睇返先再儲存。",
            "A colleague just cleared this order's staff note. Yours wasn't saved — check it, then save again.",
          ),
    );
  }
}

export const api = {
  async listWeeks() {
    const tabs = sortTabs(await getTabs(SPREADSHEET_ID));
    const titles = tabs.map((t) => t.title);
    return { tabs: titles, default_tab: titles[0] ?? "", sheet_url: SHEET_URL };
  },

  async getWeek(args: { tab: string }) {
    const values = await getValues(SPREADSHEET_ID, a1(args.tab, "A1:J2000"));
    if (values.length === 0) {
      // Empty read: make sure the tab exists before calling it empty.
      const tabs = await getTabs(SPREADSHEET_ID);
      if (!tabs.some((t) => t.title === args.tab)) {
        throw new Error(tr(`Sheet 入面冇「${args.tab}」呢個 tab，請重新載入再揀過。`, `The Sheet has no tab "${args.tab}". Please reload and choose again.`));
      }
    }
    assertLayout(values[0]);
    const { orders } = parseOrders(values);
    return {
      tab: args.tab,
      orders,
      total_orders: orders.length,
      picked_count: orders.filter((o) => o.picked_up).length,
    };
  },

  async setPickedUp(args: { tab: string; order_no: string; picked_up: boolean }) {
    const { sheetId, firstRowByOrder, hasPickedAtHeader } = await loadWeek(args.tab);
    const row = firstRowByOrder.get(args.order_no);
    if (row == null) throw orderNotFound(args.tab, args.order_no);
    const pickedAt = args.picked_up ? nowWinnipeg() : "";
    const requests: unknown[] = [];
    // A tab created before column I existed gets its header first.
    if (!hasPickedAtHeader) requests.push(writeRow(sheetId, 1, COL.pickedAt, ["領取日期時間"]));
    requests.push(writeRow(sheetId, row, COL.pickedUp, [args.picked_up ? "TRUE" : "FALSE", pickedAt]));
    await writeOrFail(requests);
    return { ok: true as const, picked_up: args.picked_up, picked_at: pickedAt };
  },

  /** Writes the staff note (column J) on the order group's first row.
   *  `expected` is the note the editor started from: if the Sheet now holds
   *  something else, nothing is written and StaleNoteError carries the
   *  current note, so a colleague's note is never overwritten unseen. */
  async setStaffNote(args: { tab: string; order_no: string; note: string; expected: string }) {
    const note = args.note.trim();
    if (note.length > STAFF_NOTE_MAX) {
      throw new Error(
        tr(`員工備註最多 ${STAFF_NOTE_MAX} 個字。`, `Staff notes can be at most ${STAFF_NOTE_MAX} characters.`),
      );
    }
    const { sheetId, orders, firstRowByOrder, staffNoteColumn } = await loadWeek(args.tab);
    if (staffNoteColumn === "taken") {
      throw new Error(
        tr(
          "Sheet J 欄表頭唔係「員工備註」，唔敢亂寫，請先檢查 Sheet 第一行。",
          "The Sheet's column J header isn't 「員工備註」, so nothing was written. Please check the Sheet's first row.",
        ),
      );
    }
    const row = firstRowByOrder.get(args.order_no);
    const order = orders.find((o) => o.order_no === args.order_no);
    if (row == null || !order) throw orderNotFound(args.tab, args.order_no);
    if (order.staff_note !== args.expected.trim()) throw new StaleNoteError(order.staff_note);
    if (order.staff_note === note) return { ok: true as const, staff_note: note };
    const requests: unknown[] = [];
    // A tab without the column yet gets its header first.
    if (staffNoteColumn === "blank") requests.push(writeRow(sheetId, 1, COL.staffNote, [STAFF_NOTE_HEADER]));
    requests.push(writeRow(sheetId, row, COL.staffNote, [note]));
    await writeOrFail(requests);
    return { ok: true as const, staff_note: note };
  },
};

export type WeekData = Awaited<ReturnType<typeof api.getWeek>>;
