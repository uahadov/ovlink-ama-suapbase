const test = require('node:test');
const assert = require('node:assert/strict');

const { createLogger, setSink, redact } = require('../src/lib/logger');
const requestIdMiddleware = require('../src/middleware/request-id');

test('logger: emits one structured entry and redacts secret keys', () => {
  const entries = [];
  setSink((entry) => entries.push(entry));
  try {
    const log = createLogger('test-scope');
    log.info('hello', {
      password: 'super-secret',
      api_key: 'abc',
      cookie: 'connect.sid=x',
      safe: 'visible',
    });
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.level, 'info');
    assert.equal(entry.scope, 'test-scope');
    assert.equal(entry.msg, 'hello');
    assert.equal(entry.password, '[redacted]');
    assert.equal(entry.api_key, '[redacted]');
    assert.equal(entry.cookie, '[redacted]');
    assert.equal(entry.safe, 'visible');
    assert.ok(entry.ts);
  } finally {
    setSink(null);
  }
});

test('logger: level filter drops debug in production default', () => {
  const entries = [];
  const previousLevel = process.env.LOG_LEVEL;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.LOG_LEVEL = 'warn';
  process.env.NODE_ENV = 'production';
  setSink((entry) => entries.push(entry));
  try {
    const log = createLogger('filter');
    log.debug('nope');
    log.info('nope');
    log.warn('yes');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].level, 'warn');
  } finally {
    setSink(null);
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('logger: redact handles errors, cycles and depth', () => {
  const err = new Error('boom');
  err.code = 'E_BOOM';
  assert.deepEqual(redact({ err }).err, { name: 'Error', message: 'boom', code: 'E_BOOM', status: undefined });

  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(redact(cyclic).self, '[circular]');
});

test('request id middleware: accepts a valid inbound id and echoes it', () => {
  const headers = {};
  const req = { get: () => 'req-abc-1234' };
  const res = { setHeader: (key, value) => { headers[key] = value; }, locals: {} };
  let called = 0;
  requestIdMiddleware(req, res, () => { called += 1; });
  assert.equal(called, 1);
  assert.equal(req.id, 'req-abc-1234');
  assert.equal(headers['x-request-id'], 'req-abc-1234');
  assert.equal(res.locals.requestId, 'req-abc-1234');
});

test('request id middleware: rejects injection and generates a uuid', () => {
  const headers = {};
  const req = { get: () => 'a\nb=\r\nInjected: 1' };
  const res = { setHeader: (key, value) => { headers[key] = value; }, locals: {} };
  requestIdMiddleware(req, res, () => {});
  assert.match(req.id, /^[0-9a-f-]{36}$/);
  assert.equal(headers['x-request-id'], req.id);
});
