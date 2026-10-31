#!/usr/bin/env node
/**
 * Outreach automation runner — a deliberately separate process.
 *
 * The web app (server.js) no longer starts cold-email or social-listening bots:
 * they share an event loop with the redirect hot path and their ToS surface has
 * nothing to do with the link product. Run them here, on their own schedule:
 *
 *   node scripts/outreach-runner.js            # long-running loop
 *   node scripts/outreach-runner.js --once     # single pass, then exit
 *
 * Requires ENABLE_MARKETING_BOTS=1 as an explicit acknowledgement.
 */
'use strict';

require('dotenv').config();

const { isEnabledEnv } = require('../src/config/index');

const ONCE = process.argv.includes('--once');
const running = [];

function log(message) {
  process.stdout.write(`[outreach] ${message}\n`);
}

function startAll() {
  if (!isEnabledEnv('ENABLE_MARKETING_BOTS', false)) {
    log('ENABLE_MARKETING_BOTS is not set; refusing to start outreach automation.');
    process.exit(1);
  }

  const b2b = require('../src/marketing_bots/b2b-email-hunter');
  const social = require('../src/marketing_bots/social-listener');

  if (ONCE) {
    if (typeof b2b.processQueue === 'function') {
      Promise.resolve(b2b.processQueue()).catch((err) => {
        log(`b2b single pass failed: ${err && (err.message || err)}`);
      });
    }
    if (typeof social.scan === 'function') {
      Promise.resolve(social.scan()).catch((err) => {
        log(`social single pass failed: ${err && (err.message || err)}`);
      });
    }
    log('single pass dispatched; exiting.');
    return;
  }

  b2b.start();
  social.start();
  running.push(b2b, social);
  log('outreach bots started. Send SIGTERM to stop.');
}

function stopAll() {
  for (const bot of running) {
    try {
      if (bot && typeof bot.stop === 'function') bot.stop();
    } catch (err) {
      log(`stop failed: ${err && (err.message || err)}`);
    }
  }
  running.length = 0;
}

process.on('SIGTERM', () => { stopAll(); process.exit(0); });
process.on('SIGINT', () => { stopAll(); process.exit(0); });
process.on('unhandledRejection', (err) => {
  log(`unhandled rejection: ${err && (err.message || err)}`);
});

startAll();
