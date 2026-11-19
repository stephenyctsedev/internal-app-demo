// POST /api/login  { password } -> sets demo_session cookie (30 days).
const { checkPassword, createSession, setSessionCookie, readJsonBody, getAuthMode } = require('./_lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  if (!process.env.APP_PASSWORD) {
    return res.status(500).json({ ok: false, error: 'APP_PASSWORD is not configured on the server' });
  }
  let body;
  try { body = await readJsonBody(req); } catch { return res.status(400).json({ ok: false, error: 'invalid_json' }); }
  if (!checkPassword(body.password)) {
    return res.status(401).json({ ok: false, error: 'wrong_password' });
  }
  try {
    setSessionCookie(res, createSession(), req);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'SESSION_SECRET is not set' });
  }
  return res.status(200).json({ ok: true, authenticated: true, canEdit: true, authMode: getAuthMode() });
};
