'use strict';

const crypto = require('crypto');
const { SAML } = require('@node-saml/node-saml');
const { parseStringPromise } = require('xml2js');

// SAML clock skew tolerance for NotBefore/NotOnOrAfter condition validation (3 minutes).
const SAML_ACCEPTED_CLOCK_SKEW_MS = 3 * 60 * 1000;
const SAML_METADATA_MAX_LENGTH = 200 * 1024;
const RELAY_STATE_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Common consumer/free email domains that should never trigger corporate SSO realm discovery.
 */
const PUBLIC_CONSUMER_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com',
  'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'mail.ru', 'yandex.com',
  'yandex.ru', 'proton.me', 'protonmail.com', 'aol.com', 'zoho.com', 'gmx.com',
  'gmx.net', 'web.de', 'mail.com'
]);

/**
 * Check if an email domain or full email address belongs to a public consumer provider.
 * @param {string} input
 * @returns {boolean}
 */
function isPublicConsumerEmailDomain(input) {
  if (!input || typeof input !== 'string') return true;
  const cleaned = input.trim().toLowerCase();
  const domain = cleaned.includes('@') ? cleaned.split('@').pop() : cleaned;
  return PUBLIC_CONSUMER_DOMAINS.has(domain);
}

/**
 * Sanitize internal return URL to prevent Open Redirect vulnerabilities.
 * Allows only relative paths starting with a single '/' and rejects protocols and scheme-relative slashes.
 * @param {string} url
 * @returns {string} safe relative path or '/dashboard'
 */
function sanitizeReturnUrl(url) {
  if (!url || typeof url !== 'string') return '/dashboard';
  const trimmed = url.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
    return '/dashboard';
  }
  // Disallow ASCII control characters, newlines, and explicit protocol wrappers
  if (/[\x00-\x1f\x7f]|^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(trimmed)) {
    return '/dashboard';
  }
  return trimmed;
}

/**
 * Generate a cryptographically signed RelayState token using HMAC-SHA256.
 * @param {number|string} workspaceId
 * @param {string} [returnTo='/dashboard']
 * @param {string} secret
 * @returns {string} base64url-encoded payload and HMAC signature
 */
