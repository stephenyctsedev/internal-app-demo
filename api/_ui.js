// Small server-rendered pages for the key flow: the invite (申請) form and a
// person's own key page (我的鑰匙). Plain HTML + a few lines of JS, no build.
import { APPS } from "./_lib.js";

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
a.btn,button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:10px 16px;cursor:pointer;text-decoration:none;color:#fff;background:var(--ink);white-space:nowrap}
a.btn.stock{background:var(--stock)}a.btn.groupbuy{background:var(--groupbuy)}
button.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
button:disabled{opacity:.5;cursor:default}
label{display:block}input[type=text]{width:100%;font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);margin:6px 0 14px}
.check{display:flex;gap:10px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin:8px 0}
.note{border-top:1px solid var(--line);margin-top:20px;padding-top:14px}
.err{color:var(--err);min-height:1.5em;margin:8px 0}`;

function shell(title, body, script = "") {
  return `<!DOCTYPE html><html lang="zh-HK"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" /><meta name="referrer" content="no-referrer" />
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

/** /?invite=… — ask for a name; the apps are fixed by the invite code
 *  (the owner decides), so they are only shown, not chosen. */
export function invitePage(apps) {
  const list = apps
    .map((id) => `<div class="check"><img src="/icons/${id}.svg" alt="" width="28" height="28" />${esc(APPS[id].title)}</div>`)
    .join("");
  const body = `<h1>申請鑰匙</h1>
<p class="mute">填好之後，管理員批准咗你先用得。</p>
<form id="f" novalidate>
<label>你個名<input type="text" name="name" maxlength="30" autocomplete="name" required /></label>
<p>你會申請用：</p>${list}
<p class="err" id="err" role="alert"></p>
<button type="submit">遞交申請</button></form>
<div id="done" hidden><p><span class="pill wait">等緊批准</span></p><p>已經遞交申請，等管理員批准。</p><p class="mute">轉緊去你嘅鑰匙頁…</p></div>`;
  const script = `
const f=document.getElementById("f"),err=document.getElementById("err"),done=document.getElementById("done");
f.addEventListener("submit",async(e)=>{e.preventDefault();err.textContent="";
const name=f.elements.namedItem("name").value.trim();
if(!name){err.textContent="請填你個名。";return}
const b=f.querySelector("button");b.disabled=true;
try{const invite=new URLSearchParams(location.search).get("invite")||"";
const r=await fetch("/api/access",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"register",invite,name})});
const j=await r.json().catch(()=>({}));
if(r.ok&&j.key){f.hidden=true;done.hidden=false;
// Wait until the server can see the new key (it may answer from another
// instance), so the redirect lands on the key page, not the dead page.
for(let i=0;i<8;i++){try{const s=await fetch("/api/access",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"status",key:j.key})});if(s.ok)break}catch{}await new Promise(z=>setTimeout(z,1500))}
location.replace("/?key="+encodeURIComponent(j.key));return}
err.textContent=r.status===404?"呢條邀請連結已經用唔到，請搵管理員。":(j.error&&j.error.message)||"申請唔到，請再試一次。";
}catch{err.textContent="連唔到伺服器，請檢查網絡再試。"}b.disabled=false});`;
  return shell("申請鑰匙", body, script);
}

/** /?key=… (or an app this key isn't approved for) — the person's own page.
 *  Lists only the apps they were invited to or the owner ticked. */
export function keyPage(user, key) {
  const k = encodeURIComponent(key);
  const shown = Object.keys(APPS).filter((id) => user.ok[id] || user.requested[id]);
  const cards = shown
    .map((id) => {
      const right = user.ok[id] ? `<a class="btn ${id}" href="/?app=${id}&amp;key=${esc(k)}">開啟</a>` : "";
      const pill = user.ok[id] ? `<span class="pill ok">已批准</span>` : `<span class="pill wait">等緊批准</span>`;
      return `<div class="card"><img src="/icons/${id}.svg" alt="" /><div class="t"><b>${esc(APPS[id].title)}</b>${pill}</div>${right}</div>`;
    })
    .join("");
  const waiting = shown.some((id) => !user.ok[id]);
  const body = `<h1>${esc(user.name || "你好")}</h1>
<p class="mute">呢頁係你自己嘅鑰匙頁。</p>${cards}
${waiting ? `<p class="mute">已經通知管理員。批准之後呢頁會自動更新，唔使閂。</p>` : ""}
<div class="note mute"><p><b>呢條連結就係你嘅鑰匙</b>，唔好傳畀其他人。請收藏呢頁。</p>
<p>撳「開啟」之後，喺 Safari 撳「分享 → 加入主畫面」，以後由主畫面開就得。</p></div>`;
  if (!waiting) return shell("我的鑰匙", body);
  const state = JSON.stringify(Object.fromEntries(Object.keys(APPS).map((id) => [id, user.ok[id]])));
  const script = `
const key=new URLSearchParams(location.search).get("key")||"",was=${state};
setInterval(async()=>{try{const r=await fetch("/api/access",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"status",key})});
if(!r.ok)return;const j=await r.json();if(Object.keys(was).some(a=>j.apps[a]&&j.apps[a].ok!==was[a]))location.reload()}catch{}},20000);`;
  return shell("我的鑰匙", body, script);
}
