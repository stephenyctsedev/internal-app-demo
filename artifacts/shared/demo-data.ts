// Sample data for the portfolio demo build (`__DEMO__`).
//
// Everything here is fictional: product codes, barcodes, customers and
// orders were made up for the demo. The shape matches the real Google
// Sheets exactly (same tabs, same header row, same cell formats), so the
// apps' data layers run unchanged on top of it.

export type DemoTab = { sheetId: number; title: string; grid: string[][] };
export type DemoSpreadsheet = { tabs: DemoTab[] };

export const DEMO_WAREHOUSE_SHEET_ID = "DEMO_WAREHOUSE_SHEET_ID";
export const DEMO_GROUPBUY_SHEET_ID = "DEMO_GROUPBUY_SHEET_ID";

const ITEMS_HEADER = ["貨品編號", "來源貨單", "英文名", "中文名", "包裝/規格", "條碼", "數量", "單位", "儲存", "低存量提示", "備註", "最後更新", "貨架狀態"];
const MOVES_HEADER = ["ID", "日期", "貨品ID", "貨品", "變動", "種類", "備註"];
const ORDERS_HEADER = ["訂單編號", "姓名", "客人備註", "貨品", "數量", "單位", "備註", "已領取", "領取日期時間"];

// code, source, English, Chinese, packing, barcode, qty, unit, storage, low, notes, updated, shelf
const ITEMS: string[][] = [
  ["1000101", "貨單 #10001", "Free Range Chicken", "走地雞", "7's", "2000000001019", "12", "Case", "冷凍 1F", "5", "", "2026-11-24T16:05:00.000Z", ""],
  ["1000102", "貨單 #10001", "White Shrimp 26-30 (P&D, Tail-on)", "26-30 去腸有尾白蝦肉", "10 x 1.6LB", "2000000001026", "8", "Case", "冷凍 1F", "3", "", "2026-11-24T16:05:00.000Z", ""],
  ["1000103", "貨單 #10001", "Spring Roll Pastry 10\"", "春卷皮 10 吋", "30 x 30pcs", "2000000001033", "3", "Case", "冷凍 2F", "4", "", "2026-11-23T18:20:00.000Z", "補貨架"],
  ["1000104", "貨單 #10001", "Wonton Wrapper 3.5\"", "炸雲吞皮", "27 x 500g", "2000000001040", "6", "Case", "冷凍 2F", "2", "", "2026-11-22T19:40:00.000Z", ""],
  ["1000105", "貨單 #10002", "Red Bean Bun", "紅豆包", "36 x 100g", "2000000001057", "2", "Case", "冷凍 2F", "3", "", "2026-11-25T15:10:00.000Z", ""],
  ["1000106", "貨單 #10002", "Leek & Egg Dumpling", "韭菜雞蛋水餃", "20 x 400g", "2000000001064", "5", "Case", "冷凍 1F", "2", "", "2026-11-21T17:00:00.000Z", ""],
  ["1000107", "貨單 #10002", "Shrimp & Pork Shumai", "鮮蝦肉燒賣", "12pcs", "2000000001071", "30", "Pack", "冷凍 1F", "10", "", "2026-11-25T20:30:00.000Z", ""],
  ["1000108", "貨單 #10002", "Bean Curd Roll", "鮮竹卷", "6pcs", "2000000001088", "18", "Pack", "冷凍 2F", "10", "", "2026-11-24T21:15:00.000Z", "補貨架"],
  ["1000109", "貨單 #10003", "Pork Meat Ball", "豬肉丸", "10 x 2LB", "2000000001095", "1", "Case", "冷凍 1F", "2", "", "2026-11-25T22:00:00.000Z", ""],
  ["1000110", "貨單 #10003", "Taiwanese Taro Cake", "台式芋頭糕", "12 x 1kg", "2000000001101", "4", "Case", "冷凍 2F", "", "", "2026-11-20T16:45:00.000Z", ""],
  ["1000111", "貨單 #10003", "Grilled Eel (Unagi)", "蒲燒鰻魚", "20 x 300g", "2000000001118", "1.5", "Case", "冷凍 1F", "1", "半箱已開", "2026-11-23T18:20:00.000Z", ""],
  ["1000112", "貨單 #10003", "Beef Chuck Roll", "牛肩肉", "20 KG", "", "40", "KG", "冷凍 1F", "15", "", "2026-11-24T16:05:00.000Z", ""],
  ["1000113", "手動新增", "Jasmine Rice", "茉莉香米", "25LB", "2000000001132", "14", "個", "dry", "5", "", "2026-11-19T15:00:00.000Z", ""],
  ["1000114", "手動新增", "Light Soy Sauce", "生抽", "12 x 500ml", "2000000001149", "3", "Box", "dry", "2", "", "2026-11-19T15:00:00.000Z", ""],
  ["1000115", "手動新增", "Shanghai Bok Choy", "上海白菜", "20LB", "", "2", "Box", "fresh", "", "星期五到貨", "2026-11-25T14:30:00.000Z", ""],
  ["TMP-001", "手動新增", "Sesame Balls", "芝麻球", "", "", "0", "Pack", "unclassified", "5", "未有條碼", "2026-11-25T23:10:00.000Z", ""],
];

