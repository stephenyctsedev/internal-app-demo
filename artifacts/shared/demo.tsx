// The strip shown at the top of each app in the portfolio demo build
// (`__DEMO__`): says the data is sample data kept in this browser, links
// back to the demo home page and offers a reset. Renders nothing in the
// claude.ai artifact and Vercel web builds.
import { resetDemoData } from "./demo-store";
import { t, useLang } from "./i18n";

export function DemoBanner() {
  useLang();
  if (!__DEMO__) return null;
  const reset = () => {
    if (!confirm(t("將示範資料還原做最初嘅樣？", "Reset the sample data to how it started?"))) return;
    resetDemoData();
    location.reload();
  };
  return (
    <div
      role="note"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-1.5 text-center text-xs text-[var(--dim)]"
    >
      <span>
        <b className="font-semibold text-[var(--text)]">Demo</b> ·{" "}
        {t("示範資料，只儲喺呢個瀏覽器，冇連接 Google Sheet", "Sample data kept in this browser — not connected to Google Sheets")}
      </span>
      <span className="flex items-center gap-3">
        <a href="./" className="underline underline-offset-2">
          {t("返主頁", "All apps")}
        </a>
        <button type="button" onClick={reset} className="underline underline-offset-2">
          {t("還原資料", "Reset data")}
        </button>
      </span>
    </div>
  );
}
