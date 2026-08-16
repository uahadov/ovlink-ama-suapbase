/**
 * TEMPORARY DEBUG SCRIPT — test different msgId variations
 * Run: node test-webhook-sig3.js
 */
require('dotenv').config();
const crypto = require('crypto');

const secret = (process.env.POLAR_WEBHOOK_SECRET || '').toString().trim();
const keyBuffer = Buffer.from(secret.slice(6), 'base64');

const msgTs = '1786837071';
const receivedSig = '+Mk3l+MNk0/XAIIfIHdBHaca8E7GKbNYOnxfIuTEaSg=';

// Reconstruct the body exactly as Polar sends it (minified JSON)
const body = `{"type":"order.updated","timestamp":"2026-08-15T22:55:12.147031Z","data":{"id":"8c8eaa76-fa6c-4911-b4a7-ce62da388caa","created_at":"2026-08-15T22:55:02.453729Z","modified_at":"2026-08-15T22:55:12.047165Z","status":"paid","paid":true,"subtotal_amount":0,"discount_amount":0,"net_amount":0,"tax_amount":0,"total_amount":0,"applied_balance_amount":0,"due_amount":0,"refunded_amount":0,"refunded_tax_amount":0,"currency":"usd","billing_reason":"subscription_create","billing_name":"Melahet Haciyeva","billing_address":{"line1":null,"line2":null,"postal_code":null,"city":null,"state":null,"country":"AZ"},"invoice_number":"OVLINK-VOMWTLXDKA-0001","is_invoice_generated":true,"receipt_number":null,"seats":null,"customer_id":"c5f1e729-1ab1-4695-9512-0b5640f94e66","product_id":"6eceab28-77b3-4d51-a4ee-89caded20f83","product_price_id":null,"discount_id":null,"subscription_id":"1f4989b0-fb87-4dc9-87a8-e03ec483bda3","checkout_id":"d8a308f8-f7b0-4b5d-802c-d2347a8e551c","next_payment_attempt_at":null,"metadata":{},"custom_field_data":{},"platform_fee_amount":0,"platform_fee_currency":null,"customer":{"id":"c5f1e729-1ab1-4695-9512-0b5640f94e66","created_at":"2026-08-15T22:54:46.335018Z","modified_at":"2026-08-15T22:55:02.448165Z","metadata":{"user_id":"38"},"external_id":null,"email":"lazimsizlar0@gmail.com","email_verified":false,"type":"individual","name":"Melahet Haciyeva","billing_name":"Melahet Haciyeva","billing_address":{"line1":null,"line2":null,"postal_code":null,"city":null,"state":null,"country":"AZ"},"tax_id":null,"locale":"en","organization_id":"008b6fed-1c47-4bf3-a09f-1413e8c825d3","default_payment_method_id":null,"deleted_at":null,"first_user_event_at":null,"avatar_url":"https://www.gravatar.com/avatar/8e14edbc1096a9cc33a90c47ae4fd5aed1f3e7e7b95ac923378f8a10628f3708?d=404"},"user_id":"c5f1e729-1ab1-4695-9512-0b5640f94e66","user":{"id":"c5f1e729-1ab1-4695-9512-0b5640f94e66","email":"lazimsizlar0@gmail.com","public_name":"M","avatar_url":"https://www.gravatar.com/avatar/8e14edbc1096a9cc33a90c47ae4fd5aed1f3e7e7b95ac923378f8a10628f3708?d=404","github_username":null},"product":{"metadata":{},"id":"6eceab28-77b3-4d51-a4ee-89caded20f83","created_at":"2026-08-15T14:25:48.460217Z","modified_at":null,"trial_interval":"day","trial_interval_count":3,"name":"Ovlink Pro","description":"Unlock full access to Ovlink Pro:\\n\u2022 Unlimited short links & custom aliases\\n\u2022 Real-time detailed visitor & click analytics\\n\u2022 Full API & Webhook access for automation\\n\u2022 Advanced fraud & abuse protection\\n\u2022 3-day free trial included","visibility":"public","recurring_interval":"month","recurring_interval_count":1,"meter_interval":null,"meter_interval_count":null,"is_recurring":true,"is_archived":false,"organization_id":"008b6fed-1c47-4bf3-a09f-1413e8c825d3"},"product_price":null,"discount":null,"subscription":{"metadata":{},"created_at":"2026-08-15T22:55:02.010972Z","modified_at":null,"id":"1f4989b0-fb87-4dc9-87a8-e03ec483bda3","amount":0,"currency":"usd","recurring_interval":"month","recurring_interval_count":1,"status":"trialing","current_period_start":"2026-08-15T22:55:02.002654Z","current_period_end":"2026-08-18T22:54:45.963496Z","current_meter_period_start":null,"current_meter_period_end":null,"trial_start":"2026-08-15T22:55:02.002654Z","trial_end":"2026-08-18T22:54:45.963496Z","cancel_at_period_end":false,"canceled_at":null,"started_at":"2026-08-15T22:55:02.002654Z","ends_at":null,"ended_at":null,"past_due_at":null,"pause_at_period_end":false,"paused_at":null,"resumes_at":null,"customer_id":"c5f1e729-1ab1-4695-9512-0b5640f94e66","product_id":"6eceab28-77b3-4d51-a4ee-89caded20f83","discount_id":"04cdc1c6-c468-474d-8b89-ac75cbc06811","checkout_id":"d8a308f8-f7b0-4b5d-802c-d2347a8e551c","seats":null,"customer_cancellation_reason":null,"customer_cancellation_comment":null,"price_id":"b60c2a36-21d5-4e40-8631-5b09912578d0","user_id":"c5f1e729-1ab1-4695-9512-0b5640f94e66"},"items":[{"created_at":"2026-08-15T22:55:02.462915Z","modified_at":null,"id":"0e486699-4dc2-480e-87ac-1a969721d13b","label":"Trial period for Ovlink Pro (Aug 15, 2026 - Aug 18, 2026)","amount":0,"tax_amount":0,"proration":false,"product_price_id":null}],"description":"Ovlink Pro","amount":0,"from_balance_amount":0,"refundable_amount":0,"refundable_tax_amount":0}}`;

const bodyBuf = Buffer.from(body, 'utf8');

// Try different msgId candidates — maybe Polar uses Delivery ID, not Event ID
const candidates = [
  { label: 'Event ID (what server reads from header)',    id: '9b3f8d9e-75a7-4951-8bc3-aa8db136b804' },
  { label: 'Delivery ID (no suffix)',                    id: '3255133f-b1c2-48e5-8cef-9cba593df2f5' },
  { label: 'Delivery ID (with _subrow suffix)',          id: '3255133f-b1c2-48e5-8cef-9cba593df2f5_subrow' },
];

console.log('receivedSig:', receivedSig, '\n');
for (const c of candidates) {
  const prefix = Buffer.from(`${c.id}.${msgTs}.`, 'utf8');
  const toSign = Buffer.concat([prefix, bodyBuf]);
  const computed = crypto.createHmac('sha256', keyBuffer).update(toSign).digest('base64');
  const match = computed === receivedSig;
  console.log(`[${match ? '✅ MATCH' : '❌ no match'}] ${c.label}`);
  if (match) console.log('  ↳ FOUND! Polar uses this ID:', c.id);
}
