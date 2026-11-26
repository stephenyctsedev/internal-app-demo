// Per-person keys, approved by the owner in a private Google Sheet (鑰匙簿).
//
// Sheet = env ACCESS_SHEET_ID, shared only with the owner + the service
// account. Two tabs (created on first use if missing):
//   鑰匙  A 名 · B 倉庫 ▾ · C 團購 ▾ · D 申請 · E 申請時間 · F Key 指紋
//         (B / C: blank = no access · 閱讀 = read only · 寫入 = read + write)
//   裝置  A 名 · B 批准 ☐ · C 裝置 · D 登記時間 · E Key 指紋 · F Passkey ID · G 算法 · H 公鑰
//   設定  one invite code per row, found by the label in column A:
//         倉庫邀請碼 / 團購邀請碼 / 倉庫＋團購邀請碼 · B <code>  (blank = closed)
// The owner decides the apps: the invite link a person got sets what they
// ask for (they can't pick). Picking 閱讀 / 寫入 in B / C approves that
// person for that app — the owner may approve an app they never asked for;
// blanking it revokes; deleting the row removes the key entirely. 閱讀 is
// enforced by the server (api/sheets.js refuses every write), not just by
// the page hiding its buttons. Older sheets had ☐ checkboxes there: a
// ticked one counts as 寫入, and loadAccess() turns them into the dropdown
// once (see upgradeLevels). Only SHA-256 fingerprints of
// keys are stored — the key itself is shown once, to its owner.
//
// The key alone opens nothing: each device proves itself with a passkey
// (Face ID / fingerprint / screen lock), gets a row in 裝置, and only works
// once the owner ticks that row. A shared link therefore only lets someone
// *ask* for a device, which emails the owner (as does a new key).
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { APPS, HttpError, sheetsApi } from "./_lib.js";
import { ALGS, cookieName, readCookie, sessionCred } from "./_passkey.js";

export const KEYS_TAB = "鑰匙";
export const SETTINGS_TAB = "設定";
export const DEVICES_TAB = "裝置";
const DEVICE_HEADER = ["名", "批准", "裝置", "登記時間", "Key 指紋", "Passkey ID", "算法", "公鑰"];
const MAX_DEVICES = 4000;
const MAX_PENDING_DEVICES = 30; // across everyone
const MAX_PENDING_DEVICES_EACH = 3;
/** Invite rows in 設定 (column A label → which apps that link asks for). */
export const INVITES = [
  { label: `${APPS.stock.label}邀請碼`, apps: ["stock"] },
  { label: `${APPS.groupbuy.label}邀請碼`, apps: ["groupbuy"] },
  { label: `${APPS.stock.label}＋${APPS.groupbuy.label}邀請碼`, apps: ["stock", "groupbuy"] },
];
const HEADER = ["名", APPS.stock.label, APPS.groupbuy.label, "申請", "申請時間", "Key 指紋"];
const COL = { stock: 1, groupbuy: 2, requested: 3 }; // 0-based column of each field
const MAX_ROWS = 2000;
const MAX_PENDING = 20; // rows with no app ticked: past this, registration pauses
const CACHE_MS = 30_000;
const MISS_REFRESH_MS = 2_000;

export const accessSheetId = () => process.env.ACCESS_SHEET_ID || "";
export const fingerprint = (key) => createHash("sha256").update(String(key)).digest("hex");
const ticked = (v) => v === true || String(v ?? "").trim().toUpperCase() === "TRUE";

/** The two choices in 鑰匙!B:C. */
export const LEVELS = { read: "閱讀", write: "寫入" };
/** A 鑰匙!B / C cell → "write" | "read" | null. A ticked checkbox (sheets
 *  from before 閱讀／寫入) counts as 寫入, so nobody loses access. */
export function levelOf(v) {
  if (ticked(v)) return "write";
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s.includes("寫") || s.includes("写") || s === "write") return "write";
  if (s.includes("讀") || s.includes("读") || s.includes("閱") || s === "read") return "read";
  return null;
}
/** Still an old checkbox value (TRUE / FALSE), not a 閱讀／寫入 choice. */
const isCheckbox = (v) => typeof v === "boolean" || /^(TRUE|FALSE)$/i.test(String(v ?? "").trim());
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

