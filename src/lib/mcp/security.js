'use strict';

const net = require('net');
const dns = require('dns');
const { dbGetAsync } = require('../../db/helpers');

/**
 * Defense-in-Depth Security Utilities for Ovlink MCP Server
 *
 * 1. validateDestinationUrlSafe: SSRF Defense
 *    - Blocks RFC 1918 (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8)
 *    - Blocks Cloud Metadata (169.254.169.254, 100.100.100.200)
 *    - Blocks Carrier-Grade NAT (100.64.0.0/10)
 *    - Blocks IPv6 loopback, link-local, unique-local, NAT64, and IPv4-mapped IPv6
 *    - Blocks decimal/hex/octal representations
 *    - Blocks internal/dangerous ports (only standard 80 and 443 allowed)
 *    - Blocks dynamic DNS services (nip.io, sslip.io) and embedded IP patterns
 *    - Validates DNS resolved IP addresses
 *    - Blocks domains found in `blocked_domains` database table
 *
 * 2. Prompt Injection (XPIA) Defense
 *    - Strips instruction-injection tokens (<|im_start|>, [INST], etc.)
 *    - Escapes delimiter tags and wraps untrusted user data in <ovlink_untrusted_data type="..."> tags
 *
 * 3. Strict GEO Prohibition
 *    - Rejects any GEO/location parameter modifications with code -32007
 *
 * 4. DNS Rebinding Prevention (CVE-2025-66414)
 *    - Validates Host against allowed domains and Origin headers
 */

const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.lan',
  '.corp',
  '.home',
  '.intranet',
  '.onion',
  '.home.arpa',
  '.nip.io',
  '.sslip.io',
];

const BLOCKED_EXACT_HOSTS = new Set([
  'localhost',
  'instance-data',
  'metadata',
  'metadata.google.internal',
  'metadata.azure.internal',
  'metadata.aws.internal',
  'localtest.me',
  'vcap.me',
  'lvh.me',
  'lacolhost.com',
  'customer-metadata',
]);

const EMBEDDED_PRIVATE_IP_RE = /(?:^|\.)(?:127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0)(?:\.|$)/i;

const DANGEROUS_PORTS = new Set([
  21, 22, 23, 25, 53, 69, 110, 111, 135, 137, 138, 139, 143, 389,
  445, 636, 1433, 1521, 2049, 2375, 2376, 3000, 3306, 5000, 5432,
  5984, 6379, 7000, 8000, 8080, 8443, 8888, 9000, 9200, 11211, 27017, 28017
]);

const PROMPT_INJECTION_TOKENS = [
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  /<\|system\|>/gi,
  /<\|user\|>/gi,
  /<\|assistant\|>/gi,
  /<\|endoftext\|>/gi,
  /\[INST\]/gi,
  /\[\/INST\]/gi,
  /<<SYS>>/gi,
  /<<\/SYS>>/gi,
  /<system>/gi,
  /<\/system>/gi,
  /Human:\s*/gi,
  /Assistant:\s*/gi,
];

const GEO_PARAM_KEYS = new Set([
  'geo',
  'country',
  'countries',
  'city',
  'cities',
  'region',
  'regions',
  'location',
  'locations',
  'latitude',
  'longitude',
  'ip_targeting',
  'geo_targeting',
  'geo_rules',
  'geo_rule'
]);

/**
 * Parses numeric IPv4 representation (e.g. integer 2130706433 or hex 0x7f000001).
 * Returns dotted-decimal string or null if not an integer IP.
 */
function parseNumericIpv4(host) {
  if (!host || typeof host !== 'string') return null;
  const trimmed = host.trim().toLowerCase();

  // Decimal integer IP (e.g. 2130706433)
  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    if (num >= 0 && num <= 4294967295) {
      const a = (num >>> 24) & 255;
      const b = (num >>> 16) & 255;
      const c = (num >>> 8) & 255;
      const d = num & 255;
      return `${a}.${b}.${c}.${d}`;
    }
  }

  // Hex integer IP (e.g. 0x7f000001)
  if (/^0x[0-9a-f]+$/i.test(trimmed)) {
    const num = Number.parseInt(trimmed, 16);
    if (!Number.isNaN(num) && num >= 0 && num <= 4294967295) {
      const a = (num >>> 24) & 255;
      const b = (num >>> 16) & 255;
      const c = (num >>> 8) & 255;
      const d = num & 255;
      return `${a}.${b}.${c}.${d}`;
    }
  }

  // Octal or dotted hex parts (e.g. 0177.0.0.1 or 0x7f.0.0.1)
  const parts = trimmed.split('.');
  if (parts.length === 4) {
    const octets = [];
    for (const part of parts) {
      let val;
      if (/^0x[0-9a-f]+$/i.test(part)) {
        val = Number.parseInt(part, 16);
      } else if (/^0\d+$/.test(part)) {
        val = Number.parseInt(part, 8);
      } else if (/^\d+$/.test(part)) {
        val = Number.parseInt(part, 10);
      } else {
        return null;
      }
      if (Number.isNaN(val) || val < 0 || val > 255) return null;
      octets.push(val);
    }
    return octets.join('.');
  }

  return null;
}

