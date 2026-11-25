// GET /?app=stock|groupbuy&key=… → the app page, only if this person's key
//     is ticked for that app in 鑰匙簿 (or the old shared env key).
// GET /?key=…    (or an app the key isn't ticked for) → 我的鑰匙 page.
// GET /?invite=… → the 申請 form, only while the invite code matches.
// Anything else → the text-free dead page.
import { APPS, securityHeaders } from "./_lib.js";
import { canUse, findUser, inviteOk } from "./_access.js";
import { invitePage, keyPage } from "./_ui.js";
import { PAGES } from "./_pages.js";

// Error page: no text at all (no title, no words) — only a picture of a
// dead web page, so it gives away nothing about keys or apps.
const DEAD_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" /><meta name="robots" content="noindex, nofollow" />
<title>\u200b</title>
<style>:root{color-scheme:light dark;--bg:#f4f4f2;--card:#fff;--line:#c9c9c3;--ink:#8a8a84;--bar:#e6e6e1}
@media (prefers-color-scheme:dark){:root{--bg:#151514;--card:#1f1f1d;--line:#3d3d3a;--ink:#7d7d77;--bar:#2a2a28}}
html,body{margin:0;height:100%;background:var(--bg)}
body{display:grid;place-items:center;padding:16px;box-sizing:border-box}
svg{width:min(320px,80vw);height:auto}</style></head>
<body><svg viewBox="0 0 240 190" aria-hidden="true" focusable="false" fill="none" stroke-linecap="round" stroke-linejoin="round">
<rect x="10" y="10" width="220" height="160" rx="14" fill="var(--card)" stroke="var(--line)" stroke-width="4"/>
<path d="M10 46h220" stroke="var(--line)" stroke-width="4"/>
<circle cx="32" cy="28" r="5" fill="var(--line)"/><circle cx="50" cy="28" r="5" fill="var(--line)"/><circle cx="68" cy="28" r="5" fill="var(--line)"/>
<rect x="88" y="21" width="124" height="14" rx="7" fill="var(--bar)"/>
<g stroke="var(--ink)" stroke-width="6"><path d="M78 80l20 20M98 80l-20 20M142 80l20 20M162 80l-20 20"/>
<path d="M88 140c10-12 54-12 64 0"/></g>
<path d="M196 46l-10 22 14 10-12 20 10 14-8 18" stroke="var(--line)" stroke-width="3"/>
</svg></body></html>`;

async function route(q) {
  const app = q.get("app");
  const key = q.get("key") ?? "";
  if (q.has("invite")) return !app && !key && (await inviteOk(q.get("invite"))) ? [200, invitePage()] : null;
  if (app !== null && !Object.hasOwn(APPS, app)) return null;
  if (app && (await canUse(app, key))) return [200, PAGES[app]];
  const user = await findUser(key);
  return user ? [200, keyPage(user, key)] : null;
}

export default async function handler(req, res) {
  securityHeaders(res);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const q = new URL(req.url, "http://localhost").searchParams;
  // Blank / wrong app, key or invite all get the SAME page: no text, just
  // the dead-page picture, so it never says what was wrong.
  let page = null;
  let status = 404;
  try {
    page = await route(q);
  } catch (e) {
    console.error(e); // e.g. 鑰匙簿 unreachable: still say nothing
    status = 503;
  }
  if (page) [res.statusCode, page] = page;
  else res.statusCode = status;
  res.end(page ?? DEAD_PAGE);
}
