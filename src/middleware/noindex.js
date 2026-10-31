function noindexMiddleware(req, res, next) {
  const noIndex = [
    /^\/admin(\/|$)/,
    /^\/login$/,
    /^\/login\.html$/,
    /^\/register$/,
    /^\/register\.html$/,
    /^\/dashboard\.html$/,
    /^\/dashboard$/,
    /^\/stats$/,
    /^\/stats\.html$/,
    /^\/account$/,
    /^\/notifications$/,
    /^\/forgot-password$/,
    /^\/reset-password$/,
  ];
  if (noIndex.some((r) => r.test(req.path))) {
    res.set('X-Robots-Tag', 'noindex,nofollow');
  }
  next();
}

function internalDocsMiddleware(req, res, next) {
  const p = (req.path || '').toString().trim().toLowerCase();
  if (p === '/agents' || p === '/agents.md') {
    return res.status(404).send('Not found');
  }
  return next();
}

module.exports = { noindexMiddleware, internalDocsMiddleware };
