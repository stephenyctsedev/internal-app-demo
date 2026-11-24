// Actions for the group-buy pickup artifact — DIRECT mode.
//
// The Google Sheet「團購記錄 - Demo Co.」IS the database. There is
// no local copy: every read reads the Sheet live, and the only writes
// are on the first row of an order group: the 已領取 checkbox
// (column H) and the 領取日期時間 (column I) beside it.
//
// Sheet layout (verified live 2026-11-21 against tab「2026-11-23」;
// column I confirmed on both tabs 2026-11-23):
//   Each tab is one week. Row 1 is the frozen header:
//     A 訂單編號 · B 姓名 · C 客人備註 · D 貨品 · E 數量 · F 單位 ·
//     G 備註 · H 已領取 · I 領取日期時間
//   One order spans several consecutive rows sharing the same 訂單編號;
//   A/B/C are filled on every row of the group. H carries a checkbox
//   value ("TRUE"/"FALSE") ONLY on the group's first row — that single
//   cell is the order's picked-up state. I on the same row holds the
//   pickup date-time ("YYYY-MM-DD HH:mm", Winnipeg time) recorded when
//   the order was marked picked up; it is cleared when the order is
//   marked back to not picked up. Orders ticked directly in the Sheet
//   before column I existed simply have an empty I.
//
// Writes re-read the tab first and locate the group's first row BY ITS
// 訂單編號 (column A) — the row number is only the physical write
// address after the key match, never a remembered position.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { privileged } from "@space/privileged";

const SPREADSHEET_ID = "DEMO_GROUPBUY_SHEET_ID";
const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/DEMO_GROUPBUY_SHEET_ID/edit";
/** Generous row cap for one weekly tab (2026-11-23 has 713 rows). */
const READ_RANGE = (tab: string) => `${tab}!A1:I2000`;

const SHEET_CONTRACTS = [
  privileged.sheetsGetTabs,
  privileged.sheetsReadRange,
  privileged.sheetsWriteRange,
];

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

const itemShape = z.object({
  product: z.string(),
  qty: z.string(),
  unit: z.string(),
  note: z.string(),
});

const orderShape = z.object({
  order_no: z.string(),
  name: z.string(),
  customer_note: z.string(),
  picked_up: z.boolean(),
  /** Pickup date-time as stored in column I ("YYYY-MM-DD HH:mm",
   *  Winnipeg time); empty when the order is not picked up, or when it
   *  was ticked before the timestamp was recorded. */
  picked_at: z.string(),
  items: z.array(itemShape),
});

type Order = z.infer<typeof orderShape>;

const okResponse = z.object({
  ok: z.literal(true),
  picked_up: z.boolean(),
  picked_at: z.string(),
});

/** Current Winnipeg date-time as "YYYY-MM-DD HH:mm" — the string
 *  written to column I when an order is marked picked up.
 *
 *  Manitoba no longer switches between standard and daylight time:
 *  since 2026-11-01 it stays on UTC−5 all year. The runtime's tz
 *  database still applies the old America/Winnipeg DST rules (it
 *  dropped back to UTC−6 on 2026-11-01), which made every recorded
 *  pickup time one hour slow — so compute from a fixed UTC−5 offset
 *  instead of the named zone. */
