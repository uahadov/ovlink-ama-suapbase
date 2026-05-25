const serverless = require('serverless-http');
const path = require('path');

// server.js { app, helpers } objesi export ediyor,
// sadece Express app'ini alıyoruz
const serverModule = require('../../server.js');
const app = serverModule && serverModule.app ? serverModule.app : serverModule;

// Binary content types for image files (logo, favicon, etc.)
// serverless-http v4+ handles binary via the 'binary' option.
// The response must be base64-encoded with isBase64Encoded=true for
// API Gateway / Lambda to deliver raw bytes to the client.
exports.handler = serverless(app, {
  binary: [
    'image/png',
    'image/webp',
    'image/x-icon',
    'image/vnd.microsoft.icon',
    'image/jpeg',
    'image/svg+xml',
    'application/octet-stream',
    'font/woff',
    'font/woff2',
    'font/ttf',
    'application/font-woff',
    'application/font-woff2',
  ],
});
