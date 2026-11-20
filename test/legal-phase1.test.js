const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('Phase 1 legal views & routes: DPA, Subprocessors, KVKK, Register consent, Checkout disclosure, and Cookie Opt-in/Reject', () => {
  const publicRoutes = fs.readFileSync(path.join(ROOT, 'src/routes/public.js'), 'utf8');
  assert.match(publicRoutes, /router\.get\('\/legal\/dpa'/);
  assert.match(publicRoutes, /router\.get\('\/legal\/subprocessors'/);
  assert.match(publicRoutes, /router\.get\('\/legal\/kvkk'/);
  assert.match(publicRoutes, /2021\/914/);
  assert.match(publicRoutes, /454-VIIQD/);
  assert.match(publicRoutes, /Standart Sözleşme/);

  const legalTemplate = fs.readFileSync(path.join(ROOT, 'views/legal-doc.ejs'), 'utf8');
  assert.match(legalTemplate, /legalDocHeading/);
  assert.match(legalTemplate, /partials\/home-footer/);

  const footer = fs.readFileSync(path.join(ROOT, 'views/partials/home-footer.ejs'), 'utf8');
  assert.match(footer, /href="\/legal\/dpa"/);
  assert.match(footer, /href="\/legal\/subprocessors"/);
  assert.match(footer, /href="\/legal\/kvkk"/);
  assert.match(footer, /id="rejectCookieBtn"/);
  assert.match(footer, /id="acceptCookieBtn"/);
  assert.match(footer, /ovlinkCookieConsentAllowed/);

  const registerView = fs.readFileSync(path.join(ROOT, 'views/register.ejs'), 'utf8');
  assert.match(registerView, /id="regConsentCheck"/);
  assert.match(registerView, /998-IIIQ/);
  assert.match(registerView, /consent_accepted: true/);

  const accountRoute = fs.readFileSync(path.join(ROOT, 'src/routes/api/account.js'), 'utf8');
  assert.match(accountRoute, /consent_accepted === false/);

  const pricingView = fs.readFileSync(path.join(ROOT, 'views/pricing.ejs'), 'utf8');
  assert.match(pricingView, /id="checkoutLegalDisclosure"/);
  assert.match(pricingView, /908-IIQ/);
  assert.match(pricingView, /Polar\.sh/);
});