// id, date, code, label, delta, kind, note
const MOVES: string[][] = [
  ["1", "2026-11-18T16:00:00.000Z", "1000101", "走地雞 · Free Range Chicken", "10", "initial", "期初存量"],
  ["2", "2026-11-18T16:00:00.000Z", "1000102", "26-30 去腸有尾白蝦肉 · White Shrimp", "6", "initial", "期初存量"],
  ["3", "2026-11-18T16:00:00.000Z", "1000103", "春卷皮 10 吋 · Spring Roll Pastry", "5", "initial", "期初存量"],
  ["4", "2026-11-18T16:00:00.000Z", "1000107", "鮮蝦肉燒賣 · Shrimp & Pork Shumai", "24", "initial", "期初存量"],
  ["5", "2026-11-20T17:30:00.000Z", "1000107", "鮮蝦肉燒賣 · Shrimp & Pork Shumai", "-6", "out", "團購出貨"],
  ["6", "2026-11-23T18:20:00.000Z", "1000103", "春卷皮 10 吋 · Spring Roll Pastry", "-2", "out", ""],
  ["7", "2026-11-23T18:20:00.000Z", "1000111", "蒲燒鰻魚 · Grilled Eel (Unagi)", "-0.5", "out", "半箱已開"],
  ["8", "2026-11-24T16:05:00.000Z", "1000101", "走地雞 · Free Range Chicken", "2", "in", "貨單 #10004"],
  ["9", "2026-11-24T16:05:00.000Z", "1000102", "26-30 去腸有尾白蝦肉 · White Shrimp", "2", "in", "貨單 #10004"],
  ["10", "2026-11-25T20:30:00.000Z", "1000107", "鮮蝦肉燒賣 · Shrimp & Pork Shumai", "12", "in", ""],
  ["11", "2026-11-25T22:00:00.000Z", "1000109", "豬肉丸 · Pork Meat Ball", "-1", "adjust", "盤點"],
];

type Line = [string, string, string, string, string];
type DemoOrder = { no: number; name: string; note: string; lines: Line[]; picked?: string };

function orderRows(orders: DemoOrder[]): string[][] {
  const rows: string[][] = [ORDERS_HEADER];
  for (const o of orders) {
    o.lines.forEach(([product, qty, unit, note], i) => {
      const row = [String(o.no), o.name, o.note, product, qty, unit, note];
      if (i === 0) row.push(o.picked ? "TRUE" : "FALSE", o.picked ?? "");
      rows.push(row);
    });
  }
  return rows;
}

