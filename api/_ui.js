// Small server-rendered pages for the key flow: the invite (申請) form, a
// person's own key page (我的鑰匙) and the owner's 管理 page (invite links).
// Plain HTML + a few lines of JS, no build.
import { APPS } from "./_lib.js";
import { LANG_STYLE, langScript, langToggle } from "./_i18n.js";

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f3;--card:#fff;--ink:#1d1d1b;--mute:#6b6b66;--line:#e2e2dc;
--stock:#ea580c;--groupbuy:#177245;--ok:#177245;--ok-bg:#e7f4ec;--wait:#9a6700;--wait-bg:#fdf3d8;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecece8;--mute:#a2a29c;--line:#34342f;
--ok:#5fc48a;--ok-bg:#16301f;--wait:#e3b341;--wait-bg:#33290f;--err:#f97066}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink)}
body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"PingFang HK","Noto Sans HK","Microsoft JhengHei",sans-serif;padding:24px 16px 40px}
main{max-width:440px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}p{margin:0 0 12px}.mute{color:var(--mute);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin:12px 0;display:flex;gap:12px;align-items:center}
.card img{width:44px;height:44px;border-radius:10px;flex:none}.card .t{flex:1;min-width:0}.card b{display:block}
.pill{display:inline-block;font-size:13px;padding:2px 8px;border-radius:99px}
.pill.ok{color:var(--ok);background:var(--ok-bg)}.pill.wait{color:var(--wait);background:var(--wait-bg)}.pill.no{color:var(--mute);border:1px solid var(--line)}
a.btn,button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:10px 16px;cursor:pointer;text-decoration:none;color:var(--bg);background:var(--ink);white-space:nowrap}
a.btn.stock{color:#fff;background:var(--stock)}a.btn.groupbuy{color:#fff;background:var(--groupbuy)}
button.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
button:disabled{opacity:.5;cursor:default}
label{display:block}input[type=text]{width:100%;font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);margin:6px 0 14px}
.apps{margin:0 0 8px;padding:0;list-style:none}.apps li{display:flex;gap:10px;align-items:center;padding:4px 0;font-weight:600}
.note{border-top:1px solid var(--line);margin-top:20px;padding-top:14px}
.err{color:var(--err);min-height:1.5em;margin:8px 0}
.box{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0}
.box b{display:block;margin-bottom:4px}.box p{margin:4px 0 12px}.box .alt{margin:14px 0 0}
.box .alt button{margin-left:6px;padding:6px 12px}.card.dev{border-color:var(--wait);background:var(--wait-bg)}
.card.dev .mute{display:block}
h2{font-size:17px;margin:26px 0 4px}
select{font:inherit;padding:9px 10px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);width:100%;margin:6px 0 14px}
.chk{display:flex;gap:10px;align-items:center;padding:6px 0;font-weight:600;cursor:pointer}
.chk input{width:20px;height:20px;margin:0;accent-color:var(--ink)}.chk img{width:28px;height:28px;border-radius:7px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.two label{min-width:0}
.acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.acts .btn,.acts button{padding:8px 14px}
a.btn.wa{color:#fff;background:#1f8f4e}
input.link{font-size:14px;margin:6px 0 0}
.inv{display:block}.inv .head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.inv .head img{width:24px;height:24px;border-radius:6px}
.inv .head b{display:inline;margin:0;flex:1;min-width:0}.inv .meta{font-size:13px;color:var(--mute);margin:6px 0 0}
.inv.off{opacity:.65}.inv .acts button{padding:6px 12px;font-size:14px}
#f .err{min-height:0;margin:0 0 10px}#f .err:empty,#listErr:empty{display:none}
#cleanup{margin:4px 0 0;font-size:14px;padding:8px 14px}
button.danger{background:transparent;color:var(--err);border:1px solid var(--line)}
.inapp{position:relative;border-color:var(--wait);background:var(--wait-bg);padding-right:44px}
.inapp .arrow{position:absolute;top:8px;right:14px;font-size:26px;line-height:1;color:var(--wait)}
.inapp ol{margin:0 0 4px;padding-left:22px;font-weight:600}.inapp ol li{margin:2px 0}
${LANG_STYLE}`;

const json = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

/** Chat apps' built-in browsers (WeChat above all) can't do passkeys, so
 *  Face ID never comes up there. From the request's User-Agent:
 *  null, or { app: "wechat" | "other", os: "ios" | "android" | "desktop" }. */
export function inAppOf(req) {
  const ua = String(req?.headers?.["user-agent"] ?? "");
  let app = null;
  if (/MicroMessenger|wxwork/i.test(ua)) app = "wechat";
  else if (/FBAN|FBAV|FB_IAB|Instagram|\bLine\/|DingTalk|\bQQ\/|Weibo|Lark|Feishu/i.test(ua)) app = "other";
  if (!app) return null;
  const os = /iPhone|iPad|iPod/i.test(ua) ? "ios" : /Android/i.test(ua) ? "android" : "desktop";
  return { app, os };
}

/** In place of the Face ID buttons inside an in-app browser: how to get
 *  this same page into Safari / Chrome, plus a copy-link fallback. */
function inAppBox(inApp, L) {
  const where = inApp.app === "wechat" ? L("微信", "WeChat") : L("呢個 app", "this app");
  const item =
    inApp.os === "ios"
      ? L("「在 Safari 中打開」", "\"Open in Safari\"")
      : inApp.os === "android"
        ? L("「在瀏覽器打開」", "\"Open in Browser\"")
        : L("「用預設瀏覽器打開」", "\"Open in default browser\"");
  const browser = inApp.os === "ios" ? "Safari" : "Chrome";
  return `<div class="box inapp"><span class="arrow" aria-hidden="true">↗</span>
<b>${L(`喺${where}入面用唔到 Face ID／指紋`, `Face ID / fingerprint doesn't work inside ${where}`)}</b>
<p class="mute">${L(`請用 ${browser} 開呢頁：`, `Please open this page in ${browser}:`)}</p>
<ol><li>${L("撳右上角「⋯」", "Tap \"⋯\" at the top right")}</li><li>${L(`揀${item}`, `Choose ${item}`)}</li></ol>
<p class="mute alt">${L(`搵唔到？複製連結，貼去 ${browser} 開。`, `Can't find it? Copy the link and paste it into ${browser}.`)}<button type="button" id="copyLink" class="ghost">${L("複製連結", "Copy link")}</button></p></div>`;
}

/** Wires #copyLink (if the in-app box is on the page). */
function inAppScript(L) {
  return `{const b=document.getElementById("copyLink");if(b)b.addEventListener("click",async()=>{const u=location.href;
try{await navigator.clipboard.writeText(u)}catch{const t=document.createElement("textarea");t.value=u;t.setAttribute("readonly","");document.body.append(t);t.select();t.setSelectionRange(0,u.length);try{document.execCommand("copy")}catch{}t.remove()}
b.textContent=${json(L("複製咗 ✓", "Copied ✓"))};setTimeout(()=>b.textContent=${json(L("複製連結", "Copy link"))},2000)})}`;
}

function shell(lang, title, body, script = "", head = "") {
  return `<!DOCTYPE html><html lang="${lang === "en" ? "en" : "zh-HK"}"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" /><meta name="referrer" content="no-referrer" />
<title>${esc(title)}</title>${head}<style>${STYLE}</style></head>
<body><main><div class="top">${langToggle(lang)}</div>${body}</main><script>${langScript(lang)}${script}</script></body></html>`;
}

/** /?invite=… — ask for a name; the apps are fixed by the invite code
 *  (the owner decides), so they are only shown, not chosen. */
export function invitePage(apps, lang = "zh", inApp = null) {
  const L = (zh, en) => (lang === "en" ? en : zh);
  const list = apps
    .map((id) => `<li><img src="/icons/${id}.svg" alt="" width="24" height="24" />${esc(L(APPS[id].title, APPS[id].titleEn))}</li>`)
    .join("");
  const body = `<h1>${L("申請鑰匙", "Request a key")}</h1>
<p class="mute">${L("填好之後，管理員批准咗你先用得。", "Fill this in; you can use it once the admin approves.")}</p>
${inApp ? inAppBox(inApp, L) : ""}<form id="f" novalidate${inApp ? " hidden" : ""}>
<label>${L("你個名", "Your name")}<input type="text" name="name" maxlength="30" autocomplete="name" required /></label>
<p class="mute" style="margin:0 0 4px">${L("批准之後可以用：", "Once approved you can use:")}</p><ul class="apps">${list}</ul>
<p class="err" id="err" role="alert"></p>
<button type="submit">${L("遞交申請", "Submit request")}</button></form>
<div id="done" hidden><p><span class="pill wait">${L("等緊批准", "Waiting for approval")}</span></p><p>${L("已經遞交申請，等管理員批准。", "Request sent — waiting for the admin to approve.")}</p><p class="mute">${L("轉緊去你嘅鑰匙頁…", "Taking you to your key page…")}</p></div>`;
  // In WeChat the form stays hidden: applying there would use up a
  // one-time link, then the same link in Safari would be dead.
  const script = `${inAppScript(L)}
const f=document.getElementById("f"),err=document.getElementById("err"),done=document.getElementById("done");
f.addEventListener("submit",async(e)=>{e.preventDefault();err.textContent="";
const name=f.elements.namedItem("name").value.trim();
if(!name){err.textContent=${json(L("請填你個名。", "Please enter your name."))};return}
const b=f.querySelector("button");b.disabled=true;
try{const invite=new URLSearchParams(location.search).get("invite")||"";
const r=await fetch("/api/access",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"register",invite,name})});
const j=await r.json().catch(()=>({}));
if(r.ok&&j.key){f.hidden=true;done.hidden=false;
// Wait until the server can see the new key (it may answer from another
// instance), so the redirect lands on the key page, not the dead page.
for(let i=0;i<8;i++){try{const s=await fetch("/api/access",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"status",key:j.key})});if(s.ok)break}catch{}await new Promise(z=>setTimeout(z,1500))}
location.replace("/?key="+encodeURIComponent(j.key));return}
err.textContent=r.status===404?${json(L("呢條邀請連結已經用唔到，請搵管理員。", "This invite link no longer works — please contact the admin."))}:(j.error&&j.error.message)||${json(L("申請唔到，請再試一次。", "Couldn't send the request — please try again."))};
}catch{err.textContent=${json(L("連唔到伺服器，請檢查網絡再試。", "Can't reach the server — check your connection and try again."))}}b.disabled=false});`;
  return shell(lang, L("申請鑰匙", "Request a key"), body, script);
}

/** /?key=… (or an app this key can't open here yet) — the person's own
 *  page. `device` is this browser's state: "approved" | "pending" | "none".
 *  With "none" it registers or unlocks this device with a passkey. */
export function keyPage(user, key, device, passkey, lang = "zh", inApp = null) {
  const L = (zh, en) => (lang === "en" ? en : zh);
  const k = encodeURIComponent(key);
  const shown = Object.keys(APPS).filter((id) => user.ok[id] || user.requested[id]);
  const cards = shown
    .map((id) => {
      const open = user.ok[id] && device === "approved";
      const right = open ? `<a class="btn ${id}" href="/?app=${id}&amp;key=${esc(k)}">${L("開啟", "Open")}</a>` : "";
      const pill = user.ok[id]
        ? `<span class="pill ok">${L("已批准", "Approved")}</span> <span class="pill no">${
            user.level[id] === "write" ? L("可以改", "Can edit") : L("只可閱讀", "View only")
          }</span>`
        : `<span class="pill wait">${L("等緊批准", "Waiting for approval")}</span>`;
      return `<div class="card"><img src="/icons/${id}.svg" alt="" /><div class="t"><b>${esc(L(APPS[id].title, APPS[id].titleEn))}</b>${pill}</div>${right}</div>`;
    })
    .join("");
  const hasDevices = passkey.creds.length > 0;
  let dev = "";
  if (device === "pending") {
    dev = `<div class="card dev"><div class="t"><b>${L("呢部裝置等緊批准", "This device is waiting for approval")}</b><span class="mute">${L("管理員批准咗就用得，呢頁會自動更新，唔使閂。", "It works once the admin approves. This page updates by itself — no need to close it.")}</span></div></div>`;
  } else if (device === "none" && inApp) {
    dev = inAppBox(inApp, L);
  } else if (device === "none") {
    dev = hasDevices
      ? `<div class="dev box"><b>${L("確認呢部裝置", "Confirm this device")}</b><p class="mute">${L("用 Face ID／指紋／螢幕鎖，證明呢部係你登記咗嘅裝置。", "Use Face ID / fingerprint / screen lock to prove this is a device you registered.")}</p>
