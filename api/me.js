// GET /api/me -> never 401s. Frontend uses this to decide what to show:
// { authenticated, canEdit, authMode }.
// canEdit is true only with a valid session cookie, in both modes.
const { isAuthenticated, canEdit, getAuthMode } = require('./_lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const authed = isAuthenticated(req);
  return res.status(200).json({
    ok: true,
    authenticated: authed,
    canEdit: canEdit(req),
    authMode: getAuthMode(),
  });
};
