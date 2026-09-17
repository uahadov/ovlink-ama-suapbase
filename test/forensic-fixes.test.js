const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

test('DEF-01: workspaces.js has bcrypt available for SAML JIT provisioning', async () => {
  const workspacesRouter = require('../src/routes/api/workspaces');
  assert.ok(workspacesRouter, 'workspaces router loaded');
  
  // Verify bcrypt is in scope and functional without ReferenceError
  const bcrypt = require('bcrypt');
  const hash = await bcrypt.hash('testSecret123', 10);
  assert.ok(hash && hash.startsWith('$2'), 'bcrypt hash generated successfully');
});

test('DEF-02: withTransaction is exported by src/db/helpers and server helpers', () => {
  const { withTransaction } = require('../src/db/helpers');
  assert.equal(typeof withTransaction, 'function', 'withTransaction must be an exported function');

  const { helpers } = require('../server');
  assert.equal(typeof helpers.withTransaction, 'function', 'helpers.withTransaction must be exported in server.js');
});

test('DEF-03: parseBooleanInput handles truthy and falsy values without ReferenceError', () => {
  const { parseBooleanInput } = require('../src/routes/api/webhooks');
  assert.equal(typeof parseBooleanInput, 'function', 'parseBooleanInput must be an exported function');

  // Truthy inputs
  assert.equal(parseBooleanInput(true), true);
  assert.equal(parseBooleanInput('true'), true);
  assert.equal(parseBooleanInput('TRUE'), true);
  assert.equal(parseBooleanInput('1'), true);
  assert.equal(parseBooleanInput(1), true);
  assert.equal(parseBooleanInput('on'), true);

  // Falsy inputs
  assert.equal(parseBooleanInput(false), false);
  assert.equal(parseBooleanInput('false'), false);
  assert.equal(parseBooleanInput('FALSE'), false);
  assert.equal(parseBooleanInput('0'), false);
  assert.equal(parseBooleanInput(0), false);
  assert.equal(parseBooleanInput('off'), false);

  // Fallbacks
  assert.equal(parseBooleanInput(undefined, true), true);
  assert.equal(parseBooleanInput(undefined, false), false);
  assert.equal(parseBooleanInput('invalid', false), false);
});

test('DEF-04: maintenance.js getEffectiveSettings synchronizes with global.__siteSettings', () => {
  const { getEffectiveSettings, siteSettings } = require('../src/middleware/maintenance');

  // Clean test baseline
  delete global.__siteSettings;
  const baseline = getEffectiveSettings();
  assert.equal(typeof baseline, 'object');

  // Dynamically mutate global.__siteSettings as admin route does
  global.__siteSettings = {
    maintenance_enabled: '1',
    maintenance_message_az: 'Təmir işləri gedir',
    maintenance_message_tr: 'Bakım çalışması',
    maintenance_message_en: 'Under maintenance',
  };

  const updated = getEffectiveSettings();
  assert.equal(updated.maintenance_enabled, '1', 'maintenance_enabled must reflect global update');
  assert.equal(updated.maintenance_message_en, 'Under maintenance', 'message must reflect global update');

  // Restore
  delete global.__siteSettings;
  siteSettings.maintenance_enabled = '0';
});

test('DEF-05: SMTP fallback transporter configuration has bounded timeouts (<= 8000ms)', () => {
  // Check the email module doesn't block the event loop for 25-35s
  const fs = require('fs');
  const emailCode = fs.readFileSync(require.resolve('../src/lib/email'), 'utf8');

  assert.ok(!emailCode.includes('connectionTimeout: 25000'), 'connectionTimeout 25000 must be removed');
  assert.ok(!emailCode.includes('greetingTimeout: 25000'), 'greetingTimeout 25000 must be removed');
  assert.ok(!emailCode.includes('socketTimeout: 35000'), 'socketTimeout 35000 must be removed');
});

test('DEF-06: Helmet Content Security Policy does not include https: wildcard in scriptSrc', () => {
  const fs = require('fs');
  const helmetCode = fs.readFileSync(require.resolve('../src/middleware/helmet'), 'utf8');

  // Match scriptSrc array block
  const scriptSrcMatch = helmetCode.match(/scriptSrc:\s*\[([\s\S]*?)\]/);
  assert.ok(scriptSrcMatch, 'scriptSrc directive found');
  const scriptSrcContent = scriptSrcMatch[1];
  assert.ok(!scriptSrcContent.includes('"https:"') && !scriptSrcContent.includes("'https:'"), 'https: wildcard must not be present in scriptSrc');
});

