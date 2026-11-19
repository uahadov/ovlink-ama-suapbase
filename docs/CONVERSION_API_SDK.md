# Ovlink Conversion Event API & Minimal JS SDK (v1)

## 1. Endpoint Overview

- **Ingest conversion:** `POST /api/pro/v1/conversions`
  - **Auth:** `x-api-key: <pro_api_key>` (or `Authorization: Bearer <pro_api_key>`) with `shorten:write` scope.
  - **Optional server-to-server HMAC signature:**
    - `X-Ovlink-Timestamp`: Unix timestamp in seconds (must be within ±300 seconds).
    - `X-Ovlink-Signature`: `sha256=<HMAC-SHA256(api_key, "${timestamp}.${rawBody}")>`.
- **List conversions:** `GET /api/pro/v1/conversions?short=abc&campaign_id=1&goal=purchase&limit=50`
  - **Auth:** `x-api-key` with `account:read` scope.

## 2. Event Schema

| Field | Type | Required | Rules |
|---|---|---|---|
| `event_id` | string | Yes | 4–120 chars (`A-Za-z0-9._:-`). Unique per account; exact replay returns `200 OK`, changed payload returns `409 Conflict`. |
| `short` / `link_id` | string / int | One required | Must belong to the authenticated account (`404` otherwise). |
| `campaign_id` | int | No | Optional; if provided, must match the link's campaign. |
| `goal` | string | Yes | 1–40 lowercase `[a-z0-9_-]` (e.g. `lead`, `purchase`, `signup`). |
| `timestamp` | ISO-8601 UTC | No (defaults to now) | Max `+5 min` future skew, max `30 days` in the past. |
| `source` | enum | No (`server_api`) | `server_api`, `js_sdk`, `webhook`, `checkout`, `crm`. |
| `consent` | enum | No (`analytics`) | `analytics`, `essential`, `declined`. |
| `value` | number | No | Non-negative finite monetary value (requires `currency`). |
| `currency` | string | When `value` set | 3-letter ISO-4217 uppercase (e.g. `AZN`, `USD`, `EUR`, `TRY`). |
| `actor` | object/string | No | Hashed with HMAC-SHA256 before storage; never stored in `essential` or `declined` consent mode. |

## 3. Cookie & Consent Behavior

- **Zero third-party cookies:** `public/ovlink-conversion.js` never writes cookies or reads cross-site trackers.
- **`consent: "analytics"`**: Stores event + HMAC-hashed `actor_hash` (no raw email, phone, or IP).
- **`consent: "essential"`**: Stores event count/value without any `actor_hash` (`actor_hash = NULL`).
- **`consent: "declined"`**: SDK skips transmission; server returns `202 Accepted` (`recorded: false, reason: "consent_declined"`) and writes **0 database rows**.

## 4. Server-to-Server Example (Signed Node.js)

```js
const crypto = require('crypto');

const apiKey = process.env.OVLINK_API_KEY;
const rawBody = JSON.stringify({
  event_id: 'ord_2026_10042',
  short: 'summer26',
  goal: 'purchase',
  source: 'checkout',
  consent: 'analytics',
  value: 149.5,
  currency: 'AZN',
  actor: { external_id: 'cust_8821' },
});
const ts = Math.floor(Date.now() / 1000).toString();
const sig = 'sha256=' + crypto.createHmac('sha256', apiKey).update(`${ts}.${rawBody}`).digest('hex');

await fetch('https://ovlink.sbs/api/pro/v1/conversions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'X-Ovlink-Timestamp': ts,
    'X-Ovlink-Signature': sig,
  },
  body: rawBody,
});
```

## 5. Minimal Browser SDK Example (Lead Form + Checkout)

Never expose your Pro API key in browser JavaScript. Point `endpoint` at your own backend proxy route that forwards the payload to Ovlink server-to-server.

```html
<script src="/ovlink-conversion.js"></script>
<script>
  OvlinkConversion.init({ endpoint: '/api/ovlink/conversions', consentMode: 'analytics' });
  // Lead form submit:
  OvlinkConversion.trackLead({ eventId: 'lead_901', short: 'promo26' });
  // E-commerce checkout:
  OvlinkConversion.trackPurchase({ eventId: 'ord_502', short: 'promo26', value: 89.9, currency: 'AZN' });
</script>
```
