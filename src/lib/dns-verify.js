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

async function verifyCustomDomainDns(domain, verificationToken, options = {}) {
  const txtHost = customDomain.getCustomDomainTxtHost(domain);
  const token = sanitizeDnsTxtValue(verificationToken);
  const customResolver = options && typeof options.resolver === 'object' ? options.resolver : null;
  const tlsProbe = options && typeof options.tlsProbe === 'function' ? options.tlsProbe : null;

  const txtValues = customResolver && typeof customResolver.resolveTxt === 'function'
    ? (await customResolver.resolveTxt(txtHost)).map((v) => sanitizeDnsTxtValue(v)).filter(Boolean)
    : await resolveTxtValues(txtHost);
  const ownershipVerified = !!token && txtValues.some((v) => {
    if (typeof v !== 'string') return false;
    return tsscmp(v, token) || tsscmp(v, `ovlink-verify=${token}`);
  });

  const cnameValues = customResolver && typeof customResolver.resolveCname === 'function'
    ? (await customResolver.resolveCname(domain)).map((v) => normalizeHostName(v)).filter(Boolean)
    : await resolveCnameValues(domain);
  const domainAddresses = customResolver && typeof customResolver.resolveAddresses === 'function'
    ? (await customResolver.resolveAddresses(domain)).map((v) => String(v || '').trim()).filter(Boolean)
    : await resolveAddressValues(domain);
  const expectedTarget = (options && options.expectedTarget !== undefined)
    ? normalizeHostName(options.expectedTarget)
    : customDomain.getCustomDomainTargetHost();
  const expectedTargetAddresses = expectedTarget
    ? (customResolver && typeof customResolver.resolveAddresses === 'function'
      ? (await customResolver.resolveAddresses(expectedTarget)).map((v) => String(v || '').trim()).filter(Boolean)
      : await resolveAddressValues(expectedTarget))
    : [];

  const cnameReady = expectedTarget ? cnameValues.some((v) => v === expectedTarget) : cnameValues.length > 0;
  const addressReady = expectedTarget
    ? domainAddresses.some((ip) => expectedTargetAddresses.includes(ip))
    : domainAddresses.length > 0;
  const routingReady = cnameReady || addressReady;

  let tlsOk = null;
  if (tlsProbe && ownershipVerified && routingReady) {
    try {
      const probe = await tlsProbe(domain);
      tlsOk = !!(probe && probe.ok !== false);
    } catch {
      tlsOk = false;
    }
  }

  let reasonCode = 'ok';
  if (!ownershipVerified) {
    reasonCode = txtValues.length ? 'txt_mismatch' : 'txt_missing';
  } else if (!routingReady) {
    reasonCode = 'routing_missing';
  } else if (tlsOk === false) {
    reasonCode = 'tls_failed';
  }

  return {
    txtHost,
    txtValues,
    cnameValues,
    domainAddresses,
    expectedTarget,
    expectedTargetAddresses,
    ownershipVerified,
    routingReady,
    tlsOk,
    reasonCode,
  };
}

function classifyDomainVerification(result, { previousStatus = '' } = {}) {
  const wasActive = previousStatus === 'active' || previousStatus === 'degraded';
  if (!result || !result.ownershipVerified) {
    return { status: wasActive ? 'degraded' : 'pending_verification', degraded: wasActive };
  }
  if (!result.routingReady || result.tlsOk === false) {
    return { status: wasActive ? 'degraded' : 'pending_routing', degraded: wasActive };
  }
  return { status: 'active', degraded: false };
}

function describeDomainStatus(reasonCode, lang = 'az', { degraded = false } = {}) {
  const l = ['az', 'tr', 'en'].includes(lang) ? lang : 'az';
  const copy = {
    ok: {
      az: 'Domen aktiv edildi. Artıq qısa linklərdə istifadə edə bilərsiniz.',
      tr: 'Alan adı aktif edildi. Artık kısa linklerde kullanabilirsiniz.',
      en: 'Domain is active and ready to use for short links.',
    },
    txt_missing: {
      az: degraded ? 'Domenin TXT doğrulama qeydi silinib — yönləndirmə müvəqqəti dayandırıldı.' : 'TXT qeydi tapılmadı. Doğrulama tokenini DNS-ə əlavə edin.',
      tr: degraded ? 'Alan adının TXT doğrulama kaydı silindi — yönlendirme geçici olarak durduruldu.' : 'TXT kaydı bulunamadı. Doğrulama tokenini DNS’e ekleyin.',
      en: degraded ? 'Domain TXT verification record is missing — routing paused until restored.' : 'TXT record not found. Add the verification token to DNS.',
    },
    txt_mismatch: {
      az: 'TXT qeydi tapıldı, amma token uyğun gəlmir. Dəqiq doğrulama dəyərini yoxlayın.',
      tr: 'TXT kaydı bulundu ancak token eşleşmiyor. Doğrulama değerini kontrol edin.',
      en: 'TXT record found, but token does not match. Check the exact verification value.',
    },
    routing_missing: {
      az: degraded ? 'Domenin CNAME/A yönləndirməsi pozulub — DNS qeydlərini yeniləyin.' : 'Mülkiyyət doğrulandı, amma domen hələ yönləndirməyə hazır deyil. CNAME və ya A/AAAA qeydlərini yoxlayın.',
      tr: degraded ? 'Alan adının CNAME/A yönlendirmesi bozuldu — DNS kayıtlarını güncelleyin.' : 'Sahiplik doğrulandı ancak alan adı henüz yönlendirmeye hazır değil. CNAME veya A/AAAA kayıtlarını kontrol edin.',
      en: degraded ? 'Domain CNAME/A routing is broken — update DNS records to restore.' : 'Ownership verified but routing is not ready yet. Check your CNAME or A/AAAA records.',
    },
    tls_failed: {
      az: 'DNS hazırdır, amma SSL/TLS sertifikatı doğrulanmadı. Sertifikat yenilənməsini gözləyin və ya yoxlayın.',
      tr: 'DNS hazır ancak SSL/TLS sertifikatı doğrulanamadı. Sertifika yenilenmesini bekleyin veya kontrol edin.',
      en: 'DNS is ready, but SSL/TLS certificate check failed. Wait for certificate issuance or inspect TLS.',
    },
  };
  return (copy[reasonCode] || copy.routing_missing)[l];
}

module.exports = {
  verifyCustomDomainDns,
  classifyDomainVerification,
  describeDomainStatus,
  resolveTxtValues,
  resolveCnameValues,
  resolveAddressValues,
  resolveDnsWithFallback,
  DNS_FALLBACK_SERVERS
};
