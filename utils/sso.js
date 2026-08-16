'use strict';

const { SAML } = require('@node-saml/node-saml');
const { parseStringPromise } = require('xml2js');

// SAML clock skew tolerance for NotBefore/NotOnOrAfter condition validation.
const SAML_ACCEPTED_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SAML_METADATA_MAX_LENGTH = 200 * 1024;

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
    const binding = (svc.$ && svc.$ && svc.$.Binding || '').toString();
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

module.exports = {
  SAML_ACCEPTED_CLOCK_SKEW_MS,
  SAML_METADATA_MAX_LENGTH,
  parseIdpMetadataXml,
  buildSamlOptions,
  createWorkspaceSamlInstance,
  extractProfileEmail,
};
