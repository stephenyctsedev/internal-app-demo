// 團購記錄 — direct-mode data layer (port of the Space's server actions).
//
// The Google Sheet「團購記錄 - Demo Co.」IS the database. Each tab is
// one week; new weeks are added as the rightmost tab:
//   A 訂單編號 · B 姓名 · C 客人備註 · D 貨品 · E 數量 · F 單位 · G 備註 ·
//   H 已領取 · I 領取日期時間
// One order spans several consecutive rows sharing a 訂單編號; H (checkbox
// text TRUE/FALSE) and I (pickup date-time) live ONLY on the group's first
// row. Writes re-read the tab first and find the group's first row BY ITS
// 訂單編號 — the row number is only the write address after the key match.

import { a1, batchUpdate, getTabs, getValues, writeRow, type Tab } from "../../shared/sheets";

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
} as const;

export type OrderItem = { product: string; qty: string; unit: string; note: string };
export type Order = {
  order_no: string;
  name: string;
  customer_note: string;
  picked_up: boolean;
  /** Pickup date-time as stored in column I ("YYYY-MM-DD HH:mm", Winnipeg). */
  picked_at: string;
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
      "Sheet 欄位同預期唔同（A 訂單編號 · B 姓名 · C 客人備註 · D 貨品 · E 數量 · F 單位 · G 備註 · H 已領取 · I 領取日期時間），唔敢亂讀，請先檢查 Sheet 第一行。",
    );
  }
  const pickedAtHeader = cellAt(header, COL.pickedAt);
  if (pickedAtHeader !== "" && pickedAtHeader !== "領取日期時間") {
    throw new Error("Sheet I 欄表頭唔係「領取日期時間」，唔敢亂讀，請先檢查 Sheet 第一行。");
  }
}

function parseOrders(values: string[][]): { orders: Order[]; firstRowByOrder: Map<string, number> } {
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
    getValues(SPREADSHEET_ID, a1(tab, "A1:I2000")),
  ]);
  const found = tabs.find((t) => t.title === tab);
  if (!found) throw new Error(`Sheet 入面冇「${tab}」呢個 tab，請重新載入再揀過。`);
  assertLayout(values[0]);
  return {
    sheetId: found.sheetId,
    ...parseOrders(values),
    hasPickedAtHeader: cellAt(values[0], COL.pickedAt) === "領取日期時間",
  };
}

export const api = {
  async listWeeks() {
    const tabs = sortTabs(await getTabs(SPREADSHEET_ID));
    const titles = tabs.map((t) => t.title);
    return { tabs: titles, default_tab: titles[0] ?? "", sheet_url: SHEET_URL };
  },

  async getWeek(args: { tab: string }) {
    const values = await getValues(SPREADSHEET_ID, a1(args.tab, "A1:I2000"));
    if (values.length === 0) {
      // Empty read: make sure the tab exists before calling it empty.
      const tabs = await getTabs(SPREADSHEET_ID);
      if (!tabs.some((t) => t.title === args.tab)) {
        throw new Error(`Sheet 入面冇「${args.tab}」呢個 tab，請重新載入再揀過。`);
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
    if (row == null) {
      throw new Error(
        `喺「${args.tab}」入面搵唔到訂單編號 ${args.order_no} — 可能已經俾人喺 Sheet 改咗，請重新載入再試。`,
      );
    }
    const pickedAt = args.picked_up ? nowWinnipeg() : "";
    const requests: unknown[] = [];
    // A tab created before column I existed gets its header first.
    if (!hasPickedAtHeader) requests.push(writeRow(sheetId, 1, COL.pickedAt, ["領取日期時間"]));
    requests.push(writeRow(sheetId, row, COL.pickedUp, [args.picked_up ? "TRUE" : "FALSE", pickedAt]));
    try {
      await batchUpdate(SPREADSHEET_ID, requests);
    } catch (e) {
      throw new Error(
        e instanceof Error && e.message ? `寫唔到去 Google Sheet：${e.message}` : "寫唔到去 Google Sheet，請檢查網絡再試。",
      );
    }
    return { ok: true as const, picked_up: args.picked_up, picked_at: pickedAt };
  },
};

export type WeekData = Awaited<ReturnType<typeof api.getWeek>>;