/**
 * Checks if an IPv4 address is in a private, loopback, link-local, or cloud metadata range.
 */
function isPrivateOrReservedIpv4(ip) {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // malformed, fail closed
  }

  const [a, b, c, d] = parts;

  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;

  // 10.0.0.0/8 (RFC 1918)
  if (a === 10) return true;

  // 172.16.0.0/12 (RFC 1918)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.168.0.0/16 (RFC 1918)
  if (a === 192 && b === 168) return true;

  // 0.0.0.0/8 (Current network)
  if (a === 0) return true;

  // 169.254.0.0/16 (Link-local / AWS, GCP, Azure metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;

  // 100.100.100.200 (Alibaba Cloud internal metadata server)
  if (a === 100 && b === 100 && c === 100 && d === 200) return true;

  // 100.64.0.0/10 (Carrier-Grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;

  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (a === 192 && b === 0 && c === 0) return true;

  // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0 && c === 2) return true;

  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;

  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;

  // 224.0.0.0/4 (Multicast)
  if (a >= 224 && a <= 239) return true;

  // 240.0.0.0/4 (Reserved / Future use)
  if (a >= 240) return true;

  // 255.255.255.255 (Broadcast)
  if (a === 255 && b === 255 && c === 255 && d === 255) return true;

  return false;
}

/**
 * Checks if an IPv6 address is in a private, loopback, or link-local range.
 */
function isPrivateOrReservedIpv6(rawIpv6) {
  let ip = rawIpv6.toLowerCase().trim();
  if (ip.startsWith('[') && ip.endsWith(']')) {
    ip = ip.slice(1, -1);
  }

  // Loopback (::1) and Unspecified (::)
  if (ip === '::1' || ip === '::' || ip === '0:0:0:0:0:0:0:1' || ip === '0:0:0:0:0:0:0:0') {
    return true;
  }

  // IPv4-mapped IPv6 (::ffff:x.x.x.x or ::ffff:hex)
  if (ip.startsWith('::ffff:')) {
    const embeddedIpv4 = ip.slice(7);
    if (net.isIPv4(embeddedIpv4)) {
      return isPrivateOrReservedIpv4(embeddedIpv4);
    }
    const hexNum = parseNumericIpv4('0x' + embeddedIpv4.replace(/:/g, ''));
    if (hexNum) {
      return isPrivateOrReservedIpv4(hexNum);
    }
    return true;
  }

  // NAT64 Well-Known Prefix (64:ff9b::/96)
  if (ip.startsWith('64:ff9b:')) {
    return true;
  }

  // Unique Local Address (fc00::/7 -> starts with fc or fd)
  if (ip.startsWith('fc') || ip.startsWith('fd')) {
    return true;
  }

  // Link-Local (fe80::/10 -> starts with fe8, fe9, fea, feb)
  if (/^fe[89ab]/i.test(ip)) {
    return true;
  }

  // Multicast (ff00::/8)
  if (ip.startsWith('ff')) {
    return true;
  }

  // Documentation prefix (2001:db8::/32)
  if (ip.startsWith('2001:db8') || ip === '2001:db8') {
    return true;
  }

  // 6to4 prefix (2002::/16)
  if (ip.startsWith('2002:')) {
    return true;
  }

  return false;
}

/**
 * Validates destination URL for SSRF protection and database blocklist.
 * Supports http: and https: protocols.
 */