function parse(rows, deviceRows, settingRows) {
  const users = [];
  rows.forEach((r, i) => {
    const hash = String(r[5] ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) return;
    const req = String(r[COL.requested] ?? "");
    users.push({
      row: i + 2, // 1-based sheet row (data starts on row 2)
      name: String(r[0] ?? "").trim(),
      hash,
      level: { stock: levelOf(r[COL.stock]), groupbuy: levelOf(r[COL.groupbuy]) },
      ok: { stock: !!levelOf(r[COL.stock]), groupbuy: !!levelOf(r[COL.groupbuy]) },
      requested: { stock: req.includes(APPS.stock.label), groupbuy: req.includes(APPS.groupbuy.label) },
    });
  });
  const devices = [];
  deviceRows.forEach((r, i) => {
    const keyHash = String(r[4] ?? "").trim().toLowerCase();
    const credId = String(r[5] ?? "").trim();
    const alg = Number(r[6]);
    const spki = String(r[7] ?? "").trim();
    if (!/^[0-9a-f]{64}$/.test(keyHash) || !credId || !ALGS[alg] || !spki) return;
    devices.push({ row: i + 2, name: String(r[0] ?? "").trim(), ok: ticked(r[1]), label: String(r[2] ?? ""), keyHash, credId, alg, spki });
  });
  // Invite codes are found by their label in column A, not by row number.
  const codes = new Map(settingRows.map((r) => [String(r[0] ?? "").trim(), String(r[1] ?? "").trim()]));
  const invites = INVITES.map((i) => ({ apps: i.apps, code: codes.get(i.label) ?? "" })).filter((i) => i.code);
  // Old ☐ cells still to turn into the 閱讀／寫入 dropdown (upgradeLevels).
  const checkboxes = [];
  rows.forEach((r, i) => {
    for (const app of ["stock", "groupbuy"]) {
      if (isCheckbox(r[COL[app]])) checkboxes.push({ row: i + 2, col: COL[app], write: ticked(r[COL[app]]) });
    }
  });
  return { users, devices, invites, checkboxes };
}

async function readRaw(id) {
  const get = (range) =>
    sheetsApi("GET", `${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`);
  const [keys, devices, settings] = await Promise.all([
    get(`${quoted(KEYS_TAB)}!A2:F${MAX_ROWS}`),
    get(`${quoted(DEVICES_TAB)}!A2:H${MAX_DEVICES}`),
    get(`${quoted(SETTINGS_TAB)}!A1:B20`),
  ]);
  return parse(keys.values ?? [], devices.values ?? [], settings.values ?? []);
}

/** The whole 鑰匙簿, cached for 30 s unless `fresh`. Creates missing tabs. */
export async function loadAccess({ fresh = false } = {}) {
  const id = accessSheetId();
  if (!id) return { users: [], devices: [], invites: [], checkboxes: [] };
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
  if (data.checkboxes.length) await upgradeLevels(id, data.checkboxes);
  cache = { at: Date.now(), data };
  return data;
}

/** One-off: the 倉庫 / 團購 cells of rows written before 閱讀／寫入 are
 *  ☐ checkboxes, which can't hold 閱讀. Turn each into the dropdown —
 *  ticked → 寫入 (same access as before), unticked → blank. Touches only
 *  cells still holding TRUE / FALSE, so running it twice is harmless.
 *  Best effort: access already reads a tick as 寫入, so a failure here
 *  changes nothing for anyone and is simply retried on the next read. */
async function upgradeLevels(id, cells) {
  try {
    const sheetId = (await tabIds(id))[KEYS_TAB];
    if (sheetId === undefined) return;
    await sheetsApi("POST", `${encodeURIComponent(id)}:batchUpdate`, {
      requests: cells.map((c) => ({
        updateCells: {
          start: { sheetId, rowIndex: c.row - 1, columnIndex: c.col },
          rows: [{ values: [level(c.write ? "write" : null)] }],
          fields: LEVEL_FIELDS,
        },
      })),
    });
  } catch (e) {
    console.error("鑰匙簿 upgrade to 閱讀／寫入 failed", e);
  }
}

export function forgetCache() {
  cache = null;
}

/** Which apps this invite code asks for, or null (wrong / closed). Checks
 *  every code in constant time, so timing never hints at a near match. */
export async function inviteApps(invite, opts) {
  if (!accessSheetId() || typeof invite !== "string" || !invite) return null;
  let hit = null;
  for (const i of (await loadAccess(opts)).invites) if (sameSecret(invite, i.code) && !hit) hit = i.apps;
  return hit;
}

/** find() on the cached 鑰匙簿; on a miss, re-read it — the row may have
 *  been written a moment ago by another server instance (Vercel runs
 *  several, each with its own 30 s cache) — but at most once every 2 s per
 *  instance, so wrong keys / stale cookies can't flood Google. */
async function lookup(find, opts = {}) {
  const hit = find(await loadAccess(opts));
  if (hit || opts.fresh) return hit ?? null;
  if (cache && Date.now() - cache.at < MISS_REFRESH_MS) return null;
  return find(await loadAccess({ fresh: true })) ?? null;
}

/** The person this key belongs to, or null. */
export async function findUser(key, opts) {
  if (typeof key !== "string" || key.length < 20) return null;
  const h = fingerprint(key);
  return lookup((d) => d.users.find((u) => u.hash === h), opts);
}

