// GET /?app=stock|groupbuy&key=… → the app page, only with the right key.
import { APPS, keyOk, securityHeaders } from "./_lib.js";
import { PAGES } from "./_pages.js";

function message(title, text) {
  return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" /><meta name="robots" content="noindex, nofollow" />
<title>${title}</title>
<style>:root{color-scheme:light dark;--bg:#f6f6f4;--fg:#1c1c1a;--muted:#6b6b66}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ededea;--muted:#9a9a94}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font-family:system-ui,-apple-system,"PingFang HK","Noto Sans TC",sans-serif;padding:16px;box-sizing:border-box}
h1{font-size:20px;margin:0 0 8px}p{margin:0;color:var(--muted);line-height:1.6}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
}

export default function handler(req, res) {
  securityHeaders(res);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const q = new URL(req.url, "http://localhost").searchParams;
  if (!keyOk(q.get("key"))) {
    res.statusCode = 401;
    res.end(message("唔可以入", "密碼唔啱或者冇俾密碼。請用正確嘅連結（網址要有 ?key=…）。"));
    return;
  }
  const app = q.get("app") ?? "";
  if (!Object.hasOwn(APPS, app)) {
    res.statusCode = 404;
    res.end(message("搵唔到", "請喺網址加 ?app=stock（倉庫存貨）或者 ?app=groupbuy（團購記錄）。"));
    return;
  }
  res.statusCode = 200;
  res.end(PAGES[app]);
}
