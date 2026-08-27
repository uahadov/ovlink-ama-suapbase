const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { dbGetAsync, dbRunAsync } = require('../../db/helpers');
const { requireSignedIn } = require('../../middleware/auth');
const { pickLang, normalizeLang } = require('../../lib/i18n');
const { normalizeCustomDomainInput, normalizeHostName } = require('../../lib/url-helpers');
const { verifyCustomDomainDns } = require('../../lib/dns-verify');
const { getCustomDomainTargetHost, getCustomDomainTxtHost, refreshCustomDomainCache, checkProPlanStatus } = require('../../lib/custom-domain');
const { isProAccessActive, getEffectivePlanForUser, PLAN_TIERS } = require('../../lib/plans');
const { db } = require('../../db/index');
const { encryptAES256GCM, decryptAES256GCM } = require('../../../utils/crypto');

function buildCustomDomainPayload(row) {
  if (!row) return null;
  return {
    id: row.id,
    domain: row.domain,
    status: row.status,
    verification_token: row.verification_token,
    txt_host: getCustomDomainTxtHost(row.domain),
    target_host: getCustomDomainTargetHost(),
    created_at: row.created_at,
    verified_at: row.verified_at,
    last_checked_at: row.last_checked_at,
    routing_ok: !!row.routing_ok,
  };
}

function isInternalHost(domain) {
  const normalized = normalizeCustomDomainInput(domain);
  if (!normalized) return true;
  const baseHost = getCustomDomainTargetHost();
  if (baseHost && (normalized === baseHost || normalized.endsWith('.' + baseHost))) return true;
  const reserved = ['localhost', '127.0.0.1', 'ovlink.sbs', 'ovlink.com'];
  return reserved.includes(normalized);
}

const handleListDomains = (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  db.all(
    'SELECT id, domain, status, verification_token, created_at, verified_at, last_checked_at, routing_ok FROM custom_domains WHERE user_id = ? ORDER BY created_at DESC',
    [req.session.userId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Could not load domains.' });
      }

      return res.json({
        domains: (rows || []).map((row) => buildCustomDomainPayload(row)),
        target_host: getCustomDomainTargetHost(),
      });
    }
  );
};

router.get('/api/domains', handleListDomains);
router.get('/api/custom-domains', handleListDomains);

router.post('/api/domains/add', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const domain = normalizeCustomDomainInput(req.body && req.body.domain);
  if (!domain) {
    return res.status(400).json({ error: pickLang(uiLang, 'Düzgün domen daxil edin.', 'Geçerli bir alan adı girin.', 'Please enter a valid domain.') });
  }

  if (isInternalHost(domain)) {
    return res.status(400).json({ error: pickLang(uiLang, 'Bu domen sistem tərəfindən istifadə olunur.', 'Bu alan adı sistem tarafından kullanılıyor.', 'This domain is reserved by the system.') });
  }

  db.get('SELECT * FROM custom_domains WHERE domain = ?', [domain], (err, existing) => {
    if (err) {
      return res.status(500).json({ error: pickLang(uiLang, 'Domen əlavə edilə bilmədi.', 'Alan adı eklenemedi.', 'Could not add domain.') });
    }

    if (existing && existing.user_id !== req.session.userId) {
      return res.status(409).json({ error: pickLang(uiLang, 'Bu domen artıq başqa hesabda istifadə olunur.', 'Bu alan adı başka bir hesapta kullanılıyor.', 'This domain is already used by another account.') });
    }

    if (existing && existing.user_id === req.session.userId) {
      return res.json({
        message: pickLang(uiLang, 'Domen artıq mövcuddur.', 'Alan adı zaten mevcut.', 'Domain already exists.'),
        domain: buildCustomDomainPayload(existing),
      });
    }

    const token = encryptAES256GCM(crypto.randomBytes(20).toString('hex'));
    const now = new Date().toISOString();
    db.run(
      'INSERT INTO custom_domains (user_id, domain, status, verification_token, created_at, routing_ok) VALUES (?, ?, ?, ?, ?, 0)',
      [req.session.userId, domain, 'pending_verification', token, now],
      function (insertErr) {
        if (insertErr) {
          return res.status(500).json({ error: pickLang(uiLang, 'Domen əlavə edilə bilmədi.', 'Alan adı eklenemedi.', 'Could not add domain.') });
        }

        db.get(
          'SELECT id, domain, status, verification_token, created_at, verified_at, last_checked_at, routing_ok FROM custom_domains WHERE id = ?',
          [this.lastID],
          (fetchErr, row) => {
            if (fetchErr || !row) {
              return res.status(500).json({ error: pickLang(uiLang, 'Domen əlavə edildi, amma oxuna bilmədi.', 'Alan adı eklendi ancak okunamadı.', 'Domain added but could not be loaded.') });
            }

            return res.json({
              message: pickLang(uiLang, 'Domen əlavə edildi. İndi DNS doğrulamasanı edin.', 'Alan adı eklendi. Şimdi DNS doğrulamasını yapın.', 'Domain added. Complete DNS verification now.'),
              domain: buildCustomDomainPayload(row),
            });
          }
        );
      }
    );
  });
});