function nowWinnipeg(): string {
  const shifted = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

// --- Sheet IO helpers --------------------------------------------------------

async function readTabs(ctx: Ctx): Promise<string[]> {
  try {
    const res = await ctx.executePrivileged(privileged.sheetsGetTabs, {
      spreadsheetId: SPREADSHEET_ID,
    });
    return res.tabs;
  } catch {
    throw new Error(
      "連唔到 Google Sheet — 而家係直連模式，冇本機副本，連返線先至用到。請檢查網絡再試。",
    );
  }
}

async function readTab(ctx: Ctx, tab: string): Promise<string[][]> {
  try {
    const res = await ctx.executePrivileged(privileged.sheetsReadRange, {
      spreadsheetId: SPREADSHEET_ID,
      range: READ_RANGE(tab),
    });
    return res.values;
  } catch {
    throw new Error(
      "連唔到 Google Sheet — 而家係直連模式，冇本機副本，連返線先至用到。請檢查網絡再試。",
    );
  }
}

function cellAt(row: string[] | undefined, idx: number): string {
  if (!row) return "";
  return (row[idx] ?? "").trim();
}

function assertLayout(header: string[] | undefined): void {
  const expected = ["訂單編號", "姓名", "客人備註", "貨品", "數量", "單位", "備註", "已領取"];
  const ok = expected.every((label, i) => cellAt(header, i) === label);
  if (!ok) {
    throw new Error(
      "Sheet 欄位同預期唔同（A 訂單編號 · B 姓名 · C 客人備註 · D 貨品 · E 數量 · F 單位 · G 備註 · H 已領取 · I 領取日期時間），唔敢亂讀，請先檢查 Sheet 第一行。",
    );
  }
  // Column I is newer: a tab whose header cell is still empty is read
  // fine (timestamps just come back empty), and setPickedUp writes the
  // header before recording a time. A different label means the layout
  // changed under us — refuse rather than guess.
  const pickedAtHeader = cellAt(header, COL.pickedAt);
  if (pickedAtHeader !== "" && pickedAtHeader !== "領取日期時間") {
    throw new Error(
      "Sheet I 欄表頭唔係「領取日期時間」，唔敢亂讀，請先檢查 Sheet 第一行。",
    );
  }
}

/** Groups the tab's data rows into orders. Returns the orders plus, for
 *  each order, the 1-based Sheet row of its first row (the row whose H
 *  cell holds the checkbox). */
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
      // Same group: fill name / customer note if a later row carries them.
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

const DATE_TAB = /^\d{4}-\d{2}-\d{2}$/;

/** Week tabs newest-first: date-named tabs (YYYY-MM-DD) sorted descending,
 *  then any other tabs in Sheet order. */
function sortTabs(tabs: string[]): string[] {
  const dated = tabs.filter((t) => DATE_TAB.test(t)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const others = tabs.filter((t) => !DATE_TAB.test(t));
  return [...dated, ...others];
}

async function loadWeek(ctx: Ctx, tab: string) {
  const tabs = await readTabs(ctx);
  if (!tabs.includes(tab)) {
    throw new Error(`Sheet 入面冇「${tab}」呢個 tab，請重新載入再揀過。`);
  }
  const values = await readTab(ctx, tab);
  assertLayout(values[0]);
  return {
    ...parseOrders(values),
    hasPickedAtHeader: cellAt(values[0], COL.pickedAt) === "領取日期時間",
  };
}

export const Actions = {
  listWeeks: defineAction({
    description:
      "Lists the weekly tabs of the group-buy Google Sheet (newest week first) plus the Sheet URL. Direct mode: read live from the Sheet, no local copy.",
    request: z.object({}),
    response: z.object({
      tabs: z.array(z.string()),
      default_tab: z.string(),
      sheet_url: z.string(),
    }),
    privileged: SHEET_CONTRACTS,
    async handler(ctx) {
      const tabs = sortTabs(await readTabs(ctx));
      return {
        tabs,
        default_tab: tabs[0] ?? "",
        sheet_url: SHEET_URL,
      };
    },
  }),

  getWeek: defineAction({
    description:
      "Reads one weekly tab live from the group-buy Sheet and returns its orders grouped by 訂單編號, each with name, customer note, item lines, picked-up state and pickup date-time (column I), plus the week's totals.",
    request: z.object({ tab: z.string().min(1).max(60) }),
    response: z.object({
      tab: z.string(),
      orders: z.array(orderShape),
      total_orders: z.number(),
      picked_count: z.number(),
    }),
    privileged: SHEET_CONTRACTS,
    async handler(ctx, args) {
      const { orders } = await loadWeek(ctx, args.tab);
      return {
        tab: args.tab,
        orders,
        total_orders: orders.length,
        picked_count: orders.filter((o) => o.picked_up).length,
      };
    },
  }),

  setPickedUp: defineAction({
    description:
      "Marks one order picked up (or back to not picked up) on the first row of that order's group in the given weekly tab: writes TRUE/FALSE to 已領取 (column H) and, in the same write, the current Winnipeg date-time to 領取日期時間 (column I) — or clears column I when marking back to not picked up. The group is located by 訂單編號 after a fresh read; no other row is touched.",
    request: z.object({
      tab: z.string().min(1).max(60),
      order_no: z.string().min(1).max(20),
      picked_up: z.boolean(),
    }),
    response: okResponse,
    privileged: SHEET_CONTRACTS,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const { firstRowByOrder, hasPickedAtHeader } = await loadWeek(ctx, args.tab);
      const row = firstRowByOrder.get(args.order_no);
      if (row == null) {
        throw new Error(
          `喺「${args.tab}」入面搵唔到訂單編號 ${args.order_no} — 可能已經俾人喺 Sheet 改咗，請重新載入再試。`,
        );
      }
      const pickedAt = args.picked_up ? nowWinnipeg() : "";
      try {
        // A tab created before column I existed gets its header first,
        // so the timestamp never lands in an unlabelled column.
        if (!hasPickedAtHeader) {
          await ctx.executePrivileged(privileged.sheetsWriteRange, {
            spreadsheetId: SPREADSHEET_ID,
            range: `${args.tab}!I1`,
            values: [["領取日期時間"]],
          });
        }
        await ctx.executePrivileged(privileged.sheetsWriteRange, {
          spreadsheetId: SPREADSHEET_ID,
          range: `${args.tab}!H${row}:I${row}`,
          values: [[args.picked_up ? "TRUE" : "FALSE", pickedAt]],
        });
      } catch {
        throw new Error("寫唔到去 Google Sheet，請檢查網絡再試。");
      }
      ctx.invalidateQueries();
      return { ok: true as const, picked_up: args.picked_up, picked_at: pickedAt };
    },
  }),
} satisfies ActionsModule;
