import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const [name, title] = process.argv.slice(2);
const dir = `${name}`;
mkdirSync(`dist`, { recursive: true });

const out = await build({
  entryPoints: [`${dir}/src/main.tsx`],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  write: false,
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".css": "empty" },
  logLevel: "warning",
});
let js = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

execFileSync("node_modules/.bin/tailwindcss", ["-i", `${dir}/src/theme.css`, "-o", `dist/${name}.css`, "--minify"], { stdio: "inherit" });
const css = readFileSync(`dist/${name}.css`, "utf8");

const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>${title}</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>
`;
writeFileSync(`dist/${name}.html`, html);
console.log(name, (html.length / 1024).toFixed(0) + " KB");
