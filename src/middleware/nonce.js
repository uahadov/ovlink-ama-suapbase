const crypto = require('crypto');

function nonceMiddleware(req, res, next) {
  res.locals.nonce = crypto.randomBytes(16).toString('base64');
  next();
}

module.exports = nonceMiddleware;
