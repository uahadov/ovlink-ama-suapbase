const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'public', 'lang.js');
let src = fs.readFileSync(filePath, 'utf8');

function extractLangBlock(source, lang) {
  let re;
  if (lang === 'az') {
    re = /(\n\s*az\s*:\s*\{)([\s\S]*?)(\n\s*\}\s*,)/m;
  } else if (lang === 'tr') {
    re = /(\n\s*tr\s*:\s*\{)([\s\S]*?)(\n\s*\}\s*\n\s*\};)/m;
  } else {
    throw new Error('Unsupported lang: ' + lang);
  }

  const m = re.exec(source);
  if (!m) throw new Error(`Could not find lang block for ${lang}`);
  return { re, fullMatch: m[0], head: m[1], body: m[2], tail: m[3], index: m.index };
}

function replaceLangBlock(source, lang, newBody) {
  const block = extractLangBlock(source, lang);
  const replacement = block.head + newBody + block.tail;
  return source.slice(0, block.index) + replacement + source.slice(block.index + block.fullMatch.length);
}

function setKey(blockBody, key, value) {
  const esc = value.replace(/\\/g, '\\\\').replace(/\"/g, '\\"');
  const re = new RegExp(`(^\\s*${key}\\s*:\\s*\")([^\"]*)(\"\\s*,\\s*$)`, 'm');
  if (!re.test(blockBody)) {
    throw new Error(`Key not found: ${key}`);
  }
  return blockBody.replace(re, `$1${esc}$3`);
}

function hasKey(blockBody, key) {
  const re = new RegExp(`^\\s*${key}\\s*:`, 'm');
  return re.test(blockBody);
}

function insertAfterKey(blockBody, afterKey, linesToInsert) {
  const re = new RegExp(`(^\\s*${afterKey}\\s*:\\s*\"[^\"]*\"\\s*,\\s*$)`, 'm');
  const m = re.exec(blockBody);
  if (!m) throw new Error(`After-key not found: ${afterKey}`);
  const insertion = linesToInsert.join('\n');
  return blockBody.replace(re, `$1\n${insertion}`);
}

function patchLanguage(lang, updates, inserts) {
  const block = extractLangBlock(src, lang);
  let body = block.body;

  for (const [k, v] of Object.entries(updates)) {
    if (hasKey(body, k)) body = setKey(body, k, v);
  }

  const insertLines = [];
  for (const [k, v] of inserts) {
    if (!hasKey(body, k)) {
      const esc = v.replace(/\\/g, '\\\\').replace(/\"/g, '\\"');
      insertLines.push(`        ${k}: "${esc}",`);
    }
  }
  if (insertLines.length) {
    body = insertAfterKey(body, 'privacy_data_collection_text', insertLines);
  }

  src = replaceLangBlock(src, lang, body);
}

patchLanguage('az', {
  privacy_data_collection_text:
    "Ovlink xidmətinin işləməsi, statistika və təhlükəsizlik üçün texniki və hesab məlumatlarını toplaya bilər: e-poçt, şifrə hash-i, yaradılan link məlumatları, klik vaxtı, IP, brauzer/OS və təxmini ölkə/şəhər, şikayət səbəbi və qeydlər, eləcə də admin audit qeydləri.",
  privacy_cookies_text:
    "Kukilər (cookies) seans (login) idarəetməsi və CSRF müdafiəsi üçün istifadə olunur. Dil seçimi və tema kimi istifadəçi seçimləri brauzer yaddaşında saxlanıla bilər. Həssas məlumatlar localStorage/sessionStorage-da saxlanmır.",
  privacy_third_party_title: "3-cü tərəf xidmətlər",
  privacy_third_party_text:
    "E-poçt göndərilməsi üçün üçüncü tərəf e-poçt provayderindən istifadə oluna bilər. Bəzi statik fayllar CDN-lərdən yüklənə bilər (bu zaman IP və brauzer məlumatı həmin xidmətlər tərəfindən emal oluna bilər). Məlumatlar satılmır; yalnız xidmətin işləməsi üçün zəruri olduqda paylaşılır.",
  privacy_disclaimer_title: "Təhlükəsizlik və məsuliyyət",
  privacy_disclaimer_text:
    "Ovlink məlumatların təhlükəsizliyi üçün müasir təhlükəsizlik tədbirlərindən istifadə edir. Lakin internetin təbiəti gereyi heç bir sistem 100% təhlükəsiz deyil.",
}, [
  ['privacy_account_title', 'Hesab məlumatları'],
  ['privacy_account_text', 'Qeydiyyat zamanı e-poçt ünvanınızı saxlayırıq. Şifrələr açıq şəkildə saxlanılmır (hash edilir). E-poçt doğrulaması üçün təsdiqləmə kodu müvəqqəti saxlanıla bilər. Sui-istifadə hallarında hesablar müvəqqəti və ya daimi bloklana bilər.'],
  ['privacy_analytics_title', 'Link və klik statistikası'],
  ['privacy_analytics_text', 'Yaradılan linklər (qısa kod, hədəf URL, yaradılma tarixi və limit/bitmə ayarları) saxlanılır. Linkə daxil olduqda klik statistikası üçün klik vaxtı, IP və cihaz/brauzer məlumatı, təxmini ölkə/şəhər qeydə alına bilər.'],
  ['privacy_moderation_title', 'Şikayətlər və moderasiya'],
  ['privacy_moderation_text', 'İstifadəçilər linkləri şikayət edə bilər (səbəb və istəyə bağlı qeyd). Təhlükəsizlik üçün adminlər linkləri deaktiv edə, domenləri bloklaya və istifadəçiləri məhdudlaşdıra bilər. Bu əməliyyatlar audit qeydlərində saxlanıla bilər.'],
  ['privacy_retention_title', 'Saxlama müddəti və hüquqlarınız'],
  ['privacy_retention_text', 'Məlumatlar xidmətin işləməsi, təhlükəsizlik və hüquqi öhdəliklər üçün lazım olduğu müddətcə saxlanıla bilər. Hesab və ya linklərinizlə bağlı sorğular üçün bizimlə əlaqə saxlaya bilərsiniz.'],
]);

patchLanguage('tr', {
  privacy_data_collection_text:
    "Ovlink'in çalışması, istatistik ve güvenlik için teknik ve hesap verilerini toplayabilir: e-posta, sifre hash'i, olusturulan link verileri, tiklama zamani, IP, tarayici/OS ve yaklasik ulke/sehir, bildirim sebebi ve notlar, ayrica admin audit kayitlari.",
  privacy_cookies_text:
    "Cerezler (cookies) oturum (login) yonetimi ve CSRF korumasi icin kullanilir. Dil ve tema gibi tercihler tarayici hafizasinda saklanabilir. Hassas veriler localStorage/sessionStorage icinde tutulmaz.",
  privacy_third_party_title: "3. taraf hizmetler",
  privacy_third_party_text:
    "E-posta gonderimi icin 3. taraf e-posta saglayicisi kullanilabilir. Bazi statik dosyalar CDN uzerinden yuklenebilir (bu durumda IP ve tarayici bilgileri ilgili hizmetlerce islenebilir). Veriler satilmaz; sadece hizmetin calismasi icin gerekli oldugunda paylasilir.",
  privacy_disclaimer_title: "Guvenlik ve sorumluluk",
  privacy_disclaimer_text:
    "Ovlink verilerin guvenligi icin modern guvenlik onlemleri kullanir. Ancak internetin dogasi geregi hicbir sistem %100 guvenli degildir.",
}, [
  ['privacy_account_title', 'Hesap bilgileri'],
  ['privacy_account_text', 'Kayit sirasinda e-posta adresinizi saklariz. Sifreler acik sekilde saklanmaz (hashlenir). E-posta dogrulamasi icin dogrulama kodu gecici olarak tutulabilir. Kotu kullanimi onlemek icin hesaplar gecici veya kalici engellenebilir.'],
  ['privacy_analytics_title', 'Link ve tiklama istatistikleri'],
  ['privacy_analytics_text', 'Olusturulan linkler (kisa kod, hedef URL, olusturma tarihi ve limit/sure ayarlari) saklanir. Linke gidildiginde istatistik ve guvenlik amaciyla tiklama zamani, IP, tarayici/cihaz bilgisi ve yaklasik ulke/sehir kaydedilebilir.'],
  ['privacy_moderation_title', 'Bildirimler ve moderasyon'],
  ['privacy_moderation_text', 'Kullanicilar linkleri bildirebilir (sebep ve istege bagli not). Guvenlik icin adminler linkleri devre disi birakabilir, domain engelleyebilir ve kullanicilari sinirlayabilir. Bu islemler audit kayitlarinda tutulabilir.'],
  ['privacy_retention_title', 'Saklama suresi ve haklariniz'],
  ['privacy_retention_text', 'Veriler, hizmetin calismasi, guvenlik ve hukuki yukumlulukler icin gerekli oldugu surece saklanabilir. Hesabiniz veya linklerinizle ilgili talepler icin bizimle iletisime gecebilirsiniz.'],
]);

fs.writeFileSync(filePath, src, 'utf8');
console.log('Patched privacy translations in public/lang.js');
