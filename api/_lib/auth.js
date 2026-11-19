// Auth helpers for Demo stock app.
// Session = HMAC-signed token in an httpOnly cookie `demo_session`.
// No password is ever stored in localStorage / a cookie — only this token.
// Cookie lasts 30 days, so the 2nd visit does not ask for the password again.
//
// Two modes, switched by env var AUTH_MODE (never hard-coded to one):
//  - gate (default): unauthenticated visitors see nothing at all.
//    Every API call (reads AND writes) requires a valid session.
//  - readonly: unauthenticated visitors can READ items / movements /
//    status, but every WRITE (add/update/delete/adjust/set-quantity/
//    shelf/update-movement) still requires a valid session cookie.
//    The backend enforces this — hiding buttons in the frontend alone
//    would not be enough.
// Frontend decides what to show from GET /api/me -> { authenticated,
// canEdit, authMode }. canEdit is true only with a valid session.
const crypto = require('crypto');

const COOKIE_NAME = 'demo_session';
const SESSION_DAYS = 30;

function getAuthMode() {
  const m = String(process.env.AUTH_MODE || 'gate').trim().toLowerCase();
  return m === 'readonly' ? 'readonly' : 'gate';
}

function getSessionSecret() {
  return process.env.SESSION_SECRET || '';
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payload) {
  const secret = getSessionSecret();
  if (!secret) throw new Error('SESSION_SECRET is not set');
  const body = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function createSession() {
  const now = Math.floor(Date.now() / 1000);
  return sign({ iat: now, exp: now + SESSION_DAYS * 24 * 60 * 60 });
}

function verifySession(token) {
  try {
    if (!token || typeof token !== 'string') return false;
    const secret = getSessionSecret();
    if (!secret) return false;
    const [body, sig] = token.split('.');
    if (!body || !sig) return false;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const out = {};
  const header = req.headers && req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSecureRequest(req) {
  // Vercel sets x-forwarded-proto; in production the cookie must be Secure.
  if (process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production') return true;
  const proto = req.headers && req.headers['x-forwarded-proto'];
  return proto === 'https';
}

function setSessionCookie(res, token, req) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_DAYS * 24 * 60 * 60}; SameSite=Lax${secure}`
  );
}

function clearSessionCookie(res, req) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`
  );
}

// Constant-time password check against APP_PASSWORD (env var only).
function checkPassword(input) {
  const expected = process.env.APP_PASSWORD || '';
  if (!expected || typeof input !== 'string') return false;
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function isAuthenticated(req) {
  const cookies = parseCookies(req);
  return verifySession(cookies[COOKIE_NAME]);
}

// canEdit is true only with a valid session, in both modes.
function canEdit(req) {
  return isAuthenticated(req);
}

function requireAuth(req, res) {
  // Writes: always require a valid session, in BOTH modes.
  if (isAuthenticated(req)) return true;
  res.status(401).json({ ok: false, error: 'unauthorized' });
  return false;
}

function requireRead(req, res) {
  // Reads: gate mode requires a session; readonly mode allows anyone.
  if (getAuthMode() === 'readonly') return true;
  return requireAuth(req, res);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

module.exports = {
  COOKIE_NAME,
  SESSION_DAYS,
  getAuthMode,
  isAuthenticated,
  canEdit,
  createSession,
  verifySession,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  checkPassword,
  requireAuth,
  requireRead,
  readJsonBody,
};
