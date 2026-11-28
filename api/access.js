// POST /api/access — the key flow behind the invite form and 我的鑰匙 page.
//   {action:"register",       invite, name}            → {key, name}   (apps come from the invite)
//   {action:"status",         key}                     → {name, apps:{stock:{ok,level,requested},…}, device}
//                                                         level = "read" | "write" | null
//   {action:"passkey-create", key, credential, standalone} → {device}  + session cookie
//   {action:"passkey-get",    key, credential}         → {device}      + session cookie
// device = "approved" | "pending" | "none" (for this browser's session cookie).
// The owner's 管理 page (every call carries admin = 設定 管理碼):
//   {action:"admin-list",   admin}                      → {invites:[…], legacy:[label…], people:[…]}
//   {action:"admin-create", admin, apps, note, days, uses} → {invite}  (days / uses: null = no limit)
//   {action:"admin-revoke", admin, code}                → {}
//   {action:"admin-cleanup", admin}                     → {removed}  (deletes 過咗期 / 用完 links)
//   {action:"admin-remove-legacy", admin, label}        → {}  (deletes an old fixed 設定 code)
//   {action:"admin-people", admin}                      → {people:[{id, name, asked, requested, level, devices:[{id,label,at,ok}], pending}]}
//   {action:"admin-set-level", admin, user, app, level} → {people}  (level "read" | "write" | null → 鑰匙 B / C)
//   {action:"admin-device", admin, device, ok}          → {people}  (裝置 批准 ☐)
//   {action:"admin-remove-device", admin, device}       → {people}  (deletes the 裝置 row)
//   {action:"admin-remove-person", admin, user}         → {people}  (deletes the 鑰匙 row + their 裝置 rows)
//   user = the person's key fingerprint, device = the passkey id (both from admin-people).
// Unknown invite / key / 管理碼 → 404 with no detail.
import { APPS, HttpError, securityHeaders } from "./_lib.js";
import {
  addDevice,
  clearDeadInvites,
  createInvite,
  deviceLabel,
  deviceState,
  findDevice,
  findUser,
  isAdmin,
  listInvites,
  listPeople,
  register,
  removeDevice,
  removeLegacyInvite,
  removePerson,
  revokeInvite,
  setDevice,
  setLevel,
} from "./_access.js";
import { newSession, sessionCookie, siteOf, verifyAssertion, verifyRegistration } from "./_passkey.js";
import { langOf, localize } from "./_i18n.js";

async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") return JSON.parse(req.body);
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8"));
    return req.body;
  }
  let s = "";
  for await (const c of req) {
    s += c;
    if (s.length > 64 * 1024) throw new HttpError(413, "bad_input", "too large");
  }
  return JSON.parse(s || "{}");
}

async function knownUser(key) {
  const u = await findUser(key);
  if (!u) throw new HttpError(404, "not_found", "not found");
  return u;
}

async function needAdmin(code) {
  if (!(await isAdmin(code))) throw new HttpError(404, "not_found", "not found");
}

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
        const { key, name } = await register(b.invite, b.name);
        return send(200, { key, name });
      }
      case "status": {
        const u = await knownUser(b.key);
        return send(200, {
          name: u.name,
          apps: Object.fromEntries(Object.keys(APPS).map((a) => [a, { ok: u.ok[a], level: u.level[a], requested: u.requested[a] }])),
          device: await deviceState(u, req.headers.cookie),
        });
      }
      case "passkey-create": {
        const u = await knownUser(b.key);
        const reg = verifyRegistration(b.credential, u.hash, siteOf(req));
        const dev = await addDevice(u, reg, deviceLabel(req.headers["user-agent"], b.standalone === true));
        res.setHeader("Set-Cookie", sessionCookie(req, u.hash, newSession(u.hash, reg.credId)));
        return send(200, { device: dev.ok ? "approved" : "pending" });
      }
      case "passkey-get": {
        const u = await knownUser(b.key);
        const dev = typeof b.credential?.id === "string" ? await findDevice(u, b.credential.id) : null;
        if (!dev) throw new HttpError(404, "no_device", "呢部裝置未登記，或者已經被管理員刪咗。請撳「登記呢部裝置」。");
        verifyAssertion(b.credential, dev, u.hash, siteOf(req));
        res.setHeader("Set-Cookie", sessionCookie(req, u.hash, newSession(u.hash, dev.credId)));
        return send(200, { device: dev.ok ? "approved" : "pending" });
      }
      case "admin-list":
        await needAdmin(b.admin);
        return send(200, { ...(await listInvites()), ...(await listPeople()) });
      case "admin-create":
        await needAdmin(b.admin);
        return send(200, { invite: await createInvite(b) });
      case "admin-revoke":
        await needAdmin(b.admin);
        await revokeInvite(b.code);
        return send(200, {});
      case "admin-cleanup":
        await needAdmin(b.admin);
        return send(200, { removed: await clearDeadInvites() });
      case "admin-remove-legacy":
        await needAdmin(b.admin);
        await removeLegacyInvite(b.label);
        return send(200, {});
      case "admin-people":
        await needAdmin(b.admin);
        return send(200, await listPeople());
      // Each change answers with the list read again right after it, so the
      // page shows what the Sheet now holds (another server instance may
      // still have an older copy cached).
      case "admin-set-level":
        await needAdmin(b.admin);
        await setLevel(b.user, b.app, b.level ?? null);
        return send(200, await listPeople({ fresh: true }));
      case "admin-device":
        await needAdmin(b.admin);
        await setDevice(b.device, b.ok === true);
        return send(200, await listPeople({ fresh: true }));
      case "admin-remove-device":
        await needAdmin(b.admin);
        await removeDevice(b.device);
        return send(200, await listPeople({ fresh: true }));
      case "admin-remove-person":
        await needAdmin(b.admin);
        await removePerson(b.user);
        return send(200, await listPeople({ fresh: true }));
      default:
        throw new HttpError(400, "bad_input", "unknown action");
    }
  } catch (e) {
    if (e instanceof HttpError) {
      // Google-side problems never reach the invite/key pages as details.
      const code = e.code === "no_access" || e.code === "not_configured" || e.code === "upstream_error" ? 503 : e.status;
      const message = code === 503 ? "伺服器暫時用唔到，請遲啲再試。" : e.message;
      if (code === 503) console.error(e);
      return send(code, { error: { code: code === 503 ? "unavailable" : e.code, message: localize(langOf(req), message) } });
    }
    console.error(e);
    send(500, { error: { code: "unavailable", message: localize(langOf(req), "伺服器暫時用唔到，請遲啲再試。") } });
  }
}
