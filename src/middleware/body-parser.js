const express = require('express');

const jsonParser = express.json({
  limit: '100kb',
  verify: (req, _res, buf) => { req.rawBody = buf; }
});

const urlencodedParser = express.urlencoded({
  extended: false,
  limit: '100kb',
  parameterLimit: 100
});

module.exports = { jsonParser, urlencodedParser };
