// Privileged host handlers: the only code in this Space that talks to
// Google Sheets. Action code imports the contract descriptors from
// `@space/privileged` and calls `ctx.executePrivileged(...)`; the handlers
// below run on the host and shell out to the Google Workspace CLI
// (`hatch_gws_cli sheets ...`), which carries the user's connected
// Google Sheets account. No credentials live here — auth stays in the CLI.
//
// Same proven pattern as the「倉庫存貨」Space (cang-ku-cun-huo).

import { spawnSync } from "node:child_process";
import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";

const CLI = "/opt/hatch/bin/hatch_gws_cli";

export const privileged = definePrivilegedContracts({
  // Workbook structure: the list of tab titles, in Sheet order. Used to
  // discover the weekly tabs.
  sheetsGetTabs: {
    request: z.object({
      spreadsheetId: z.string().min(1),
    }),
    response: z.object({
      tabs: z.array(z.string()),
    }),
    capabilities: ["google_sheets:spreadsheets.get"],
    timeoutMs: 30000,
  },
  // Generic single-range read (one weekly tab, columns A:I).
  sheetsReadRange: {
    request: z.object({
      spreadsheetId: z.string().min(1),
      range: z.string().min(1),
    }),
    response: z.object({
      values: z.array(z.array(z.string())),
    }),
    capabilities: ["google_sheets:spreadsheets.get"],
    timeoutMs: 30000,
  },
  // Single-range write — used only for an order group's first-row
  // H:I cells (已領取 + 領取日期時間), plus the I1 header when a tab
  // predates column I.
  sheetsWriteRange: {
    request: z.object({
      spreadsheetId: z.string().min(1),
      range: z.string().min(1),
      values: z.array(z.array(z.union([z.string(), z.number()]))),
    }),
    response: z.object({ updatedCells: z.number() }),
    capabilities: ["google_sheets:spreadsheets.values.update"],
    timeoutMs: 30000,
  },
});

type CliResult = Record<string, unknown>;

function runCli(args: string[]): CliResult {
  const result = spawnSync(CLI, args, {
    encoding: "utf8",
    timeout: 25000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`Google Sheets 連接失敗：${result.error.message}`);
  }
  const stdout = (result.stdout ?? "").trim();
  let parsed: CliResult;
  try {
    parsed = JSON.parse(stdout) as CliResult;
  } catch {
    throw new Error(
      `Google Sheets 回應讀唔到（${(result.stderr ?? "").slice(0, 200) || stdout.slice(0, 200)}）`,
    );
  }
  if (result.status !== 0 || parsed["ok"] === false) {
    const message =
      typeof parsed["error"] === "string"
        ? parsed["error"]
        : typeof parsed["message"] === "string"
          ? parsed["message"]
          : `Google Sheets 操作失敗（status ${result.status}）`;
    throw new Error(message);
  }
  return parsed;
}

function valuesGet(spreadsheetId: string, range: string): string[][] {
  const out = runCli([
    "sheets",
    "spreadsheets",
    "values",
    "get",
    "--params",
    JSON.stringify({ spreadsheetId, range }),
  ]);
  const values = out["values"];
  if (!Array.isArray(values)) return [];
  return values.map((row) =>
    Array.isArray(row) ? row.map((c) => (c == null ? "" : String(c))) : [],
  );
}

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  sheetsGetTabs(args) {
    const out = runCli([
      "sheets",
      "spreadsheets",
      "get",
      "--params",
      JSON.stringify({ spreadsheetId: args.spreadsheetId }),
    ]);
    const sheets = out["sheets"];
    const tabs: string[] = [];
    if (Array.isArray(sheets)) {
      for (const s of sheets) {
        if (s && typeof s === "object") {
          const props = (s as Record<string, unknown>)["properties"];
          if (props && typeof props === "object") {
            const title = (props as Record<string, unknown>)["title"];
            if (typeof title === "string" && title) tabs.push(title);
          }
        }
      }
    }
    return { tabs };
  },
  sheetsReadRange(args) {
    return { values: valuesGet(args.spreadsheetId, args.range) };
  },
  sheetsWriteRange(args) {
    const out = runCli([
      "sheets",
      "spreadsheets",
      "values",
      "update",
      "--params",
      JSON.stringify({
        spreadsheetId: args.spreadsheetId,
        range: args.range,
        valueInputOption: "RAW",
      }),
      "--json",
      JSON.stringify({ values: args.values }),
    ]);
    const cells = out["updatedCells"];
    return { updatedCells: typeof cells === "number" ? cells : 0 };
  },
});
