// Per-person keys, approved by the owner in a private Google Sheet (鑰匙簿).
//
// Sheet = env ACCESS_SHEET_ID, shared only with the owner + the service
// account. Two tabs (created on first use if missing):
//   鑰匙  A 名 · B 倉庫 ☐ · C 團購 ☐ · D 申請 · E 申請時間 · F Key 指紋
//   設定  A1 邀請碼 · B1 <code>   (blank B1 = registration closed)
// Ticking B / C approves that person for that app; unticking revokes it;
// deleting the row removes the key entirely. Only SHA-256 fingerprints of
// keys are stored — the key itself is shown once, to its owner.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { APPS, HttpError, legacyKeyOk, sheetsApi } from "./_lib.js";

export const KEYS_TAB = "鑰匙";
export const SETTINGS_TAB = "設定";
const HEADER = ["名", APPS.stock.label, APPS.groupbuy.label, "申請", "申請時間", "Key 指紋"];
const COL = { stock: 1, groupbuy: 2, requested: 3 }; // 0-based column of each field
const MAX_ROWS = 2000;
const MAX_PENDING = 20; // rows with no app ticked: past this, registration pauses
const CACHE_MS = 30_000;

export const accessSheetId = () => process.env.ACCESS_SHEET_ID || "";
export const fingerprint = (key) => createHash("sha256").update(String(key)).digest("hex");
const ticked = (v) => v === true || String(v ?? "").trim().toUpperCase() === "TRUE";
const quoted = (tab) => `'${tab.replace(/'/g, "''")}'`;

/** Winnipeg time, fixed UTC−5 (same rule as the group-buy app). */
export const winnipegNow = () => new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 16).replace("T", " ");

function sameSecret(a, b) {
  const x = createHash("sha256").update(String(a ?? "")).digest();
  const y = createHash("sha256").update(String(b ?? "")).digest();
  return timingSafeEqual(x, y);
}

// --- reading -----------------------------------------------------------------

let cache = null; // { at, data }

function parse(rows, inviteRows) {
  const users = [];
  rows.forEach((r, i) => {
    const hash = String(r[5] ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) return;
    const req = String(r[COL.requested] ?? "");
    users.push({
      row: i + 2, // 1-based sheet row (data starts on row 2)
      name: String(r[0] ?? "").trim(),
      hash,
      ok: { stock: ticked(r[COL.stock]), groupbuy: ticked(r[COL.groupbuy]) },
      requested: { stock: req.includes(APPS.stock.label), groupbuy: req.includes(APPS.groupbuy.label) },
    });
  });
  return { users, invite: String(inviteRows?.[0]?.[0] ?? "").trim() };
}

async function readRaw(id) {
  const get = (range) =>
    sheetsApi("GET", `${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`);
  const [keys, settings] = await Promise.all([
    get(`${quoted(KEYS_TAB)}!A2:F${MAX_ROWS}`),
    get(`${quoted(SETTINGS_TAB)}!B1:B1`),
  ]);
  return parse(keys.values ?? [], settings.values ?? []);
}

/** The whole 鑰匙簿, cached for 30 s unless `fresh`. Creates missing tabs. */
export async function loadAccess({ fresh = false } = {}) {
  const id = accessSheetId();
  if (!id) return { users: [], invite: "" };
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  let data;
  try {
    data = await readRaw(id);
  } catch (e) {
    // A missing tab reads as "Unable to parse range": set the sheet up once.
    if (!(e instanceof HttpError && e.status === 400)) throw e;
    await setup(id);
    data = await readRaw(id);
  }
  cache = { at: Date.now(), data };
  return data;
}

export function forgetCache() {
  cache = null;
}

/** Does this invite code match 設定!B1 (and is registration open)? */
export async function inviteOk(invite) {
  if (!accessSheetId() || typeof invite !== "string" || !invite) return false;
  const { invite: want } = await loadAccess();
  return !!want && sameSecret(invite, want);
}

