const crypto = require('crypto');
const net = require('net');
const geoip = require('geoip-lite');

function getRequestIp(req) {
  // Rely on Express `req.ip` + trusted proxy chain. Do not trust raw forwarded headers here.
  let ip = (req.ip || req.socket?.remoteAddress || '').toString().trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function parseAcceptLang(header) {
  const raw = (header || '').toLowerCase();
  if (raw.includes('az')) return 'az';
  if (raw.includes('tr')) return 'tr';
  if (raw.includes('en')) return 'en';
  return '';
}

function isPrivateIp(ip) {
  if (!ip) return false;
  let v = ip.toString().trim().toLowerCase();
  if (v.startsWith('::ffff:')) v = v.slice(7);

  if (v === '::1' || v === '127.0.0.1' || v === 'localhost') return true;
  if (v.startsWith('10.') || v.startsWith('192.168.')) return true;
  if (v.startsWith('172.')) {
    const parts = v.split('.');
    const second = parseInt(parts[1] || '0', 10);
    if (second >= 16 && second <= 31) return true;
  }

  // IPv6 local ranges: loopback/link-local/unique-local
  if (v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:')) return true;

  return false;
}

function normalizeCountryCode(raw) {
  const code = (raw || '').toString().trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  // Cloudflare special values are not ISO country codes.
  if (code === 'XX' || code === 'T1' || code === 'A1' || code === 'A2') return '';
  return code;
}

function getRequestGeoMeta(req) {
  const ip = getRequestIp(req);

  // Cloudflare passes real country in CF-IPCountry; prefer it when valid.
  const cfCountry = normalizeCountryCode(req.get('cf-ipcountry') || req.get('x-vercel-ip-country'));

  let country = 'Unknown';
  let city = 'Unknown';

  if (cfCountry) {
    country = cfCountry;
  } else if (isPrivateIp(ip)) {
    country = 'Local Dev';
    city = 'Localhost';
  } else {
    const geo = geoip.lookup(ip || '');
    const geoCountry = normalizeCountryCode(geo && geo.country);
    if (geoCountry) country = geoCountry;
    if (geo && geo.city) city = (geo.city || '').toString().trim() || 'Unknown';
  }

  return { ip, country, city };
}

function hashIpForStorage(ip) {
  const value = (ip || '').toString().trim();
  if (!value) return '';
  return crypto
    .createHash('sha256')
    .update(`${process.env.SESSION_SECRET}|${value}`)
    .digest('hex')
    .slice(0, 24);
}

function maskIpForDisplay(rawIp) {
  let ip = (rawIp || '').toString().trim();
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);

  const ipVersion = net.isIP(ip);
  if (ipVersion === 4) {
    const parts = ip.split('.');
    if (parts.length !== 4) return '';
    return `${parts[0]}.${parts[1]}.x.x`;
  }

  if (ipVersion === 6) {
    const blocks = ip.toLowerCase().split(':').filter(Boolean);
    if (blocks.length >= 2) return `${blocks[0]}:${blocks[1]}:xxxx:xxxx`;
    return 'xxxx:xxxx';
  }

  return '';
}

function buildNetworkFingerprintForDisplay(rawIp) {
  const hash = hashIpForStorage(rawIp);
  if (!hash) return '';
  return hash.slice(0, 10).toUpperCase();
}

module.exports = {
  getRequestGeoMeta,
  getRequestIp,
  maskIpForDisplay,
  buildNetworkFingerprintForDisplay,
  parseAcceptLang,
  hashIpForStorage
};
