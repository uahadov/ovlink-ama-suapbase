const { buildAbsoluteUrl } = require('./security');

let googleOidc = {
  client: null,
  generators: null,
  ready: false,
  redirectUri: null
};
let googleOidcInitPromise = null;
let googleOidcInitError = null;

const GOOGLE_ISSUER_URL = 'https://accounts.google.com';
const GOOGLE_ISSUER_FALLBACK_METADATA = Object.freeze({
  issuer: GOOGLE_ISSUER_URL,
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
});

function buildGoogleIssuerFallback(Issuer) {
  return new Issuer(GOOGLE_ISSUER_FALLBACK_METADATA);
}

async function discoverGoogleIssuerWithFallback(Issuer) {
  try {
    return await Issuer.discover(GOOGLE_ISSUER_URL);
  } catch (discoverErr) {
    console.warn('[google-auth] discovery failed; using static issuer metadata fallback');
    return buildGoogleIssuerFallback(Issuer);
  }
}

function getGoogleBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || '').toString().trim();
}

function getGoogleRedirectUri(req) {
  const configured = (process.env.GOOGLE_REDIRECT_URI || '').toString().trim();
  if (configured) return configured;

  const base = getGoogleBaseUrl();
  if (base) {
    try {
      return new URL('/auth/google/callback', base).toString();
    } catch {}
  }

  if (req) {
    return buildAbsoluteUrl(req, '/auth/google/callback');
  }

  return googleOidc.redirectUri || '';
}

async function getGoogleOidcClient(options = {}) {
  const force = options && options.force === true;
  const req = options && options.req ? options.req : null;

  if (!force && googleOidc.ready && googleOidc.client && googleOidc.generators) return true;
  if (!force && googleOidcInitPromise) return googleOidcInitPromise;

  googleOidcInitPromise = (async () => {
    try {
      if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        googleOidc.ready = false;
        googleOidc.client = null;
        googleOidc.generators = null;
        googleOidcInitError = 'missing_client_credentials';
        return false;
      }

      const redirectUri = getGoogleRedirectUri(req);
      if (!redirectUri) {
        googleOidc.ready = false;
        googleOidc.client = null;
        googleOidc.generators = null;
        googleOidcInitError = 'missing_redirect_uri';
        console.warn('[google-auth] PUBLIC_BASE_URL/BASE_URL or GOOGLE_REDIRECT_URI missing; Google login disabled.');
        return false;
      }

      const mod = await import('openid-client');
      const { Issuer, generators } = mod;
      const googleIssuer = await discoverGoogleIssuerWithFallback(Issuer);
      googleOidc.client = new googleIssuer.Client({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uris: [redirectUri],
        response_types: ['code']
      });
      googleOidc.generators = generators;
      googleOidc.ready = true;
      googleOidc.redirectUri = redirectUri;
      googleOidcInitError = null;
      return true;
    } catch (err) {
      googleOidc.ready = false;
      googleOidc.client = null;
      googleOidc.generators = null;
      googleOidcInitError = (err && err.message) ? err.message : 'init_failed';
      console.error('[google-auth] init failed', err);
      return false;
    } finally {
      googleOidcInitPromise = null;
    }
  })();

  return googleOidcInitPromise;
}

getGoogleOidcClient().then((initialized) => {
  if (initialized) {
    console.log('[google-auth] Status: READY');
    console.log('[google-auth] Redirect URI:', googleOidc.redirectUri);
  } else {
    console.warn('[google-auth] Status: DISABLED');
    console.warn('[google-auth] Error:', googleOidcInitError || 'Unknown error');
    console.warn('[google-auth] Check GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and PUBLIC_BASE_URL/BASE_URL environment variables.');
  }
});

module.exports = {
  googleOidc,
  getGoogleOidcClient,
  initGoogleOidc: getGoogleOidcClient,
  getGoogleRedirectUri
};
