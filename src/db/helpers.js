const { pool } = require('./pool');
const { db } = require('./index');
function dbGetAsync(sql, params = []) {
  const pgSql = db.convertSql(sql);
  return pool.query(pgSql, params).then(res => res.rows[0]).catch(err => Promise.reject(err));
}

function dbAllAsync(sql, params = []) {
  const pgSql = db.convertSql(sql);
  return pool.query(pgSql, params).then(res => res.rows).catch(err => Promise.reject(err));
}

function dbRunAsync(sql, params = []) {
  const pgSql = db.convertSql(sql);
  return pool.query(pgSql, params).then(res => ({
    changes: res.rowCount || 0,
    lastID: res.rows && res.rows[0] ? res.rows[0].id : 0
  })).catch(err => Promise.reject(err));
}

async function withTransaction(fn) {
  if (pool && typeof pool.connect === 'function') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tx = {
        query: (sql, params = []) => client.query(db.convertSql(sql), params),
        run: (sql, params = []) => client.query(db.convertSql(sql), params).then(res => ({
          changes: res.rowCount || 0,
          lastID: res.rows && res.rows[0] ? res.rows[0].id : 0
        })),
        get: (sql, params = []) => client.query(db.convertSql(sql), params).then(res => res.rows[0]),
        all: (sql, params = []) => client.query(db.convertSql(sql), params).then(res => res.rows),
      };
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }

  await dbRunAsync('BEGIN');
  try {
    const tx = {
      query: (sql, params) => dbRunAsync(sql, params),
      run: (sql, params) => dbRunAsync(sql, params),
      get: (sql, params) => dbGetAsync(sql, params),
      all: (sql, params) => dbAllAsync(sql, params),
    };
    const result = await fn(tx);
    await dbRunAsync('COMMIT');
    return result;
  } catch (err) {
    try { await dbRunAsync('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

module.exports = { dbRunAsync, dbGetAsync, dbAllAsync, withTransaction };