const WEEK_1: DemoOrder[] = [
  { no: 1, name: "Alice", note: "", picked: "2026-11-16 11:05", lines: [["無激素雞翅", "10", "Lb", "", ""], ["蒲燒鰻魚", "2", "包", "", ""]] },
  { no: 2, name: "陳太", note: "", picked: "2026-11-16 11:40", lines: [["鮮蝦肉燒賣", "3", "包", "", ""]] },
  { no: 3, name: "Ben", note: "要袋", picked: "2026-11-16 12:10", lines: [["紫芋卷", "2", "包", "", ""], ["紅豆包", "1", "包", "", ""]] },
  { no: 4, name: "David", note: "", picked: "2026-11-16 13:30", lines: [["走地雞", "1", "隻", "", ""]] },
  { no: 5, name: "黃小姐", note: "", lines: [["鮮竹卷", "4", "包", "", ""], ["韭菜雞蛋水餃", "2", "包", "", ""]] },
];

const WEEK_2: DemoOrder[] = [
  { no: 1, name: "Alice", note: "", lines: [["無激素雞翅", "15", "Lb", "", ""], ["蒲燒鰻魚", "2", "包", "", ""]] },
  { no: 2, name: "小明", note: "", picked: "2026-11-23 10:00", lines: [["無激素雞翅", "5", "Lb", "", ""], ["鮑魚", "3", "包", "", ""]] },
  { no: 3, name: "Ben", note: "要袋", lines: [["紫芋卷", "2", "包", "", ""]] },
  { no: 4, name: "陳太", note: "下晝先到", lines: [["鮮蝦肉燒賣", "4", "包", "", ""], ["鮮竹卷", "2", "包", "", ""], ["台式芋頭糕", "1", "條", "", ""]] },
  { no: 5, name: "Cindy", note: "", picked: "2026-11-23 10:25", lines: [["走地雞", "2", "隻", "", ""]] },
  { no: 6, name: "李生", note: "", lines: [["26-30 白蝦肉", "2", "包", "", ""], ["豬肉丸", "1", "包", "", ""]] },
  { no: 7, name: "Emily", note: "代朋友取", lines: [["紅豆包", "2", "包", "", ""], ["芝麻球", "1", "包", "", ""]] },
  { no: 8, name: "Frank", note: "", picked: "2026-11-23 11:15", lines: [["韭菜雞蛋水餃", "3", "包", "", ""]] },
  { no: 9, name: "黃小姐", note: "", lines: [["鮮竹卷", "4", "包", "", ""], ["蒲燒鰻魚", "1", "包", "", ""]] },
  { no: 10, name: "Grace", note: "", lines: [["無激素雞翅", "10", "Lb", "", ""], ["台式芋頭糕", "1", "條", "", ""]] },
  { no: 11, name: "David", note: "", lines: [["走地雞", "1", "隻", "", ""], ["鮑魚", "2", "包", "", ""]] },
  { no: 12, name: "Alice", note: "第二張單", lines: [["鮮蝦肉燒賣", "2", "包", "", ""]] },
  { no: 24, name: "Henry", note: "", lines: [["牛肩肉", "2", "Lb", "", ""], ["上海白菜", "1", "包", "", ""]] },
];

/** A fresh copy of the seed data (callers may mutate it). */
export function demoSeed(): Record<string, DemoSpreadsheet> {
  const copy = (g: string[][]) => g.map((r) => r.slice());
  return {
    [DEMO_WAREHOUSE_SHEET_ID]: {
      tabs: [
        { sheetId: 0, title: "Sheet1", grid: copy([ITEMS_HEADER, ...ITEMS]) },
        { sheetId: 101, title: "出入記錄", grid: copy([MOVES_HEADER, ...MOVES]) },
        {
          sheetId: 102,
          title: "Space 更新狀態",
          grid: [
            ["項目", "內容"],
            ["呢版係乜（交接文件）", "示範資料 — demo data, not a real business"],
            ["最後更新時間 (Winnipeg)", "2026-11-25 18:10"],
            ["貨品總數", String(ITEMS.length)],
          ],
        },
      ],
    },
    [DEMO_GROUPBUY_SHEET_ID]: {
      tabs: [
        { sheetId: 201, title: "2026-11-16", grid: orderRows(WEEK_1) },
        { sheetId: 202, title: "2026-11-23", grid: orderRows(WEEK_2) },
      ],
    },
  };
}
