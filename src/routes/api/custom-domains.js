const express = require('express');
const router = express.Router();


const { dbGetAsync, dbRunAsync } = require('../../db/helpers');
const { requireSignedIn } = require('../../middleware/auth');
const { pickLang, normalizeLang } = require('../../lib/i18n');
const { normalizeCustomDomainInput } = require('../../lib/url-helpers');
const { verifyDomainDns } = require('../../lib/dns-verify');
const { checkProPlanStatus } = require('../../lib/custom-domain'); // assuming logic moved or needed
const { isProAccessActive, getEffectivePlanForUser, PLAN_TIERS } = require('../../lib/plans');
const { db } = require('../../db/index');



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
// Legacy compatibility path expected by older clients and external backend checks.
// Legacy compatibility path expected by older clients and external backend checks.
router.get('/api/custom-domains', handleListDomains);

router.post('/api/domains/add', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const domain = normalizeCustomDomainInput(req.body && req.body.domain);
  if (!domain) {
    return res.status(400).json({ error: pickLang(uiLang, 'Dâ”œâ•zgâ”œâ•n domen daxil edin.', 'Geâ”œÄŸerli bir alan adâ”€â–’ girin.', 'Please enter a valid domain.') });
  }

  if (isInternalHost(domain)) {
    return res.status(400).json({ error: pickLang(uiLang, 'Bu domen sistem tâ•”Ã–râ•”Ã–findâ•”Ã–n istifadâ•”Ã– olunur.', 'Bu alan adâ”€â–’ sistem tarafâ”€â–’ndan kullanâ”€â–’lâ”€â–’yor.', 'This domain is reserved by the system.') });
  }

  db.get('SELECT * FROM custom_domains WHERE domain = ?', [domain], (err, existing) => {
    if (err) {
      return res.status(500).json({ error: pickLang(uiLang, 'Domen â•”Ã–lavâ•”Ã– edilâ•”Ã– bilmâ•”Ã–di.', 'Alan adâ”€â–’ eklenemedi.', 'Could not add domain.') });
    }

    if (existing && existing.user_id !== req.session.userId) {
      return res.status(409).json({ error: pickLang(uiLang, 'Bu domen artâ”€â–’q baâ”¼ÅŸqa hesabda istifadâ•”Ã– olunur.', 'Bu alan adâ”€â–’ baâ”¼ÅŸka bir hesapta kullanâ”€â–’lâ”€â–’yor.', 'This domain is already used by another account.') });
    }

    if (existing && existing.user_id === req.session.userId) {
      return res.json({
        message: pickLang(uiLang, 'Domen artâ”€â–’q mâ”œÃ‚vcuddur.', 'Alan adâ”€â–’ zaten mevcut.', 'Domain already exists.'),
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
          return res.status(500).json({ error: pickLang(uiLang, 'Domen â•”Ã–lavâ•”Ã– edilâ•”Ã– bilmâ•”Ã–di.', 'Alan adâ”€â–’ eklenemedi.', 'Could not add domain.') });
        }

        db.get(
          'SELECT id, domain, status, verification_token, created_at, verified_at, last_checked_at, routing_ok FROM custom_domains WHERE id = ?',
          [this.lastID],
          (fetchErr, row) => {
            if (fetchErr || !row) {
              return res.status(500).json({ error: pickLang(uiLang, 'Domen â•”Ã–lavâ•”Ã– edildi, amma oxuna bilmâ•”Ã–di.', 'Alan adâ”€â–’ eklendi ancak okunamadâ”€â–’.', 'Domain added but could not be loaded.') });
            }

            return res.json({
              message: pickLang(uiLang, 'Domen â•”Ã–lavâ•”Ã– edildi. â”€â–‘ndi DNS doâ”€ÅŸrulamasâ”€â–’nâ”€â–’ edin.', 'Alan adâ”€â–’ eklendi. â”¼Åimdi DNS doâ”€ÅŸrulamasâ”€â–’nâ”€â–’ yapâ”€â–’n.', 'Domain added. Complete DNS verification now.'),
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
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlâ”€â–’â”¼ÅŸ domen ID.', 'Geâ”œÄŸersiz alan adâ”€â–’ ID.', 'Invalid domain ID.') });
  }

  db.get(
    'SELECT id, user_id, domain, status, verification_token, created_at, verified_at, last_checked_at, routing_ok FROM custom_domains WHERE id = ? AND user_id = ?',
    [domainId, req.session.userId],
    (err, row) => {
      if (err || !row) {
        return res.status(404).json({ error: pickLang(uiLang, 'Domen tapâ”€â–’lmadâ”€â–’.', 'Alan adâ”€â–’ bulunamadâ”€â–’.', 'Domain not found.') });
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
                return res.status(500).json({ error: pickLang(uiLang, 'Doâ”€ÅŸrulama mâ•”Ã–lumatâ”€â–’ yadda saxlanmadâ”€â–’.', 'Doâ”€ÅŸrulama sonucu kaydedilemedi.', 'Verification result could not be saved.') });
              }

              refreshCustomDomainCache();

              db.get(
                'SELECT id, domain, status, verification_token, created_at, verified_at, last_checked_at, routing_ok FROM custom_domains WHERE id = ?',
                [domainId],
                (fetchErr, updatedRow) => {
                  if (fetchErr || !updatedRow) {
                    return res.status(500).json({ error: pickLang(uiLang, 'Doâ”€ÅŸrulama tamamlandâ”€â–’, amma nâ•”Ã–ticâ•”Ã– oxuna bilmâ•”Ã–di.', 'Doâ”€ÅŸrulama tamamlandâ”€â–’ ancak sonuâ”œÄŸ okunamadâ”€â–’.', 'Verification completed but result could not be loaded.') });
                  }

                  let message = '';
                  if (!result.ownershipVerified) {
                    message = pickLang(uiLang, 'TXT qeydi tapâ”€â–’lmadâ”€â–’. Doâ”€ÅŸrulama tokenini DNS-â•”Ã– â•”Ã–lavâ•”Ã– edin.', 'TXT kaydâ”€â–’ bulunamadâ”€â–’. Doâ”€ÅŸrulama tokenini DNSÃ”Ã‡Ã–e ekleyin.', 'TXT record not found. Add the verification token to DNS.');
                  } else if (!result.routingReady) {
                    message = pickLang(uiLang, 'Mâ”œâ•lkiyyâ•”Ã–t doâ”€ÅŸrulandâ”€â–’, amma domen hâ•”Ã–lâ•”Ã– yâ”œÃ‚nlâ•”Ã–ndirmâ•”Ã–yâ•”Ã– hazâ”€â–’r deyil. CNAME vâ•”Ã– ya A/AAAA qeydlâ•”Ã–rini yoxlayâ”€â–’n.', 'Sahiplik doâ”€ÅŸrulandâ”€â–’ ancak alan adâ”€â–’ henâ”œâ•z yâ”œÃ‚nlendirmeye hazâ”€â–’r deâ”€ÅŸil. CNAME veya A/AAAA kayâ”€â–’tlarâ”€â–’nâ”€â–’ kontrol edin.', 'Ownership verified but routing is not ready yet. Check your CNAME or A/AAAA records.');
                  } else {
                    message = pickLang(uiLang, 'Domen aktiv edildi. Artâ”€â–’q qâ”€â–’sa linklâ•”Ã–rdâ•”Ã– istifadâ•”Ã– edâ•”Ã– bilâ•”Ã–rsiniz.', 'Alan adâ”€â–’ aktif edildi. Artâ”€â–’k kâ”€â–’sa linklerde kullanabilirsiniz.', 'Domain is active and ready to use for short links.');
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
          return res.status(500).json({ error: pickLang(uiLang, 'DNS yoxlanâ”€â–’â”¼ÅŸâ”€â–’ zamanâ”€â–’ xâ•”Ã–ta baâ”¼ÅŸ verdi.', 'DNS kontrolâ”œâ• sâ”€â–’rasâ”€â–’nda hata oluâ”¼ÅŸtu.', 'DNS verification failed.') });
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
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlâ”€â–’â”¼ÅŸ domen ID.', 'Geâ”œÄŸersiz alan adâ”€â–’ ID.', 'Invalid domain ID.') });
  }

  db.get('SELECT domain FROM custom_domains WHERE id = ? AND user_id = ?', [domainId, req.session.userId], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ error: pickLang(uiLang, 'Domen tapâ”€â–’lmadâ”€â–’.', 'Alan adâ”€â–’ bulunamadâ”€â–’.', 'Domain not found.') });
    }

    const domainHost = normalizeHostName(row.domain);
    db.run('UPDATE urls SET domain_host = NULL WHERE user_id = ? AND domain_host = ?', [req.session.userId, domainHost], function (updateErr) {
      if (updateErr) {
        return res.status(500).json({ error: pickLang(uiLang, 'Domen silinmâ•”Ã–di.', 'Alan adâ”€â–’ silinemedi.', 'Domain could not be deleted.') });
      }

      const detachedCount = this.changes || 0;
      db.run('DELETE FROM custom_domains WHERE id = ? AND user_id = ?', [domainId, req.session.userId], (deleteErr) => {
        if (deleteErr) {
          return res.status(500).json({ error: pickLang(uiLang, 'Domen silinmâ•”Ã–di.', 'Alan adâ”€â–’ silinemedi.', 'Domain could not be deleted.') });
        }

        refreshCustomDomainCache();
        return res.json({
          message: pickLang(uiLang, 'Domen silindi.', 'Alan adâ”€â–’ silindi.', 'Domain deleted.'),
          detached_links: detachedCount,
        });
      });
    });
  });


});

module.exports = router;

