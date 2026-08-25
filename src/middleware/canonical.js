const { getSafeHostHeader, normalizeHostName } = require('../lib/url-helpers');
const { isActiveCustomDomainHost } = require('../lib/custom-domain');

function httpsRedirectMiddleware(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();
  const hostHeader = getSafeHostHeader(req);
  if (!hostHeader) return res.status(400).send('Bad Request');
  const host = hostHeader.toLowerCase().split(':')[0];
  const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (isLocalhost) return next();
  if (!req.secure) {
    return res.redirect(301, `https://${hostHeader}${req.originalUrl}`);
  }
  return next();
}

function canonicalHostMiddleware(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();

  const base = (process.env.BASE_URL || '').toString().trim();
  if (!base) return next();

  let baseUrl;
  try {
    baseUrl = new URL(base);
  } catch {
    return next();
  }

  const hostHeader = getSafeHostHeader(req);
  if (!hostHeader) return res.status(400).send('Bad Request');

  const currentHost = hostHeader.toLowerCase();
  const canonicalHost = baseUrl.host.toLowerCase();
  if (currentHost === canonicalHost) return next();

  const currentHostOnly = normalizeHostName(currentHost);
  if (!currentHostOnly) return res.status(400).send('Bad Request');

  if (currentHostOnly === 'localhost' || currentHostOnly === '127.0.0.1' || currentHostOnly === '::1') {
    return next();
  }

  if (isActiveCustomDomainHost(currentHostOnly)) {
    return next();
  }

  return res.redirect(301, `${baseUrl.protocol}//${canonicalHost}${req.originalUrl}`);
}

module.exports = {
  httpsRedirectMiddleware,
  canonicalHostMiddleware
};
