const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseIdpMetadataXml,
  buildSamlOptions,
  extractProfileEmail,
} = require('../utils/sso');

const CERT_BODY = 'MIIDvzCCAqegAwIBAgIUQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function oktaMetadata({ entityId = 'http://www.okta.com/abc123', redirect = true, post = true, cert = CERT_BODY } = {}) {
  const services = [];
  if (redirect) services.push('<SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://sso.company.com/app/abc123/sso/saml"/>');
  if (post) services.push('<SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sso.company.com/app/abc123/sso/saml/post"/>');
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${entityId}">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>
    </md:KeyDescriptor>
    ${services.join('\n    ')}
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
}

test('parseIdpMetadataXml extracts entityId, redirect endpoint and certificate', async () => {
  const parsed = await parseIdpMetadataXml(oktaMetadata());
  assert.equal(parsed.entityId, 'http://www.okta.com/abc123');
  assert.equal(parsed.ssoLoginUrl, 'https://sso.company.com/app/abc123/sso/saml');
  assert.equal(parsed.certificate, CERT_BODY);
});

test('parseIdpMetadataXml falls back to HTTP-POST binding when Redirect is absent', async () => {
  const parsed = await parseIdpMetadataXml(oktaMetadata({ redirect: false }));
  assert.equal(parsed.ssoLoginUrl, 'https://sso.company.com/app/abc123/sso/saml/post');
});

test('parseIdpMetadataXml rejects unusable documents', async () => {
  await assert.rejects(() => parseIdpMetadataXml(''), /empty/i);
  await assert.rejects(() => parseIdpMetadataXml('this is not xml at all <'), /valid XML/i);
  await assert.rejects(() => parseIdpMetadataXml('<foo><bar/></foo>'), /EntityDescriptor/i);
  await assert.rejects(() => parseIdpMetadataXml(oktaMetadata({ entityId: '' })), /entityID/i);
  await assert.rejects(() => parseIdpMetadataXml(oktaMetadata({ cert: '' })), /certificate/i);
  await assert.rejects(
    () => parseIdpMetadataXml(oktaMetadata({ redirect: false, post: false })),
    /SingleSignOnService/i
  );
});

test('buildSamlOptions produces node-saml v5 option names', () => {
  const options = buildSamlOptions({
    issuer: 'https://ovlink.example/sso/7/metadata',
    acsUrl: 'https://ovlink.example/sso/7/acs',
    idpEntityId: 'http://www.okta.com/abc',
    idpSsoUrl: 'https://sso.company.com/sso',
    idpCertificate: CERT_BODY,
  });
  assert.equal(options.issuer, 'https://ovlink.example/sso/7/metadata');
  assert.equal(options.callbackUrl, 'https://ovlink.example/sso/7/acs');
  assert.equal(options.entryPoint, 'https://sso.company.com/sso');
  assert.equal(options.idpCert, CERT_BODY);
  assert.equal(options.idpIssuer, 'http://www.okta.com/abc');
  assert.equal(options.wantAuthnResponseSigned, true);
  assert.equal(options.wantAssertionsSigned, false);
  assert.equal(options.validateInResponseTo, 'never');
});

test('extractProfileEmail finds email in nameID and attributes, lowercased', () => {
  assert.equal(extractProfileEmail({ nameID: 'John.Doe@Company.com' }), 'john.doe@company.com');
  assert.equal(
    extractProfileEmail({ nameID: 'x|y', attributes: { email: ['Jane@Corp.io'] } }),
    'jane@corp.io'
  );
  assert.equal(
    extractProfileEmail({
      nameID: 'opaque-id',
      attributes: { 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'claim@corp.io' },
    }),
    'claim@corp.io'
  );
  assert.equal(extractProfileEmail({ nameID: 'not-an-email' }), '');
  assert.equal(extractProfileEmail(null), '');
});
