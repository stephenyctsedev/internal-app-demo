// POST /api/sheets  {app, tool, input}  (header x-app-key)
// Server side of the web build's Sheets transport: the same three tools the
// claude.ai artifacts use through the Google Sheets connector, answered with
// the same shapes, but only for the spreadsheet that ?app= is allowed to use.
// A person set to 閱讀 (read only) for that app in the 鑰匙簿 gets the two
// read tools only; every update_spreadsheet is refused here, whatever the
// page sends.
import { APPS, HttpError, securityHeaders, serviceAccountEmail, sheetsApi } from "./_lib.js";
import { accessLevel } from "./_access.js";
import { langOf } from "./_i18n.js";

const ALLOWED_REQUESTS = new Set(["updateCells", "appendCells", "deleteDimension"]);

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") return JSON.parse(req.body);
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8"));
    return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 4 * 1024 * 1024) throw new HttpError(413, "tool_error", "Request too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function run(tool, input, spreadsheetId) {
  const id = encodeURIComponent(spreadsheetId);
  switch (tool) {
    case "get_values": {
      if (typeof input?.range !== "string") throw new HttpError(400, "tool_error", "range missing");
      const r = await sheetsApi("GET", `${id}/values/${encodeURIComponent(input.range)}`);
      return { range: r.range, values: r.values ?? [] };
    }
    case "get_spreadsheet": {
      const r = await sheetsApi("GET", `${id}?fields=${encodeURIComponent("sheets.properties(sheetId,title)")}`);
      return { sheets: r.sheets ?? [] };
    }
    case "update_spreadsheet": {
      const requests = input?.requests;
      if (!Array.isArray(requests) || requests.length === 0 || requests.length > 1000) {
        throw new HttpError(400, "tool_error", "requests missing");
      }
      for (const rq of requests) {
        const keys = rq && typeof rq === "object" ? Object.keys(rq) : [];
        if (keys.length !== 1 || !ALLOWED_REQUESTS.has(keys[0])) {
          throw new HttpError(400, "tool_error", `unsupported request ${keys.join(",")}`);
        }
      }
      const r = await sheetsApi("POST", `${id}:batchUpdate`, { requests });
      return { spreadsheetId, replies: r.replies ?? [] };
    }
    default:
      throw new HttpError(400, "tool_error", `unknown tool ${tool}`);
  }
}

export default async function handler(req, res) {
  securityHeaders(res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const send = (status, body) => {
    res.statusCode = status;
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method !== "POST") throw new HttpError(405, "tool_error", "POST only");
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, "tool_error", "invalid JSON");
    }
    const app = body?.app;
    if (typeof app !== "string" || !Object.hasOwn(APPS, app)) throw new HttpError(400, "tool_error", "unknown app");
    const level = await accessLevel(app, req.headers["x-app-key"], req.headers.cookie);
    if (!level) throw new HttpError(401, "bad_key", "bad key");
    const { spreadsheetId } = APPS[app];
    if (body.input?.spreadsheetId !== spreadsheetId) {
      throw new HttpError(403, "tool_error", "spreadsheet not allowed for this app");
    }
    if (body.tool === "update_spreadsheet" && level !== "write") {
      throw new HttpError(403, "read_only", "你只有閱讀權限，改唔到 Sheet。要改嘢請搵管理員。");
    }
    send(200, await run(body.tool, body.input, spreadsheetId));
  } catch (e) {
    if (e instanceof HttpError) {
      // The one message the app shows as-is (shared/sheets.ts webFriendly).
      const en = langOf(req) === "en";
      const message =
        e.code === "no_access" && en
          ? `The service account can't open this Google Sheet — in the Sheet tap "Share" and add ${serviceAccountEmail() || "the service account's email"} as an Editor.`
          : e.code === "read_only" && en
            ? "You have read-only access and can't change the Sheet. Ask the admin if you need to make changes."
            : e.message;
      send(e.status, { error: { code: e.code, message } });
    }
    else {
      console.error(e);
      send(502, { error: { code: "upstream_error", message: "server error" } });
    }
  }
}
