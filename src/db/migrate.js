const { db } = require('./index');
const { pool } = require('./pool');
const bcrypt = require('bcrypt');
const { encryptAES256GCM, decryptAES256GCM, blindIndex } = require('../../utils/crypto.js');
const { DEFAULT_API_KEY_SCOPES_STORAGE } = require('../lib/security');
const { buildVerificationExpiryIso } = require('../lib/session');
const { siteSettings } = require('../middleware/maintenance');
const { refreshCustomDomainCache } = require('../lib/custom-domain');

function ensureDbTables() {
  db.serialize(() => {
  
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      password TEXT,
      email_verified INTEGER DEFAULT 0,
      verification_code TEXT,
      verification_expires_at TEXT,
      auth_provider TEXT DEFAULT 'local',
      google_id TEXT
    )`);
  
    // URL tablosu
    db.run(`CREATE TABLE IF NOT EXISTS urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original TEXT,
      short TEXT UNIQUE,
      created_at TEXT,
      reports INTEGER DEFAULT 0,
      user_id INTEGER,
      link_password TEXT,
      dangerous INTEGER DEFAULT 0,
      expires_at TEXT,
      max_clicks INTEGER,
      original_b TEXT,
      ab_split_percent INTEGER DEFAULT 50,
      ios_url TEXT,
      android_url TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
  
    db.run('ALTER TABLE urls ADD COLUMN folder_name TEXT', () => {});
    db.run('ALTER TABLE urls ADD COLUMN tags_json TEXT', () => {});
  
    // Reports tablosu: "reason" ve "user_id" sâ”œâ•tunlarâ”€â–’nâ”€â–’ iâ”œÄŸeriyor.
    db.run(`CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      short TEXT,
      created_at TEXT,
      reason TEXT,
      user_id INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
  
    // Tâ”€â–’klama tablosu
    db.run(`CREATE TABLE IF NOT EXISTS clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url_id INTEGER,
      click_time TEXT,
      ip TEXT,
      browser TEXT,
      os TEXT,
      country TEXT,
      city TEXT,
      FOREIGN KEY(url_id) REFERENCES urls(id)
    )`);
  
    // ===== Admin System Tables / Indexes (NEW) =====
  
    // Site settings (maintenance + announcement)
    db.run(`CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`);
  
    db.run("INSERT OR IGNORE INTO site_settings (key, value) VALUES ('maintenance_enabled', '0')");
    db.run("INSERT OR IGNORE INTO site_settings (key, value) VALUES ('maintenance_message_az', '')");
    db.run("INSERT OR IGNORE INTO site_settings (key, value) VALUES ('maintenance_message_tr', '')");
    db.run("INSERT OR IGNORE INTO site_settings (key, value) VALUES ('maintenance_message_en', '')");
    db.run("INSERT OR IGNORE INTO site_settings (key, value) VALUES ('announcement_enabled', '0')");
    db.run("INSERT OR IGNORE INTO site_settings (key, value) VALUES ('announcement_text_az', '')");
    db.run("INSERT OR IGNORE INTO site_settings (key, value) VALUES ('announcement_text_tr', '')");
    db.run("INSERT OR IGNORE INTO site_settings (key, value) VALUES ('announcement_text_en', '')");
  
    db.run(`CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      failed_login_count INTEGER DEFAULT 0,
      lock_until TEXT,
      last_failed_at TEXT,
      last_login_at TEXT,
      created_at TEXT
    )`);
  
    // 2FA migration: no-op if columns already exist
    db.run('ALTER TABLE admin_users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0', () => {});
    db.run('ALTER TABLE admin_users ADD COLUMN totp_secret TEXT', () => {});
    db.run('ALTER TABLE admin_users ADD COLUMN email_hash TEXT', () => {});
  
    db.run(`CREATE TABLE IF NOT EXISTS blocked_domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT UNIQUE NOT NULL,
      created_at TEXT,
      created_by_admin_id INTEGER,
      note TEXT,
      FOREIGN KEY(created_by_admin_id) REFERENCES admin_users(id)
    )`);
  
    db.run(`CREATE TABLE IF NOT EXISTS admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT,
      admin_user_id INTEGER,
      action TEXT,
      target_type TEXT,
      target_id TEXT,
      metadata_json TEXT,
      ip TEXT,
      user_agent TEXT,
      FOREIGN KEY(admin_user_id) REFERENCES admin_users(id)
    )`);
  
    db.run(`CREATE TABLE IF NOT EXISTS admin_auth_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      email_or_username TEXT,
      ip_address TEXT,
      country TEXT,
      user_agent TEXT,
      created_at TEXT
    )`);
    db.run('ALTER TABLE admin_auth_audit ADD COLUMN country TEXT', () => {});
    db.run('ALTER TABLE admin_auth_audit ADD COLUMN metadata_json TEXT', () => {});
  
    db.run('CREATE INDEX IF NOT EXISTS idx_admin_auth_audit_created_at ON admin_auth_audit(created_at)', () => {});
  
    db.run(`CREATE TABLE IF NOT EXISTS guest_limits (
      ip TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      updated_at TEXT,
      PRIMARY KEY (ip, day)
    )`);
  
  
  db.run(`CREATE TABLE IF NOT EXISTS custom_domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    domain TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_verification',
    verification_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    verified_at TEXT,
    last_checked_at TEXT,
    routing_ok INTEGER DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
  
    db.run(`CREATE TABLE IF NOT EXISTS user_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_token TEXT NOT NULL UNIQUE,
      user_agent TEXT,
      device_label TEXT,
      browser TEXT,
      os TEXT,
      country TEXT,
      ip_hash TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_login_at TEXT,
      last_login_method TEXT,
      is_revoked INTEGER NOT NULL DEFAULT 0,
      revoked_at TEXT,
      device_fingerprint TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
  
    db.run('ALTER TABLE user_sessions ADD COLUMN device_fingerprint TEXT', () => {});
  
    db.run(`CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT 'account:read,shorten:write,webhooks:read,webhooks:write',
      key_hash TEXT NOT NULL UNIQUE,
      hash_version INTEGER NOT NULL DEFAULT 1,
      key_prefix TEXT NOT NULL,
      last4 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
  
    db.run(`CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      secret_hash_version INTEGER NOT NULL DEFAULT 1,
      signature_v2_key TEXT,
      signature_v2_enabled INTEGER NOT NULL DEFAULT 0,
      events TEXT NOT NULL,
      message_locale TEXT NOT NULL DEFAULT 'auto',
      message_template TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_failure_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
  
    db.run(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      http_status INTEGER,
      response_excerpt TEXT,
      next_retry_at TEXT,
      last_attempt_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(webhook_id) REFERENCES webhooks(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
  
    db.run(`CREATE TABLE IF NOT EXISTS subscription_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      admin_user_id INTEGER,
      target_user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      old_tier TEXT,
      new_tier TEXT,
      old_status TEXT,
      new_status TEXT,
      old_expires_at TEXT,
      new_expires_at TEXT,
      duration_seconds INTEGER,
      reason TEXT,
      metadata_json TEXT,
      FOREIGN KEY(admin_user_id) REFERENCES admin_users(id),
      FOREIGN KEY(target_user_id) REFERENCES users(id)
    )`);
  
    db.run(`CREATE TABLE IF NOT EXISTS security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      outcome TEXT NOT NULL,
      user_id INTEGER,
      api_key_id INTEGER,
      ip_hash TEXT,
      ip_masked TEXT,
      user_agent TEXT,
      details_json TEXT
    )`);
  
    db.run(`CREATE TABLE IF NOT EXISTS api_idempotency_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      api_key_id INTEGER,
      endpoint TEXT NOT NULL,
      idempotency_hash TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status_code INTEGER,
      response_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      UNIQUE(user_id, endpoint, idempotency_hash),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(api_key_id) REFERENCES api_keys(id)
    )`);
  
    db.run(`CREATE TABLE IF NOT EXISTS api_usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      api_key_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      error_type TEXT NOT NULL DEFAULT 'ok',
      created_at TEXT NOT NULL
    )`);
  
  // Domain-aware short links
  db.run('ALTER TABLE urls ADD COLUMN domain_host TEXT', () => {});
  db.run('ALTER TABLE urls ADD COLUMN original_b TEXT', () => {});
  db.run('ALTER TABLE urls ADD COLUMN ab_split_percent INTEGER DEFAULT 50', () => {});
  db.run('ALTER TABLE urls ADD COLUMN ios_url TEXT', () => {});
  db.run('ALTER TABLE urls ADD COLUMN android_url TEXT', () => {});
  
    // Privacy scrub: remove legacy full IPs from public analytics/audit tables
    db.run("UPDATE clicks SET ip = NULL WHERE ip IS NOT NULL");
    db.run("UPDATE clicks SET city = NULL WHERE city IS NOT NULL");
    db.run("DELETE FROM guest_limits");
  
    // Columns for link moderation
    db.run('ALTER TABLE urls ADD COLUMN disabled INTEGER DEFAULT 0', () => {});
    db.run('ALTER TABLE urls ADD COLUMN disabled_reason TEXT', () => {});
    db.run('ALTER TABLE urls ADD COLUMN disabled_at TEXT', () => {});
    db.run('ALTER TABLE urls ADD COLUMN disabled_by_admin_id INTEGER', () => {});
  
    // Optional notes on user reports
    db.run('ALTER TABLE reports ADD COLUMN notes TEXT', () => {});
    db.run('ALTER TABLE reports ADD COLUMN resolved_at TEXT', () => {});
    db.run('ALTER TABLE reports ADD COLUMN resolved_by_admin_id INTEGER', () => {});
  
    // Columns for user moderation
    db.run('ALTER TABLE users ADD COLUMN created_at TEXT', () => {});
    db.run('ALTER TABLE users ADD COLUMN email_hash TEXT', () => {});
    db.run('ALTER TABLE users ADD COLUMN last_login_at TEXT', () => {});
    db.run('ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0', () => {});
    db.run('ALTER TABLE users ADD COLUMN ban_until TEXT', () => {});
    db.run('ALTER TABLE users ADD COLUMN ban_reason TEXT', () => {});
    db.run('ALTER TABLE users ADD COLUMN ban_set_at TEXT', () => {});
    db.run('ALTER TABLE users ADD COLUMN ban_set_by_admin_id INTEGER', () => {});
  
    // User preferences
    db.run("ALTER TABLE users ADD COLUMN ui_lang TEXT DEFAULT 'az'", () => {});
    db.run("ALTER TABLE users ADD COLUMN ui_theme TEXT DEFAULT 'light'", () => {});
    db.run('ALTER TABLE users ADD COLUMN notify_report INTEGER DEFAULT 1', () => {});
    db.run('ALTER TABLE users ADD COLUMN notify_limit INTEGER DEFAULT 1', () => {});
    db.run('ALTER TABLE users ADD COLUMN notify_disabled INTEGER DEFAULT 1', () => {});
    db.run("ALTER TABLE users ADD COLUMN auth_provider TEXT DEFAULT 'local'", () => {});
    db.run('ALTER TABLE users ADD COLUMN google_id TEXT', () => {});
    db.run('ALTER TABLE users ADD COLUMN google_id_hash TEXT', () => {});
    db.run('ALTER TABLE users ADD COLUMN verification_expires_at TEXT', () => {});
    db.run("ALTER TABLE users ADD COLUMN plan_tier TEXT DEFAULT 'free'", () => {});
    db.run("ALTER TABLE users ADD COLUMN plan_status TEXT DEFAULT 'active'", () => {});
    db.run('ALTER TABLE users ADD COLUMN pro_expires_at TEXT', () => {});
    db.run('ALTER TABLE users ADD COLUMN pro_paused_at TEXT', () => {});
    db.run('ALTER TABLE users ADD COLUMN pro_updated_at TEXT', () => {});
    db.run('ALTER TABLE users ADD COLUMN polar_customer_id TEXT', () => {});
    db.run('ALTER TABLE users ADD COLUMN polar_subscription_id TEXT', () => {});
    db.run('ALTER TABLE users ADD COLUMN trial_used_at TEXT', () => {});
    db.run('ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0', () => {});
    db.run('ALTER TABLE users ADD COLUMN totp_secret TEXT', () => {});
    db.run('ALTER TABLE users ADD COLUMN totp_pending_secret TEXT', () => {});
    db.run('ALTER TABLE users ADD COLUMN pending_email TEXT', () => {});
    db.run('ALTER TABLE users ADD COLUMN pending_email_code TEXT', () => {});
    db.run('ALTER TABLE users ADD COLUMN pending_email_expires_at TEXT', () => {});
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_polar_sub ON users(polar_subscription_id) WHERE polar_subscription_id IS NOT NULL', () => {});
    db.run(`ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '${DEFAULT_API_KEY_SCOPES_STORAGE}'`, () => {});
    db.run('ALTER TABLE api_keys ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 1', () => {});
    db.run("ALTER TABLE webhooks ADD COLUMN message_locale TEXT DEFAULT 'auto'", () => {});
    db.run('ALTER TABLE webhooks ADD COLUMN message_template TEXT', () => {});
    db.run('ALTER TABLE webhooks ADD COLUMN secret_hash_version INTEGER NOT NULL DEFAULT 1', () => {});
    db.run('ALTER TABLE webhooks ADD COLUMN signature_v2_key TEXT', () => {});
    db.run('ALTER TABLE webhooks ADD COLUMN signature_v2_enabled INTEGER NOT NULL DEFAULT 0', () => {});
    db.run("UPDATE users SET auth_provider = 'local' WHERE auth_provider IS NULL OR auth_provider = ''", () => {});
    db.run("UPDATE users SET plan_tier = 'free' WHERE plan_tier IS NULL OR plan_tier = ''", () => {});
    db.run("UPDATE users SET plan_status = 'active' WHERE plan_status IS NULL OR plan_status = ''", () => {});
    db.run(`UPDATE api_keys SET scopes = '${DEFAULT_API_KEY_SCOPES_STORAGE}' WHERE scopes IS NULL OR TRIM(scopes) = ''`, () => {});
    db.run("UPDATE api_keys SET hash_version = 1 WHERE hash_version IS NULL OR hash_version < 1", () => {});
    db.run("UPDATE webhooks SET message_locale = 'auto' WHERE message_locale IS NULL OR message_locale = ''", () => {});
    db.run("UPDATE webhooks SET secret_hash_version = 1 WHERE secret_hash_version IS NULL OR secret_hash_version < 1", () => {});
    db.run("UPDATE webhooks SET signature_v2_enabled = 0 WHERE signature_v2_enabled IS NULL", () => {});
    db.run("UPDATE webhooks SET signature_v2_enabled = 1 WHERE signature_v2_key IS NOT NULL AND TRIM(signature_v2_key) <> ''", () => {});
    db.run(
      "UPDATE webhooks SET events = 'link.created,link.updated,link.deleted,webhook.test' " +
      "WHERE events IS NULL OR TRIM(events) = '' OR LOWER(REPLACE(events, ' ', '')) = 'link.created'",
      () => {}
    );
  
  
    db.run("UPDATE users SET ui_lang = 'az' WHERE ui_lang IS NULL OR ui_lang = ''", () => {});
    db.run("UPDATE users SET ui_theme = 'light' WHERE ui_theme IS NULL OR ui_theme = ''", () => {});
    db.run('UPDATE users SET notify_report = 1 WHERE notify_report IS NULL', () => {});
    db.run('UPDATE users SET notify_limit = 1 WHERE notify_limit IS NULL', () => {});
    db.run('UPDATE users SET notify_disabled = 1 WHERE notify_disabled IS NULL', () => {});
  
    // Helpful indexes
    db.run('CREATE INDEX IF NOT EXISTS idx_reports_short ON reports(short)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_reports_short_created_at ON reports(short, created_at DESC)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_clicks_url_id ON clicks(url_id)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_urls_user_id ON urls(user_id)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_urls_user_created_at ON urls(user_id, created_at DESC)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_urls_domain_host ON urls(domain_host)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_custom_domains_user_id ON custom_domains(user_id)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_custom_domains_status ON custom_domains(status)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_user_sessions_last_seen ON user_sessions(last_seen_at)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_user_sessions_device_fp ON user_sessions(user_id, device_fingerprint)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)', () => {});
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)', () => {});
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id_hash ON users(google_id_hash)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan_tier, plan_status, pro_expires_at)', () => {});
  
    // One account per email identity. users.email stores random-IV ciphertext,
    // so the old `email UNIQUE` constraint never blocked duplicate plaintext
    // emails; email_hash is the real identity key and must be unique. Legacy
    // duplicate rows keep their data but lose email-keyed login: their
    // email_hash gets a unique suffix. The kept row prefers verified accounts,
    // then the oldest registration.
    db.all("SELECT email_hash FROM users WHERE email_hash IS NOT NULL AND email_hash != '' GROUP BY email_hash HAVING COUNT(*) > 1", (dupErr, dupRows) => {
      const createUsersEmailHashIndex = (attempt = 0) => {
        db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_hash ON users(email_hash) WHERE email_hash IS NOT NULL', (idxErr) => {
          if (!idxErr) return;
          if (attempt === 0) {
            // Another app instance may still be migrating duplicates (rolling
            // restart / parallel boots); retry once before giving up.
            setTimeout(createUsersEmailHashIndex, 2000, 1).unref();
          } else {
            console.error('[startup] users.email_hash unique index failed (will retry next boot):', idxErr.message);
          }
        });
      };
      if (dupErr || !Array.isArray(dupRows) || dupRows.length === 0) return createUsersEmailHashIndex();
      let pendingUsersDupes = dupRows.length;
      dupRows.forEach((dup) => {
        db.all('SELECT id, email_verified FROM users WHERE email_hash = ? ORDER BY email_verified DESC, id ASC', [dup.email_hash], (rowErr, rows) => {
          if (!rowErr && Array.isArray(rows) && rows.length > 1) {
            rows.slice(1).forEach((staleRow) => {
              db.run('UPDATE users SET email_hash = ? WHERE id = ?', [`${dup.email_hash}:dup:${staleRow.id}`, staleRow.id], () => {});
            });
          }
          if (--pendingUsersDupes === 0) createUsersEmailHashIndex();
        });
      });
    });
  
    // Same one-identity-per-email rule for admin accounts.
    db.all("SELECT email_hash FROM admin_users WHERE email_hash IS NOT NULL AND email_hash != '' GROUP BY email_hash HAVING COUNT(*) > 1", (adminDupErr, adminDupRows) => {
      const createAdminEmailHashIndex = (attempt = 0) => {
        db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_email_hash ON admin_users(email_hash) WHERE email_hash IS NOT NULL', (idxErr) => {
          if (!idxErr) return;
          if (attempt === 0) {
            setTimeout(createAdminEmailHashIndex, 2000, 1).unref();
          } else {
            console.error('[startup] admin_users.email_hash unique index failed (will retry next boot):', idxErr.message);
          }
        });
      };
      if (adminDupErr || !Array.isArray(adminDupRows) || adminDupRows.length === 0) return createAdminEmailHashIndex();
      let pendingAdminDupes = adminDupRows.length;
      adminDupRows.forEach((dup) => {
        db.all('SELECT id FROM admin_users WHERE email_hash = ? ORDER BY id ASC', [dup.email_hash], (rowErr, rows) => {
          if (!rowErr && Array.isArray(rows) && rows.length > 1) {
            rows.slice(1).forEach((staleRow) => {
              db.run('UPDATE admin_users SET email_hash = ? WHERE id = ?', [`${dup.email_hash}:dup:${staleRow.id}`, staleRow.id], () => {});
            });
          }
          if (--pendingAdminDupes === 0) createAdminEmailHashIndex();
        });
      });
    });
  
    db.run('CREATE INDEX IF NOT EXISTS idx_blocked_domains_domain ON blocked_domains(domain)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_api_keys_user_active ON api_keys(user_id, revoked_at)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_api_keys_user_created ON api_keys(user_id, created_at DESC)', () => {});
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_webhooks_user_active ON webhooks(user_id, is_active)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_webhooks_user_created ON webhooks(user_id, created_at DESC)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id, status, next_retry_at)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_user ON webhook_deliveries(user_id, created_at)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_user_sessions_user_seen ON user_sessions(user_id, is_revoked, last_seen_at DESC)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_api_idem_lookup ON api_idempotency_keys(user_id, endpoint, idempotency_hash)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_api_idem_expiry ON api_idempotency_keys(expires_at)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_api_usage_user_created ON api_usage_logs(user_id, created_at)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_api_usage_key_created ON api_usage_logs(api_key_id, created_at)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_api_usage_user_error ON api_usage_logs(user_id, error_type, created_at)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_api_usage_user_method ON api_usage_logs(user_id, method, created_at)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_subscription_audit_target ON subscription_audit(target_user_id, created_at)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type, outcome, created_at)', () => {});
    // Older databases created security_events with plain FKs (user_id/api_key_id) that
    // broke audit inserts once the referenced row disappeared. Normalize both to
    // ON DELETE SET NULL — guarded (only when actually needed) and race-safe across
    // concurrently booting instances; goes straight through pool.query so the db-shim
    // error hook does not spam ops alerts while it settles.
    const normalizeSecurityEventFk = (conname, column, refTable) => pool.query(
      'SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = $1 AND c.conname = $2',
      ['security_events', conname]
    ).then(({ rows }) => {
      const def = rows && rows[0] && rows[0].def ? String(rows[0].def) : '';
      if (/ON DELETE SET NULL/i.test(def)) return undefined;
      return pool.query('DO $$ BEGIN ALTER TABLE security_events DROP CONSTRAINT IF EXISTS ' + conname + '; BEGIN ALTER TABLE security_events ADD CONSTRAINT ' + conname + ' FOREIGN KEY (' + column + ') REFERENCES ' + refTable + '(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN NULL; END; END $$');
    }).catch((err) => {
      console.error('[migrate] security_events FK normalization skipped:', err && err.message);
    });
    normalizeSecurityEventFk('security_events_user_id_fkey', 'user_id', 'users');
    normalizeSecurityEventFk('security_events_api_key_id_fkey', 'api_key_id', 'api_keys');
  
    // Notifications
    db.run('ALTER TABLE notifications ADD COLUMN title_en TEXT', () => {});
    db.run('ALTER TABLE notifications ADD COLUMN body_en TEXT', () => {});
    db.run(`CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title_az TEXT,
      title_tr TEXT,
      title_en TEXT,
      body_az TEXT,
      body_tr TEXT,
      body_en TEXT,
      link_short TEXT,
      event_key TEXT,
      created_at TEXT,
      read_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
  
    db.run('CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_notifications_read_at ON notifications(read_at)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_notifications_user_created_at ON notifications(user_id, created_at DESC)', () => {});
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_user_event ON notifications(user_id, event_key)', () => {});
  
    // Durable history of every processed Polar webhook event so billing issues
    // ("I paid but did not get Pro") can be traced from the admin panel.
    // Table + index are chained and retried once: a transient lock/timeout on
    // the CREATE TABLE must not leave the index statement failing on a missing
    // relation.
    const createPolarEventsSchema = (attempt = 0) => {
      db.run(`CREATE TABLE IF NOT EXISTS polar_events (
        id SERIAL PRIMARY KEY,
        webhook_id TEXT,
        event_type TEXT,
        product_id TEXT,
        user_id INTEGER,
        outcome TEXT,
        detail TEXT,
        created_at TEXT
      )`, (tblErr) => {
        if (tblErr) {
          console.error('[startup] polar_events table creation failed:', tblErr.message);
          if (attempt === 0) {
            setTimeout(() => createPolarEventsSchema(1), 5000).unref();
          }
          return;
        }
        db.run('CREATE INDEX IF NOT EXISTS idx_polar_events_created ON polar_events(created_at DESC)', (idxErr) => {
          if (!idxErr) return;
          if (attempt === 0) {
            setTimeout(() => createPolarEventsSchema(1), 5000).unref();
          } else {
            console.error('[startup] polar_events index failed (will retry next boot):', idxErr.message);
          }
        });
      });
    };
    createPolarEventsSchema();
  
    db.run(`CREATE TABLE IF NOT EXISTS polar_processed_webhooks (
      webhook_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      processed_at TEXT NOT NULL
    )`, () => {});
  
    // Password reset tokens
    db.run(`CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
  
    const allTablesForRls = [
      'users', 'urls', 'reports', 'clicks', 'site_settings', 'admin_users', 
      'blocked_domains', 'admin_audit_log', 'admin_auth_audit', 'guest_limits',
      'custom_domains', 'user_sessions', 'api_keys', 'webhooks', 'webhook_deliveries',
      'subscription_audit', 'security_events', 'api_idempotency_keys', 'api_usage_logs',
      'notifications', 'password_resets', 'bot_users', 'bot_settings', 'bot_auth_codes'
    ];
    allTablesForRls.forEach(t => {
      db.run(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`, () => {});
    });
  
    // Bot integration tables
    db.run(`CREATE TABLE IF NOT EXISTS bot_users (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      platform_user_id TEXT NOT NULL,
      platform_username TEXT,
      user_id INTEGER NOT NULL,
      linked_at TEXT NOT NULL,
      UNIQUE(platform, platform_user_id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`, () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_bot_users_platform ON bot_users(platform, platform_user_id)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_bot_users_user_id ON bot_users(user_id)', () => {});
  
    db.run(`CREATE TABLE IF NOT EXISTS bot_settings (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      platform_user_id TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'en',
      UNIQUE(platform, platform_user_id)
    )`, () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_bot_settings_platform ON bot_settings(platform, platform_user_id)', () => {});
  
    db.run(`CREATE TABLE IF NOT EXISTS bot_auth_codes (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL,
      platform_user_id TEXT NOT NULL,
      platform_username TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`, () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_bot_auth_codes_code ON bot_auth_codes(code)', () => {});
  
  	  // Team workspaces (Pro-only): one workspace per Pro owner, members share
  	  // link creation through the same account; SSO connections bind a corporate
  	  // IdP to a workspace.
  	  //
  	  // These tables have foreign-key dependencies on each other (members,
  	  // invitations, sso_connections -> workspaces) so they must be created
  	  // sequentially.  PostgreSQL enforces FK existence at DDL time, and
  	  // db.run() is async, so parallel calls would race.
  	  db.run(`CREATE TABLE IF NOT EXISTS workspaces (
  	    id SERIAL PRIMARY KEY,
  	    name TEXT NOT NULL,
      owner_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(owner_user_id),
      FOREIGN KEY(owner_user_id) REFERENCES users(id)
    )`, () => {
      db.run(`CREATE TABLE IF NOT EXISTS workspace_members (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TEXT NOT NULL,
        UNIQUE(workspace_id, user_id),
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`, () => {
        db.run(`CREATE TABLE IF NOT EXISTS workspace_invitations (
          id SERIAL PRIMARY KEY,
          workspace_id INTEGER NOT NULL,
          email_encrypted TEXT NOT NULL,
          email_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'member',
          token_hash TEXT NOT NULL UNIQUE,
          invited_by_user_id INTEGER,
          expires_at TEXT NOT NULL,
          accepted_at TEXT,
          revoked_at TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        )`, () => {
          db.run(`CREATE TABLE IF NOT EXISTS sso_connections (
            id SERIAL PRIMARY KEY,
            workspace_id INTEGER NOT NULL,
            idp_entity_id TEXT NOT NULL,
            idp_sso_url TEXT NOT NULL,
            idp_certificate TEXT NOT NULL,
            metadata_xml TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT,
            UNIQUE(workspace_id),
            FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
          )`, () => {
            db.run('ALTER TABLE urls ADD COLUMN workspace_id INTEGER', () => {});
            db.run('CREATE INDEX IF NOT EXISTS idx_urls_workspace_id ON urls(workspace_id)', () => {});
            db.run('CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id ON workspace_members(user_id)', () => {});
            db.run('CREATE INDEX IF NOT EXISTS idx_workspace_invitations_hash ON workspace_invitations(email_hash)', () => {});
            db.run('ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY', () => {});
            db.run('ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY', () => {});
            db.run('ALTER TABLE workspace_invitations ENABLE ROW LEVEL SECURITY', () => {});
            db.run('ALTER TABLE sso_connections ENABLE ROW LEVEL SECURITY', () => {});
            db.run(`CREATE TABLE IF NOT EXISTS sso_replay_cache (
              assertion_id TEXT PRIMARY KEY,
              workspace_id INTEGER,
              expires_at TEXT NOT NULL,
              created_at TEXT NOT NULL
            )`, () => {
              db.run('CREATE INDEX IF NOT EXISTS idx_sso_replay_expires ON sso_replay_cache(expires_at)', () => {});
            });
          });
        });
      });
    });
  
    db.run('CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id)', () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token_hash)', () => {});
    db.run(
      "UPDATE users SET verification_expires_at = ? WHERE email_verified != 1 AND verification_code IS NOT NULL AND (verification_expires_at IS NULL OR TRIM(verification_expires_at) = '')",
      [buildVerificationExpiryIso(30)],
      () => {}
    );
  
    db.all('SELECT key, value FROM site_settings', [], (err, rows) => {
      if (err || !rows) return;
      rows.forEach((r) => {
        if (r && r.key) siteSettings[r.key] = r.value;
      });
    });
  
    refreshCustomDomainCache();
  
    // Seed the first admin user from env (only if table is empty)
    db.get('SELECT COUNT(*) AS cnt FROM admin_users', (err, row) => {
      if (err) return;
      if ((row && row.cnt) > 0) return;
      const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
      const password = (process.env.ADMIN_PASSWORD || '').toString();
      if (!email || !password) {
        console.warn('[admin] No admin users exist. Set ADMIN_EMAIL and ADMIN_PASSWORD to seed the first admin.');
        return;
      }
      bcrypt.hash(password, 12, (hashErr, hash) => {
        if (hashErr) return;
        const encryptedEmail = encryptAES256GCM(email);
        const emailHash = blindIndex(email);
        db.run(
          'INSERT INTO admin_users (email, email_hash, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
          [encryptedEmail, emailHash, hash, 'admin', new Date().toISOString()],
          () => {
          }
        );
      });
    });
  });
  
  db.all('SELECT id, email_hash, email FROM admin_users', (err, rows) => {
    if (err) return;
    for (const row of rows) {
      if (!row.email_hash && row.email) {
        const plainEmail = row.email.includes(':') ? decryptAES256GCM(row.email) : row.email;
        const newHash = blindIndex(plainEmail);
        const encrypted = row.email.includes(':') ? row.email : encryptAES256GCM(row.email);
        db.run('UPDATE admin_users SET email = ?, email_hash = ? WHERE id = ?', [encrypted, newHash, row.id]);
      }
    }
  });
}
module.exports = { ensureDbTables };

