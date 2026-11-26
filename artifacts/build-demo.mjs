// Portfolio demo build: compiles both apps with `__DEMO__` (sample data in
// the browser's localStorage, no Google Sheets, no keys) into a static site
// in ../docs/, ready for GitHub Pages ("Deploy from branch → /docs") or any
// static host. Icon paths are relative so it works under a sub-path.
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildPage } from "./build.mjs";

const OUT = fileURLToPath(new URL("../docs/", import.meta.url));
mkdirSync(OUT, { recursive: true });

const pages = {
  "warehouse.html": await buildPage("warehouse", "倉庫存貨", { demo: true, icon: "stock", iconBase: "icons/" }),
  "groupbuy.html": await buildPage("groupbuy", "團購記錄", { demo: true, icon: "groupbuy", iconBase: "icons/" }),
};
for (const [file, html] of Object.entries(pages)) {
  writeFileSync(OUT + file, html);
  console.log(file, (html.length / 1024).toFixed(0) + " KB");
}
cpSync(fileURLToPath(new URL("../public/icons/", import.meta.url)), OUT + "icons/", { recursive: true });
cpSync(fileURLToPath(new URL("demo/index.html", import.meta.url)), OUT + "index.html");
writeFileSync(OUT + ".nojekyll", "");
console.log("index.html + icons → docs/");
