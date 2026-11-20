// Privileged host handlers: the only code in this Space that talks to
// Google Sheets. Action code imports the contract descriptors from
// `@space/privileged` and calls `ctx.executePrivileged(...)`; the handlers
// below run on the host and shell out to the Google Workspace CLI
// (`hatch_gws_cli sheets ...`), which carries the user's connected
// Google Sheets account. No credentials live here — auth stays in the CLI.

import { spawnSync } from "node:child_process";
import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";

const CLI = "/opt/hatch/bin/hatch_gws_cli";

export const privileged = definePrivilegedContracts({
  sheetsReadAll: {
    request: z.object({
      spreadsheetId: z.string().min(1),
      itemsRange: z.string().min(1),
      movementsRange: z.string().min(1),
    }),
    response: z.object({
      itemValues: z.array(z.array(z.string())),
      movementValues: z.array(z.array(z.string())),
    }),
    capabilities: ["google_sheets:spreadsheets.get"],
    timeoutMs: 30000,
  },
  // Generic single-range read (direct mode reads the items tab, the
  // movements tab and the 「Space 更新狀態」 tab independently).
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
  sheetsBatchUpdate: {
    request: z.object({
      spreadsheetId: z.string().min(1),
      requests: z.array(z.record(z.string(), z.unknown())),
    }),
    response: z.object({ ok: z.literal(true) }),
    capabilities: ["google_sheets:spreadsheets.batchUpdate"],
    timeoutMs: 30000,
  },
  // One-time structural change (user, 2026-11-18: 「拎走佢 A column ID」):
  // deletes column A (the ID column) of the given sheet tab via a
  // deleteDimension COLUMNS request, so the 貨品編號 becomes the Sheet's
  // primary key column. Only ever called by the removeSheetIdColumn
  // migration action, which is guarded by a sync_meta flag.
  deleteSheetColumnA: {
    request: z.object({
      spreadsheetId: z.string().min(1),
      sheetId: z.number().int().min(0),
    }),
    response: z.object({ ok: z.literal(true) }),
    capabilities: ["google_sheets:spreadsheets.batchUpdate"],
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
  sheetsReadAll(args) {
    return {
      itemValues: valuesGet(args.spreadsheetId, args.itemsRange),
      movementValues: valuesGet(args.spreadsheetId, args.movementsRange),
    };
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
  sheetsBatchUpdate(args) {
    runCli([
      "sheets",
      "spreadsheets",
      "batchUpdate",
      "--params",
      JSON.stringify({ spreadsheetId: args.spreadsheetId }),
      "--json",
      JSON.stringify({ requests: args.requests }),
    ]);
    return { ok: true as const };
  },
  deleteSheetColumnA(args) {
    runCli([
      "sheets",
      "spreadsheets",
      "batchUpdate",
      "--params",
      JSON.stringify({ spreadsheetId: args.spreadsheetId }),
      "--json",
      JSON.stringify({
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: args.sheetId,
                dimension: "COLUMNS",
                startIndex: 0,
                endIndex: 1,
              },
            },
          },
        ],
      }),
    ]);
    return { ok: true as const };
  },
});
