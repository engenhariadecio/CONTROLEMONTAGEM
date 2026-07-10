function ehApi(req) {
  return req.xhr
    || req.path.startsWith('/api/')
    || (req.headers.accept && req.headers.accept.includes('json'));
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (ehApi(req)) return res.status(401).json({ error: 'Não autenticado' });
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    if (ehApi(req)) return res.status(401).json({ error: 'Não autenticado' });
    return res.redirect('/login');
  }
  if (req.session.role === 'admin') return next();
  if (ehApi(req)) return res.status(403).json({ error: 'Acesso restrito ao administrador' });
  return res.redirect('/');
}

module.exports = { requireAuth, requireAdmin };
