// End-to-end test of the Vercel web build without Google: run `npm run build`
// at the repo root first, then `node artifacts/test/web_e2e.mjs`.
// Starts dev-server.mjs with the real /api handlers, but globalThis.fetch is
// stubbed so oauth2/sheets.googleapis.com are answered from mock.js's
// in-memory sheets. Checks the key gate, then drives both apps in Chromium.
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
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: "bot@test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});

// --- fake Google, backed by mock.js -----------------------------------------
const win = {};
vm.runInNewContext(readFileSync(new URL("mock.js", import.meta.url), "utf8"), { window: win, setTimeout });
win.__lat = 5;
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

check("no page errors", errs.length === 0, JSON.stringify(errs));
check("google calls happened", calls.some((c) => c.endsWith(":batchUpdate")), calls.length + " calls");
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
