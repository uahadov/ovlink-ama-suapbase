const serverless = require('serverless-http');

// server.js { app, helpers } objesi export ediyor,
// sadece Express app'ini alıyoruz
const serverModule = require('../../server.js');
const app = serverModule && serverModule.app ? serverModule.app : serverModule;

exports.handler = serverless(app);