<button id="unlock">${L("用 Face ID／指紋解鎖", "Unlock with Face ID / fingerprint")}</button>
<p class="mute alt">${L("呢部裝置第一次用？", "First time on this device?")}<button id="enroll" class="ghost">${L("登記呢部裝置", "Register this device")}</button></p></div>`
      : `<div class="dev box"><b>${L("登記呢部裝置", "Register this device")}</b><p class="mute">${L("第一次用要用 Face ID／指紋／螢幕鎖登記呢部裝置。管理員批准咗呢部裝置，先開到 app。", "The first time, register this device with Face ID / fingerprint / screen lock. The apps open once the admin approves this device.")}</p>
<button id="enroll">${L("登記呢部裝置", "Register this device")}</button></div>`;
  }
  const waiting = device === "pending" || (device === "approved" && shown.some((id) => !user.ok[id]));
  const body = `<h1>${esc(user.name || L("你好", "Hello"))}</h1>
<p class="mute">${L("呢頁係你自己嘅鑰匙頁。", "This is your own key page.")}</p>${dev}${cards}
<p class="err" id="err" role="alert"></p>
${device === "approved" && waiting ? `<p class="mute">${L("已經通知管理員。批准之後呢頁會自動更新，唔使閂。", "The admin has been notified. This page updates by itself once approved — no need to close it.")}</p>` : ""}
<div class="note mute"><p><b>${L("呢條連結只可以喺你登記咗嘅裝置用。", "This link only works on devices you registered.")}</b>${L("畀咗其他人都開唔到，只會通知管理員。", " Anyone else who gets it can't open it — the admin just gets notified.")}</p>
<p>${L("撳「開啟」之後，喺 Safari 撳「分享 → 加入主畫面」（Android：Chrome 選單 → 加到主畫面），以後由主畫面開就得。", "After tapping \"Open\", in Safari tap Share → Add to Home Screen (Android: Chrome menu → Add to Home screen), then open it from your home screen.")}</p></div>`;
  const cfg = {
    rpId: passkey.rpId,
    create: passkey.create,
    get: passkey.get,
    userId: passkey.userId,
    name: user.name || "user",
    creds: passkey.creds,
    state: Object.fromEntries(Object.keys(APPS).map((id) => [id, user.level[id] ?? null])),
    device,
    waiting,
    m: {
      fail: L("做唔到，請再試一次。", "That didn't work — please try again."),
      already: L("呢部裝置已經登記咗，請撳「用 Face ID／指紋解鎖」。", "This device is already registered — tap \"Unlock with Face ID / fingerprint\"."),
      cancelFirst: L("取消咗，或者呢部裝置未設定 Face ID／指紋／螢幕鎖。", "Cancelled, or this device has no Face ID / fingerprint / screen lock set up."),
      cancel: L(
        "呢部裝置搵唔到你嘅 passkey（或者撳咗取消）。第一次用呢部裝置，請撳「登記呢部裝置」。",
        "Your passkey wasn't found on this device (or you cancelled). First time on this device? Tap \"Register this device\".",
      ),
      offline: L("連唔到伺服器，請檢查網絡再試。", "Can't reach the server — check your connection and try again."),
      other: L("做唔到：", "That didn't work: "),
      noWebauthn: L(
        "呢個瀏覽器用唔到 Face ID／指紋登入，請用最新版 Safari 或者 Chrome。",
        "This browser can't sign in with Face ID / fingerprint — please use the latest Safari or Chrome.",
      ),
    },
  };
  const script = `${inAppScript(L)}
