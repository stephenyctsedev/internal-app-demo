// End-to-end test of the Vercel web build without Google: run `npm run build`
// at the repo root first, then `node artifacts/test/web_e2e.mjs`.
// Starts dev-server.mjs with the real /api handlers, but globalThis.fetch is
// stubbed so oauth2/sheets.googleapis.com are answered from mock.js's
// in-memory sheets (plus an empty 鑰匙簿) and api.resend.com is caught.
// Chromium's virtual authenticator plays Face ID. Covers: the dead-page gate,
// invite → device passkey → owner ticks person + device → both apps work;
// the same link on another device (blocked, owner emailed); a synced passkey
// in another cookie jar (home-screen app) unlocking without a new device;
// revoking devices / people / invites; 閱讀 (read only) vs 寫入 per app,
// enforced by /api/sheets; old ☐ cells upgraded to the 閱讀／寫入 dropdown;
// the owner's 管理 page (/?admin=…): pick apps → invite link, 1-use /
// expiring links, stopping links, old fixed 設定 codes still honoured.
import { readFileSync } from "node:fs";
import { generateKeyPairSync, createVerify } from "node:crypto";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

// --- fake env ---------------------------------------------------------------
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ACCESS = "access-sheet-test-id";
process.env.ACCESS_SHEET_ID = ACCESS;
process.env.NOTIFY_EMAIL = "owner@example.com";
process.env.RESEND_API_KEY = "re_test";
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: "bot@test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});

// --- fake Google, backed by mock.js -----------------------------------------
const win = {};
vm.runInNewContext(readFileSync(new URL("mock.js", import.meta.url), "utf8"), { window: win, setTimeout });
win.__lat = 5;
win.__ss[ACCESS] = { tabs: [{ sheetId: 0, title: "工作表1", grid: [] }] }; // fresh, empty 鑰匙簿
const emails = [];
let emailDown = false;
const mcp = await win.claude.use("mcp");
const tool = async (t, input) => (await mcp.callTool("Google Sheets", t, input)).payload;
const calls = [];
const accessWrites = []; // batchUpdate bodies sent to the 鑰匙簿
const realFetch = globalThis.fetch;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.host === "oauth2.googleapis.com") {
    const jwt = new URLSearchParams(String(init.body)).get("assertion").split(".");
    const ok = createVerify("RSA-SHA256").update(jwt[0] + "." + jwt[1]).verify(publicKey, jwt[2], "base64url");
    return ok ? json(200, { access_token: "tok", expires_in: 3600 }) : json(400, { error: "invalid_grant" });
  }
  if (u.host === "api.resend.com") {
    const b = JSON.parse(init.body);
    if (init.headers?.authorization !== "Bearer re_test" || emailDown) return json(500, { message: "down" });
    emails.push(b);
    return json(200, { id: "e" + emails.length });
  }
  if (u.host === "sheets.googleapis.com") {
    if (init.headers?.authorization !== "Bearer tok") return json(401, { error: { message: "no auth" } });
    const m = u.pathname.match(/^\/v4\/spreadsheets\/([^/:]+)(?::batchUpdate|\/values\/(.+))?$/);
    const id = decodeURIComponent(m[1]);
    calls.push(init.method + " " + u.pathname); if (process.env.DBG) console.log("G", init.method, decodeURIComponent(u.pathname), u.search);
    try {
      if (m[2]) return json(200, await tool("get_values", { spreadsheetId: id, range: decodeURIComponent(m[2]) }));
      if (u.pathname.endsWith(":batchUpdate")) {
        if (id === ACCESS) accessWrites.push(JSON.parse(init.body));
        return json(200, (await tool("update_spreadsheet", { spreadsheetId: id, ...JSON.parse(init.body) })).content);
      }
      return json(200, (await tool("get_spreadsheet", { spreadsheetId: id })).content);
    } catch (e) {
      return json(400, { error: { message: e.message } });
    }
  }
  return realFetch(url, init);
};

