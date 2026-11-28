// 團購 員工備註 (column J): add / edit / clear from a card, header written on
// first save, stale-note refusal, read-only hides ✎, a foreign J header is
// left alone. Run after `node build.mjs groupbuy 團購記錄`:
//   cd test && node run_gb_note.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const mock = readFileSync(here("mock.js"), "utf8");
const url = "file://" + here("../dist/groupbuy.html");
const GB = "DEMO_GROUPBUY_SHEET_ID";

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " " + extra}`);
  if (!ok) failed++;
};

const browser = await chromium.launch();
async function open(init = "") {
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.addInitScript(mock);
  if (init) await page.addInitScript(init);
  await page.goto(url);
  await page.waitForSelector("text=#1", { timeout: 8000 });
  return { page, errs };
}
const grid = (page) => page.evaluate((id) => window.__ss[id].tabs[1].grid, GB);
const card = (page, no) => page.locator("li.rounded-2xl", { hasText: `#${no}` });

// --- add a note: header J1 is written, note goes on the group's first row only
{
  const { page, errs } = await open();
  await page.click('button[aria-label="訂單 1 加員工備註"]');
  await page.fill("#staff-note-1", "  客人會遲啲嚟\n已打電話  ");
  await page.click("text=儲存");
  await page.waitForSelector("text=員工備註：");
  let g = await grid(page);
  check("J1 header written", g[0][9] === "員工備註", JSON.stringify(g[0]));
  check("note on first row, trimmed", g[1][9] === "客人會遲啲嚟\n已打電話", JSON.stringify(g[1]));
  check("second row of order untouched", (g[2][9] ?? "") === "", JSON.stringify(g[2]));
  check("other columns untouched", g[1].slice(0, 8).join("|") === "1|Alice||無激素雞翅|15|Lb||FALSE", JSON.stringify(g[1]));
  check("note shown on card", (await card(page, 1).innerText()).includes("客人會遲啲嚟"));

  // edit it
  await page.click('button[aria-label="改訂單 1 嘅員工備註"]');
  check("editor prefilled", (await page.inputValue("#staff-note-1")) === "客人會遲啲嚟\n已打電話");
  await page.fill("#staff-note-1", "星期六先嚟");
  await page.click("text=儲存");
  await page.waitForSelector("#staff-note-1", { state: "detached" });
  g = await grid(page);
  check("note edited", g[1][9] === "星期六先嚟", JSON.stringify(g[1]));

  // stale: a colleague changes it in the Sheet while this editor is open
  await page.click('button[aria-label="改訂單 1 嘅員工備註"]');
  await page.fill("#staff-note-1", "我嘅版本");
  await page.evaluate((id) => (window.__ss[id].tabs[1].grid[1][9] = "同事寫嘅"), GB);
  await page.click("text=儲存");
  await page.waitForSelector("[role=alert]");
  const alert = await page.innerText("[role=alert]");
  g = await grid(page);
  check("stale save refused", g[1][9] === "同事寫嘅" && alert.includes("同事寫嘅"), alert);
  check("draft kept after refusal", (await page.inputValue("#staff-note-1")) === "我嘅版本");
  await page.click("text=儲存");
  await page.waitForSelector("text=員工備註：");
  g = await grid(page);
  check("second save after seeing colleague's note goes through", g[1][9] === "我嘅版本", JSON.stringify(g[1]));

  // clear it
  await page.click('button[aria-label="改訂單 1 嘅員工備註"]');
  await page.fill("#staff-note-1", "");
  await page.click("text=儲存");
  await page.waitForSelector('button[aria-label="訂單 1 加員工備註"]');
  g = await grid(page);
  check("note cleared", (g[1][9] ?? "") === "", JSON.stringify(g[1]));

  // cancel writes nothing
  const before = await page.evaluate(() => window.__log.length);
  await page.click('button[aria-label="訂單 3 加員工備註"]');
  await page.fill("#staff-note-3", "唔好寫");
  await page.click("text=取消");
  check("cancel writes nothing", (await page.evaluate(() => window.__log.length)) === before);

  // pickup swipe still writes H/I only and leaves J alone
  await page.evaluate((id) => (window.__ss[id].tabs[1].grid[5][9] = "keep"), GB);
  await page.click("text=↻ 載入");
  await page.waitForSelector("text=keep");
  const t3 = page.locator('[role=slider][aria-label^="訂單 3 標記已領取"]');
  await t3.focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector('[role=slider][aria-label^="訂單 3 改返未領取"]');
  await page.waitForTimeout(500);
  g = await grid(page);
  check("pickup still works, J kept", g[5][7] === "TRUE" && g[5][9] === "keep", JSON.stringify(g[5]));
  await page.screenshot({ path: "gb_note.png" });
  check("no page errors", errs.length === 0, JSON.stringify(errs));
  await page.close();
}

// --- English UI
{
  const { page } = await open("try { localStorage.setItem('lang', 'en') } catch {}");
  check("English label", (await page.innerText("body")).includes("Add staff note"));
  await page.close();
}

// --- column J used for something else: nothing shown, nothing written, app still loads
{
  const { page } = await open(`
    const g = window.__ss["${GB}"].tabs[1].grid;
    g[0][9] = "其他"; g[1][9] = "唔關事";
  `);
  check("foreign J: app loads", (await card(page, 1).count()) === 1);
  check("foreign J: value not shown as note", !(await page.innerText("body")).includes("唔關事"));
  await page.click('button[aria-label="訂單 1 加員工備註"]');
  await page.fill("#staff-note-1", "x");
  await page.click("text=儲存");
  await page.waitForSelector("[role=alert]");
  const g = await grid(page);
  check("foreign J: nothing written", g[1][9] === "唔關事" && g[0][9] === "其他", JSON.stringify(g[1]));
  await page.close();
}

// --- a note already in the Sheet is shown on load
// (read-only hiding of ✎ is checked in web_e2e.mjs: only the web build has 閱讀)
{
  const { page } = await open(`
    window.__ss["${GB}"].tabs[1].grid[0][9] = "員工備註";
    window.__ss["${GB}"].tabs[1].grid[1][9] = "只睇";
  `);
  check("existing note shown", (await page.innerText("body")).includes("只睇"));
  await page.close();
}

await browser.close();
console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
