const express = require('express');
const QRCode = require('qrcode');
const { db } = require('../../db/index');
const { buildShortUrl } = require('../../lib/url-helpers');

const router = express.Router();

router.get('/api/qrcode', (req, res) => {
  const shortRaw = (req.query.short || '').toString().trim();
  const colorDark = (req.query.colorDark || '#000000').toString().trim();
  const colorLight = (req.query.colorLight || '#ffffff').toString().trim();

  const shortOk = /^(?:[A-Za-z0-9_-]{1,64})$/.test(shortRaw) || /^(?:0|1|true|false)$/i.test(shortRaw);
  if (!shortOk) return res.status(400).json({ error: 'Invalid short' });

  const isHex = (v) => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
  if (!isHex(colorDark)) return res.status(400).json({ error: 'Invalid colorDark' });
  if (!isHex(colorLight)) return res.status(400).json({ error: 'Invalid colorLight' });

  db.get('SELECT * FROM urls WHERE short = ?', [shortRaw], (err, row) => {
    if (err || !row) return res.status(404).send('Belə Bir Link Tapılmadı');

    const fullUrl = buildShortUrl(req, shortRaw, row.domain_host || '');

    QRCode.toDataURL(fullUrl, {
      color: {
        dark: colorDark,
        light: colorLight
      }
    }, (err, url) => {
      if (err) return res.status(500).send('QR kod oluşturulamadı.');
      res.json({ qrCode: url });
    });
  });
});

module.exports = router;
