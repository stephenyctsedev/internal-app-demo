declare module "*.css";

/** true in the Vercel web build, false in the claude.ai artifact build (esbuild define). */
declare const __WEB__: boolean;

/** true in the portfolio demo build (sample data in localStorage, no Google Sheets). */
declare const __DEMO__: boolean;