router.post('/api/domains/verify', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const domainId = Number.parseInt((req.body && req.body.domain_id) || '', 10);
  if (!Number.isInteger(domainId) || domainId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış domen ID.', 'Geçersiz alan adı ID.', 'Invalid domain ID.') });
  }

  db.get(
    'SELECT id, user_id, domain, status, verification_token, created_at, verified_at, last_checked_at, routing_ok FROM custom_domains WHERE id = ? AND user_id = ?',
    [domainId, req.session.userId],
    (err, row) => {
      if (err || !row) {
        return res.status(404).json({ error: pickLang(uiLang, 'Domen tapılmadı.', 'Alan adı bulunamadı.', 'Domain not found.') });
      }

      (async () => {
        try {
          const result = await verifyCustomDomainDns(row.domain, decryptAES256GCM(row.verification_token));
          const now = new Date().toISOString();
          const status = !result.ownershipVerified
            ? 'pending_verification'
            : (result.routingReady ? 'active' : 'pending_routing');
          const verifiedAt = result.ownershipVerified ? (row.verified_at || now) : null;
          const routingOk = result.routingReady ? 1 : 0;

          db.run(
            'UPDATE custom_domains SET status = ?, verified_at = ?, last_checked_at = ?, routing_ok = ? WHERE id = ? AND user_id = ?',
            [status, verifiedAt, now, routingOk, domainId, req.session.userId],
            (updateErr) => {
              if (updateErr) {
                return res.status(500).json({ error: pickLang(uiLang, 'Doğrulama məlumatı yadda saxlanmadı.', 'Doğrulama sonucu kaydedilemedi.', 'Verification result could not be saved.') });
              }

              refreshCustomDomainCache();

              db.get(
                'SELECT id, domain, status, verification_token, created_at, verified_at, last_checked_at, routing_ok FROM custom_domains WHERE id = ?',
                [domainId],
                (fetchErr, updatedRow) => {
                  if (fetchErr || !updatedRow) {
                    return res.status(500).json({ error: pickLang(uiLang, 'Doğrulama tamamlandı, amma nəticə oxuna bilmədi.', 'Doğrulama tamamlandı ancak sonuç okunamadı.', 'Verification completed but result could not be loaded.') });
                  }

                  let message = '';
                  if (!result.ownershipVerified) {
                    message = pickLang(uiLang, 'TXT qeydi tapılmadı. Doğrulama tokenini DNS-ə əlavə edin.', 'TXT kaydı bulunamadı. Doğrulama tokenini DNS’e ekleyin.', 'TXT record not found. Add the verification token to DNS.');
                  } else if (!result.routingReady) {
                    message = pickLang(uiLang, 'Mülkiyyət doğrulandı, amma domen hələ yönləndirməyə hazır deyil. CNAME və ya A/AAAA qeydlərini yoxlayın.', 'Sahiplik doğrulandı ancak alan adı henüz yönlendirmeye hazır değil. CNAME veya A/AAAA kayıtlarını kontrol edin.', 'Ownership verified but routing is not ready yet. Check your CNAME or A/AAAA records.');
                  } else {
                    message = pickLang(uiLang, 'Domen aktiv edildi. Artıq qısa linklərdə istifadə edə bilərsiniz.', 'Alan adı aktif edildi. Artık kısa linklerde kullanabilirsiniz.', 'Domain is active and ready to use for short links.');
                  }

                  return res.json({
                    message,
                    domain: buildCustomDomainPayload(updatedRow),
                    dns: {
                      txt_host: result.txtHost,
                      txt_values: result.txtValues,
                      cname_values: result.cnameValues,
                      expected_cname: result.expectedTarget,
                      domain_ips: result.domainAddresses,
                      expected_target_ips: result.expectedTargetAddresses,
                    }
                  });
                }
              );
            }
          );
        } catch {
          return res.status(500).json({ error: pickLang(uiLang, 'DNS yoxlanışı zamanı xəta baş verdi.', 'DNS kontrolü sırasında hata oluştu.', 'DNS verification failed.') });
        }
      })();
    }
  );
});

router.post('/api/domains/delete', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const domainId = Number.parseInt((req.body && req.body.domain_id) || '', 10);
  if (!Number.isInteger(domainId) || domainId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış domen ID.', 'Geçersiz alan adı ID.', 'Invalid domain ID.') });
  }

  db.get('SELECT domain FROM custom_domains WHERE id = ? AND user_id = ?', [domainId, req.session.userId], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ error: pickLang(uiLang, 'Domen tapılmadı.', 'Alan adı bulunamadı.', 'Domain not found.') });
    }

    const domainHost = normalizeHostName(row.domain);
    db.run('UPDATE urls SET domain_host = NULL WHERE user_id = ? AND domain_host = ?', [req.session.userId, domainHost], function (updateErr) {
      if (updateErr) {
        return res.status(500).json({ error: pickLang(uiLang, 'Domen silinmədi.', 'Alan adı silinemedi.', 'Domain could not be deleted.') });
      }

      const detachedCount = this.changes || 0;
      db.run('DELETE FROM custom_domains WHERE id = ? AND user_id = ?', [domainId, req.session.userId], (deleteErr) => {
        if (deleteErr) {
          return res.status(500).json({ error: pickLang(uiLang, 'Domen silinmədi.', 'Alan adı silinemedi.', 'Domain could not be deleted.') });
        }

        refreshCustomDomainCache();
        return res.json({
          message: pickLang(uiLang, 'Domen silindi.', 'Alan adı silindi.', 'Domain deleted.'),
          detached_links: detachedCount,
        });
      });
    });
  });
});

module.exports = router;