const C=${json(cfg)},T0=Date.now(),key=new URLSearchParams(location.search).get("key")||"",err=document.getElementById("err");
const enc=(b)=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
const dec=(s)=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")+"===".slice((s.length+3)%4)),(c)=>c.charCodeAt(0));
const post=(b)=>fetch("/api/access",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...b,key})});
const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
const standalone=()=>matchMedia("(display-mode: standalone)").matches||navigator.standalone===true;
async function settle(){ // wait until the server (any instance) sees this device, then reload
for(let i=0;i<8;i++){try{const r=await post({action:"status"});if(r.ok&&(await r.json()).device!=="none")break}catch{}await sleep(1500)}
location.reload()}
async function send(body){const r=await post(body);const j=await r.json().catch(()=>({}));
if(!r.ok)throw Object.assign(new Error((j.error&&j.error.message)||C.m.fail),{name:"Server"});return j}
function say(e,first){err.textContent=e.name==="Server"?e.message
:e.name==="InvalidStateError"?C.m.already
:e.name==="NotAllowedError"?(first?C.m.cancelFirst:C.m.cancel)
:e.name==="TypeError"?C.m.offline:C.m.other+e.message}
function wire(id,run){const b=document.getElementById(id);if(!b)return;b.addEventListener("click",async()=>{
if(Date.now()-T0>9*60e3){location.reload();return}
if(!window.PublicKeyCredential){err.textContent=C.m.noWebauthn;return}
err.textContent="";document.querySelectorAll(".dev button").forEach((x)=>x.disabled=true);
try{await run();await settle()}catch(e){say(e,id==="enroll")}
document.querySelectorAll(".dev button").forEach((x)=>x.disabled=false)})}
wire("enroll",async()=>{const c=await navigator.credentials.create({publicKey:{
challenge:dec(C.create),rp:{id:C.rpId,name:"Demo Co. 倉庫／團購"},user:{id:dec(C.userId),name:C.name,displayName:C.name},
pubKeyCredParams:[{type:"public-key",alg:-7},{type:"public-key",alg:-257}],
authenticatorSelection:{residentKey:"preferred",userVerification:"required"},attestation:"none",timeout:120000,
excludeCredentials:C.creds.map((id)=>({type:"public-key",id:dec(id)}))}});
await send({action:"passkey-create",standalone:standalone(),credential:{id:c.id,clientDataJSON:enc(c.response.clientDataJSON),attestationObject:enc(c.response.attestationObject)}})});
wire("unlock",async()=>{const c=await navigator.credentials.get({publicKey:{challenge:dec(C.get),rpId:C.rpId,userVerification:"required",timeout:120000,
allowCredentials:C.creds.map((id)=>({type:"public-key",id:dec(id)}))}});
await send({action:"passkey-get",credential:{id:c.id,clientDataJSON:enc(c.response.clientDataJSON),authenticatorData:enc(c.response.authenticatorData),signature:enc(c.response.signature)}})});
if(C.waiting)setInterval(async()=>{try{const r=await post({action:"status"});if(!r.ok)return;const j=await r.json();
if(j.device!==C.device||Object.keys(C.state).some((a)=>j.apps[a]&&(j.apps[a].level??null)!==C.state[a]))location.reload()}catch{}},20000);`;
  return shell(lang, L("我的鑰匙", "My key"), body, script);
}

/** /?admin=… — the owner's page: pick the apps, make an invite link to
 *  share, and see / stop the links made so far (all in 鑰匙簿 邀請 tab). */
export function adminPage(lang = "zh") {
  const L = (zh, en) => (lang === "en" ? en : zh);
  const appRow = (id, on) =>
    `<label class="chk"><input type="checkbox" name="app" value="${id}"${on ? " checked" : ""} /><img src="/icons/${id}.svg" alt="" />${esc(L(APPS[id].title, APPS[id].titleEn))}</label>`;
  const body = `<h1>${L("邀請連結", "Invite links")}</h1>