const { startServer } = await import("../../dev-server.mjs");
const server = await startServer(0);
const base = `http://localhost:${server.address().port}`;
let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`);
  if (!ok) failed++;
};
const { forgetCache } = await import("../../api/_access.js");
const { PAGES } = await import("../../api/_pages.js");
const { withLevel } = await import("../../api/app.js");
const { createHash } = await import("node:crypto");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const tab = (t) => win.__ss[ACCESS].tabs.find((x) => x.title === t);
const isDead = (text) => !/key|密碼|stock|groupbuy|app=|鑰匙|申請|裝置/i.test(text) && text.includes("<svg");
const accessReq = (body, headers = {}) =>
  realFetch(base + "/api/access", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const sheetsReq = (headers, body) =>
  realFetch(base + "/api/sheets", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const get = (q, headers = {}) => realFetch(`${base}/${q}`, { headers });
const code = (label) => tab("設定").grid.find((row) => row[0] === label)?.[1];
const GB = "DEMO_GROUPBUY_SHEET_ID";
const WH = "DEMO_WAREHOUSE_SHEET_ID";
const tick = (t, row, col, v) => { tab(t).grid[row][col] = v ? "TRUE" : "FALSE"; forgetCache(); };
/** Owner picks 閱讀 / 寫入 / blank in 鑰匙 (col 1 = 倉庫, 2 = 團購). */
const setLevel = (row, col, v) => { tab("鑰匙").grid[row][col] = v; forgetCache(); };
let r, text;

// --- setup + gate -----------------------------------------------------------------
r = await get("?invite=wrong");
check("wrong invite → dead page", r.status === 404 && isDead(await r.text()));
check("first use created 鑰匙 / 裝置 / 邀請 / 設定", tab("鑰匙")?.grid[0].join("|") === "名|倉庫|團購|申請|申請時間|Key 指紋" &&
  tab("裝置")?.grid[0].join("|") === "名|批准|裝置|登記時間|Key 指紋|Passkey ID|算法|公鑰" &&
  tab("邀請")?.grid[0].join("|") === "邀請碼|倉庫|團購|畀邊個|建立時間|到期|可用次數|已用" && !!tab("設定"));
check("original tab left alone", win.__ss[ACCESS].tabs[0].title === "工作表1");
const admin = code("管理碼");
check("設定 has a long 管理碼 and no fixed invite codes", /^[a-z2-9]{24}$/.test(admin ?? "") && !code("倉庫邀請碼") && !code("團購邀請碼") && !code("倉庫＋團購邀請碼"));
for (const q of ["?admin=wrong", "?admin=", `?admin=${admin}&key=${"k".repeat(32)}`, `?admin=${admin}&invite=x`, `?admin=${admin}&app=stock`]) {
  r = await get(q);
  check(`GET /${q.replace(admin, "<管理碼>")} → dead`, r.status === 404 && isDead(await r.text()), `→ ${r.status}`);
}
r = await get(`?admin=${admin}`);
text = await r.text();
check("GET /?admin=<管理碼> → 管理 page", r.status === 200 && text.includes("整條連結"));
{
  const hrefs = [...text.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  const codes = await Promise.all(hrefs.map(async (h) => (await realFetch(base + h)).status));
  const mf = await (await realFetch(base + "/icons/admin.webmanifest")).json();
  check("管理 page links its 4 icon files, all load; manifest keeps the page URL", hrefs.length === 4 && hrefs.every((h) => h.includes("admin")) &&
    codes.every((c) => c === 200) && !("start_url" in mf) && mf.short_name === "邀請", JSON.stringify(hrefs));
}
r = await accessReq({ action: "admin-create", admin: "wrong".repeat(5), apps: ["stock"] });
check("admin api with wrong 管理碼 → 404, nothing written", r.status === 404 && tab("邀請").grid.length === 1);
r = await accessReq({ action: "admin-create", admin, apps: ["nope"] });
check("admin api: no real app picked → 400", r.status === 400 && tab("邀請").grid.length === 1);
r = await accessReq({ action: "admin-create", admin, apps: ["stock"], days: -3 });
check("admin api: bad expiry → 400", r.status === 400);
const mkInvite = async (apps, extra = {}) => (await (await accessReq({ action: "admin-create", admin, apps, uses: null, days: null, ...extra })).json()).invite.code;
const inv = { groupbuy: await mkInvite(["groupbuy"]), both: await mkInvite(["stock", "groupbuy", "nope"]) };
{
  const row = tab("邀請").grid.find((x) => x[0] === inv.both);
  check("邀請 row: code, ☑ 倉庫 ☑ 團購, time, no expiry / limit, 已用 0", /^[a-z2-9]{16}$/.test(inv.both) && row[1] === "TRUE" && row[2] === "TRUE" &&
    /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(row[4]) && row[5] === "" && row[6] === "" && row[7] === "0", JSON.stringify(row));
}
for (const q of ["?app=stock", "?app=stock&key=wrong", "?app=nope&key=x", "", "?app=&key=", "?key=" + "k".repeat(32), `?invite=${inv.groupbuy}&app=stock`]) {
  r = await get(q);
  check(`GET /${q} → dead`, r.status === 404 && isDead(await r.text()), `→ ${r.status}`);
}
check("dead page links no icon / manifest", !/<link/i.test(await (await get("?app=stock&key=wrong")).text()));
r = await accessReq({ action: "register", invite: "nope", name: "x" });
check("api register with wrong invite → 404", r.status === 404);
r = await accessReq({ action: "register", invite: inv.groupbuy, name: "  " });
check("api register without name → 400", r.status === 400 && tab("鑰匙").grid.length === 1);
r = await accessReq({ action: "request", key: "x".repeat(32), app: "groupbuy" });
check("no self-service app request", r.status === 400);
for (const [which, want, not] of [["groupbuy", "團購記錄", "倉庫存貨"], ["both", "倉庫存貨", null]]) {
  const html = await (await get(`?invite=${inv[which]}`)).text();
  check(`${which} invite form lists only its apps`, html.includes(want) && (!not || !html.includes(not)) && !html.includes('type="checkbox"'));
}

// --- devices (Chromium contexts, each with its own virtual Face ID) ---------------------
const browser = await chromium.launch();
const errs = [];
async function device() {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errs.push(String(e)));
  if (process.env.DBG) page.on("console", (m) => console.log("C", m.text()));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const cookie = async () => (await ctx.cookies()).filter((c) => c.name.startsWith("sw_")).map((c) => `${c.name}=${c.value}`).join("; ");
  return { ctx, page, cdp, authenticatorId, cookie };
}
// the owner makes 阿明's link on the 管理 page (defaults: 倉庫 only, 1 use, 7 days)
const O = await device();
O.page.on("dialog", (d) => d.accept());
await O.ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
await O.page.goto(`${base}/?admin=${admin}`);
await O.page.waitForSelector(".inv");
check("管理 page lists the links made so far", (await O.page.locator(".inv").count()) === 2 && (await O.page.locator("#legacy").isHidden()));
check("管理 page: 倉庫 ticked by default, 團購 not", (await O.page.isChecked("input[value=stock]")) && !(await O.page.isChecked("input[value=groupbuy]")));
await O.page.uncheck("input[value=stock]");
await O.page.click("text=整條連結");
check("管理 page: nothing picked → asks for an app", (await O.page.innerText("#err")).includes("最少揀一個"));
await O.page.check("input[value=stock]");
await O.page.fill("input[name=note]", "阿明");
await O.page.click("text=整條連結");
await O.page.waitForSelector("#out:not([hidden])");
const amLink = await O.page.inputValue("#link");
inv.stock = new URL(amLink).searchParams.get("invite");
check("管理 page: new link shown", amLink.startsWith(`${base}/?invite=`) && /^[a-z2-9]{16}$/.test(inv.stock), amLink);
check("管理 page: WhatsApp button carries the link", decodeURIComponent((await O.page.getAttribute("#wa", "href")).split("text=")[1]).endsWith(amLink));
await O.page.click("#copy");
check("管理 page: 複製 copies the link", (await O.page.evaluate(() => navigator.clipboard.readText())) === amLink);
{
  const row = tab("邀請").grid.find((x) => x[0] === inv.stock);
  const days = (Date.parse(row?.[5].replace(" ", "T") + "Z") - Date.parse(row?.[4].replace(" ", "T") + "Z")) / 86400_000;
  check("邀請 row: 倉庫 only, 畀 阿明, 7 days, 1 use", row[1] === "TRUE" && row[2] === "FALSE" && row[3] === "阿明" && days === 7 && row[6] === "1" && row[7] === "0", JSON.stringify(row));
}
check("管理 page: list now has 3 links, newest first", (await O.page.locator(".inv").count()) === 3 && (await O.page.locator(".inv").first().innerText()).includes("阿明"));
await O.page.screenshot({ path: new URL("web_admin.png", import.meta.url).pathname });

const A = await device(); // 阿明's phone
const page = A.page;

await page.goto(`${base}/?app=stock&key=nope`);
check("UI wrong key: no text, only the picture", (await page.innerText("body")).trim() === "" && (await page.title()).trim().replace(/\u200b/g, "") === "" && (await page.locator("svg").count()) === 1);
await page.screenshot({ path: new URL("web_dead.png", import.meta.url).pathname });

// 阿明 gets the 倉庫 invite
await page.goto(`${base}/?invite=${inv.stock}`);
check("stock invite form shows 倉庫 only", /批准之後可以用：\s*倉庫存貨\s*$/m.test(await page.innerText("form")) && !(await page.innerText("body")).includes("團購"));
await page.screenshot({ path: new URL("web_invite.png", import.meta.url).pathname });
await page.click("text=遞交申請");
check("form needs a name", (await page.innerText("#err")).includes("名"));
await page.fill("input[name=name]", "阿明 <b>");
await page.click("text=遞交申請");
await page.waitForURL(/\/\?key=/, { timeout: 8000 });
const myKey = new URL(page.url()).searchParams.get("key");
const mk = encodeURIComponent(myKey);
check("got a long random key", /^[A-Za-z0-9_-]{32}$/.test(myKey), myKey);
let body = await page.innerText("body");
check("key page: asks to register this device; 倉庫 等緊批准; no 開啟", body.includes("登記呢部裝置") && body.includes("阿明 <b>") &&
  /倉庫存貨\s*等緊批准/.test(body) && !body.includes("團購") && (await page.locator("#unlock").count()) === 0 && (await page.locator("a.btn").count()) === 0, body.replace(/\s+/g, " "));
await page.screenshot({ path: new URL("web_key_register.png", import.meta.url).pathname });
const amRow = tab("鑰匙").grid[1];
check("鑰匙 row: both apps blank, 申請=倉庫, fingerprint only", amRow[0] === "阿明 <b>" && amRow[1] === "" && amRow[2] === "" && amRow[3] === "倉庫" &&
  amRow[5] === sha(myKey) && !JSON.stringify(win.__ss[ACCESS]).includes(myKey), JSON.stringify(amRow));
check("owner emailed on applying: 新申請 with the apps + the link's note", emails.length === 1 && emails[0].subject.includes("阿明") && emails[0].subject.includes("新申請：倉庫") &&
  emails[0].text.includes("未登記裝置") && emails[0].text.includes("邀請連結備註：阿明") && emails[0].text.includes(ACCESS), emails[0]?.subject);
check("1-use link: counted, then dead", tab("邀請").grid.find((x) => x[0] === inv.stock)?.[7] === "1" && (await get(`?invite=${inv.stock}`)).status === 404);
r = await accessReq({ action: "register", invite: inv.stock, name: "第二個人" });
check("1-use link: a second sign-up → 404, no new row", r.status === 404 && tab("鑰匙").grid.length === 2);
await O.page.reload();
await O.page.waitForSelector(".inv");
{
  const first = O.page.locator(".inv").first();
  const t = await first.innerText();
  check("管理 page: used-up link shows 用完 · 已用：1 / 1, no 複製", t.includes("用完") && t.includes("已用：1 / 1") && (await first.locator("text=複製").count()) === 0, t.replace(/\s+/g, " "));
  await first.locator("text=停用").click();
  await O.page.waitForFunction(() => document.querySelectorAll(".inv").length === 2);
  check("管理 page: 停用 deletes its 邀請 row", !tab("邀請").grid.some((x) => x[0] === inv.stock) && tab("邀請").grid.length === 3);
}

// registers this phone with "Face ID"
await page.click("#enroll");
await page.waitForSelector("text=呢部裝置等緊批准", { timeout: 15000 });
await page.screenshot({ path: new URL("web_key_pending.png", import.meta.url).pathname });
{
  const cells = accessWrites.findLast((w) => w.requests?.[0]?.appendCells?.rows?.[0]?.values?.length === 6)?.requests[0].appendCells.rows[0].values ?? [];
  const dv = cells[1]?.dataValidation;
  check("new 鑰匙 row: 倉庫 / 團購 are 閱讀／寫入 dropdowns", dv?.condition?.type === "ONE_OF_LIST" && dv.strict &&
    dv.condition.values.map((v) => v.userEnteredValue).join("|") === "閱讀|寫入" && JSON.stringify(cells[2]?.dataValidation) === JSON.stringify(dv), JSON.stringify(cells[1]));
}
const devA = tab("裝置").grid[1];
check("裝置 row: unticked, label, fingerprint, passkey id, ES256 public key", devA?.[0] === "阿明 <b>" && devA[1] === "FALSE" && devA[2] === "Linux · Chrome" &&
  devA[4] === sha(myKey) && devA[5].length > 10 && devA[6] === "-7" && devA[7].startsWith("MFkw"), JSON.stringify(devA));
check("owner emailed again: 新裝置 with the device and apps", emails.length === 2 && emails[1].subject.includes("阿明") && emails[1].subject.includes("新裝置：Linux · Chrome") &&
  emails[1].text.includes("申請用：倉庫") && emails[1].text.includes("「鑰匙」tab") && emails[1].text.includes(ACCESS), emails[1]?.subject);
const ckA = await A.cookie();
const cookA = (await A.ctx.cookies()).find((c) => c.name.startsWith("sw_"));
check("session cookie: HttpOnly, Lax, per key", cookA?.httpOnly && cookA.sameSite === "Lax" && cookA.name === "sw_" + sha(myKey).slice(0, 12));
r = await sheetsReq({ "x-app-key": myKey, cookie: ckA }, { app: "stock", tool: "get_spreadsheet", input: { spreadsheetId: WH } });
check("nothing approved yet: api → 401", r.status === 401);

// owner sets 阿明 to 寫入 for 倉庫 — but the device is still pending
setLevel(1, 1, "寫入");
r = await get(`?app=stock&key=${mk}`, { cookie: ckA });
check("person ok, device pending: app URL → key page", r.status === 200 && (await r.text()).includes("呢部裝置等緊批准"));
r = await sheetsReq({ "x-app-key": myKey, cookie: ckA }, { app: "stock", tool: "get_spreadsheet", input: { spreadsheetId: WH } });
check("person ok, device pending: api → 401", r.status === 401);
r = await accessReq({ action: "status", key: myKey }, { cookie: ckA });
check("status says device pending", (await r.json()).device === "pending");

// owner ticks the device
tick("裝置", 1, 1, true);
await page.reload();
check("key page: 開啟 倉庫", (await page.getAttribute("a.btn.stock", "href")) === `/?app=stock&key=${mk}` && !(await page.innerText("body")).includes("登記呢部裝置"));
await page.screenshot({ path: new URL("web_key.png", import.meta.url).pathname });
r = await get(`?app=stock&key=${mk}`, { cookie: ckA });
check("approved: stock app opens, told 寫入", r.status === 200 && (await r.text()) === withLevel(PAGES.stock, "write") &&
  withLevel(PAGES.stock, "write").includes('<meta name="app-access" content="write" />'));
r = await get(`?app=stock&key=${mk}`);
check("…but not without this device's cookie", (await r.text()).includes("確認呢部裝置"));
r = await sheetsReq({ "x-app-key": myKey, cookie: ckA }, { app: "stock", tool: "get_spreadsheet", input: { spreadsheetId: WH } });
check("approved: stock api ok", r.status === 200);
r = await sheetsReq({ "x-app-key": myKey }, { app: "stock", tool: "get_spreadsheet", input: { spreadsheetId: WH } });
check("api without cookie → 401", r.status === 401);
r = await sheetsReq({ "x-app-key": myKey, cookie: ckA.replace(/.$/, (c) => (c === "A" ? "B" : "A")) }, { app: "stock", tool: "get_spreadsheet", input: { spreadsheetId: WH } });
check("api with tampered cookie → 401", r.status === 401);
r = await sheetsReq({ "x-app-key": myKey, cookie: ckA }, { app: "groupbuy", tool: "get_spreadsheet", input: { spreadsheetId: GB } });
check("not ticked for 團購: api → 401", r.status === 401);

// owner also sets 團購 (never asked) to 寫入 → works, no extra email
setLevel(1, 2, "寫入");
const auth = { "x-app-key": myKey, cookie: ckA };
r = await sheetsReq(auth, { app: "groupbuy", tool: "get_spreadsheet", input: { spreadsheetId: WH } });
check("api other app's sheet → 403", r.status === 403);
r = await sheetsReq(auth, { app: "groupbuy", tool: "update_spreadsheet", input: { spreadsheetId: GB, requests: [{ deleteSheet: { sheetId: 0 } }] } });
check("api disallowed request type → 400", r.status === 400);
r = await sheetsReq(auth, { app: "groupbuy", tool: "get_values", input: { spreadsheetId: GB, range: "'2026-11-23'!A1:I3" } });
check("api get_values", r.status === 200 && (await r.json()).values.length === 3);
check("owner-ticked 團購: no extra email", emails.length === 2);
for (const app of ["stock", "groupbuy"]) {
  const html = await (await get(`?app=${app}&key=${mk}`, { cookie: ckA })).text();
  const hrefs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  const codes = await Promise.all(hrefs.map(async (h) => (await realFetch(base + h)).status));
  check(`${app} page links its 4 icon files and all load`, hrefs.length === 4 && hrefs.every((h) => h.includes(app)) && codes.every((c) => c === 200));
}

// both apps in the browser
await page.goto(`${base}/?app=groupbuy&key=${mk}`);
await page.waitForSelector("text=Alice", { timeout: 10000 }).catch(async (e) => { console.log(await page.innerText("body"), errs); throw e; });
const thumb = page.locator('[role=slider][aria-label^="訂單 1 標記已領取"]');
const bb = await thumb.boundingBox();
const track = await thumb.locator("xpath=..").boundingBox();
await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
await page.mouse.down();
await page.mouse.move(bb.x + track.width, bb.y + bb.height / 2, { steps: 10 });
await page.mouse.up();
await page.locator('[role=slider][aria-label^="訂單 1 改返未領取"]').waitFor({ timeout: 5000 });
await page.waitForTimeout(300);
const row = win.__ss[GB].tabs[1].grid[1];
check("groupbuy pickup written via /api/sheets", row[7] === "TRUE" && /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(row[8]), JSON.stringify(row));
await page.screenshot({ path: new URL("web_gb.png", import.meta.url).pathname });
await page.goto(`${base}/?app=stock&key=${mk}`);
await page.waitForSelector("text=永達 嘉美雞", { timeout: 10000 });
check("stock list renders", (await page.innerText("body")).includes("春卷皮"));
check("寫入: editing buttons shown, no 只可閱讀", (await page.locator("text=＋ 新增貨品").count()) === 1 && (await page.locator("text=只可閱讀").count()) === 0);
await page.screenshot({ path: new URL("web_wh.png", import.meta.url).pathname });

// --- 閱讀 (read only) -------------------------------------------------------------------
setLevel(1, 2, "閱讀");
r = await sheetsReq(auth, { app: "groupbuy", tool: "get_values", input: { spreadsheetId: GB, range: "'2026-11-23'!A1:I3" } });
check("閱讀: get_values ok", r.status === 200);
r = await sheetsReq(auth, { app: "groupbuy", tool: "get_spreadsheet", input: { spreadsheetId: GB } });
check("閱讀: get_spreadsheet ok", r.status === 200);
const gbBefore = JSON.stringify(win.__ss[GB]);
r = await sheetsReq(auth, { app: "groupbuy", tool: "update_spreadsheet", input: { spreadsheetId: GB, requests: [{ updateCells: { start: { sheetId: 0, rowIndex: 1, columnIndex: 7 }, rows: [{ values: [{ userEnteredValue: { stringValue: "TRUE" } }] }], fields: "userEnteredValue" } }] } });
let j = await r.json();
check("閱讀: update_spreadsheet → 403 read_only, Sheet untouched", r.status === 403 && j.error?.code === "read_only" && j.error.message.includes("閱讀") && JSON.stringify(win.__ss[GB]) === gbBefore, JSON.stringify(j));
r = await sheetsReq({ ...auth, cookie: auth.cookie + "; lang=en" }, { app: "groupbuy", tool: "update_spreadsheet", input: { spreadsheetId: GB, requests: [{ deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: 2 } } }] } });
check("閱讀: refusal in English too", r.status === 403 && (await r.json()).error.message.startsWith("You have read-only access"));
r = await sheetsReq(auth, { app: "stock", tool: "get_spreadsheet", input: { spreadsheetId: WH } });
check("閱讀 for 團購 leaves 倉庫 at 寫入", r.status === 200);
r = await get(`?app=groupbuy&key=${mk}`, { cookie: ckA });
check("閱讀: groupbuy page told read", (await r.text()) === withLevel(PAGES.groupbuy, "read"));
await page.goto(`${base}/?app=groupbuy&key=${mk}`);
await page.waitForSelector("text=Alice", { timeout: 10000 });
check("閱讀 UI (團購): 只可閱讀 shown, no swipe to pick up", (await page.locator("text=只可閱讀").count()) === 1 && (await page.locator("[role=slider]").count()) === 0 &&
  (await page.innerText("body")).includes("已領取"));
await page.screenshot({ path: new URL("web_gb_readonly.png", import.meta.url).pathname });
setLevel(1, 1, "閱讀");
await page.goto(`${base}/?app=stock&key=${mk}`);
await page.waitForSelector("text=永達 嘉美雞", { timeout: 10000 });
body = await page.innerText("body");
const noEdit = await page.evaluate(() => ["新增貨品", "多選", "入貨", "出貨", "補貨架", "已補好", "編輯"].filter((w) => [...document.querySelectorAll("button:not([aria-label*='篩選'])")].some((b) => b.textContent.trim().replace(/^＋\s*/, "") === w)));
check("閱讀 UI (倉庫): 只可閱讀 shown; no add / select / in / out / shelf / edit buttons; no quantity input",
  body.includes("只可閱讀") && noEdit.length === 0 && (await page.locator("input[type=number]").count()) === 0 && (await page.locator("button[aria-label^='增加']").count()) === 0, JSON.stringify(noEdit));
await page.click("text=出入記錄");
await page.waitForTimeout(300);
check("閱讀 UI (倉庫): stock log readable, no 編輯", (await page.locator("section[aria-label='出入記錄'] li").count()) > 0 &&
  (await page.locator("section[aria-label='出入記錄'] button", { hasText: "編輯" }).count()) === 0);
await page.screenshot({ path: new URL("web_wh_readonly.png", import.meta.url).pathname });
r = await accessReq({ action: "status", key: myKey }, { cookie: ckA });
j = await r.json();
check("status reports each app's level", j.apps.stock.level === "read" && j.apps.groupbuy.level === "read" && j.apps.stock.ok === true, JSON.stringify(j.apps));
text = await (await get(`?key=${mk}`, { cookie: ckA })).text();
check("key page: 已批准 · 只可閱讀", (text.match(/只可閱讀/g) ?? []).length === 2 && !text.includes("可以改"));
setLevel(1, 1, "寫入");
setLevel(1, 2, "寫入");
text = await (await get(`?key=${mk}`, { cookie: ckA })).text();
check("key page: 已批准 · 可以改", (text.match(/可以改/g) ?? []).length === 2 && !text.includes("只可閱讀"));
setLevel(1, 2, "亂打嘢");
r = await sheetsReq(auth, { app: "groupbuy", tool: "get_spreadsheet", input: { spreadsheetId: GB } });
check("anything but 閱讀／寫入 = no access", r.status === 401);
setLevel(1, 2, "寫入");

const bad = await page.evaluate(async () => (await fetch("/api/sheets", { method: "POST", headers: { "content-type": "application/json", "x-app-key": "bad" }, body: JSON.stringify({ app: "stock" }) })).status);
check("api from page with bad key → 401", bad === 401);

// --- the link is shared: another phone ------------------------------------------------
const B = await device();
await B.page.goto(`${base}/?app=stock&key=${mk}`);
body = await B.page.innerText("body");
check("other phone: key page asks to confirm this device, no 開啟", body.includes("確認呢部裝置") && (await B.page.locator("a.btn").count()) === 0);
await B.page.screenshot({ path: new URL("web_key_confirm.png", import.meta.url).pathname });
await B.page.click("#unlock");
await B.page.waitForFunction(() => document.getElementById("err").textContent.length > 0, null, { timeout: 15000 });
check("other phone: Face ID finds no passkey → told to register", (await B.page.innerText("#err")).includes("登記呢部裝置"));
await B.page.click("#enroll");
await B.page.waitForSelector("text=呢部裝置等緊批准", { timeout: 15000 });
check("other phone: new pending 裝置 row, owner emailed 新裝置", tab("裝置").grid.length === 3 && tab("裝置").grid[2][1] === "FALSE" &&
  emails.length === 3 && emails[2].subject.includes("新裝置"), emails[2]?.subject);
const ckB = await B.cookie();
r = await get(`?app=stock&key=${mk}`, { cookie: ckB });
check("other phone: app URL still key page", !(await r.text()).includes("出入記錄"));
r = await sheetsReq({ "x-app-key": myKey, cookie: ckB }, { app: "stock", tool: "get_spreadsheet", input: { spreadsheetId: WH } });
check("other phone: api → 401", r.status === 401);
r = await sheetsReq({ "x-app-key": myKey, cookie: ckA }, { app: "stock", tool: "get_spreadsheet", input: { spreadsheetId: WH } });
check("阿明's phone unaffected", r.status === 200);

// forged sign-ins
const fakeCd = (challenge, type = "webauthn.get") => Buffer.from(JSON.stringify({ type, challenge, origin: base })).toString("base64url");
r = await accessReq({ action: "passkey-get", key: myKey, credential: { id: devA[5], clientDataJSON: fakeCd("x"), authenticatorData: "AAAA", signature: "AAAA" } });
check("forged sign-in (bad challenge) → rejected", r.status === 400);
const html = await (await get(`?key=${mk}`)).text();
const getChal = JSON.parse(html.match(/const C=(\{.*?\}),T0/)[1].replace(/\\u003c/g, "<")).get;
const adBytes = Buffer.concat([createHash("sha256").update("localhost").digest(), Buffer.from([5, 0, 0, 0, 1])]);
r = await accessReq({ action: "passkey-get", key: myKey, credential: { id: devA[5], clientDataJSON: fakeCd(getChal), authenticatorData: adBytes.toString("base64url"), signature: Buffer.alloc(70, 1).toString("base64url") } });
check("forged sign-in (right challenge, wrong signature) → 401, no cookie", r.status === 401 && !r.headers.get("set-cookie"));
r = await accessReq({ action: "passkey-get", key: myKey, credential: { id: "nope", clientDataJSON: fakeCd(getChal) } });
check("sign-in with unknown passkey → 404", r.status === 404);

// --- same passkey in another cookie jar (synced passkey / iPhone home-screen app) ------
const H = await device();
const { credentials } = await A.cdp.send("WebAuthn.getCredentials", { authenticatorId: A.authenticatorId });
await H.cdp.send("WebAuthn.addCredential", { authenticatorId: H.authenticatorId, credential: credentials[0] });
await H.page.goto(`${base}/?app=groupbuy&key=${mk}`);
await H.page.click("#unlock");
await H.page.waitForSelector("text=Alice", { timeout: 15000 });
check("synced passkey: Face ID unlocks straight into the app, no new device, no email", tab("裝置").grid.length === 3 && emails.length === 3);

// --- owner revokes ----------------------------------------------------------------------
tick("裝置", 1, 1, false);
r = await sheetsReq({ "x-app-key": myKey, cookie: ckA }, { app: "stock", tool: "get_spreadsheet", input: { spreadsheetId: WH } });
check("device unticked: api → 401", r.status === 401);
r = await sheetsReq({ "x-app-key": myKey, cookie: await H.cookie() }, { app: "stock", tool: "get_spreadsheet", input: { spreadsheetId: WH } });
check("…for every cookie jar using that passkey", r.status === 401);
r = await get(`?app=stock&key=${mk}`, { cookie: ckA });
check("device unticked: app URL → key page (等緊批准)", (await r.text()).includes("呢部裝置等緊批准"));
tick("裝置", 1, 1, true);
tab("裝置").grid.splice(2, 1); // owner deletes the other phone's row
forgetCache();
r = await get(`?key=${mk}`, { cookie: ckB });
check("deleted device: its cookie counts for nothing → register again", (await r.text()).includes("確認呢部裝置"));
setLevel(1, 1, "");
r = await sheetsReq({ "x-app-key": myKey, cookie: ckA }, { app: "stock", tool: "get_spreadsheet", input: { spreadsheetId: WH } });
check("app blanked for the person: api → 401", r.status === 401);
r = await sheetsReq({ "x-app-key": myKey, cookie: ckA }, { app: "groupbuy", tool: "get_spreadsheet", input: { spreadsheetId: GB } });
check("…other app still fine", r.status === 200);

// more people: both-apps invite (client's apps list ignored), email down
emailDown = true;
r = await accessReq({ action: "register", invite: inv.both, name: "阿芳", apps: ["stock"] });
const fangKey = (await r.json()).key;
check("both invite → 申請 倉庫、團購", r.status === 200 && tab("鑰匙").grid[2]?.[0] === "阿芳" && tab("鑰匙").grid[2][3] === "倉庫、團購");
emailDown = false;
r = await accessReq({ action: "register", invite: inv.groupbuy, name: "阿強", apps: ["stock", "groupbuy"] });
check("groupbuy invite → 申請 團購 only", r.status === 200 && tab("鑰匙").grid[3]?.[3] === "團購");
check("email down: 阿芳 still registered, no email; 阿強 emailed 新申請：團購", emails.length === 4 && emails[3].subject.includes("阿強 新申請：團購"), emails[3]?.subject);

// someone registered on ANOTHER server instance: an unknown key re-reads (at most every 2 s)
r = await accessReq({ action: "status", key: fangKey });
const ghostKey = "g".repeat(32);
tab("鑰匙").grid.push(["阿華", "FALSE", "FALSE", "倉庫", "2026-11-25 13:00", sha(ghostKey)]);
r = await get(`?key=${ghostKey}`);
check("unknown key within 2 s of a read: no extra Google read (dead page)", r.status === 404);
await new Promise((z) => setTimeout(z, 2100));
r = await get(`?key=${ghostKey}`);
text = await r.text();
check("…after 2 s: re-read finds the new row → key page", r.status === 200 && text.includes("阿華") && text.includes("登記呢部裝置"));
let before = calls.length;
for (const k of ["x".repeat(32), "y".repeat(32), "z".repeat(32)]) await get(`?key=${k}`);
check("wrong keys right after a re-read don't hit Google", calls.length === before, `${calls.length - before} calls`);

// 設定 rows can move; deleting a person kills the link; stopping an invite closes it
tab("設定").grid.unshift(["我自己加嘅一行", "abc"]);
forgetCache();
check("設定 rows moved: 管理碼 still works", (await get(`?admin=${admin}`)).status === 200);
check("…and the invites too", (await get(`?invite=${inv.groupbuy}`)).status === 200);
tab("鑰匙").grid.splice(1, 1);
forgetCache();
for (const q of [`?key=${mk}`, `?app=groupbuy&key=${mk}`]) {
  r = await get(q, { cookie: ckA });
  check(`deleted person: ${q.replace(mk, "<key>")} → dead, even with the device cookie`, r.status === 404 && isDead(await r.text()));
}
r = await accessReq({ action: "status", key: fangKey });
check("other person untouched", r.status === 200 && (await r.json()).name === "阿芳");
r = await accessReq({ action: "admin-revoke", admin, code: inv.groupbuy });
check("團購 invite stopped (api) → dead page", r.status === 200 && (await get(`?invite=${inv.groupbuy}`)).status === 404);
r = await accessReq({ action: "admin-revoke", admin, code: inv.groupbuy });
check("stopping it again → 404", r.status === 404);
r = await accessReq({ action: "register", invite: "", name: "y" });
check("blank invite never matches a blank code", r.status === 404);
check("倉庫＋團購 invite still open", (await get(`?invite=${inv.both}`)).status === 200);
{
  const row = tab("邀請").grid.find((x) => x[0] === inv.both);
  check("no-limit link counts its sign-up (阿芳)", row[7] === "1", JSON.stringify(row));
  const setExp = (v) => { row[5] = v; forgetCache(); };
  setExp("2020-01-01 00:00");
  check("expired link → dead", (await get(`?invite=${inv.both}`)).status === 404);
  setExp("43831"); // owner typed a date: Sheets keeps a serial number (2020-01-01)
  check("expired link (date typed into Sheets) → dead", (await get(`?invite=${inv.both}`)).status === 404);
  setExp("73051"); // 2099-12-31
  check("future date typed into Sheets → open", (await get(`?invite=${inv.both}`)).status === 200);
  row[6] = "1"; forgetCache();
  check("limit lowered to what's used → dead", (await get(`?invite=${inv.both}`)).status === 404);
  row[6] = ""; row[1] = "FALSE"; row[2] = "FALSE"; forgetCache();
  check("no app ticked on the row → dead", (await get(`?invite=${inv.both}`)).status === 404);
  row[2] = "TRUE"; forgetCache();
  text = await (await get(`?invite=${inv.both}`)).text();
  check("owner ticks apps in the 邀請 tab → form follows", text.includes("團購記錄") && !text.includes("倉庫存貨"));
}
r = await accessReq({ action: "admin-list", admin });
j = await r.json();
check("admin-list: rows + states", r.status === 200 && j.invites.length === 1 && j.invites[0].state === "ok" && j.legacy.length === 0, JSON.stringify(j));

// old fixed codes in 設定 (from before the 管理 page) keep working until blanked
tab("設定").grid.push(["倉庫邀請碼", "oldfixedcode234"]);
forgetCache();
text = await (await get("?invite=oldfixedcode234")).text();
check("old fixed 倉庫邀請碼 still opens the 倉庫 form", text.includes("倉庫存貨") && !text.includes("團購記錄"));
r = await accessReq({ action: "register", invite: "oldfixedcode234", name: "舊連結" });
check("…and signs up for 倉庫", r.status === 200 && tab("鑰匙").grid.at(-1)[3] === "倉庫");
r = await accessReq({ action: "admin-list", admin });
check("管理 page is told about the old codes", JSON.stringify((await r.json()).legacy) === JSON.stringify([{ label: "倉庫邀請碼", apps: ["stock"] }]));
tab("設定").grid.push(["團購邀請碼", "oldfixedcode567"]);
forgetCache();
await O.page.reload();
await O.page.waitForSelector("#legacyBox:not([hidden])");
check("管理 page lists each old code with 移除", (await O.page.locator("#legacy .inv").count()) === 2 &&
  (await O.page.locator("#legacy .inv").first().innerText()).includes("倉庫邀請碼") && (await O.page.locator("#legacy button", { hasText: "移除" }).count()) === 2);
await O.page.screenshot({ path: new URL("web_admin_legacy.png", import.meta.url).pathname, fullPage: true });
const setRows = tab("設定").grid.length;
await O.page.locator("#legacy .inv", { hasText: "倉庫邀請碼" }).locator("text=移除").click();
await O.page.waitForFunction(() => document.querySelectorAll("#legacy .inv").length === 1);
check("移除 deletes that 設定 row only", !tab("設定").grid.some((x) => x[0] === "倉庫邀請碼") && tab("設定").grid.length === setRows - 1 &&
  tab("設定").grid.some((x) => x[0] === "團購邀請碼") && !!code("管理碼"));
check("removed old code → dead", (await get("?invite=oldfixedcode234")).status === 404 && (await get("?invite=oldfixedcode567")).status === 200);
r = await accessReq({ action: "admin-remove-legacy", admin, label: "倉庫邀請碼" });
check("removing it again → 404", r.status === 404);
r = await accessReq({ action: "admin-remove-legacy", admin, label: "管理碼" });
check("only old invite labels can be removed (not 管理碼)", r.status === 404 && !!code("管理碼"));
tab("設定").grid.find((x) => x[0] === "團購邀請碼")[1] = "";
forgetCache();
check("old fixed code blanked in the sheet → dead too", (await get("?invite=oldfixedcode567")).status === 404);
await O.page.reload();
await O.page.waitForSelector(".inv");
check("…and the 舊邀請碼 section goes away", await O.page.locator("#legacyBox").isHidden());

// 清走過咗期／用完嘅: one used-up + one expired link go, the working one stays
{
  const once = await mkInvite(["stock"], { uses: 1 });
  await accessReq({ action: "register", invite: once, name: "用完" });
  const old = await mkInvite(["groupbuy"]);
  tab("邀請").grid.find((x) => x[0] === old)[5] = "2020-01-01 00:00";
  forgetCache();
  await O.page.reload();
  await O.page.waitForSelector("#cleanup:not([hidden])");
  check("清走 button counts the dead links", (await O.page.innerText("#cleanup")).includes("2 條"));
  await O.page.click("#cleanup");
  await O.page.waitForSelector("#cleanup", { state: "hidden" });
  const left = tab("邀請").grid.slice(1).map((x) => x[0]);
  check("清走 deletes only expired / used-up rows", left.length === 1 && left[0] === inv.both && (await O.page.locator("#list .inv").count()) === 1, JSON.stringify(left));
  r = await accessReq({ action: "admin-cleanup", admin });
  check("nothing left to clear → removed 0", (await r.json()).removed === 0);
}

// 管理碼 blanked → 管理 page closed (and not re-created)
tab("設定").grid.find((x) => x[0] === "管理碼")[1] = "";
forgetCache();
check("管理碼 blanked → dead page", (await get(`?admin=${admin}`)).status === 404 && (await accessReq({ action: "admin-list", admin: "" })).status === 404);
check("…and not re-created", (await accessReq({ action: "status", key: fangKey })).status === 200 && tab("設定").grid.filter((x) => x[0] === "管理碼").length === 1);

// a 鑰匙簿 from before the 管理 page: no 邀請 tab, no 管理碼 row → both added
{
  const s = win.__ss[ACCESS];
  s.tabs = s.tabs.filter((t) => t.title !== "邀請");
  tab("設定").grid = tab("設定").grid.filter((x) => x[0] !== "管理碼");
  forgetCache();
  r = await accessReq({ action: "status", key: fangKey });
  const newAdmin = code("管理碼");
  check("old 鑰匙簿: 邀請 tab + 管理碼 row added, people untouched", r.status === 200 && tab("邀請")?.grid[0][0] === "邀請碼" &&
    /^[a-z2-9]{24}$/.test(newAdmin ?? "") && newAdmin !== admin && tab("設定").grid[0][0] === "我自己加嘅一行");
  check("…the new 管理碼 opens the 管理 page", (await get(`?admin=${newAdmin}`)).status === 200);
}

// RS256 (Windows Hello) signatures, checked directly
{
  const { verifyAssertion, newChallenge } = await import("../../api/_passkey.js");
  const { generateKeyPairSync: gen, sign: rsaSign } = await import("node:crypto");
  const kp = gen("rsa", { modulusLength: 2048 });
  const dev = { alg: -257, spki: kp.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
  const h = sha("rsa-person-key-000000000000");
  const cd = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: Buffer.from(newChallenge(h, "get")).toString("base64url"), origin: base }));
  const ad = Buffer.concat([createHash("sha256").update("localhost").digest(), Buffer.from([5, 0, 0, 0, 7])]);
  const sig = rsaSign("sha256", Buffer.concat([ad, createHash("sha256").update(cd).digest()]), kp.privateKey);
  const cred = { clientDataJSON: cd.toString("base64url"), authenticatorData: ad.toString("base64url"), signature: sig.toString("base64url") };
  const site = { origin: base, rpId: "localhost" };
  let ok = true;
  try { verifyAssertion(cred, dev, h, site); } catch { ok = false; }
  let rejected = false;
  try { verifyAssertion({ ...cred, signature: Buffer.from(sig).fill(1, 0, 4).toString("base64url") }, dev, h, site); } catch { rejected = true; }
  let wrongSite = false;
  try { verifyAssertion(cred, dev, h, { origin: "https://evil.example", rpId: "evil.example" }); } catch { wrongSite = true; }
  check("RS256 passkey signature verifies; tampered / other site rejected", ok && rejected && wrongSite);
}

// a 鑰匙簿 from before 閱讀／寫入: ☐ cells. Ticked = 寫入 straight away; the
// cells become the dropdown on the next read.
{
  const oldKey = "o".repeat(32);
  tab("鑰匙").grid.push(["舊人", "TRUE", "FALSE", "倉庫", "2026-11-01 09:00", sha(oldKey)]);
  const n = tab("鑰匙").grid.length;
  forgetCache();
  accessWrites.length = 0;
  r = await accessReq({ action: "status", key: oldKey });
  j = await r.json();
  const row = tab("鑰匙").grid[n - 1];
  const req = accessWrites[0]?.requests ?? [];
  check("old ticked ☐ = 寫入, unticked = none", j.apps.stock.level === "write" && j.apps.groupbuy.level === null, JSON.stringify(j.apps));
  check("old ☐ cells upgraded once: TRUE → 寫入, FALSE → blank, dropdown on each", row[1] === "寫入" && row[2] === "" &&
    req.length >= 2 && req.every((q) => q.updateCells?.rows[0].values[0].dataValidation?.condition?.type === "ONE_OF_LIST") &&
    !tab("鑰匙").grid.slice(1).some((x) => /^(TRUE|FALSE)$/.test(x[1]) || /^(TRUE|FALSE)$/.test(x[2])), JSON.stringify(row));
  forgetCache();
  accessWrites.length = 0;
  await accessReq({ action: "status", key: oldKey });
  check("…and not again", accessWrites.length === 0);
}

check("no page errors", errs.length === 0, JSON.stringify(errs));
check("google calls happened", calls.some((c) => c.endsWith(":batchUpdate")), calls.length + " calls");
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
