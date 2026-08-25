const dnsNative = require('dns');
const dns = dnsNative.promises;
const tsscmp = require('tsscmp');
const { normalizeHostName } = require('./url-helpers');
// custom-domain will be created next
const customDomain = require('./custom-domain');

const DNS_FALLBACK_SERVERS = (process.env.DNS_FALLBACK_SERVERS || process.env.DNS_RESOLVERS || '1.1.1.1,8.8.8.8')
  .toString()
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

function sanitizeDnsTxtValue(rawValue) {
  const value = (rawValue || '').toString().trim();
  return value.replace(/^"+|"+$/g, '').trim();
}

function resolveWithServer(server, method, hostname) {
  return new Promise((resolve, reject) => {
    try {
      const resolver = new dnsNative.Resolver();
      resolver.setServers([server]);
      if (typeof resolver[method] !== 'function') {
        return reject(new Error('Unsupported DNS resolver method'));
      }
      resolver[method](hostname, (err, records) => {
        if (err) return reject(err);
        return resolve(records || []);
      });
    } catch (err) {
      return reject(err);
    }
  });
}

async function resolveDnsWithFallback(method, hostname) {
  const host = (hostname || '').toString().trim();
  if (!host) return [];

  const queryHosts = [host];
  if (!host.endsWith('.')) queryHosts.push(`${host}.`);

  for (const queryHost of queryHosts) {
    try {
      const records = await dns[method](queryHost);
      if (records && records.length) return records;
    } catch {
      // continue to fallback servers
    }

    for (const server of DNS_FALLBACK_SERVERS) {
      try {
        const records = await resolveWithServer(server, method, queryHost);
        if (records && records.length) return records;
      } catch {
        // try next server
      }
    }
  }

  return [];
}

async function resolveTxtValues(hostname) {
  const records = await resolveDnsWithFallback('resolveTxt', hostname);
  return (records || []).flat().map((v) => sanitizeDnsTxtValue(v)).filter(Boolean);
}

async function resolveCnameValues(hostname) {
  const records = await resolveDnsWithFallback('resolveCname', hostname);
  return (records || []).map((v) => normalizeHostName(v)).filter(Boolean);
}

async function resolveAddressValues(hostname) {
  const values = new Set();

  const v4 = await resolveDnsWithFallback('resolve4', hostname);
  for (const item of (v4 || [])) {
    const value = (item || '').toString().trim();
    if (value) values.add(value);
  }

  const v6 = await resolveDnsWithFallback('resolve6', hostname);
  for (const item of (v6 || [])) {
    const value = (item || '').toString().trim();
    if (value) values.add(value);
  }

  return Array.from(values);
}

async function verifyCustomDomainDns(domain, verificationToken) {
  const txtHost = customDomain.getCustomDomainTxtHost(domain);
  const token = sanitizeDnsTxtValue(verificationToken);

  const txtValues = await resolveTxtValues(txtHost);
  const ownershipVerified = !!token && txtValues.some((v) => tsscmp(v, token));

  const cnameValues = await resolveCnameValues(domain);
  const domainAddresses = await resolveAddressValues(domain);
  const expectedTarget = customDomain.getCustomDomainTargetHost();
  const expectedTargetAddresses = expectedTarget ? await resolveAddressValues(expectedTarget) : [];

  const cnameReady = expectedTarget ? cnameValues.some((v) => v === expectedTarget) : cnameValues.length > 0;
  const addressReady = expectedTarget
    ? domainAddresses.some((ip) => expectedTargetAddresses.includes(ip))
    : domainAddresses.length > 0;
  const routingReady = cnameReady || addressReady;

  return {
    txtHost,
    txtValues,
    cnameValues,
    domainAddresses,
    expectedTarget,
    expectedTargetAddresses,
    ownershipVerified,
    routingReady,
  };
}

module.exports = {
  verifyCustomDomainDns,
  resolveTxtValues,
  resolveCnameValues,
  resolveAddressValues,
  resolveDnsWithFallback,
  DNS_FALLBACK_SERVERS
};
