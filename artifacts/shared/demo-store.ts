// In-browser stand-in for Google Sheets, used only by the portfolio demo
// build (`__DEMO__`). It answers the same three tools the real connector
// does — get_values, get_spreadsheet, update_spreadsheet — with the same
// answer shapes, so every read/write path in the apps runs for real, just
// against sample data kept in this browser's localStorage instead of a
// Google Sheet. Nothing leaves the device.

import { demoSeed, type DemoSpreadsheet } from "./demo-data";

const STORAGE_KEY = "demo-sheets-v1";
const LATENCY_MS = 120;

let db: Record<string, DemoSpreadsheet> | null = null;

function load(): Record<string, DemoSpreadsheet> {
  if (db) return db;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) db = JSON.parse(raw);
  } catch {
    // storage blocked or corrupt: start from the seed
  }
  if (!db) db = demoSeed();
  return db;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    // storage blocked (private mode): the demo still works for this visit
  }
}

/** Puts the sample data back the way it started. */
export function resetDemoData() {
  db = demoSeed();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

class ToolError extends Error {
  code = "tool_error";
}

function sheet(id: string): DemoSpreadsheet {
  const s = load()[id];
  if (!s) throw new ToolError(`Requested entity was not found: ${id}`);
  return s;
}

const colNum = (s: string) => s.split("").reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0);

function parseRange(r: string) {
  const m = r.match(/^'?((?:[^']|'')+)'?!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!m) throw new ToolError("Unable to parse range: " + r);
  return { tab: m[1].replace(/''/g, "'"), c1: colNum(m[2]) - 1, r1: +m[3] - 1, c2: colNum(m[4]) - 1, r2: +m[5] - 1 };
}

function setCell(g: string[][], r: number, c: number, v: string) {
  while (g.length <= r) g.push([]);
  const row = g[r];
  while (row.length <= c) row.push("");
  row[c] = v;
}

function cellValue(cd: any): string {
  const u = cd?.userEnteredValue;
  if (!u) return "";
  if ("numberValue" in u) return String(u.numberValue);
  if ("boolValue" in u) return u.boolValue ? "TRUE" : "FALSE";
  return u.stringValue ?? "";
}

const tools: Record<string, (input: any) => unknown> = {
  get_values({ spreadsheetId, range }) {
    const p = parseRange(range);
    const t = sheet(spreadsheetId).tabs.find((x) => x.title === p.tab);
    if (!t) throw new ToolError("Unable to parse range: " + range);
    const rows = t.grid
      .slice(p.r1, p.r2 + 1)
      .map((r) => r.slice(p.c1, p.c2 + 1))
      .map((r) => {
        while (r.length && r[r.length - 1] === "") r.pop();
        return r;
      });
    while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
    return { range, values: rows };
  },

  get_spreadsheet({ spreadsheetId }) {
    return {
      sheets: sheet(spreadsheetId).tabs.map((t) => ({ properties: { sheetId: t.sheetId, title: t.title } })),
    };
  },

  update_spreadsheet({ spreadsheetId, requests }) {
    const s = sheet(spreadsheetId);
    const byId = (id: number) => {
      const t = s.tabs.find((x) => x.sheetId === id);
      if (!t) throw new ToolError(`No grid with id: ${id}`);
      return t;
    };
    // Apply to a copy so a bad request leaves the data untouched (batchUpdate is atomic).
    const before = JSON.stringify(s);
    try {
      for (const rq of requests as any[]) {
        if (rq.updateCells) {
          const { start, rows } = rq.updateCells;
          const t = byId(start.sheetId);
          rows.forEach((row: any, i: number) =>
            (row.values ?? []).forEach((cd: any, j: number) =>
              setCell(t.grid, start.rowIndex + i, start.columnIndex + j, cellValue(cd)),
            ),
          );
        } else if (rq.appendCells) {
          const t = byId(rq.appendCells.sheetId);
          let last = t.grid.length;
          while (last > 0 && t.grid[last - 1].every((x) => x === "")) last--;
          t.grid.length = last;
          for (const row of rq.appendCells.rows) t.grid.push((row.values ?? []).map(cellValue));
        } else if (rq.deleteDimension) {
          const { sheetId, startIndex, endIndex } = rq.deleteDimension.range;
          byId(sheetId).grid.splice(startIndex, endIndex - startIndex);
        } else if (rq.addSheet) {
          const { sheetId, title } = rq.addSheet.properties;
          s.tabs.push({ sheetId, title, grid: [] });
        } else {
          throw new ToolError("Unsupported request: " + Object.keys(rq).join(", "));
        }
      }
    } catch (e) {
      Object.assign(s, JSON.parse(before));
      throw e;
    }
    save();
    return { spreadsheetId, replies: requests.map(() => ({})) };
  },
};

/** Runs one Sheets tool against the demo data. */
export async function demoCall(tool: string, input: unknown): Promise<any> {
  await new Promise((r) => setTimeout(r, LATENCY_MS));
  const fn = tools[tool];
  if (!fn) throw new ToolError("Unknown tool: " + tool);
  // Hand back a deep copy, like a real network answer.
  return JSON.parse(JSON.stringify(fn(input)));
}
