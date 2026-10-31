/**
 * Correlates a request across logs and error reports.
 *
 * An incoming x-request-id is accepted only when it looks like an id, so a
 * client cannot inject arbitrary strings into log output. Mounted before the
 * session middleware: probes and static assets get an id without touching the
 * session store.
 */
'use strict';

const crypto = require('crypto');

const INCOMING_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

function requestIdMiddleware(req, res, next) {
  let id = '';
  try {
    const incoming = (req.get('x-request-id') || '').toString().trim();
    id = INCOMING_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
  } catch (err) {
    id = crypto.randomUUID();
  }
  req.id = id;
  try {
    res.setHeader('x-request-id', id);
    if (res.locals) res.locals.requestId = id;
  } catch (err) {
    // headers already sent — nothing to do
  }
  next();
}

module.exports = requestIdMiddleware;
module.exports.requestIdMiddleware = requestIdMiddleware;