/** This person's devices (any state). */
export async function devicesOf(user) {
  return (await loadAccess()).devices.filter((d) => d.keyHash === user.hash);
}

export const findDevice = (user, credId, opts) =>
  lookup((d) => d.devices.find((x) => x.credId === credId && x.keyHash === user.hash), opts);

/** "approved" | "pending" | "none" for the device behind this request's
 *  session cookie (one cookie per key). */
export async function deviceState(user, cookieHeader) {
  const credId = sessionCred(readCookie(cookieHeader, cookieName(user.hash)), user.hash);
  if (!credId) return "none";
  const dev = await findDevice(user, credId);
  return !dev ? "none" : dev.ok ? "approved" : "pending";
}

/** What this request may do in this app: "write" | "read" | null (nothing).
 *  Needs the person set to 閱讀／寫入 for the app in 鑰匙 AND this device
 *  (its passkey session) ticked in 裝置. */
export async function accessLevel(app, key, cookieHeader) {
  if (!Object.hasOwn(APPS, app)) return null;
  const u = await findUser(key);
  if (!u?.level[app]) return null;
  return (await deviceState(u, cookieHeader)) === "approved" ? u.level[app] : null;
}

// --- writing -----------------------------------------------------------------

async function tabIds(id) {
  const r = await sheetsApi("GET", `${encodeURIComponent(id)}?fields=${encodeURIComponent("sheets.properties(sheetId,title)")}`);
  return Object.fromEntries((r.sheets ?? []).map((s) => [s.properties.title, s.properties.sheetId]));
}

const str = (v) => ({ userEnteredValue: { stringValue: String(v) } });
/** A checkbox cell. Carries its own validation: see setup() for why the
 *  column isn't pre-filled with checkboxes. */
const checkbox = (v) => ({
  userEnteredValue: { boolValue: !!v },
  dataValidation: { condition: { type: "BOOLEAN" }, strict: true },
  userEnteredFormat: { horizontalAlignment: "CENTER" },
});
/** A 鑰匙!B / C cell: dropdown of 閱讀 / 寫入 (blank = no access). */
const level = (v) => ({
  userEnteredValue: { stringValue: v ? LEVELS[v] : "" },
  dataValidation: {
    condition: { type: "ONE_OF_LIST", values: [{ userEnteredValue: LEVELS.read }, { userEnteredValue: LEVELS.write }] },
    strict: true,
    showCustomUi: true,
  },
  userEnteredFormat: { horizontalAlignment: "CENTER" },
});
const LEVEL_FIELDS = "userEnteredValue,dataValidation,userEnteredFormat.horizontalAlignment";

/** Adds 鑰匙 / 裝置 / 設定 if they are missing (never touches existing tabs). */
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
      // No column-wide dropdowns / checkboxes: each appended row brings
      // its own (level(), checkbox()), so appendCells always lands right
      // after the last person.
    );
  }
  if (!(DEVICES_TAB in have)) {
    const sheetId = newId();
    requests.push(
      { addSheet: { properties: { sheetId, title: DEVICES_TAB, index: 1, gridProperties: { frozenRowCount: 1 } } } },
      { updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 }, rows: [{ values: DEVICE_HEADER.map(str) }], fields: "userEnteredValue" } },
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
            ...INVITES.map((i) => ({ values: [str(i.label), str(newInviteCode())] })),
            { values: [] },
            {
              values: [
                str("說明"),
                str("邀請連結：https://<你個域名>/?invite=<上面其中一個邀請碼>。畀邊個碼，對方就只係申請到嗰個 app。清空 = 暫停嗰種邀請；改 = 舊連結即刻失效。"),
              ],
            },
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

/** Invite link → new pending person, asking for the apps that invite
 *  covers. Returns their key (shown once). */
export async function register(invite, rawName) {
  const id = accessSheetId();
  if (!id) throw new HttpError(404, "not_found", "not found");
  const data = await loadAccess({ fresh: true });
  const apps = await inviteApps(invite);
  if (!apps) throw new HttpError(404, "not_found", "not found");
  const name = String(rawName ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 30);
  if (!name) throw new HttpError(400, "bad_input", "請填你個名。");
  const want = Object.fromEntries(Object.keys(APPS).map((a) => [a, apps.includes(a)]));
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
          rows: [{ values: [str(name), level(null), level(null), str(appsText(want)), str(winnipegNow()), str(fingerprint(key))] }],
          fields: "userEnteredValue,dataValidation,userEnteredFormat.horizontalAlignment",
        },
      },
    ],
  });
  forgetCache();
  // Email now, and again once they register a device (see addDevice).
  await notifyOwner(`${clean(name)} 新申請：${appsText(want)}`, [
    `${clean(name)} 用邀請連結申請咗 key：${appsText(want)}`,
    `時間（Winnipeg）：${winnipegNow()}`,
    "",
    `佢仲未登記裝置；佢喺部機撳「登記呢部裝置」之後你會再收到一封 email。`,
    `批准：喺「鑰匙」tab 佢嗰行「${APPS.stock.label}」／「${APPS.groupbuy.label}」揀「${LEVELS.read}」（只可以睇）或者「${LEVELS.write}」（可以改），裝置登記咗之後再喺「裝置」tab 剔「批准」。`,
    `如果你唔認識呢個人（例如條連結畀咗人），可以刪咗「鑰匙」嗰行。`,
  ]);
  return { key, name };
}

