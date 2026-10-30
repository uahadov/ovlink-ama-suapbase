const net = require('net');
const dns = require('dns').promises;
const { normalizeHostName } = require('./url-helpers');

const ALLOW_INSECURE_WEBHOOK_HTTP = ['1', 'true', 'yes', 'on'].includes(((process.env.ALLOW_INSECURE_WEBHOOK_HTTP || '') + '').trim().toLowerCase());

function normalizeWebhookUrl(rawUrl) {
  const value = (rawUrl || '').toString().trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    const isHttps = parsed.protocol === 'https:';
    const isHttpAllowed = ALLOW_INSECURE_WEBHOOK_HTTP && parsed.protocol === 'http:';
    if (!isHttps && !isHttpAllowed) return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

const WEBHOOK_URL_DNS_TIMEOUT_MS = 5000;
const WEBHOOK_BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  'metadata.google.internal',
  'metadata',
  'metadata.azure.internal',
  'metadata.aws.internal',
]);
const WEBHOOK_BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

// Ports that are never legitimate webhook/preview destinations and are commonly
// exposed by internal services (databases, caches, mail, RDP, admin planes).
// Blocking them stops the pinned-IP fetcher from being used as a service
// reachability probe (`/api/tools/fetch-metadata` is unauthenticated).
const WEBHOOK_BLOCKED_PORTS = new Set([
  22, 23, 25, 110, 143, 389, 445, 465, 587, 636, 873, 993, 995,
  1433, 1521, 2049, 2375, 2376, 3306, 3389, 5432, 5900, 6379, 7001,
  9042, 9200, 9300, 11211, 27017, 27018,
]);

function getEffectivePort(parsed) {
  const explicit = Number.parseInt(parsed && parsed.port ? parsed.port : '', 10);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  return (parsed && parsed.protocol === 'https:') ? 443 : 80;
}

function isBlockedWebhookPort(port) {
  const value = Number.parseInt(port, 10);
  if (!Number.isInteger(value) || value <= 0) return true;
  return WEBHOOK_BLOCKED_PORTS.has(value);
}
const WEBHOOK_IP_BLOCKLIST = new net.BlockList();

function addWebhookBlockedSubnet(address, prefix, family) {
  try {
    WEBHOOK_IP_BLOCKLIST.addSubnet(address, prefix, family);
  } catch {}
}

[
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['169.254.169.254', 32, 'ipv4'], // AWS IMDS
  ['100.100.100.200', 32, 'ipv4'], // Alibaba cloud metadata
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
].forEach(([address, prefix, family]) => addWebhookBlockedSubnet(address, prefix, family));

function normalizeIpCandidate(rawIp) {
  let value = (rawIp || '').toString().trim();
  if (!value) return '';
  if (value.startsWith('::ffff:')) value = value.slice(7);
  return value;
}

function isBlockedWebhookIp(rawIp) {
  const ip = normalizeIpCandidate(rawIp);
  if (!ip) return true;
  const version = net.isIP(ip);
  if (!version) return true;
  const family = version === 6 ? 'ipv6' : 'ipv4';
  return WEBHOOK_IP_BLOCKLIST.check(ip, family);
}

function isBlockedWebhookHostname(rawHostname) {
  const host = normalizeHostName(rawHostname);
  if (!host) return true;
  if (WEBHOOK_BLOCKED_HOSTS.has(host)) return true;
  return WEBHOOK_BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

async function resolveWebhookHostnameIps(hostname) {
  const host = normalizeHostName(hostname);
  if (!host) return [];
  const resolverPromise = dns.lookup(host, { all: true, verbatim: true })
    .then((rows) => (rows || []).map((row) => normalizeIpCandidate(row && row.address)).filter(Boolean))
    .catch(() => []);
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve([]), WEBHOOK_URL_DNS_TIMEOUT_MS);
  });
  const ips = await Promise.race([resolverPromise, timeoutPromise]);
  return Array.isArray(ips) ? ips : [];
}

async function validateOutboundWebhookUrl(rawUrl) {
  const normalized = normalizeWebhookUrl(rawUrl);
  if (!normalized) {
    return { ok: false, normalizedUrl: '', pinnedIp: '', reason: 'invalid_url' };
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return { ok: false, normalizedUrl: '', pinnedIp: '', reason: 'invalid_url' };
  }

  const hostnameRaw = (parsed.hostname || '').toString().trim().toLowerCase().replace(/\.+$/, '');
  if (!hostnameRaw) {
    return { ok: false, normalizedUrl: '', pinnedIp: '', reason: 'invalid_host' };
  }

  if (isBlockedWebhookPort(getEffectivePort(parsed))) {
    return { ok: false, normalizedUrl: '', pinnedIp: '', reason: 'blocked_port' };
  }

  const directIpVersion = net.isIP(hostnameRaw);
  if (directIpVersion) {
    if (isBlockedWebhookIp(hostnameRaw)) {
      return { ok: false, normalizedUrl: '', pinnedIp: '', reason: 'blocked_ip' };
    }
    return { ok: true, normalizedUrl: normalized, pinnedIp: hostnameRaw, reason: '', resolvedIps: [hostnameRaw] };
  }

  const hostname = normalizeHostName(hostnameRaw);
  if (!hostname) {
    return { ok: false, normalizedUrl: '', pinnedIp: '', reason: 'invalid_host' };
  }
  if (isBlockedWebhookHostname(hostname)) {
    return { ok: false, normalizedUrl: '', pinnedIp: '', reason: 'blocked_host' };
  }

  const resolvedIps = await resolveWebhookHostnameIps(hostname);
  if (!resolvedIps.length) {
    return { ok: false, normalizedUrl: '', pinnedIp: '', reason: 'dns_unresolved' };
  }
  if (resolvedIps.some((ip) => isBlockedWebhookIp(ip))) {
    return { ok: false, normalizedUrl: '', pinnedIp: '', reason: 'blocked_ip' };
  }

  const pinnedIp = resolvedIps[0];
  return { ok: true, normalizedUrl: normalized, pinnedIp, reason: '', resolvedIps };
}

module.exports = {
  validateOutboundWebhookUrl,
  isBlockedWebhookIp,
  isBlockedWebhookHostname,
  isBlockedWebhookPort,
  getEffectivePort,
  WEBHOOK_BLOCKED_PORTS
};
