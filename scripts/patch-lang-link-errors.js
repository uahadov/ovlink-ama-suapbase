const fs = require('fs');

const p = 'C:/Users/exlorin/Desktop/öldü mence/public/lang.js';
let s = fs.readFileSync(p, 'utf8');

if (!s.includes('error_disabled_title')) {
  s = s.replace(
    /error_expired_msg:\s*"Bu linkin istifadə müddəti bitib\.",\s*(\r?\n)/,
    (m, nl) =>
      m +
      `        error_disabled_title: "Link deaktiv edilib",${nl}` +
      `        error_disabled_msg: "Bu link admin tərəfindən deaktiv edilib və təhlükəsizlik səbəbi ilə açıla bilmir.",${nl}` +
      `        error_disabled_reason: "Səbəb",${nl}` +
      `        error_blocked_title: "Bloklandı",${nl}` +
      `        error_blocked_msg: "Bu hədəf domeni bloklanıb.",${nl}`,
  );

  s = s.replace(
    /error_expired_msg:\s*"Bu linkin kullanım süresi dolmuştur\.",\s*(\r?\n)/,
    (m, nl) =>
      m +
      `        error_disabled_title: "Link devre dışı",${nl}` +
      `        error_disabled_msg: "Bu link yönetici tarafından devre dışı bırakılmıştır.",${nl}` +
      `        error_disabled_reason: "Sebep",${nl}` +
      `        error_blocked_title: "Engellendi",${nl}` +
      `        error_blocked_msg: "Bu hedef alan adı engellenmiştir.",${nl}`,
  );
}

fs.writeFileSync(p, s, 'utf8');
console.log('Added disabled/blocked link translations');
