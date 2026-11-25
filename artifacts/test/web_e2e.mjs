// End-to-end test of the Vercel web build without Google: run `npm run build`
// at the repo root first, then `node artifacts/test/web_e2e.mjs`.
// Starts dev-server.mjs with the real /api handlers, but globalThis.fetch is
// stubbed so oauth2/sheets.googleapis.com are answered from mock.js's
// in-memory sheets (plus an empty 鑰匙簿) and api.resend.com is caught.
// Checks the key gate, drives both apps in Chromium, then the per-person key
// flow: per-app invite → pending → owner ticks → app opens → untick / delete.
import { readFileSync } from "node:fs";
import { generateKeyPairSync, createVerify } from "node:crypto";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

// --- fake env ---------------------------------------------------------------
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.STOCK_KEY = "stock pass";
process.env.GROUPBUY_KEY = "s3cret pass";
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
const key = encodeURIComponent(process.env.GROUPBUY_KEY);
const skey = encodeURIComponent(process.env.STOCK_KEY);
let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`);
  if (!ok) failed++;
};

// --- key gate ----------------------------------------------------------------
for (const [q, want] of [
  ["?app=stock", 404],
  ["?app=stock&key=wrong", 404],
  ["?app=groupbuy&key=" + key.slice(0, -1), 404],
  ["?app=nope&key=" + key, 404],
  ["", 404],
  ["?app=&key=", 404],
  ["?key=" + key, 404],
  ["?app=stock&key=" + key, 404],
  ["?app=groupbuy&key=" + skey, 404],
  ["?app=stock&key=" + skey, 200],
  ["?app=groupbuy&key=" + key, 200],
]) {
  const r = await realFetch(base + "/" + q);
  const text = await r.text();
  check(`GET /${q.replace(key, "<groupbuy key>").replace(skey, "<stock key>")}`, r.status === want, `→ ${r.status}`);
  if (want !== 200) check("  error page is the text-free dead page", !/key|密碼|stock|groupbuy|app=/i.test(text) && text.includes("<svg"));
}
const sheetsReq = (headers, body) =>
  realFetch(base + "/api/sheets", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const GB = "DEMO_GROUPBUY_SHEET_ID";
const WH = "DEMO_WAREHOUSE_SHEET_ID";
let r = await sheetsReq({ "x-app-key": "wrong" }, { app: "groupbuy", tool: "get_spreadsheet", input: { spreadsheetId: GB } });
check("api wrong key → 401", r.status === 401);
r = await sheetsReq({ "x-app-key": process.env.STOCK_KEY }, { app: "groupbuy", tool: "get_spreadsheet", input: { spreadsheetId: GB } });
check("api stock key on groupbuy → 401", r.status === 401);
r = await sheetsReq({ "x-app-key": process.env.GROUPBUY_KEY }, { app: "groupbuy", tool: "get_spreadsheet", input: { spreadsheetId: WH } });
check("api other app's sheet → 403", r.status === 403);
r = await sheetsReq({ "x-app-key": process.env.GROUPBUY_KEY }, {
  app: "groupbuy", tool: "update_spreadsheet", input: { spreadsheetId: GB, requests: [{ deleteSheet: { sheetId: 0 } }] },
});
check("api disallowed request type → 400", r.status === 400);
r = await sheetsReq({ "x-app-key": process.env.GROUPBUY_KEY }, { app: "groupbuy", tool: "get_values", input: { spreadsheetId: GB, range: "'2026-11-23'!A1:I3" } });
check("api get_values", r.status === 200 && (await r.json()).values.length === 3);
r = await sheetsReq({ "x-app-key": process.env.GROUPBUY_KEY }, { app: "groupbuy", tool: "get_spreadsheet", input: { spreadsheetId: GB } });
check("api ok", r.status === 200 && (await r.json()).sheets.length === 2);

// --- icons -------------------------------------------------------------------
for (const app of ["stock", "groupbuy"]) {
  const html = await (await realFetch(`${base}/?app=${app}&key=${app === "stock" ? skey : key}`)).text();
  const hrefs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  const codes = await Promise.all(hrefs.map(async (h) => (await realFetch(base + h)).status));
  check(`${app} page links its 4 icon files and all load`, hrefs.length === 4 && hrefs.every((h) => h.includes(app)) && codes.every((c) => c === 200), hrefs.join(" "));
}
const dead = await (await realFetch(base + "/?app=stock&key=wrong")).text();
check("error page links no icon / manifest", !/<link/i.test(dead));

// --- UI ----------------------------------------------------------------------
const browser = await chromium.launch();
const errs = [];
const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
page.on("pageerror", (e) => errs.push(String(e)));
if (process.env.DBG) { page.on("request", (r) => console.log("Q", r.url())); page.on("console", (m) => console.log("C", m.text())); }
if (process.env.DBG) page.on("response", async (r) => { if (r.url().includes("/api/")) console.log("R", r.status(), r.request().postData()?.slice(0, 150), (await r.text()).slice(0, 200)); });

await page.goto(`${base}/?app=stock&key=nope`);
check("UI wrong key: no text, only the picture", (await page.innerText("body")).trim() === "" && (await page.title()).trim().replace(/\u200b/g, "") === "" && (await page.locator("svg").count()) === 1);
await page.screenshot({ path: new URL("web_dead.png", import.meta.url).pathname });

// groupbuy: swipe order 1 to picked up → H2 TRUE, I2 set
await page.goto(`${base}/?app=groupbuy&key=${key}`);
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

// stock: list renders, then 入貨 +2 on 1212965 is recorded
await page.goto(`${base}/?app=stock&key=${skey}`);
await page.waitForSelector("text=永達 嘉美雞", { timeout: 10000 });
check("stock list renders", (await page.innerText("body")).includes("春卷皮"));
await page.screenshot({ path: new URL("web_wh.png", import.meta.url).pathname });

// a page whose key was changed after load gets the friendly error, no data
await page.goto(`${base}/?app=stock&key=${skey}`);
await page.evaluate(() => history.replaceState(null, "", "/?app=stock&key=bad"));
const msg = await page.evaluate(async () => {
  const r = await fetch("/api/sheets", { method: "POST", headers: { "content-type": "application/json", "x-app-key": "bad" }, body: JSON.stringify({ app: "stock" }) });
  return r.status;
});
check("api from page with bad key → 401", msg === 401);

// --- per-person keys (鑰匙簿) ----------------------------------------------------
const { forgetCache } = await import("../../api/_access.js");
const { createHash } = await import("node:crypto");
const tab = (t) => win.__ss[ACCESS].tabs.find((x) => x.title === t);
const isDead = (text) => !/key|密碼|stock|groupbuy|app=|鑰匙|申請/i.test(text) && text.includes("<svg");
const accessReq = (body) =>
  realFetch(base + "/api/access", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const code = (label) => tab("設定").grid.find((row) => row[0] === label)?.[1];

r = await realFetch(base + "/?invite=wrong");
check("wrong invite → dead page", r.status === 404 && isDead(await r.text()));
check("first use created 鑰匙 + 設定 tabs", tab("鑰匙")?.grid[0].join("|") === "名|倉庫|團購|申請|申請時間|Key 指紋" && !!tab("設定"));
check("original tab left alone", win.__ss[ACCESS].tabs[0].title === "工作表1");
const inv = { stock: code("倉庫邀請碼"), groupbuy: code("團購邀請碼"), both: code("倉庫＋團購邀請碼") };
check("one invite code per app (+ both), all different", Object.values(inv).every((c) => /^[a-z2-9]{12}$/.test(c ?? "")) && new Set(Object.values(inv)).size === 3, JSON.stringify(inv));

r = await realFetch(`${base}/?invite=${inv.stock}&app=stock`);
check("invite mixed with app → dead page", r.status === 404);
r = await accessReq({ action: "register", invite: "nope", name: "x" });
check("api register with wrong invite → 404", r.status === 404);
r = await accessReq({ action: "register", invite: inv.stock, name: "  " });
check("api register without name → 400", r.status === 400);
check("  …and nothing was written", tab("鑰匙").grid.length === 1);
r = await accessReq({ action: "request", key: "x".repeat(32), app: "groupbuy" });
check("no self-service request action any more", r.status === 400);

// the form shows only the app(s) the invite covers
for (const [which, want, not] of [["groupbuy", "團購記錄", "倉庫存貨"], ["both", "倉庫存貨", null]]) {
  const html = await (await realFetch(`${base}/?invite=${inv[which]}`)).text();
  check(`${which} invite form lists only its apps, no checkboxes`, html.includes(want) && (!not || !html.includes(not)) && !html.includes('type="checkbox"') && (which !== "both" || html.includes("團購記錄")));
}

// 阿明 gets the 倉庫 invite and fills in the form
await page.goto(`${base}/?invite=${inv.stock}`);
check("stock invite form shows 倉庫 only", /你會申請用：\s*倉庫存貨\s*$/m.test(await page.innerText("form")) && !(await page.innerText("body")).includes("團購"));
await page.screenshot({ path: new URL("web_invite.png", import.meta.url).pathname });
await page.click("text=遞交申請");
check("form needs a name", (await page.innerText("#err")).includes("名"));
await page.fill("input[name=name]", "阿明 <b>");
await page.click("text=遞交申請");
await page.waitForURL(/\/\?key=/, { timeout: 5000 });
const myKey = new URL(page.url()).searchParams.get("key");
check("got a long random key", /^[A-Za-z0-9_-]{32}$/.test(myKey), myKey);
let body = await page.innerText("body");
check("key page: name escaped, 倉庫 等緊批准, no 團購 card, no 申請 button",
  body.includes("阿明 <b>") && /倉庫存貨\s*等緊批准/.test(body) && !body.includes("團購") && (await page.locator("button").count()) === 0, body.replace(/\s+/g, " "));
await page.screenshot({ path: new URL("web_key_pending.png", import.meta.url).pathname });
const amRow = tab("鑰匙").grid[1];
check("row appended: unticked, 申請=倉庫, fingerprint only",
  amRow[0] === "阿明 <b>" && amRow[1] === "FALSE" && amRow[2] === "FALSE" && amRow[3] === "倉庫" && /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(amRow[4]) &&
    amRow[5] === createHash("sha256").update(myKey).digest("hex") && !JSON.stringify(win.__ss[ACCESS]).includes(myKey), JSON.stringify(amRow));
check("owner emailed once", emails.length === 1 && emails[0].to[0] === "owner@example.com" && emails[0].subject.includes("阿明") && emails[0].subject.includes("倉庫") && !emails[0].subject.includes("團購") && emails[0].text.includes(ACCESS), JSON.stringify(emails[0]?.subject));

const mk = encodeURIComponent(myKey);
r = await realFetch(`${base}/?app=stock&key=${mk}`);
let text = await r.text();
check("not yet approved: app URL shows key page, not the app", r.status === 200 && text.includes("我的鑰匙") && !text.includes("出入記錄"));
r = await sheetsReq({ "x-app-key": myKey }, { app: "stock", tool: "get_spreadsheet", input: { spreadsheetId: WH } });
check("not yet approved: api → 401", r.status === 401);

// owner ticks 倉庫
tab("鑰匙").grid[1][1] = "TRUE";
forgetCache();
r = await accessReq({ action: "status", key: myKey });
let st = await r.json();
check("status: stock ok, groupbuy not", st.apps.stock.ok && !st.apps.groupbuy.ok && !st.apps.groupbuy.requested);
r = await realFetch(`${base}/?app=stock&key=${mk}`);
check("approved: stock app opens", r.status === 200 && (await r.text()) === (await import("../../api/_pages.js")).PAGES.stock);
r = await sheetsReq({ "x-app-key": myKey }, { app: "stock", tool: "get_spreadsheet", input: { spreadsheetId: WH } });
check("approved: stock api ok", r.status === 200);
r = await sheetsReq({ "x-app-key": myKey }, { app: "groupbuy", tool: "get_spreadsheet", input: { spreadsheetId: GB } });
check("approved for stock only: groupbuy api → 401", r.status === 401);
r = await realFetch(`${base}/?app=groupbuy&key=${mk}`);
check("groupbuy URL shows key page", (await r.text()).includes("我的鑰匙"));

// owner also ticks 團購 (never asked for) → it shows up, no email
tab("鑰匙").grid[1][2] = "TRUE";
forgetCache();
await page.goto(`${base}/?key=${mk}`);
check("key page: 開啟 for both apps", (await page.getAttribute("a.btn.stock", "href")) === `/?app=stock&key=${mk}` && (await page.getAttribute("a.btn.groupbuy", "href")) === `/?app=groupbuy&key=${mk}`);
await page.screenshot({ path: new URL("web_key.png", import.meta.url).pathname });
r = await sheetsReq({ "x-app-key": myKey }, { app: "groupbuy", tool: "get_spreadsheet", input: { spreadsheetId: GB } });
check("owner-ticked 團購: api ok, no extra email", r.status === 200 && emails.length === 1);
await page.click("a.btn.stock");
await page.waitForSelector("text=永達 嘉美雞", { timeout: 10000 });
check("開啟 opens the stock app with own key", true);

// owner unticks 倉庫 → locked out of that app only
tab("鑰匙").grid[1][1] = "FALSE";
forgetCache();
r = await sheetsReq({ "x-app-key": myKey }, { app: "stock", tool: "get_spreadsheet", input: { spreadsheetId: WH } });
check("unticked: api → 401", r.status === 401);
r = await realFetch(`${base}/?app=stock&key=${mk}`);
check("unticked: app URL back to key page", (await r.text()).includes("我的鑰匙"));
r = await sheetsReq({ "x-app-key": myKey }, { app: "groupbuy", tool: "get_spreadsheet", input: { spreadsheetId: GB } });
check("…團購 still works", r.status === 200);

// 阿芳 gets the both-apps invite (an apps list in the request is ignored); email down
emailDown = true;
r = await accessReq({ action: "register", invite: inv.both, name: "阿芳", apps: ["stock"] });
const fangKey = (await r.json()).key;
check("both invite → 申請 倉庫、團購; email failing doesn't lose it", r.status === 200 && tab("鑰匙").grid[2]?.[0] === "阿芳" && tab("鑰匙").grid[2][3] === "倉庫、團購");
emailDown = false;
r = await accessReq({ action: "register", invite: inv.groupbuy, name: "阿強", apps: ["stock", "groupbuy"] });
check("groupbuy invite → 申請 團購 only, whatever the client sends", r.status === 200 && tab("鑰匙").grid[3]?.[3] === "團購" && emails.at(-1).subject.endsWith("團購"));

// invite codes are found by label, so moving rows in 設定 is fine
tab("設定").grid.unshift(["我自己加嘅一行", "abc"]);
forgetCache();
r = await realFetch(`${base}/?invite=${inv.groupbuy}`);
check("設定 rows moved: invite still works", r.status === 200);

// owner deletes 阿明's row → key is gone
tab("鑰匙").grid.splice(1, 1);
forgetCache();
for (const q of [`?key=${mk}`, `?app=groupbuy&key=${mk}`]) {
  r = await realFetch(`${base}/${q}`);
  check(`deleted row: ${q.replace(mk, "<key>")} → dead`, r.status === 404 && isDead(await r.text()));
}
r = await accessReq({ action: "status", key: myKey });
check("deleted row: status → 404", r.status === 404);
r = await accessReq({ action: "status", key: fangKey });
check("other person untouched", r.status === 200 && (await r.json()).name === "阿芳");

// owner clears the 倉庫 invite → only that link closes
tab("設定").grid.find((row) => row[0] === "倉庫邀請碼")[1] = "";
forgetCache();
r = await realFetch(`${base}/?invite=${inv.stock}`);
check("倉庫 invite cleared → dead page", r.status === 404);
r = await accessReq({ action: "register", invite: inv.stock, name: "y" });
check("倉庫 invite cleared → register 404", r.status === 404);
r = await accessReq({ action: "register", invite: "", name: "y" });
check("blank invite never matches a blank code", r.status === 404);
r = await realFetch(`${base}/?invite=${inv.groupbuy}`);
check("團購 invite still open", r.status === 200);

check("no page errors", errs.length === 0, JSON.stringify(errs));
check("google calls happened", calls.some((c) => c.endsWith(":batchUpdate")), calls.length + " calls");
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
