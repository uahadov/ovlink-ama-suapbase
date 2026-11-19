/*
 * Ovlink Minimal Conversion Tracking SDK (P21)
 * Zero dependencies, zero third-party cookies.
 * Recommended setup: send events to your own backend proxy endpoint, which
 * forwards them server-to-server to POST /api/pro/v1/conversions with x-api-key
 * and optional X-Ovlink-Signature (HMAC-SHA256).
 */
(function (root) {
  'use strict';

  var VALID_CONSENT = { analytics: true, essential: true, declined: true };
  var state = {
    endpoint: '/api/ovlink/conversions',
    consentMode: 'analytics',
    headers: {},
  };

  function generateEventId(prefix) {
    var p = (prefix || 'evt').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || 'evt';
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return p + '_' + crypto.randomUUID();
    }
    return p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  function init(options) {
    var opts = options && typeof options === 'object' ? options : {};
    if (typeof opts.endpoint === 'string' && opts.endpoint.trim()) {
      state.endpoint = opts.endpoint.trim();
    }
    if (typeof opts.consentMode === 'string' && VALID_CONSENT[opts.consentMode.toLowerCase()]) {
      state.consentMode = opts.consentMode.toLowerCase();
    }
    state.headers = opts.headers && typeof opts.headers === 'object' ? Object.assign({}, opts.headers) : {};
    return Object.assign({}, state);
  }

  function setConsent(mode) {
    var next = (mode || '').toString().trim().toLowerCase();
    if (!VALID_CONSENT[next]) return false;
    state.consentMode = next;
    return true;
  }

  function buildPayload(input) {
    var src = input && typeof input === 'object' ? input : {};
    var consent = (src.consent || state.consentMode || 'analytics').toString().trim().toLowerCase();
    var payload = {
      event_id: src.event_id || src.eventId || generateEventId(src.goal || 'conv'),
      short: src.short || undefined,
      link_id: src.link_id || src.linkId || undefined,
      campaign_id: src.campaign_id || src.campaignId || undefined,
      goal: (src.goal || '').toString().trim().toLowerCase(),
      timestamp: src.timestamp || new Date().toISOString(),
      source: src.source || 'js_sdk',
      consent: VALID_CONSENT[consent] ? consent : 'analytics',
    };
    if (src.value !== undefined && src.value !== null && src.value !== '') {
      payload.value = Number(src.value);
      payload.currency = (src.currency || '').toString().trim().toUpperCase();
    }
    // Never attach actor identifiers in essential or declined consent modes.
    if (payload.consent === 'analytics' && (src.actor || src.actorId)) {
      payload.actor = src.actor || { external_id: String(src.actorId) };
    }
    return payload;
  }

  function track(input) {
    var payload = buildPayload(input);
    if (payload.consent === 'declined') {
      return Promise.resolve({ skipped: true, reason: 'consent_declined', event_id: payload.event_id });
    }
    var body = JSON.stringify(payload);
    if (typeof fetch === 'function') {
      var headers = Object.assign({ 'Content-Type': 'application/json' }, state.headers);
      return fetch(state.endpoint, {
        method: 'POST',
        headers: headers,
        body: body,
        keepalive: true,
        credentials: 'same-origin',
      }).then(function (res) {
        return res.json().catch(function () { return { status: res.status }; });
      });
    }
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      var blob = new Blob([body], { type: 'application/json' });
      var queued = navigator.sendBeacon(state.endpoint, blob);
      return Promise.resolve({ queued: queued, event_id: payload.event_id });
    }
    return Promise.resolve({ skipped: true, reason: 'no_transport', event_id: payload.event_id });
  }

  function trackLead(opts) {
    return track(Object.assign({}, opts || {}, { goal: 'lead' }));
  }

  function trackPurchase(opts) {
    return track(Object.assign({}, opts || {}, { goal: 'purchase', source: (opts && opts.source) || 'checkout' }));
  }

  var api = {
    version: '1.0.0',
    init: init,
    setConsent: setConsent,
    buildPayload: buildPayload,
    track: track,
    trackLead: trackLead,
    trackPurchase: trackPurchase,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.OvlinkConversion = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
