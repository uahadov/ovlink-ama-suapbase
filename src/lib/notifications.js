function createUserNotification(db, userId, type, payload = {}) {
  if (!db || !userId) return;
  const {
    titleAz = '',
    titleTr = '',
    titleEn = '',
    bodyAz = '',
    bodyTr = '',
    bodyEn = '',
    linkShort = null,
    eventKey = null,
  } = payload;

  const finalTitleEn = titleEn || titleAz || titleTr || '';
  const finalBodyEn = bodyEn || bodyAz || bodyTr || '';

  db.get(
    'SELECT notify_report, notify_limit, notify_disabled FROM users WHERE id = ?',
    [userId],
    (err, row) => {
      if (err || !row) return;
      if (type === 'report' && row.notify_report != 1) return;
      if (type === 'limit' && row.notify_limit != 1) return;
      if (type === 'disabled' && row.notify_disabled != 1) return;

      const createdAt = new Date().toISOString();
      db.run(
        'INSERT OR IGNORE INTO notifications (user_id, type, title_az, title_tr, title_en, body_az, body_tr, body_en, link_short, event_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          userId,
          type,
          titleAz,
          titleTr,
          finalTitleEn,
          bodyAz,
          bodyTr,
          finalBodyEn,
          linkShort,
          eventKey,
          createdAt,
        ],
      );
    }
  );
}

module.exports = {
  createUserNotification
};