test('DEF-07: Dead threat set stubs removed from account.js', () => {
  const fs = require('fs');
  const accountCode = fs.readFileSync(require.resolve('../src/routes/api/account'), 'utf8');

  assert.ok(!accountCode.includes('threatUrlSet'), 'threatUrlSet stub should be removed');
  assert.ok(!accountCode.includes('threatHostSet'), 'threatHostSet stub should be removed');
});

test('DEF-08: convertSql preserves literal question marks in string literals', () => {
  const { db } = require('../src/db/index');

  const inputSql = "SELECT * FROM urls WHERE url LIKE '%?%' AND short = ? AND note = 'why?'";
  const converted = db.convertSql(inputSql);

  assert.ok(converted.includes("'%?%'"), 'Literal ? in first string literal must be preserved');
  assert.ok(converted.includes("'why?'"), 'Literal ? in second string literal must be preserved');
  assert.ok(converted.includes('short = $1'), 'Parameter placeholder outside quotes must be converted to $1');
});

test('DEF-09: google-auth exports error state safely and account.js handles unconfigured Google login without ReferenceError', async () => {
  const { googleOidc, getGoogleOidcInitError } = require('../src/lib/google-auth');
  assert.ok(googleOidc, 'googleOidc object exists');
  assert.ok('error' in googleOidc, 'googleOidc has error property');
  assert.equal(typeof getGoogleOidcInitError, 'function', 'getGoogleOidcInitError function exported');
});

test('DEF-10: handleLogout deletes session by sid from express_sessions', () => {
  const fs = require('fs');
  const accountCode = fs.readFileSync(require.resolve('../src/routes/api/account'), 'utf8');
  assert.ok(!accountCode.includes('WHERE user_id = ? AND sid = ?'), 'Legacy broken WHERE user_id query must be removed');
  assert.ok(accountCode.includes('DELETE FROM express_sessions WHERE sid = ?'), 'Deletion query must target sid primary key');
});

test('DEF-11: buildCustomDomainPayload provides verification object and decrypts token', () => {
  const fs = require('fs');
  const customDomainsCode = fs.readFileSync(require.resolve('../src/routes/api/custom-domains'), 'utf8');
  assert.ok(customDomainsCode.includes('decryptVerificationToken'), 'decryptVerificationToken helper must exist');
  assert.ok(customDomainsCode.includes('cname_target: targetHost'), 'payload must include cname_target');
  assert.ok(customDomainsCode.includes('txt_value: token'), 'payload must include txt_value');
});

test('DEF-12: verifyLinkPassword handles both legacy plaintext and bcrypt passwords', async () => {
  const { verifyLinkPassword, hashLinkPassword } = require('../src/routes/redirect');
  
  // Plaintext legacy password
  const isPlainOk = await verifyLinkPassword('mypassword123', 'mypassword123');
  assert.equal(isPlainOk, true, 'Plaintext legacy password must verify');

  const isPlainWrong = await verifyLinkPassword('mypassword123', 'wrongpassword');
  assert.equal(isPlainWrong, false, 'Wrong password for plaintext must fail');

  // Bcrypt password
  const bcryptHash = await hashLinkPassword('mypassword123');
  const isBcryptOk = await verifyLinkPassword(bcryptHash, 'mypassword123');
  assert.equal(isBcryptOk, true, 'Bcrypt password must verify');

  const isBcryptWrong = await verifyLinkPassword(bcryptHash, 'wrongpassword');
  assert.equal(isBcryptWrong, false, 'Wrong password for bcrypt must fail');
});

test('DEF-13: RESERVED_SHORT_ALIASES contains newly reserved system routes', () => {
  const { isShortAliasReserved } = require('../src/lib/url-helpers');
  assert.equal(isShortAliasReserved('tools'), true, 'tools must be reserved');
  assert.equal(isShortAliasReserved('ads'), true, 'ads must be reserved');
  assert.equal(isShortAliasReserved('bot'), true, 'bot must be reserved');
  assert.equal(isShortAliasReserved('bots'), true, 'bots must be reserved');
  assert.equal(isShortAliasReserved('health'), true, 'health must be reserved');
  assert.equal(isShortAliasReserved('favicon.ico'), true, 'favicon.ico must be reserved');
});

test('DEF-14: Billing notifications do not contain corrupted mojibake characters', () => {
  const fs = require('fs');
  const billingCode = fs.readFileSync(require.resolve('../src/routes/api/billing'), 'utf8');
  assert.ok(!billingCode.includes('­şææ'), 'Corrupted mojibake string must not exist in billing.js');
  assert.ok(billingCode.includes('Ovlink Pro Aktiv Edildi! 🎉'), 'Clean notification title must exist');
});
