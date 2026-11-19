# Ovlink CRM & Automation Integration Recipes (P33)

All outbound webhooks use the versioned `webhook-events-v1` envelope with `X-Ovlink-Event-Id`, `X-Ovlink-Request-Id`, and `X-Ovlink-Signature` (`t=<unix>,v1=<hmac_sha256>`).

## 1. Zapier (Webhooks by Zapier — Catch Hook)
1. Create a Zap with **Webhooks by Zapier -> Catch Hook**.
2. Paste the Zapier HTTPS URL into Ovlink Webhook settings and select `conversion.recorded` or `campaign.launched`.
3. Click **Test Delivery** (`POST /api/integrations/webhooks/test-delivery`) to inspect `event_id`, `request_id`, and `data`.

## 2. n8n (Webhook Trigger + HMAC Check)
1. Add a **Webhook** node (`POST`, raw body enabled).
2. Verify `X-Ovlink-Signature` against `${timestamp}.${rawBody}` using your webhook secret before writing to HubSpot/Pipedrive/Slack.
3. Deduplicate on `body.event_id` so manual replays or 5xx retries are idempotent.

## 3. Make (Custom Webhook)
1. Add a **Webhooks -> Custom webhook** module and copy its HTTPS address into Ovlink.
2. Route on `event_type` (`conversion.recorded`, `alert.triggered`, `report.snapshot_ready`) and store `event_id` as the CRM external key.
