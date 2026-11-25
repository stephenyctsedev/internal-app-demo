// Vercel Web Analytics for the web build only (`__WEB__`); the claude.ai
// artifact build renders nothing, and esbuild drops the import there.
import { Analytics, type BeforeSendEvent } from "@vercel/analytics/react";

// Page URLs carry the secret `?key=`: keep only `app` so the key never
// reaches Vercel's analytics data.
function stripKey(event: BeforeSendEvent): BeforeSendEvent {
  const url = new URL(event.url);
  const app = url.searchParams.get("app");
  url.search = app ? "?app=" + encodeURIComponent(app) : "";
  url.hash = "";
  return { ...event, url: url.toString() };
}

export function WebAnalytics() {
  return __WEB__ ? <Analytics beforeSend={stripKey} /> : null;
}
