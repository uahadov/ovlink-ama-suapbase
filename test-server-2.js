require('dotenv').config();
const http = require('http');
const express = require('express');
const app = require('./server');

// Override global error handler to capture exact error
app.use((err, req, res, next) => {
  console.error('[EXACT ERROR]', err ? err.stack : err);
  res.status(500).send('Server error.');
});

// Create server on different port to avoid conflict
const server = http.createServer(app).listen(4231, () => {
  // Use a cookie to simulate admin session
  // Wait, connect-pg-simple needs real session. Let's mock requireAdmin dynamically!
  const adminRoutes = require('./routes/admin');
  // I can't easily mock requireAdmin because it's inside the module.
  // Let's just create a new admin router and mount it!
  const db = require('./server').__test_db || { get(){}, all(){}, run(){} };
  // Wait, `server` module doesn't export `db`.
  console.log('Listening on 4231');
});
