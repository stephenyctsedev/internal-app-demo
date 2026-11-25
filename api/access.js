// POST /api/access — the key flow behind the invite form and 我的鑰匙 page.
//   {action:"register", invite, name, apps:["stock"|"groupbuy"]} → {key, name}
//   {action:"request",  key, app}                                → {ok:true}
//   {action:"status",   key}                                     → {name, apps:{stock:{ok,requested},…}}
// Unknown invite / key → 404 with no detail.
import { APPS, HttpError, securityHeaders } from "./_lib.js";
import { findUser, register, requestApp } from "./_access.js";

async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") return JSON.parse(req.body);
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8"));
    return req.body;
  }
  let s = "";
  for await (const c of req) {
    s += c;
    if (s.length > 16 * 1024) throw new HttpError(413, "bad_input", "too large");
  }
  return JSON.parse(s || "{}");
}

const status = (u) => ({
  name: u.name,
  apps: Object.fromEntries(Object.keys(APPS).map((a) => [a, { ok: u.ok[a], requested: u.requested[a] }])),
});

export default async function handler(req, res) {
  securityHeaders(res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const send = (code, body) => {
    res.statusCode = code;
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method !== "POST") throw new HttpError(405, "bad_input", "POST only");
    let b;
    try {
      b = await readJson(req);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, "bad_input", "invalid JSON");
    }
    switch (b?.action) {
      case "register": {
        const { key, name } = await register(b.invite, b.name, b.apps);
        return send(200, { key, name });
      }
      case "request": {
        await requestApp(b.key, b.app);
        return send(200, { ok: true });
      }
      case "status": {
        const u = await findUser(b.key);
        if (!u) throw new HttpError(404, "not_found", "not found");
        return send(200, status(u));
      }
      default:
        throw new HttpError(400, "bad_input", "unknown action");
    }
  } catch (e) {
    if (e instanceof HttpError) {
      // Google-side problems never reach the invite/key pages as details.
      const code = e.code === "no_access" || e.code === "not_configured" || e.code === "upstream_error" ? 503 : e.status;
      const message = code === 503 ? "伺服器暫時用唔到，請遲啲再試。" : e.message;
      if (code === 503) console.error(e);
      return send(code, { error: { code: code === 503 ? "unavailable" : e.code, message } });
    }
    console.error(e);
    send(500, { error: { code: "unavailable", message: "伺服器暫時用唔到，請遲啲再試。" } });
  }
}