/** The person this key belongs to, or null. */
export async function findUser(key, opts) {
  if (typeof key !== "string" || key.length < 20) return null;
  const h = fingerprint(key);
  return (await loadAccess(opts)).users.find((u) => u.hash === h) ?? null;
}

/** May this key open this app? Ticked in 鑰匙簿, or the optional old
 *  shared env key (STOCK_KEY / GROUPBUY_KEY) while people move over. */
export async function canUse(app, key) {
  if (!Object.hasOwn(APPS, app)) return false;
  if (legacyKeyOk(app, key)) return true;
  const u = await findUser(key);
  return !!u?.ok[app];
}

// --- writing -----------------------------------------------------------------

async function tabIds(id) {
  const r = await sheetsApi("GET", `${encodeURIComponent(id)}?fields=${encodeURIComponent("sheets.properties(sheetId,title)")}`);
  return Object.fromEntries((r.sheets ?? []).map((s) => [s.properties.title, s.properties.sheetId]));
}

const str = (v) => ({ userEnteredValue: { stringValue: String(v) } });
const bool = (v) => ({ userEnteredValue: { boolValue: !!v } });

/** Adds 鑰匙 / 設定 if they are missing (never touches existing tabs). */
async function setup(id) {
  const have = await tabIds(id);
  const used = new Set(Object.values(have));
  const newId = () => {
    let n;
    do n = randomInt(1, 2 ** 31 - 1);
    while (used.has(n));
    used.add(n);
    return n;
  };
  const requests = [];
  if (!(KEYS_TAB in have)) {
    const sheetId = newId();
    requests.push(
      { addSheet: { properties: { sheetId, title: KEYS_TAB, index: 0, gridProperties: { frozenRowCount: 1 } } } },
      { updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 }, rows: [{ values: HEADER.map(str) }], fields: "userEnteredValue" } },
      {
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, endRowIndex: MAX_ROWS, startColumnIndex: COL.stock, endColumnIndex: COL.groupbuy + 1 },
          rule: { condition: { type: "BOOLEAN" }, strict: true },
        },
      },
    );
  }
  if (!(SETTINGS_TAB in have)) {
    const sheetId = newId();
    requests.push(
      { addSheet: { properties: { sheetId, title: SETTINGS_TAB } } },
      {
        updateCells: {
          start: { sheetId, rowIndex: 0, columnIndex: 0 },
          rows: [
            { values: [str("邀請碼"), str(newInviteCode())] },
            { values: [str("說明"), str("邀請連結：https://<你個域名>/?invite=<上面個邀請碼>。清空 B1 = 暫停接受申請；改 B1 = 舊邀請連結即刻失效。")] },
          ],
          fields: "userEnteredValue",
        },
      },
    );
  }
  if (requests.length) await sheetsApi("POST", `${encodeURIComponent(id)}:batchUpdate`, { requests });
}

export function newInviteCode() {
  const abc = "23456789abcdefghjkmnpqrstuvwxyz"; // no 0/o/1/l/i
  return Array.from({ length: 12 }, () => abc[randomInt(abc.length)]).join("");
}

const appsText = (flags) => Object.keys(APPS).filter((a) => flags[a]).map((a) => APPS[a].label).join("、");

