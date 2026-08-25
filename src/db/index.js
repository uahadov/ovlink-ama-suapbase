const { pool } = require('./pool');
const { sendOpsAlert } = require('../lib/alerts');
const _sqlCache = new Map();
const _SQL_CACHE_MAX = 500;

const db = {
  convertSql(sql) {
    if (typeof sql !== 'string') return sql;
    
    // Check cache first
    const cached = _sqlCache.get(sql);
    if (cached !== undefined) return cached;
    
    let index = 1;
    let converted = sql.replace(/\?/g, () => `$${index++}`);
    converted = converted.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');
    
    converted = converted.replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP');
    converted = converted.replace(/datetime\(([^)]+)\)/gi, '$1::timestamp');
    
    converted = converted.replace(/ALTER TABLE (\w+) ADD COLUMN (\w+)/gi, 'ALTER TABLE $1 ADD COLUMN IF NOT EXISTS $2');
    
    if (converted.toUpperCase().includes('PRAGMA TABLE_INFO')) {
      const tableNameMatch = converted.match(/PRAGMA table_info\((\w+)\)/i);
      if (tableNameMatch) {
        const tableName = tableNameMatch[1];
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
          throw new Error('Invalid table name in PRAGMA table_info');
        }
        converted = `SELECT column_name AS name FROM information_schema.columns WHERE table_name = '${tableName}'`;
      }
    }
    
    if (converted.toUpperCase().includes('INSERT OR IGNORE')) {
      if (converted.toLowerCase().includes('site_settings')) {
        converted = converted.replace(/INSERT OR IGNORE INTO site_settings/gi, 'INSERT INTO site_settings')
                              .concat(' ON CONFLICT (key) DO NOTHING');
      } else if (converted.toLowerCase().includes('notifications')) {
        converted = converted.replace(/INSERT OR IGNORE INTO notifications/gi, 'INSERT INTO notifications')
                              .concat(' ON CONFLICT (user_id, event_key) DO NOTHING');
      } else if (converted.toLowerCase().includes('blocked_domains')) {
        converted = converted.replace(/INSERT OR IGNORE INTO blocked_domains/gi, 'INSERT INTO blocked_domains')
                              .concat(' ON CONFLICT (domain) DO NOTHING');
      } else {
        converted = converted.replace(/INSERT OR IGNORE INTO/gi, 'INSERT INTO');
      }
    }

    if (converted.toUpperCase().includes('INSERT OR REPLACE')) {
      if (converted.toLowerCase().includes('site_settings')) {
        converted = converted.replace(/INSERT OR REPLACE INTO site_settings/gi, 'INSERT INTO site_settings')
                              .concat(' ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value');
      } else {
        converted = converted.replace(/INSERT OR REPLACE INTO/gi, 'INSERT INTO');
      }
    }

    if (converted.toUpperCase().match(/^INSERT\s/i) && !converted.toUpperCase().includes('RETURNING')) {
      converted = converted + ' RETURNING *';
    }
    
    // Cache the result
    if (_sqlCache.size >= _SQL_CACHE_MAX) {
      const firstKey = _sqlCache.keys().next().value;
      _sqlCache.delete(firstKey);
    }
    _sqlCache.set(sql, converted);
    
    return converted;
  },

  _queue: [],
  _isSerializing: false,
  _isProcessingQueue: false,
  
  _processQueue() {
    if (this._queue.length === 0) {
      this._isProcessingQueue = false;
      return;
    }
    this._isProcessingQueue = true;
    const task = this._queue.shift();
    const pgSql = this.convertSql(task.sql);
    
      // Catch-all query execution
      pool.query(pgSql, task.params, (err, res) => {
        if (err) {
          console.error('[db error] Message:', err.message, '| SQL:', task.sql);
          sendOpsAlert('db_error:' + (err.code || err.message || '').toString().slice(0, 40), 'Database error', `${err.message}\nSQL: ${String(task.sql || '').slice(0, 300)}`);
        }
        
        try {
          if (err) {
            if (task.callback) task.callback(err);
          } else {
            if (task.type === 'get') {
              if (task.callback) task.callback(null, res.rows[0]);
            } else if (task.type === 'all') {
              if (task.callback) task.callback(null, res.rows);
            } else if (task.type === 'run') {
              const context = {
                lastID: res && res.rows && res.rows[0] ? res.rows[0].id : null,
                changes: res ? res.rowCount : 0
              };
              if (task.callback) task.callback.call(context, null);
            }
          }
        } finally {
          // Process next query
          this._processQueue();
        }
      });
  },

  get(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    if (this._isSerializing) {
      this._queue.push({ type: 'get', sql, params, callback });
    } else {
      const pgSql = this.convertSql(sql);
      pool.query(pgSql, params, (err, res) => {
        if (err) return callback ? callback(err) : null;
        if (callback) callback(null, res.rows[0]);
      });
    }
  },

  all(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    if (this._isSerializing) {
      this._queue.push({ type: 'all', sql, params, callback });
    } else {
      const pgSql = this.convertSql(sql);
      pool.query(pgSql, params, (err, res) => {
        if (err) return callback ? callback(err) : null;
        if (callback) callback(null, res.rows);
      });
    }
  },

  run(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    if (this._isSerializing) {
      this._queue.push({ type: 'run', sql, params, callback });
    } else {
      const pgSql = this.convertSql(sql);
      pool.query(pgSql, params, function(err, res) {
        if (err) return callback ? callback(err) : null;
        const context = {
          lastID: res && res.rows && res.rows[0] ? res.rows[0].id : null,
          changes: res ? res.rowCount : 0
        };
        if (callback) {
          callback.call(context, null);
        }
      });
    }
  },

  serialize(callback) {
    this._isSerializing = true;
    try {
      if (typeof callback === 'function') callback();
    } finally {
      this._isSerializing = false;
    }
    if (!this._isProcessingQueue) {
      this._processQueue();
    }
  }
};
module.exports = { db };
