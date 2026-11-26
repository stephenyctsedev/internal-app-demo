// 中／Eng for the server-rendered pages (申請 / 我的鑰匙) and the access API.
// The choice is the `lang` cookie, set by the 中／Eng switch on any page
// (artifacts/shared/i18n.tsx sets the same cookie). Default is Chinese.
// Owner-facing text (emails, the 鑰匙簿 Sheet) always stays Chinese.

/** "zh" | "en" from the request's `lang` cookie. */
export function langOf(req) {
  const m = /(?:^|;\s*)lang=(en|zh)\b/.exec(req?.headers?.cookie ?? "");
  return m ? m[1] : "zh";
}

/** English for the user-facing messages the access API can return. */
const EN = {
  "請填你個名。": "Please enter your name.",
  "而家等緊批准嘅申請太多，請直接搵管理員。": "Too many requests are waiting for approval — please contact the admin directly.",
  "鑰匙簿滿咗，請搵管理員。": "The key book is full — please contact the admin.",
  "已經有幾部裝置等緊批准，請直接搵管理員。": "Several devices are already waiting for approval — please contact the admin directly.",
  "而家等緊批准嘅裝置太多，請直接搵管理員。": "Too many devices are waiting for approval — please contact the admin directly.",
  "呢部裝置未登記，或者已經被管理員刪咗。請撳「登記呢部裝置」。":
    "This device isn't registered, or the admin removed it. Tap \"Register this device\".",
  "伺服器暫時用唔到，請遲啲再試。": "The server is unavailable right now — please try again later.",
  "呢部裝置嘅 passkey 類型未支援。": "This device's passkey type isn't supported.",
  "頁面過咗期，請重新整理再試。": "This page has expired — please refresh and try again.",
  "要用 Face ID／指紋／螢幕鎖確認。": "Please confirm with Face ID / fingerprint / screen lock.",
  "Passkey 驗證唔到。": "The passkey couldn't be verified.",
};

/** Translate a known message for `lang`; unknown ones pass through. */
export function localize(lang, message) {
  return lang === "en" ? (EN[message] ?? message) : message;
}

/** The 中／Eng switch button for the server pages (wired by langScript). */
export function langToggle(lang) {
  const label = lang === "en" ? "切換至中文" : "Switch to English";
  return `<button type="button" id="lang" class="lang" aria-label="${label}"><span${lang === "zh" ? ' class="on"' : ""} lang="zh-Hant">中</span><span${lang === "en" ? ' class="on"' : ""} lang="en">Eng</span></button>`;
}

export const LANG_STYLE = `.top{display:flex;justify-content:flex-end;margin:-8px 0 8px}
button.lang{display:inline-flex;padding:0;border:1px solid var(--line);background:var(--card);color:var(--mute);border-radius:99px;font-size:13px;line-height:1;overflow:hidden}
button.lang span{padding:7px 11px;border-radius:99px}button.lang span.on{background:var(--ink);color:var(--bg)}`;

/** Click → set the cookie (and the apps' localStorage key) and reload, so
 *  the server renders the other language. A typed name on the invite form
 *  survives the reload. */
export function langScript(lang) {
  const next = lang === "en" ? "zh" : "en";
  return `document.getElementById("lang").addEventListener("click",()=>{
try{localStorage.setItem("lang","${next}")}catch{}
document.cookie="lang=${next}; Path=/; Max-Age=31536000; SameSite=Lax"+(location.protocol==="https:"?"; Secure":"");
try{const n=document.querySelector("input[name=name]");if(n&&n.value)sessionStorage.setItem("lang.keep",n.value)}catch{}
location.reload()});
try{const v=sessionStorage.getItem("lang.keep"),n=document.querySelector("input[name=name]");if(v&&n){n.value=v}sessionStorage.removeItem("lang.keep")}catch{}`;
}
