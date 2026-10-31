const express = require('express');
const router = express.Router();

const { dbRunAsync } = require('../../db/helpers');

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

module.exports = router;