function createSignedRelayState(workspaceId, returnTo, secret) {
  if (!secret) throw new Error('Missing secret for RelayState HMAC generation.');
  const safeReturn = sanitizeReturnUrl(returnTo);
  const payload = JSON.stringify({
    ws: Number(workspaceId),
    ret: safeReturn,
    nonce: crypto.randomBytes(16).toString('hex'),
    ts: Date.now()
  });
  const encodedPayload = Buffer.from(payload, 'utf8').toString('base64url');
  const hmac = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${hmac}`;
}

/**
 * Verify and decode an HMAC-signed RelayState token.
 * @param {string} signedState
 * @param {number|string} expectedWorkspaceId
 * @param {string} secret
 * @returns {{valid: boolean, returnTo: string}}
 */
function verifySignedRelayState(signedState, expectedWorkspaceId, secret) {
  const fallback = { valid: false, returnTo: '/dashboard' };
  if (!signedState || typeof signedState !== 'string' || !secret) return fallback;
  const dotIdx = signedState.indexOf('.');
  if (dotIdx <= 0 || dotIdx === signedState.length - 1) return fallback;

  const encodedPayload = signedState.slice(0, dotIdx);
  const receivedHmac = signedState.slice(dotIdx + 1);

  const expectedHmac = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  const receivedBuf = Buffer.from(receivedHmac, 'utf8');
  const expectedBuf = Buffer.from(expectedHmac, 'utf8');

  if (receivedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(receivedBuf, expectedBuf)) {
    return fallback;
  }

  try {
    const rawJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const data = JSON.parse(rawJson);
    if (!data || typeof data !== 'object') return fallback;

    // Check expiration (15 minutes)
    if (!data.ts || typeof data.ts !== 'number' || (Date.now() - data.ts) > RELAY_STATE_MAX_AGE_MS || data.ts > (Date.now() + 60000)) {
      return fallback;
    }

    // Check bound workspace ID
    if (Number(data.ws) !== Number(expectedWorkspaceId)) {
      return fallback;
    }

    return { valid: true, returnTo: sanitizeReturnUrl(data.ret) };
  } catch {
    return fallback;
  }
}

/**
 * Parse an IdP (e.g. Okta) metadata XML document and extract the fields the
 * SP needs to drive authentication requests and validate signed responses.
 *
 * Expected shape (subset of SAML 2.0 metadata):
 *   <EntityDescriptor entityID="...">
 *     <IDPSSODescriptor protocolSupportEnumeration="...">
 *       <KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data>
 *         <ds:X509Certificate>BASE64...</ds:X509Certificate>
 *       </ds:X509Data></ds:KeyInfo></KeyDescriptor>
 *       <SingleSignOnService Binding="...Redirect" Location="https://..."/>
 *     </IDPSSODescriptor>
 *   </EntityDescriptor>
 *
 * @param {string} metadataXml
 * @returns {Promise<{entityId: string, ssoLoginUrl: string, certificate: string}>}
 * @throws {Error} with a descriptive message when the document is unusable.
 */
async function parseIdpMetadataXml(metadataXml) {
  const raw = (metadataXml || '').toString().trim();
  if (!raw) throw new Error('Metadata XML is empty.');
  if (raw.length > SAML_METADATA_MAX_LENGTH) throw new Error('Metadata XML is too large.');

  // Strip namespace prefixes from element names (md:, ds:, ...) so the parsed
  // object has stable PascalCase keys regardless of the IdP's prefix style.
  const prefixFree = raw.replace(/<(\/?)[A-Za-z0-9]+:/g, '<$1');

  let doc;
  try {
    doc = await parseStringPromise(prefixFree, { explicitArray: true });
  } catch {
    throw new Error('Metadata is not valid XML.');
  }

  const entityDescriptor = doc && doc.EntityDescriptor;
  if (!entityDescriptor) throw new Error('Metadata must contain an EntityDescriptor element.');

  const entityId = (entityDescriptor.$ && entityDescriptor.$.entityID || '').toString().trim();
  if (!entityId) throw new Error('Metadata is missing the entityID attribute.');

  const idpDescriptor = entityDescriptor.IDPSSODescriptor && entityDescriptor.IDPSSODescriptor[0];
  if (!idpDescriptor) throw new Error('Metadata is missing the IDPSSODescriptor element.');

  const ssoServices = Array.isArray(idpDescriptor.SingleSignOnService) ? idpDescriptor.SingleSignOnService : [];
  let ssoLoginUrl = '';
  for (const svc of ssoServices) {
    const binding = (svc.$ && svc.$.Binding || '').toString();
    const location = (svc.$ && svc.$.Location || '').toString().trim();
    // HTTP-Redirect is the binding we generate login requests with; fall back
    // to any HTTP POST binding if the IdP only offers that.
    if (binding === 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect' && location) {
      ssoLoginUrl = location;
      break;
    }
    if (!ssoLoginUrl && binding === 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST' && location) {
      ssoLoginUrl = location;
    }
  }
  if (!ssoLoginUrl) throw new Error('Metadata has no usable SingleSignOnService endpoint.');
  if (!/^https?:\/\//i.test(ssoLoginUrl)) throw new Error('SingleSignOnService endpoint must be an http(s) URL.');

  let certificate = '';
  const keyDescriptors = Array.isArray(idpDescriptor.KeyDescriptor) ? idpDescriptor.KeyDescriptor : [];
  for (const kd of keyDescriptors) {
    const use = (kd.$ && kd.$.use || '').toString().toLowerCase();
    if (use && use !== 'signing') continue;
    const certNodes =
      (kd.KeyInfo && kd.KeyInfo[0] && kd.KeyInfo[0].X509Data && kd.KeyInfo[0].X509Data[0] && kd.KeyInfo[0].X509Data[0].X509Certificate) ||
      [];
    for (const certNode of certNodes) {
      const pemBody = ((certNode && typeof certNode === 'string' ? certNode : '') || '')
        .toString()
        .replace(/\s+/g, '');
      if (pemBody) {
        certificate = pemBody;
        break;
      }
    }
    if (certificate) break;
  }
  if (!certificate) throw new Error('Metadata has no signing X509 certificate.');

  return { entityId, ssoLoginUrl, certificate };
}

/**
 * Build the @node-saml/node-saml options for one workspace's SP instance.
 * Options follow node-saml v5 naming (issuer / idpCert / entryPoint).
 *
 * @param {{issuer: string, acsUrl: string, idpEntityId: string, idpSsoUrl: string, idpCertificate: string}} cfg
 */
function buildSamlOptions(cfg) {
  return {
    issuer: cfg.issuer,
    callbackUrl: cfg.acsUrl,
    entryPoint: cfg.idpSsoUrl,
    idpIssuer: cfg.idpEntityId,
    idpCert: cfg.idpCertificate,
    // Okta signs the whole Response by default; assertions-only signatures are
    // still accepted because wantAssertionsSigned is false while any provided
    // signature is validated against the IdP certificate.
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: false,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
    // 'never' keeps the flow stateless: the ACS URL itself carries the
    // workspace binding and NotOnOrAfter conditions still bound the response.
    validateInResponseTo: 'never',
    acceptedClockSkewMs: SAML_ACCEPTED_CLOCK_SKEW_MS,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  };
}

/**
 * Create a node-saml SAML instance for a workspace SSO connection row.
 * @param {{baseUrl: string, workspaceId: number, entityId: string, ssoLoginUrl: string, certificate: string}} conn
 */
function createWorkspaceSamlInstance(conn) {
  const workspaceId = Number(conn.workspaceId);
  const pathBase = `${conn.baseUrl.replace(/\/+$/, '')}/sso/${workspaceId}`;
  return new SAML(buildSamlOptions({
    issuer: `${pathBase}/metadata`,
    acsUrl: `${pathBase}/acs`,
    idpEntityId: conn.entityId,
    idpSsoUrl: conn.ssoLoginUrl,
    idpCertificate: conn.certificate,
  }));
}

/**
 * Best-effort email extraction from a validated SAML profile.
 * Okta commonly sends the email either as the nameID or in attributes.
 * @param {object} profile
 * @returns {string} lowercased email or ''
 */
function extractProfileEmail(profile) {
  if (!profile) return '';
  const candidates = [
    profile.email,
    profile.nameID,
    profile.nameIDUnformatted,
    profile.upn,
    profile.userName,
    profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'],
    profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn'],
  ];
  if (profile.attributes && typeof profile.attributes === 'object') {
    const attr = profile.attributes;
    candidates.push(
      attr.email,
      attr.Email,
      attr['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'],
      attr['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn'],
      attr.userName,
      attr.upn
    );
    for (const key of Object.keys(attr)) {
      const keyLower = key.toLowerCase();
      const value = Array.isArray(attr[key]) ? attr[key][0] : attr[key];
      if ((keyLower.endsWith(':emailaddress') || keyLower === 'email') && value) candidates.push(value);
    }
  }
  for (const candidate of candidates) {
    const value = Array.isArray(candidate) ? candidate[0] : candidate;
    const text = (value || '').toString().trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return text.toLowerCase();
  }
  return '';
}

/**
 * Extract Assertion ID or Response ID from a validated SAML profile to enable anti-replay caching.
 * @param {object} profile
 * @returns {string}
 */
function extractAssertionId(profile) {
  if (!profile || typeof profile !== 'object') return '';
  const idCandidates = [
    profile.inResponseTo,
    profile.id,
    profile.assertionId,
    profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier'],
    profile.nameID
  ];
  if (profile.attributes && typeof profile.attributes === 'object') {
    idCandidates.push(profile.attributes.assertionId, profile.attributes.id);
  }
  for (const c of idCandidates) {
    const val = (Array.isArray(c) ? c[0] : c || '').toString().trim();
    if (val && val.length >= 8) return val;
  }
  return '';
}

module.exports = {
  SAML_ACCEPTED_CLOCK_SKEW_MS,
  SAML_METADATA_MAX_LENGTH,
  PUBLIC_CONSUMER_DOMAINS,
  isPublicConsumerEmailDomain,
  sanitizeReturnUrl,
  createSignedRelayState,
  verifySignedRelayState,
  parseIdpMetadataXml,
  buildSamlOptions,
  createWorkspaceSamlInstance,
  extractProfileEmail,
  extractAssertionId,
};
