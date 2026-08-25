const express = require('express');
const { renderSandboxedAdFrame, renderEmptySandboxedAdFrame } = require('../lib/ads');

const router = express.Router();

router.get('/ads/native-frame', (_req, res) => {
  try {
    const bodyHtml = '<div id="container-4bc00d3da0ee32cb76b16cd6f7b9ddb0"></div>'
      + '<script async="async" data-cfasync="false" src="https://pl28903451.effectivegatecpm.com/4bc00d3da0ee32cb76b16cd6f7b9ddb0/invoke.js"></script>';
    return renderSandboxedAdFrame(res, bodyHtml, 'native');
  } catch (err) {
    console.error('[ads] native-frame render failed', err);
    return renderEmptySandboxedAdFrame(res, 'native');
  }
});

router.get('/ads/social-frame', (_req, res) => {
  try {
    const bodyHtml = '<script async="async" data-cfasync="false" src="https://pl28903465.effectivegatecpm.com/0f/b0/f5/0fb0f54e10ef93c822083c8c99a700d0.js"></script>';
    return renderSandboxedAdFrame(res, bodyHtml, 'social');
  } catch (err) {
    console.error('[ads] social-frame render failed', err);
    return renderEmptySandboxedAdFrame(res, 'social');
  }
});

router.get('/ads/banner-frame', (req, res) => {
  try {
    const device = ((req.query.device || '').toString().trim().toLowerCase() === 'mobile') ? 'mobile' : 'desktop';
    const bodyHtml = device === 'mobile'
      ? '<script>atOptions={\'key\':\'bc7bf2b3e03df703d86e7de5734ce292\',\'format\':\'iframe\',\'height\':50,\'width\':320,\'params\':{}};</script><script src="https://www.highperformanceformat.com/bc7bf2b3e03df703d86e7de5734ce292/invoke.js"></script>'
      : '<script>atOptions={\'key\':\'614a4a2cd3ef3f4e132b2113dd3a6600\',\'format\':\'iframe\',\'height\':90,\'width\':728,\'params\':{}};</script><script src="https://www.highperformanceformat.com/614a4a2cd3ef3f4e132b2113dd3a6600/invoke.js"></script>';
    return renderSandboxedAdFrame(res, bodyHtml, 'banner');
  } catch (err) {
    console.error('[ads] banner-frame render failed', err);
    return renderEmptySandboxedAdFrame(res, 'banner');
  }
});

module.exports = router;
