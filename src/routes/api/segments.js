const express = require('express');
const router = express.Router();

const segments = require('../../lib/segments');

const ERROR_MESSAGES = {
  unauthorized: 'Giriş gerekli.',
  invalid_name: 'Seqment adı ən az 2 simvol olmalıdır.',
  duplicate: 'Bu adda seqment artıq mövcuddur.',
  limit_reached: 'Seqment limitinə çatmısınız.',
  not_found: 'Seqment tapılmadı.',
  db_error: 'Seqment yaradıla bilmədi.',
};

function currentUserId(req) {
  if (!req.session || !req.session.userId) return 0;
  const id = Number.parseInt(req.session.userId, 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function sendSegmentError(res, error) {
  const status = error === 'not_found' ? 404
    : (error === 'invalid_name' ? 400 : (error === 'duplicate' || error === 'limit_reached' ? 409 : 500));
  return res.status(status).json({ error: ERROR_MESSAGES[error] || ERROR_MESSAGES.db_error });
}

// GET /api/segments -> the caller's saved filter presets
router.get('/api/segments', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  try {
    const list = await segments.listSegments(userId);
    return res.json({ segments: list });
  } catch {
    return res.status(500).json({ error: 'Seqmentlər yüklənmədi.' });
  }
});

// POST /api/segments { name, filters }
router.post('/api/segments', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const result = await segments.createSegment({ userId, name: body.name, filters: body.filters });
    if (result.error) return sendSegmentError(res, result.error);
    return res.status(201).json({ segment: result.segment });
  } catch {
    return res.status(500).json({ error: ERROR_MESSAGES.db_error });
  }
});

// PATCH /api/segments/:id { name?, filters? }
router.patch('/api/segments/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const result = await segments.updateSegment({
      userId,
      segmentId: req.params.id,
      name: body.name,
      filters: body.filters,
    });
    if (result.error) return sendSegmentError(res, result.error);
    return res.json({ segment: result.segment });
  } catch {
    return res.status(500).json({ error: 'Seqment yenilənmədi.' });
  }
});

// DELETE /api/segments/:id
router.delete('/api/segments/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  try {
    const result = await segments.deleteSegment({ userId, segmentId: req.params.id });
    if (!result.deleted) return res.status(404).json({ error: ERROR_MESSAGES.not_found });
    return res.json({ deleted: true });
  } catch {
    return res.status(500).json({ error: 'Seqment silinmədi.' });
  }
});

module.exports = router;
module.exports.ERROR_MESSAGES = ERROR_MESSAGES;