<p class="mute">${L("揀佢可以申請邊個 app，整一條新連結 WhatsApp 畀佢。佢申請咗之後，你照樣要喺鑰匙簿批准。", "Pick which apps they can ask for, make a new link and send it to them. After they apply you still approve them in the key book.")}</p>
<form id="f" class="box" novalidate>
<b>${L("可以申請", "Can ask for")}</b>
${appRow("stock", true)}${appRow("groupbuy", false)}
<label style="margin-top:10px">${L("畀邊個（可以唔填，只係俾你記）", "Who it's for (optional, just for you)")}<input type="text" name="note" maxlength="40" autocomplete="off" /></label>
<div class="two">
<label>${L("可以用幾多次", "Number of uses")}<select name="uses"><option value="1" selected>${L("1 次", "Once")}</option><option value="5">${L("5 次", "5 times")}</option><option value="20">${L("20 次", "20 times")}</option><option value="">${L("唔限", "No limit")}</option></select></label>
<label>${L("有效期", "Expires after")}<select name="days"><option value="1">${L("1 日", "1 day")}</option><option value="7" selected>${L("7 日", "7 days")}</option><option value="30">${L("30 日", "30 days")}</option><option value="">${L("唔限", "Never")}</option></select></label>
</div>
<p class="err" id="err" role="alert"></p>
<button type="submit">${L("整條連結", "Make link")}</button></form>
<div id="out" class="box" hidden><b>${L("新連結", "New link")}<span class="mute" id="outApps" style="font-weight:400"></span></b>
<input type="text" class="link" id="link" readonly aria-label="${L("新連結", "New link")}" />
<div class="acts"><button type="button" id="copy">${L("複製", "Copy")}</button><a class="btn wa" id="wa" target="_blank" rel="noopener noreferrer">WhatsApp</a><button type="button" id="share" class="ghost" hidden>${L("分享…", "Share…")}</button></div></div>
<h2>${L("整咗嘅連結", "Links made")}</h2>
<p class="mute" id="empty" hidden>${L("未有。", "None yet.")}</p>
<div id="list"><p class="mute">${L("載入緊…", "Loading…")}</p></div>
<button type="button" id="cleanup" class="ghost" hidden></button>
<p class="err" id="listErr" role="alert"></p>
<div id="legacyBox" hidden><h2>${L("舊邀請碼", "Old invite codes")}</h2>
<p class="mute">${L("以前「設定」tab 嘅固定邀請碼，之前 share 咗出去嘅連結仲用得。移除 = 即刻用唔到（已經申請咗嘅人唔受影響）。", "The fixed codes from the 設定 tab. Links you shared with them still work. Remove = they stop working at once (people who already applied aren't affected).")}</p>
<div id="legacy"></div></div>
<div class="note mute"><p>${L("停用 = 條連結即刻用唔到（已經申請咗嘅人唔受影響，佢哋喺「鑰匙」tab 管）。連結都記喺鑰匙簿「邀請」tab，喺嗰度刪行一樣係停用。", "Stop = the link stops working at once (people who already applied aren't affected — manage them in the 鑰匙 tab). Links are also kept in the key book's 邀請 tab; deleting a row there stops it too.")}</p>
<p>${L("呢頁嘅網址係你自己用嘅，唔好畀人。換網址：喺「設定」tab 改「管理碼」。", "This page's address is for you only — don't share it. To change it, edit 管理碼 in the 設定 tab.")}</p></div>`;
  const cfg = {
    apps: Object.fromEntries(Object.keys(APPS).map((id) => [id, L(APPS[id].title, APPS[id].titleEn)])),
    m: {
      pick: L("最少揀一個 app。", "Pick at least one app."),
      fail: L("做唔到，請再試一次。", "That didn't work — please try again."),
      offline: L("連唔到伺服器，請檢查網絡再試。", "Can't reach the server — check your connection and try again."),
      gone: L("呢個管理頁已經用唔到（管理碼改咗或者清空咗）。", "This admin page no longer works (管理碼 was changed or cleared)."),
      copied: L("複製咗", "Copied"),
      copy: L("複製", "Copy"),
      stop: L("停用", "Stop"),
      confirm: L("停用呢條連結？之後用佢開會見到死網頁。", "Stop this link? Opening it will then show the dead page."),
      ok: L("用得", "Active"),
      expired: L("過咗期", "Expired"),
      used: L("用完", "Used up"),
      made: L("整咗：", "Made: "),
      until: L("到期：", "Expires: "),
      never: L("唔會過期", "never expires"),
      uses: L("已用：", "Used: "),
      unlimited: L("（唔限次數）", " (no limit)"),
      forWho: L("畀：", "For: "),
      waText: L("你好！撳呢條連結申請用 {apps}：", "Hi! Tap this link to request access to {apps}: "),
      old: L("舊邀請碼", "Old code"),
      fixed: L("「設定」tab · 唔限次數 · 唔會過期", "設定 tab · no limit · never expires"),
      remove: L("移除", "Remove"),
      confirmOld: L("移除呢個舊邀請碼？之前用佢 share 出去嘅連結會變死網頁。", "Remove this old code? Links shared with it will show the dead page."),
      cleanup: L("清走過咗期／用完嘅（{n} 條）", "Clear expired / used-up links ({n})"),
      confirmCleanup: L("清走 {n} 條過咗期／用完嘅連結？", "Clear {n} expired / used-up links?"),
      sep: L("、", ", "),
      time: L("（Winnipeg 時間）", " (Winnipeg time)"),
    },
  };
  const script = `
