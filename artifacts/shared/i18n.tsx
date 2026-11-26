// 中／Eng language switch shared by both apps.
//
// Strings stay inline as t("中文", "English") so the Chinese remains the
// source of truth next to its translation. The choice is per device:
// localStorage (both builds) plus, in the web build, a `lang` cookie so the
// server-rendered 申請 / 我的鑰匙 pages (api/_ui.js) open in the same
// language. Default is Chinese. Sheet data (product names, tab names,
// values written to the Sheet) is never translated.
import { useEffect, useSyncExternalStore } from "react";

export type Lang = "zh" | "en";
const KEY = "lang";

function initial(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "en" || v === "zh") return v;
  } catch {
    // storage blocked (private mode, previews)
  }
  try {
    const m = /(?:^|;\s*)lang=(en|zh)\b/.exec(document.cookie);
    if (m) return m[1] as Lang;
  } catch {
    // cookies blocked (sandboxed frame)
  }
  // The portfolio demo opens in English; the real apps default to Chinese.
  return __DEMO__ ? "en" : "zh";
}

let lang: Lang = initial();
const subs = new Set<() => void>();

function applyDocLang() {
  document.documentElement.lang = lang === "en" ? "en" : "zh-Hant";
}
applyDocLang();

/** Pick the string for the current language. */
export const t = (zh: string, en: string): string => (lang === "en" ? en : zh);
export const getLang = (): Lang => lang;
/** Locale for toLocaleString(). */
export const locale = (): string => (lang === "en" ? "en-CA" : "zh-Hant");

export function setLang(next: Lang) {
  if (next === lang) return;
  lang = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // ignore
  }
  if (__WEB__) {
    try {
      const secure = location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `lang=${next}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    } catch {
      // ignore
    }
  }
  applyDocLang();
  for (const f of subs) f();
}

/** Re-renders the caller when the language changes. Call it in each app's
 *  root component; everything below re-renders with it. */
export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => lang,
  );
}

/** Keeps the browser tab title in the current language. */
export function useDocTitle(zh: string, en: string) {
  const l = useLang();
  useEffect(() => {
    document.title = l === "en" ? en : zh;
  }, [l, zh, en]);
}

/** The 中／Eng switch: a two-segment pill, current language highlighted. */
export function LangToggle({ className = "" }: { className?: string }) {
  const l = useLang();
  const seg = (on: boolean) =>
    `px-2.5 py-1 ${on ? "bg-[var(--text)] text-[var(--bg)]" : "text-[var(--dim)]"}`;
  return (
    <button
      type="button"
      onClick={() => setLang(l === "en" ? "zh" : "en")}
      aria-label={l === "en" ? "切換至中文" : "Switch to English"}
      className={`inline-flex shrink-0 items-stretch overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface)] p-0 text-xs font-semibold leading-none ${className}`}
    >
      <span lang="zh-Hant" className={`${seg(l === "zh")} flex items-center rounded-full`}>中</span>
      <span lang="en" className={`${seg(l === "en")} flex items-center rounded-full`}>Eng</span>
    </button>
  );
}