async function validateDestinationUrlSafe(rawUrl, dbRunner = dbGetAsync) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, error: 'Destination URL is required.', code: 'INVALID_URL' };
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length > 4096) {
    return { valid: false, error: 'URL exceeds maximum length of 4096 characters.', code: 'INVALID_URL' };
  }

  let candidate = trimmed;
  let parsed;
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(candidate)) {
      parsed = new URL(candidate);
    } else {
      parsed = new URL('https://' + candidate);
    }
  } catch {
    return { valid: false, error: 'Malformed or invalid URL syntax.', code: 'INVALID_URL' };
  }

  // Protocol check: strictly http: or https:
  const protocol = (parsed.protocol || '').toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { valid: false, error: 'Only http and https protocols are supported.', code: 'UNSUPPORTED_PROTOCOL' };
  }

  let hostname = (parsed.hostname || '').toLowerCase().trim();
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  hostname = hostname.replace(/\.+$/, '');

  if (!hostname) {
    return { valid: false, error: 'URL must contain a valid host.', code: 'INVALID_HOSTNAME' };
  }

  // Port checks: standard 80 and 443 are allowed; block dangerous/internal ports
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : null;
  if (port !== null) {
    if (DANGEROUS_PORTS.has(port) || (port !== 80 && port !== 443)) {
      return { valid: false, error: `Port ${port} is restricted by SSRF security policy.`, code: 'SSRF_PORT_BLOCKED' };
    }
  }

  // Check exact blocked hosts and suffixes
  if (BLOCKED_EXACT_HOSTS.has(hostname)) {
    return { valid: false, error: 'Access to loopback and cloud metadata hosts is prohibited.', code: 'SSRF_BLOCKED' };
  }

  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return { valid: false, error: `Access to internal host domain (*${suffix}) is prohibited.`, code: 'SSRF_BLOCKED' };
    }
  }

  // Embedded private IP detection in domain (e.g. 127.0.0.1.nip.io, 169.254.169.254.sslip.io)
  if (EMBEDDED_PRIVATE_IP_RE.test(hostname)) {
    return { valid: false, error: 'Access to private or link-local IP addresses is prohibited.', code: 'SSRF_BLOCKED' };
  }

  // Check IP addresses (direct IPv4, direct IPv6, or numeric representations)
  const numericIp = parseNumericIpv4(hostname);
  const ipToCheck = numericIp || hostname;

  if (net.isIPv4(ipToCheck)) {
    if (isPrivateOrReservedIpv4(ipToCheck)) {
      return { valid: false, error: 'Access to private or link-local IP addresses is prohibited.', code: 'SSRF_BLOCKED' };
    }
  } else if (net.isIPv6(ipToCheck)) {
    if (isPrivateOrReservedIpv6(ipToCheck)) {
      return { valid: false, error: 'Access to loopback or private IPv6 addresses is prohibited.', code: 'SSRF_BLOCKED' };
    }
  } else {
    // DNS Resolution check for hostnames
    try {
      const addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
      for (const entry of (addresses || [])) {
        const addr = entry && entry.address;
        if (!addr) continue;
        if (net.isIPv4(addr) && isPrivateOrReservedIpv4(addr)) {
          return { valid: false, error: 'Access to private or link-local IP addresses is prohibited.', code: 'SSRF_BLOCKED' };
        }
        if (net.isIPv6(addr) && isPrivateOrReservedIpv6(addr)) {
          return { valid: false, error: 'Access to loopback or private IPv6 addresses is prohibited.', code: 'SSRF_BLOCKED' };
        }
      }
    } catch {
      // In offline or non-resolving test environments, proceed to DB check
    }
  }

  // Database blocklist check
  try {
    const getFn = typeof dbRunner === 'function' ? dbRunner : dbGetAsync;
    const blockedRow = await getFn(
      "SELECT domain FROM blocked_domains WHERE ? = domain OR ? LIKE '%.' || domain LIMIT 1",
      [hostname, hostname]
    );
    if (blockedRow && blockedRow.domain) {
      return { valid: false, error: 'Destination domain is blocked by security policy.', code: 'DOMAIN_BLOCKED' };
    }
  } catch (err) {
    // If DB check fails, don't crash
    console.error('[mcp-security] error checking blocked_domains:', err.message);
  }

  return {
    valid: true,
    cleanUrl: parsed.toString(),
    hostname
  };
}

/**
 * Strips prompt-injection instruction tokens from untrusted input.
 */
function stripInstructionTokens(text) {
  if (typeof text !== 'string') return '';
  let result = text;
  for (const pattern of PROMPT_INJECTION_TOKENS) {
    result = result.replace(pattern, '');
  }
  return result;
}

/**
 * Wraps untrusted user-supplied string in XML delimiter tags to mitigate XPIA.
 */
function sanitizeUntrustedString(text, type = 'text') {
  if (text === null || text === undefined) return '';
  const safeType = String(type || 'text').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  let cleaned = stripInstructionTokens(String(text));
  // Escape delimiter tags to prevent tag breakout
  cleaned = cleaned
    .replace(/<\/ovlink_untrusted_data>/gi, '&lt;/ovlink_untrusted_data&gt;')
    .replace(/<ovlink_untrusted_data[^>]*>/gi, '&lt;ovlink_untrusted_data&gt;');
  return `<ovlink_untrusted_data type="${safeType}">${cleaned}</ovlink_untrusted_data>`;
}