const C=${json(cfg)},M=C.m,admin=new URLSearchParams(location.search).get("admin")||"";
const $=(id)=>document.getElementById(id),f=$("f"),err=$("err");
const el=(tag,attrs={},...kids)=>{const e=document.createElement(tag);for(const[k,v]of Object.entries(attrs))if(k==="class")e.className=v;else e.setAttribute(k,v);for(const k of kids)e.append(k);return e};
const linkOf=(code)=>location.origin+"/?invite="+encodeURIComponent(code);
const names=(apps)=>apps.map((a)=>C.apps[a]).join(M.sep);
async function call(body){let r;try{r=await fetch("/api/access",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...body,admin})})}
catch{throw new Error(M.offline)}const j=await r.json().catch(()=>({}));
if(r.status===404&&!body.code&&!body.label)throw new Error(M.gone);if(!r.ok)throw Object.assign(new Error((j.error&&j.error.message)||M.fail),{status:r.status});return j}
async function copy(text,btn){try{await navigator.clipboard.writeText(text)}catch{const t=el("textarea");t.value=text;document.body.append(t);t.select();document.execCommand("copy");t.remove()}
const was=btn.textContent;btn.textContent=M.copied+" ✓";setTimeout(()=>btn.textContent=was,1600)}
function show(inv){const link=linkOf(inv.code);$("out").hidden=false;$("link").value=link;$("outApps").textContent=" · "+names(inv.apps);
$("wa").href="https://wa.me/?text="+encodeURIComponent(M.waText.replace("{apps}",names(inv.apps))+link);
$("copy").onclick=()=>copy(link,$("copy"));
if(navigator.share){$("share").hidden=false;$("share").onclick=()=>navigator.share({text:M.waText.replace("{apps}",names(inv.apps)),url:link}).catch(()=>{})}
$("out").scrollIntoView({behavior:"smooth",block:"nearest"})}
function render(d){const list=$("list");list.replaceChildren();$("empty").hidden=d.invites.length>0;
for(const i of d.invites){const head=el("div",{class:"head"});for(const a of i.apps)head.append(el("img",{src:"/icons/"+a+".svg",alt:""}));
head.append(el("b",{},names(i.apps)),el("span",{class:"pill "+(i.state==="ok"?"ok":"no")},M[i.state]));
const meta=[];if(i.note)meta.push(M.forWho+i.note);meta.push(M.uses+i.used+(i.max?" / "+i.max:M.unlimited));
meta.push(M.made+i.created);meta.push(i.expires?M.until+i.expires:M.never);
const acts=el("div",{class:"acts"});
if(i.state==="ok"){const c=el("button",{type:"button",class:"ghost"},M.copy);c.onclick=()=>copy(linkOf(i.code),c);acts.append(c)}
const s=el("button",{type:"button",class:"danger"},M.stop);
s.onclick=async()=>{if(!confirm(M.confirm))return;s.disabled=true;$("listErr").textContent="";
try{await call({action:"admin-revoke",code:i.code});await load()}catch(e){$("listErr").textContent=e.message;s.disabled=false}};acts.append(s);
list.append(el("div",{class:"box inv"+(i.state==="ok"?"":" off")},head,el("p",{class:"meta"},meta.join(" · ")),acts))}
const dead=d.invites.filter((i)=>i.state!=="ok").length,cl=$("cleanup");cl.hidden=!dead;cl.disabled=false;cl.textContent=M.cleanup.replace("{n}",dead);
cl.onclick=async()=>{if(!confirm(M.confirmCleanup.replace("{n}",dead)))return;cl.disabled=true;$("listErr").textContent="";
try{await call({action:"admin-cleanup"});await load()}catch(e){$("listErr").textContent=e.message;cl.disabled=false}};
const lg=$("legacy");lg.replaceChildren();$("legacyBox").hidden=!d.legacy.length;
for(const o of d.legacy){const head=el("div",{class:"head"});for(const a of o.apps)head.append(el("img",{src:"/icons/"+a+".svg",alt:""}));
head.append(el("b",{},names(o.apps)),el("span",{class:"pill no"},M.old));
const x=el("button",{type:"button",class:"danger"},M.remove);
x.onclick=async()=>{if(!confirm(M.confirmOld))return;x.disabled=true;$("listErr").textContent="";
try{await call({action:"admin-remove-legacy",label:o.label});await load()}catch(e){$("listErr").textContent=e.message;x.disabled=false}};
lg.append(el("div",{class:"box inv"},head,el("p",{class:"meta"},o.label+" · "+M.fixed),el("div",{class:"acts"},x)))}}
let retry=0; // Google's per-minute limit: the list tries again by itself
async function load(){clearTimeout(retry);try{render(await call({action:"admin-list"}));$("listErr").textContent=""}catch(e){$("list").replaceChildren();$("listErr").textContent=e.message;
if(e.status===429)retry=setTimeout(load,30000)}}
f.addEventListener("submit",async(e)=>{e.preventDefault();err.textContent="";
const apps=[...f.querySelectorAll("input[name=app]:checked")].map((x)=>x.value);
if(!apps.length){err.textContent=M.pick;return}
const num=(n)=>{const v=f.elements.namedItem(n).value;return v===""?null:Number(v)};
const b=f.querySelector("button[type=submit]");b.disabled=true;
try{const{invite}=await call({action:"admin-create",apps,note:f.elements.namedItem("note").value,uses:num("uses"),days:num("days")});
f.elements.namedItem("note").value="";show(invite);await load()}catch(e){err.textContent=e.message}b.disabled=false});
load();`;
  // Home-screen icon: no start_url in the manifest, so the shortcut keeps
  // this page's own URL (with ?admin=).
  const head = `<link rel="icon" type="image/svg+xml" href="/icons/admin.svg" />
<link rel="icon" type="image/png" sizes="192x192" href="/icons/admin-192.png" />
<link rel="apple-touch-icon" href="/icons/admin-180.png" />
<link rel="manifest" href="/icons/admin.webmanifest" />
<meta name="apple-mobile-web-app-title" content="${L("邀請", "Invites")}" />`;
  return shell(lang, L("邀請連結", "Invite links"), body, script, head);
}
