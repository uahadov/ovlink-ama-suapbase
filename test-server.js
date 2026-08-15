const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');
code = code.replace("console.error('[error-handler]', err && (err.stack || err.message || err));", "console.error('[EXACT ERROR]', err ? err.stack : err);");
code = code.replace("app.use('/admin', createAdminRouter", "app.use((req,res,next)=>{ req.session = { adminUserId: 1, adminEmail: 'test@test.com', adminRole: 'admin' }; next(); }); app.use('/admin', createAdminRouter");
fs.writeFileSync('server-test.js', code);

const http = require('http');
const app = require('./server-test');
const server = http.createServer(app).listen(4231, () => {
  fetch('http://127.0.0.1:4231/admin/links')
    .then(r => r.text())
    .then(t => {
      console.log('RESPONSE:', t.substring(0, 200));
      server.close();
      process.exit(0);
    })
    .catch(e => {
      console.log('FETCH ERR:', e);
      server.close();
      process.exit(1);
    });
});
