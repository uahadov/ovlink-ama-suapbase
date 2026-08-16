/**
 * TEMPORARY DEBUG SCRIPT — delete after fix
 * Run on the SERVER:
 *   node test-webhook-sig.js
 */
require('dotenv').config();
const crypto = require('crypto');

const secret = (process.env.POLAR_WEBHOOK_SECRET || '').toString().trim();
console.log('secret len:', secret.length);
console.log('starts with whsec_:', secret.startsWith('whsec_'));

const keyBuffer = Buffer.from(secret.slice(6), 'base64');
console.log('keyBuffer len:', keyBuffer.length);
console.log('keyBuffer hex:', keyBuffer.toString('hex'));

// Values from PM2 debug log — paste them here:
const msgId      = '9b3f8d9e-75a7-4951-8bc3-aa8db136b804';
const msgTs      = '1786837071';
const receivedSig = '+Mk3l+MNk0/XAIIfIHdBHaca8E7GKbNYOnxfIuTEaSg='; // without v1, prefix

// Try to reconstruct — we don't have the exact body bytes here,
// but we CAN verify the key is wrong by signing a known string
// and checking if our implementation matches the svix library

// Let's try with svix (if installed):
try {
  const { Webhook } = require('svix');
  console.log('\n--- Svix library available ---');

  // We'll construct a minimal test to confirm our key decoding is same as svix's
  const testPayload = '{"hello":"world"}';
  const testId = 'test-id-123';
  const testTs = Math.floor(Date.now() / 1000).toString();

  const wh = new Webhook(secret);
  // Sign manually:
  const ourToSign = `${testId}.${testTs}.${testPayload}`;
  const ourKey = Buffer.from(secret.slice(6), 'base64');
  const ourSig = crypto.createHmac('sha256', ourKey).update(ourToSign).digest('base64');
  console.log('Our sig for test payload:', ourSig);

  // Use svix to sign the same thing
  const svixHeaders = wh.sign(testId, new Date(parseInt(testTs) * 1000), testPayload);
  const svixSig = svixHeaders['webhook-signature'].replace('v1,', '');
  console.log('Svix sig for test payload:', svixSig);
  console.log('Keys match:', ourSig === svixSig);
} catch (e) {
  console.log('Svix not available:', e.message);
}

// Now let's verify the KEY is actually correct vs what Polar used.
// To do this: go to Polar dashboard -> Settings -> Webhooks -> your endpoint
// Click "Show secret" and print THAT value here:
console.log('\n--- CURRENT SECRET in .env ---');
console.log(secret);
console.log('\nGo to Polar dashboard and confirm this exact value is shown there.');
console.log('If different -> update .env and restart PM2.');
