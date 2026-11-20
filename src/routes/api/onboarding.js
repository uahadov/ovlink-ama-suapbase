const express = require('express');
const router = express.Router();

const { dbRunAsync } = require('../../db/helpers');
const b2bOnboarding = require('../../lib/b2b-onboarding');

// POST /api/user/onboarding-dismiss — hides the first-steps checklist for good.
router.post('/api/user/onboarding-dismiss', async (req, res) => {
  const userId = Number.parseInt(req.session && req.session.userId, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(401).json({ error: 'Giriş gerekli.' });
  }

  try {
    await dbRunAsync(
      'UPDATE users SET onboarding_dismissed_at = ? WHERE id = ?',
      [new Date().toISOString(), userId]
    );
    return res.json({ dismissed: true });
  } catch (err) {
    return res.status(500).json({ error: 'Əməliyyat alınmadı.' });
  }
});

// ===== P41: First 15-Minute B2B Onboarding & Activation =====

router.get('/api/user/b2b-onboarding', async (req, res) => {
  const userId = Number.parseInt(req.session && req.session.userId, 10);
  if (!Number.isInteger(userId) || userId <= 0) return res.status(401).json({ error: 'Giriş gerekli.' });
  try {
    const lang = req.query && req.query.lang ? String(req.query.lang).toLowerCase() : 'az';
    const state = await b2bOnboarding.loadB2bOnboardingState({ userId, lang });
    return res.json(state);
  } catch {
    return res.status(500).json({ error: 'Onboarding vəziyyəti yüklənmədi.' });
  }
});

router.post('/api/user/b2b-onboarding/profile', async (req, res) => {
  const userId = Number.parseInt(req.session && req.session.userId, 10);
  if (!Number.isInteger(userId) || userId <= 0) return res.status(401).json({ error: 'Giriş gerekli.' });
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = await b2bOnboarding.saveOnboardingProfile({
      userId,
      accountType: body.account_type,
      primaryGoal: body.primary_goal,
    });
    if (result.error) return res.status(result.statusCode || 400).json(result);
    return res.json(result);
  } catch {
    return res.status(500).json({ error: 'Profil saxlanıla bilmədi.' });
  }
});

router.post('/api/user/b2b-onboarding/skip', async (req, res) => {
  const userId = Number.parseInt(req.session && req.session.userId, 10);
  if (!Number.isInteger(userId) || userId <= 0) return res.status(401).json({ error: 'Giriş gerekli.' });
  try {
    return res.json(await b2bOnboarding.setOnboardingSkipped({ userId, skipped: true }));
  } catch {
    return res.status(500).json({ error: 'Keçid əməliyyatı alınmadı.' });
  }
});

router.post('/api/user/b2b-onboarding/resume', async (req, res) => {
  const userId = Number.parseInt(req.session && req.session.userId, 10);
  if (!Number.isInteger(userId) || userId <= 0) return res.status(401).json({ error: 'Giriş gerekli.' });
  try {
    return res.json(await b2bOnboarding.setOnboardingSkipped({ userId, skipped: false }));
  } catch {
    return res.status(500).json({ error: 'Davam əməliyyatı alınmadı.' });
  }
});

router.get('/api/user/b2b-onboarding/analytics', async (req, res) => {
  const userId = Number.parseInt(req.session && req.session.userId, 10);
  if (!Number.isInteger(userId) || userId <= 0) return res.status(401).json({ error: 'Giriş gerekli.' });
  try {
    return res.json(await b2bOnboarding.getOnboardingDropoffSummary());
  } catch {
    return res.status(500).json({ error: 'Analitika yüklənmədi.' });
  }
});

module.exports = router;
