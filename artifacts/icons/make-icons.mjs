// Draws the two web-app icons and renders them to PNG.
//   node artifacts/icons/make-icons.mjs   → public/icons/{stock,groupbuy}{.svg,-180.png,-192.png,-512.png}
// Square, full-bleed artwork (iOS / Android round the corners themselves);
// the drawing stays inside the central 80% so "maskable" crops are safe.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const OUT = new URL("../../public/icons/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

export const ICONS = {
  // 倉庫存貨: orange (app accent #ea580c), a shelf rack holding boxes.
  stock: {
    name: "倉庫存貨",
    short: "倉庫",
    color: "#ea580c",
    svg: (rounded) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" ${rounded ? 'rx="112"' : ""} fill="#ea580c"/>
<g fill="#fff">
  <rect x="150" y="150" width="84" height="76" rx="8"/>
  <rect x="248" y="122" width="112" height="104" rx="8"/>
  <rect x="150" y="282" width="128" height="94" rx="8"/>
  <rect x="292" y="314" width="70" height="62" rx="8"/>
</g>
<g fill="#c2410c">
  <rect x="180" y="150" width="24" height="26" rx="3"/>
  <rect x="292" y="122" width="24" height="30" rx="3"/>
  <rect x="202" y="282" width="24" height="28" rx="3"/>
</g>
<g stroke="#fff" stroke-width="24" stroke-linecap="round" fill="none">
  <path d="M122 104v304M390 104v304"/>
  <path d="M122 240h268M122 390h268"/>
</g>
</svg>`,
  },
  // 團購記錄: green (app accent #177245), a shopping bag ticked "picked up".
  groupbuy: {
    name: "團購記錄",
    short: "團購",
    color: "#177245",
    svg: (rounded) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" ${rounded ? 'rx="112"' : ""} fill="#177245"/>
<path d="M196 196v-26a60 60 0 0 1 120 0v26" fill="none" stroke="#fff" stroke-width="26" stroke-linecap="round"/>
<path d="M138 196h236l-14 196a22 22 0 0 1-22 20H174a22 22 0 0 1-22-20z" fill="#fff" stroke="#fff" stroke-width="12" stroke-linejoin="round"/>
<path d="M200 306l40 40 76-82" fill="none" stroke="#177245" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`,
  },
};

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [name, { svg, color, ...app }] of Object.entries(ICONS)) {
    writeFileSync(`${OUT}${name}.svg`, svg(true)); // browser-tab favicon: rounded
    // No start_url on purpose: it then defaults to the page's own URL, so a
    // home-screen shortcut keeps that link's ?app= & ?key=.
    writeFileSync(
      `${OUT}${name}.webmanifest`,
      JSON.stringify(
        {
          name: app.name,
          short_name: app.short,
          display: "standalone",
          theme_color: color,
          background_color: "#ffffff",
          icons: [
            { src: `${name}-192.png`, sizes: "192x192", type: "image/png", purpose: "any maskable" },
            { src: `${name}-512.png`, sizes: "512x512", type: "image/png", purpose: "any maskable" },
          ],
        },
        null,
        2,
      ) + "\n",
    );
    for (const size of [180, 192, 512]) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg(false)}`,
      );
      await page.locator("svg").screenshot({ path: `${OUT}${name}-${size}.png`, omitBackground: true });
    }
  }
  await browser.close();
  console.log("icons →", OUT);
}
