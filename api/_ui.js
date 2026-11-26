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
.apps{margin:0 0 8px;padding:0;list-style:none}.apps li{display:flex;gap:10px;align-items:center;padding:4px 0;font-weight:600}
.note{border-top:1px solid var(--line);margin-top:20px;padding-top:14px}
.err{color:var(--err);min-height:1.5em;margin:8px 0}
.box{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0}
.box b{display:block;margin-bottom:4px}.box p{margin:4px 0 12px}.box .alt{margin:14px 0 0}
.box .alt button{margin-left:6px;padding:6px 12px}.card.dev{border-color:var(--wait);background:var(--wait-bg)}
.card.dev .mute{display:block}`;

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
    .map((id) => `<li><img src="/icons/${id}.svg" alt="" width="24" height="24" />${esc(APPS[id].title)}</li>`)
    .join("");
  const body = `<h1>申請鑰匙</h1>
<p class="mute">填好之後，管理員批准咗你先用得。</p>
<form id="f" novalidate>
<label>你個名<input type="text" name="name" maxlength="30" autocomplete="name" required /></label>
<p class="mute" style="margin:0 0 4px">批准之後可以用：</p><ul class="apps">${list}</ul>
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

const json = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

/** /?key=… (or an app this key can't open here yet) — the person's own
 *  page. `device` is this browser's state: "approved" | "pending" | "none".
 *  With "none" it registers or unlocks this device with a passkey. */
export function keyPage(user, key, device, passkey) {
  const k = encodeURIComponent(key);
  const shown = Object.keys(APPS).filter((id) => user.ok[id] || user.requested[id]);
  const cards = shown
    .map((id) => {
      const open = user.ok[id] && device === "approved";
      const right = open ? `<a class="btn ${id}" href="/?app=${id}&amp;key=${esc(k)}">開啟</a>` : "";
      const pill = user.ok[id] ? `<span class="pill ok">已批准</span>` : `<span class="pill wait">等緊批准</span>`;
      return `<div class="card"><img src="/icons/${id}.svg" alt="" /><div class="t"><b>${esc(APPS[id].title)}</b>${pill}</div>${right}</div>`;
    })
    .join("");
  const hasDevices = passkey.creds.length > 0;
  let dev = "";
  if (device === "pending") {
    dev = `<div class="card dev"><div class="t"><b>呢部裝置等緊批准</b><span class="mute">管理員批准咗就用得，呢頁會自動更新，唔使閂。</span></div></div>`;
  } else if (device === "none") {
    dev = hasDevices
      ? `<div class="dev box"><b>確認呢部裝置</b><p class="mute">用 Face ID／指紋／螢幕鎖，證明呢部係你登記咗嘅裝置。</p>
<button id="unlock">用 Face ID／指紋解鎖</button>
<p class="mute alt">呢部裝置第一次用？<button id="enroll" class="ghost">登記呢部裝置</button></p></div>`
      : `<div class="dev box"><b>登記呢部裝置</b><p class="mute">第一次用要用 Face ID／指紋／螢幕鎖登記呢部裝置。管理員批准咗呢部裝置，先開到 app。</p>
<button id="enroll">登記呢部裝置</button></div>`;
  }
  const waiting = device === "pending" || (device === "approved" && shown.some((id) => !user.ok[id]));
  const body = `<h1>${esc(user.name || "你好")}</h1>
<p class="mute">呢頁係你自己嘅鑰匙頁。</p>${dev}${cards}
<p class="err" id="err" role="alert"></p>
${device === "approved" && waiting ? `<p class="mute">已經通知管理員。批准之後呢頁會自動更新，唔使閂。</p>` : ""}
<div class="note mute"><p><b>呢條連結只可以喺你登記咗嘅裝置用。</b>畀咗其他人都開唔到，只會通知管理員。</p>
<p>撳「開啟」之後，喺 Safari 撳「分享 → 加入主畫面」（Android：Chrome 選單 → 加到主畫面），以後由主畫面開就得。</p></div>`;
  const cfg = {
    rpId: passkey.rpId,
    create: passkey.create,
    get: passkey.get,
    userId: passkey.userId,
    name: user.name || "user",
    creds: passkey.creds,
    state: Object.fromEntries(Object.keys(APPS).map((id) => [id, user.ok[id]])),
    device,
    waiting,
  };
  const script = `
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
if(!r.ok)throw Object.assign(new Error((j.error&&j.error.message)||"做唔到，請再試一次。"),{name:"Server"});return j}
function say(e,first){err.textContent=e.name==="Server"?e.message
:e.name==="InvalidStateError"?"呢部裝置已經登記咗，請撳「用 Face ID／指紋解鎖」。"
:e.name==="NotAllowedError"?(first?"取消咗，或者呢部裝置未設定 Face ID／指紋／螢幕鎖。":"呢部裝置搵唔到你嘅 passkey（或者撳咗取消）。第一次用呢部裝置，請撳「登記呢部裝置」。")
:e.name==="TypeError"?"連唔到伺服器，請檢查網絡再試。":"做唔到："+e.message}
function wire(id,run){const b=document.getElementById(id);if(!b)return;b.addEventListener("click",async()=>{
if(Date.now()-T0>9*60e3){location.reload();return}
if(!window.PublicKeyCredential){err.textContent="呢個瀏覽器用唔到 Face ID／指紋登入，請用最新版 Safari 或者 Chrome。";return}
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
if(j.device!==C.device||Object.keys(C.state).some((a)=>j.apps[a]&&j.apps[a].ok!==C.state[a]))location.reload()}catch{}},20000);`;
  return shell("我的鑰匙", body, script);
}