/** Invite link → new pending person. Returns their key (shown once). */
export async function register(invite, rawName, apps) {
  const id = accessSheetId();
  if (!id) throw new HttpError(404, "not_found", "not found");
  const data = await loadAccess({ fresh: true });
  if (!data.invite || !sameSecret(invite, data.invite)) throw new HttpError(404, "not_found", "not found");
  const name = String(rawName ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 30);
  if (!name) throw new HttpError(400, "bad_input", "請填你個名。");
  const want = Object.fromEntries(Object.keys(APPS).map((a) => [a, Array.isArray(apps) && apps.includes(a)]));
  if (!Object.values(want).some(Boolean)) throw new HttpError(400, "bad_input", "請揀最少一個 app。");
  const pending = data.users.filter((u) => !u.ok.stock && !u.ok.groupbuy).length;
  if (pending >= MAX_PENDING) throw new HttpError(429, "too_many", "而家等緊批准嘅申請太多，請直接搵管理員。");
  if (data.users.length + 1 >= MAX_ROWS) throw new HttpError(429, "too_many", "鑰匙簿滿咗，請搵管理員。");

  const key = randomBytes(24).toString("base64url"); // 192-bit
  const sheetId = (await tabIds(id))[KEYS_TAB];
  await sheetsApi("POST", `${encodeURIComponent(id)}:batchUpdate`, {
    requests: [
      {
        appendCells: {
          sheetId,
          rows: [{ values: [str(name), bool(false), bool(false), str(appsText(want)), str(winnipegNow()), str(fingerprint(key))] }],
          fields: "userEnteredValue",
        },
      },
    ],
  });
  forgetCache();
  await notifyOwner(name, appsText(want), "新申請");
  return { key, name };
}

/** A known person asks for one more app. Emails only the first time. */
export async function requestApp(key, app) {
  if (!Object.hasOwn(APPS, app)) throw new HttpError(400, "bad_input", "unknown app");
  const u = await findUser(key, { fresh: true });
  if (!u) throw new HttpError(404, "not_found", "not found");
  if (u.ok[app] || u.requested[app]) return u;
  const id = accessSheetId();
  const flags = { ...u.requested, [app]: true };
  // Re-read the row by its fingerprint just before writing (rows may move).
  const r = await sheetsApi("GET", `${encodeURIComponent(id)}/values/${encodeURIComponent(`${quoted(KEYS_TAB)}!F${u.row}:F${u.row}`)}`);
  if (String(r.values?.[0]?.[0] ?? "").trim().toLowerCase() !== u.hash) {
    throw new HttpError(409, "busy", "鑰匙簿啱啱有改動，請再試一次。");
  }
  const sheetId = (await tabIds(id))[KEYS_TAB];
  await sheetsApi("POST", `${encodeURIComponent(id)}:batchUpdate`, {
    requests: [
      {
        updateCells: {
          start: { sheetId, rowIndex: u.row - 1, columnIndex: COL.requested },
          rows: [{ values: [str(appsText(flags))] }],
          fields: "userEnteredValue",
        },
      },
    ],
  });
  forgetCache();
  await notifyOwner(u.name, APPS[app].label, "加申請");
  return { ...u, requested: flags };
}

// --- email to the owner (Resend) -----------------------------------------------

/** Emails NOTIFY_EMAIL through Resend (RESEND_API_KEY). Never throws: a
 *  failed email must not lose the request, which is already in the sheet. */
export async function notifyOwner(name, appsLabel, kind) {
  const to = process.env.NOTIFY_EMAIL;
  const apiKey = process.env.RESEND_API_KEY;
  if (!to || !apiKey) return false;
  const clean = (s) => String(s).replace(/[\r\n]+/g, " ").slice(0, 60);
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${accessSheetId()}/edit`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: process.env.NOTIFY_FROM || "鑰匙簿 <onboarding@resend.dev>",
        to: [to],
        subject: `【鑰匙簿】${clean(name)} ${kind}：${clean(appsLabel)}`,
        text:
          `${clean(name)} 申請用：${clean(appsLabel)}\n` +
          `時間（Winnipeg）：${winnipegNow()}\n\n` +
          `批准：打開鑰匙簿，喺佢嗰行剔「${APPS.stock.label}」／「${APPS.groupbuy.label}」。\n` +
          `唔批：唔使理，或者刪咗嗰行。\n\n${sheetUrl}\n`,
      }),
    });
    if (!res.ok) console.error("notify email failed", res.status, await res.text().catch(() => ""));
    return res.ok;
  } catch (e) {
    console.error("notify email failed", e);
    return false;
  }
}