/** User agent → "iPhone · Safari" (informational only). */
export function deviceLabel(ua, standalone) {
  ua = String(ua ?? "");
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Macintosh/.test(ua) ? (/Mobile/.test(ua) ? "iPad" : "Mac") : /Windows/.test(ua) ? "Windows"
    : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "裝置";
  const br = standalone ? "主畫面 app" : /Edg/.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung"
    : /CriOS|Chrome/.test(ua) ? "Chrome" : /FxiOS|Firefox/.test(ua) ? "Firefox" : /Safari/.test(ua) ? "Safari" : "瀏覽器";
  return `${os} · ${br}`;
}

/** A verified new passkey → pending row in 裝置 (idempotent per passkey),
 *  and an email to the owner. */
export async function addDevice(user, reg, label) {
  const id = accessSheetId();
  const data = await loadAccess({ fresh: true });
  const mine = data.devices.filter((d) => d.keyHash === user.hash);
  const same = mine.find((d) => d.credId === reg.credId);
  if (same) return same;
  if (mine.filter((d) => !d.ok).length >= MAX_PENDING_DEVICES_EACH) {
    throw new HttpError(429, "too_many", "已經有幾部裝置等緊批准，請直接搵管理員。");
  }
  if (data.devices.filter((d) => !d.ok).length >= MAX_PENDING_DEVICES || data.devices.length + 1 >= MAX_DEVICES) {
    throw new HttpError(429, "too_many", "而家等緊批准嘅裝置太多，請直接搵管理員。");
  }
  const sheetId = (await tabIds(id))[DEVICES_TAB];
  await sheetsApi("POST", `${encodeURIComponent(id)}:batchUpdate`, {
    requests: [
      {
        appendCells: {
          sheetId,
          rows: [
            {
              values: [str(user.name), checkbox(false), str(label), str(winnipegNow()), str(user.hash), str(reg.credId), str(reg.alg), str(reg.spki)],
            },
          ],
          fields: "userEnteredValue,dataValidation,userEnteredFormat.horizontalAlignment",
        },
      },
    ],
  });
  forgetCache();
  const isNew = mine.length === 0 && !user.ok.stock && !user.ok.groupbuy;
  const wants = appsText(user.requested) || "（未有）";
  await notifyOwner(
    `${clean(user.name)} 新裝置：${clean(label)}`,
    [
      `${clean(user.name)} 登記咗一部裝置：${clean(label)}`,
      `申請用：${wants}`,
      `時間（Winnipeg）：${winnipegNow()}`,
      "",
      isNew
        ? `批准：喺「鑰匙」tab 佢嗰行「${APPS.stock.label}」／「${APPS.groupbuy.label}」揀「${LEVELS.read}」或者「${LEVELS.write}」，再喺「裝置」tab 剔「批准」。`
        : `批准呢部裝置：喺「裝置」tab 剔「批准」。`,
      `如果唔係佢本人（例如條連結畀咗人），唔好剔，可以刪咗「裝置」嗰行。`,
    ],
  );
  return { ...reg, ok: false, keyHash: user.hash };
}

// --- email to the owner (Resend) -----------------------------------------------

const clean = (s) => String(s).replace(/[\r\n]+/g, " ").slice(0, 60);

/** Emails NOTIFY_EMAIL through Resend (RESEND_API_KEY). Never throws: a
 *  failed email must not lose the request, which is already in the sheet. */
export async function notifyOwner(subject, lines) {
  const to = process.env.NOTIFY_EMAIL;
  const apiKey = process.env.RESEND_API_KEY;
  if (!to || !apiKey) return false;
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${accessSheetId()}/edit`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: process.env.NOTIFY_FROM || "鑰匙簿 <onboarding@resend.dev>",
        to: [to],
        subject: `【鑰匙簿】${clean(subject)}`,
        text: `${lines.join("\n")}\n\n${sheetUrl}\n`,
      }),
    });
    if (!res.ok) console.error("notify email failed", res.status, await res.text().catch(() => ""));
    return res.ok;
  } catch (e) {
    console.error("notify email failed", e);
    return false;
  }
}
