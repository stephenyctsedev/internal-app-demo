import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Always run relative to this folder (the Vercel build calls it from the repo root).
const HERE = dirname(fileURLToPath(import.meta.url));
process.chdir(HERE);

/** Builds one app into a single self-contained HTML string.
 *  web=false → claude.ai artifact (Google Sheets via the `mcp` connector)
 *  web=true  → Vercel web app (Google Sheets via this site's /api/sheets)
 *  demo=true → portfolio demo (sample data in the browser, no Google Sheets);
 *              iconBase lets it use relative icon paths for static hosting */
export async function buildPage(name, title, { web = false, demo = false, icon = "", iconBase = "/icons/" } = {}) {
  mkdirSync(`dist`, { recursive: true });
  const out = await build({
    absWorkingDir: HERE,
    entryPoints: [`${name}/src/main.tsx`],
    bundle: true,
    minify: true,
    format: "iife",
    target: "es2020",
    jsx: "automatic",
    write: false,
    define: { "process.env.NODE_ENV": '"production"', __WEB__: web ? "true" : "false", __DEMO__: demo ? "true" : "false" },
    loader: { ".css": "empty" },
    logLevel: "warning",
  });
  const js = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

  execFileSync("node_modules/.bin/tailwindcss", ["-i", `${name}/src/theme.css`, "-o", `dist/${name}.css`, "--minify"], { stdio: "inherit" });
  const css = readFileSync(`dist/${name}.css`, "utf8");

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />${web ? '\n<meta name="robots" content="noindex, nofollow" />\n<meta name="referrer" content="no-referrer" />' : ""}${
    icon
      ? `
<link rel="icon" type="image/svg+xml" href="${iconBase}${icon}.svg" />
<link rel="icon" type="image/png" sizes="192x192" href="${iconBase}${icon}-192.png" />
<link rel="apple-touch-icon" href="${iconBase}${icon}-180.png" />
<link rel="manifest" href="${iconBase}${icon}.webmanifest" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="${title}" />`
      : ""
  }
<title>${title}</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [name, title] = process.argv.slice(2);
  const html = await buildPage(name, title);
  writeFileSync(`dist/${name}.html`, html);
  console.log(name, (html.length / 1024).toFixed(0) + " KB");
}
