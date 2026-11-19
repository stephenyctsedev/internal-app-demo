// POST /api/logout -> clears the session cookie.
const { clearSessionCookie } = require('./_lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  clearSessionCookie(res, req);
  return res.status(200).json({ ok: true });
};
