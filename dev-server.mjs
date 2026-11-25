// Local stand-in for Vercel: `npm run build && APP_KEY=… GOOGLE_SERVICE_ACCOUNT_JSON=… npm run dev`
// then open http://localhost:3000/?app=stock&key=…
import { createServer } from "node:http";
import appHandler from "./api/app.js";
import sheetsHandler from "./api/sheets.js";

export function startServer(port = Number(process.env.PORT) || 3000) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/" || path === "/api/app") return appHandler(req, res);
    if (path === "/api/sheets") return sheetsHandler(req, res);
    res.statusCode = 404;
    res.end("Not found");
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const s = await startServer();
  console.log(`http://localhost:${s.address().port}/?app=stock&key=…`);
}
