// Local stand-in for Vercel: `npm run build && ACCESS_SHEET_ID=… GOOGLE_SERVICE_ACCOUNT_JSON=… npm run dev`
// then open http://localhost:3000/?admin=<設定 管理碼> (or ?invite=… / ?app=…&key=…)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import appHandler from "./api/app.js";
import sheetsHandler from "./api/sheets.js";
import accessHandler from "./api/access.js";

export function startServer(port = Number(process.env.PORT) || 3000) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/" || path === "/api/app") return appHandler(req, res);
    if (path === "/api/sheets") return sheetsHandler(req, res);
    if (path === "/api/access") return accessHandler(req, res);
    // Static files from public/ (Vercel serves these itself).
    const m = path.match(/^\/(icons\/[\w-]+\.(png|svg|webmanifest)|robots\.txt)$/);
    if (m) {
      const type = { png: "image/png", svg: "image/svg+xml", webmanifest: "application/manifest+json" }[m[2]] ?? "text/plain";
      return readFile(new URL(`public/${m[1]}`, import.meta.url)).then(
        (buf) => { res.setHeader("Content-Type", type); res.end(buf); },
        () => { res.statusCode = 404; res.end("Not found"); },
      );
    }
    res.statusCode = 404;
    res.end("Not found");
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const s = await startServer();
  console.log(`http://localhost:${s.address().port}/?app=stock&key=…`);
}
