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
module.exports = { dbRunAsync, dbGetAsync, dbAllAsync };
