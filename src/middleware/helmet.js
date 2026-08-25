const helmet = require('helmet');
const { isProdRuntime } = require('../config/index');

const isProd = isProdRuntime;

const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      // All forms in this app submit to same-origin routes. Restricting
      // formAction closes a common HTML-injection exfiltration vector
      // (an injected <form> posting captured data to an attacker domain).
      formAction: ["'self'"],
      scriptSrc: [
        "'self'",
        (req, res) => `'nonce-${res.locals.nonce}'`,
        "https://cdn.jsdelivr.net",
        "https://cdnjs.cloudflare.com",
        "https://unpkg.com",
        "https://static.cloudflareinsights.com"
      ],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`, "https://fonts.googleapis.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://unpkg.com"],
      // Existing templates use inline style attributes in a few places.
      // Keep this until those style attributes are migrated to CSS classes.
      styleSrcAttr: ["'unsafe-inline'"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com", "data:"],
      imgSrc: [
        "'self'",
        "data:",
        "blob:",
        "https://www.launchpact.io"
      ],
      connectSrc: [
        "'self'",
        "https://cdn.jsdelivr.net",
        "https://fonts.googleapis.com",
        "https://fonts.gstatic.com",
        "https://cloudflareinsights.com"
      ],
      frameSrc: ["'self'"],
      manifestSrc: ["'self'"],
      mediaSrc: ["'self'"],
      workerSrc: ["'self'"],
      upgradeInsecureRequests: []
    }
  },
  crossOriginEmbedderPolicy: false,
  hsts: isProd ? {
    maxAge: 15552000,
    includeSubDomains: true,
    preload: true
  } : false,
  frameguard: {
    action: 'deny'
  }
});

module.exports = helmetMiddleware;