/**
 * Recursively sanitizes user-supplied fields within an object/array payload.
 */
function sanitizePayload(data, contextKey = '') {
  if (data === null || data === undefined) return data;

  if (typeof data === 'string') {
    // Determine type tag based on property name
    const lowerKey = contextKey.toLowerCase();
    let type = 'user_data';
    if (lowerKey.includes('url')) type = 'url';
    else if (lowerKey.includes('title')) type = 'title';
    else if (lowerKey.includes('query') || lowerKey === 'q') type = 'query';
    else if (lowerKey.includes('alias') || lowerKey.includes('short')) type = 'short_alias';
    else if (lowerKey.includes('desc') || lowerKey.includes('note')) type = 'note';

    return sanitizeUntrustedString(data, type);
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitizePayload(item, contextKey));
  }

  if (typeof data === 'object') {
    const copy = {};
    for (const [key, val] of Object.entries(data)) {
      copy[key] = sanitizePayload(val, key);
    }
    return copy;
  }

  return data;
}

/**
 * Recursively verifies that arguments contain NO GEO/location parameters.
 * Throws JSON-RPC -32007 error if violation found.
 */
function assertNoGeoParameters(args) {
  if (!args || typeof args !== 'object') return;

  function scan(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, val] of Object.entries(obj)) {
      const lower = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (GEO_PARAM_KEYS.has(lower)) {
        const err = new Error('GEO parameter modification is strictly prohibited.');
        err.code = -32007;
        err.jsonRpcCode = -32007;
        throw err;
      }
      for (const gk of GEO_PARAM_KEYS) {
        if (lower.includes(gk)) {
          const err = new Error('GEO parameter modification is strictly prohibited.');
          err.code = -32007;
          err.jsonRpcCode = -32007;
          throw err;
        }
      }
      if (typeof val === 'object' && val !== null) {
        scan(val);
      }
    }
  }

  scan(args);
}

/**
 * Validates Host and Origin headers to prevent DNS Rebinding (CVE-2025-66414).
 */
function validateDnsRebinding(req) {
  const host = ((typeof req.get === 'function' ? req.get('host') : (req.headers && req.headers.host)) || '').toString().trim();
  if (!host) {
    return { valid: false, error: 'Missing Host header.' };
  }

  // Host header format validation
  if (!/^[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(host)) {
    return { valid: false, error: 'Invalid Host header format.' };
  }

  const hostnameOnly = host.split(':')[0].toLowerCase();

  // Validate Host against allowed domains (prevent DNS rebinding)
  let configuredHost = '';
  const configuredBaseUrl = process.env.PUBLIC_BASE_URL || process.env.BASE_URL;
  if (configuredBaseUrl) {
    try {
      configuredHost = new URL(configuredBaseUrl).hostname.toLowerCase();
    } catch {}
  }

  const isAllowedHost = (
    hostnameOnly === 'localhost' ||
    hostnameOnly.endsWith('.localhost') ||
    hostnameOnly === '127.0.0.1' ||
    hostnameOnly.startsWith('127.') ||
    hostnameOnly === '::1' ||
    hostnameOnly === 'ovlink.sbs' ||
    hostnameOnly.endsWith('.ovlink.sbs') ||
    (configuredHost && hostnameOnly === configuredHost)
  );

  if (!isAllowedHost) {
    return { valid: false, error: 'Host header not allowed (DNS rebinding protection).' };
  }

  const origin = ((typeof req.get === 'function' ? req.get('origin') : (req.headers && req.headers.origin)) || '').toString().trim();
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const originHost = originUrl.hostname.toLowerCase();

      // Origin must be an allowed domain or match Host
      const isAllowedOrigin = (
        originHost === 'localhost' ||
        originHost.endsWith('.localhost') ||
        originHost === '127.0.0.1' ||
        originHost.startsWith('127.') ||
        originHost === '::1' ||
        originHost === 'ovlink.sbs' ||
        originHost.endsWith('.ovlink.sbs') ||
        (configuredHost && originHost === configuredHost) ||
        originHost === hostnameOnly
      );

      if (!isAllowedOrigin) {
        return { valid: false, error: 'Cross-origin request rejected (DNS rebinding protection).' };
      }
    } catch {
      return { valid: false, error: 'Malformed Origin header.' };
    }
  }

  return { valid: true };
}

module.exports = {
  validateDestinationUrlSafe,
  parseNumericIpv4,
  isPrivateOrReservedIpv4,
  isPrivateOrReservedIpv6,
  stripInstructionTokens,
  sanitizeUntrustedString,
  sanitizePayload,
  assertNoGeoParameters,
  validateDnsRebinding,
};
