function adsGuardMiddleware(req, res, next) {
  const publicAdsPaths = new Set(['/', '/privacy', '/terms', '/contact', '/cookie-policy', '/about', '/how-it-works', '/why-ovlink', '/faq', '/help', '/docs', '/abuse-safety', '/updates']);
  const restricted = (
    req.path.startsWith('/admin') ||
    req.path === '/login' ||
    req.path === '/login.html' ||
    req.path === '/register' ||
    req.path === '/register.html' ||
    req.path === '/dashboard' ||
    req.path === '/dashboard.html' ||
    req.path === '/stats' ||
    req.path === '/stats.html' ||
    req.path === '/account' ||
    req.path === '/notifications' ||
    req.path === '/forgot-password' ||
    req.path === '/reset-password'
  );
  const socialAdsDisabled = ['0', 'false', 'no', 'off'].includes(
    (process.env.ENABLE_SOCIAL_ADS || '1').toString().trim().toLowerCase()
  );
  const bannerAdsDisabled = ['0', 'false', 'no', 'off'].includes(
    (process.env.ENABLE_BANNER_ADS || '1').toString().trim().toLowerCase()
  );
  res.locals.allowAds = (!restricted && publicAdsPaths.has(req.path));
  res.locals.enableSocialAds = !socialAdsDisabled;
  res.locals.enableBannerAds = !bannerAdsDisabled;
  return next();
}

function adSandboxMiddleware(req, res, next) {
  const flags = [
    'allow-scripts',
    'allow-popups',
    'allow-popups-to-escape-sandbox',
    'allow-top-navigation-by-user-activation',
  ];
  const allowSameOriginEnv = ['1', 'true', 'yes', 'on'].includes(
    (process.env.AD_SANDBOX_ALLOW_SAME_ORIGIN || '').toString().trim().toLowerCase()
  );
  if (allowSameOriginEnv) {
    flags.push('allow-same-origin');
  }
  res.locals.adFrameSandbox = flags.join(' ');
  next();
}

module.exports = { adsGuardMiddleware, adSandboxMiddleware };
