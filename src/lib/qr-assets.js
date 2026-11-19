const QRCode = require('qrcode');

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const PRINT_SIZES = Object.freeze([256, 512, 1024, 2048]);
const VALID_ECC_LEVELS = Object.freeze(['M', 'Q', 'H']);
const VALID_FORMATS = Object.freeze(['svg', 'png']);
const MIN_QUIET_ZONE = 4;
const MAX_QUIET_ZONE = 12;
const MIN_CONTRAST_RATIO = 3.0;
const RECOMMENDED_PRINT_CONTRAST = 4.5;

const LOGO_SAFE_ZONE = Object.freeze({
  max_area_ratio: 0.2,
  min_ecc: 'H',
  min_quiet_zone_modules: MIN_QUIET_ZONE,
});

const LIFECYCLE_NOTICES = {
  soft_deleted: {
    az: 'QR kod deaktiv edildi və yeni skanları dayandırıldı. Keçmiş skan statistikası qorunur, bağlı qısa link isə işləməyə davam edir.',
    tr: 'QR kodu devre dışı bırakıldı ve yeni taramalar durduruldu. Geçmiş tarama istatistikleri korunur, bağlı kısa bağlantı çalışmaya devam eder.',
    en: 'QR code was deactivated and no longer redirects scans. Historical scan metrics remain preserved and the underlying short link stays active.',
  },
  pro_expired: {
    az: 'Pro plan bitdikdə mövcud QR kodlar silinmir, çap olunmuş /q/ keçidləri işləməyə davam edir və tarixi skan rəqəmləri qorunur.',
    tr: 'Pro plan sona erdiğinde mevcut QR kodları silinmez, basılı /q/ bağlantıları çalışmaya devam eder ve geçmiş tarama verileri korunur.',
    en: 'When a Pro subscription expires, existing QR assets are not deleted, printed /q/ scans continue to redirect, and historical scan counts remain preserved.',
  },
};

function normalizeLang(lang) {
  const raw = String(lang || 'az').trim().toLowerCase().slice(0, 2);
  if (raw === 'tr' || raw === 'en') return raw;
  return 'az';
}

function parseHexColor(hex) {
  const raw = String(hex == null ? '' : hex).trim();
  if (!HEX_COLOR_RE.test(raw)) return null;
  let expanded = raw.slice(1).toLowerCase();
  if (expanded.length === 3) {
    expanded = expanded
      .split('')
      .map((ch) => ch + ch)
      .join('');
  }
  const intVal = Number.parseInt(expanded, 16);
  return {
    normalized: `#${expanded}`,
    r: (intVal >> 16) & 255,
    g: (intVal >> 8) & 255,
    b: intVal & 255,
  };
}

function srgbChannelToLinear(channel) {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance(rgb) {
  const r = srgbChannelToLinear(rgb.r);
  const g = srgbChannelToLinear(rgb.g);
  const b = srgbChannelToLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function evaluateQrContrast(colorDark, colorLight, lang = 'az') {
  const dark = parseHexColor(colorDark);
  const light = parseHexColor(colorLight);
  if (!dark || !light) {
    return {
      valid: false,
      print_ready: false,
      inverted: false,
      contrast_ratio: 0,
      code: 'invalid_color',
      message: 'Invalid hex color format.',
    };
  }

  const lumDark = relativeLuminance(dark);
  const lumLight = relativeLuminance(light);
  const inverted = lumDark >= lumLight;
  const lighter = Math.max(lumDark, lumLight);
  const darker = Math.min(lumDark, lumLight);
  const ratio = Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
  const loc = normalizeLang(lang);

  if (inverted) {
    const messages = {
      az: 'QR kodun ön rəngi (tünd) arxa fondan daha tünd olmalıdır, əks halda kamera skan etməyə bilər.',
      tr: 'QR kodun ön rengi arka plandan daha koyu olmalıdır, aksi halde kamera tarayamayabilir.',
      en: 'QR foreground color must be darker than the background color for reliable camera scanning.',
    };
    return {
      valid: false,
      print_ready: false,
      inverted: true,
      contrast_ratio: ratio,
      dark_luminance: Number(lumDark.toFixed(4)),
      light_luminance: Number(lumLight.toFixed(4)),
      code: 'inverted_contrast',
      message: messages[loc],
    };
  }

  if (ratio < MIN_CONTRAST_RATIO) {
    const messages = {
      az: `Rəng kontrastı çox aşağıdır (${ratio}:1). Etibarlı skan üçün minimum ${MIN_CONTRAST_RATIO}:1 lazımdır.`,
      tr: `Renk kontrastı çok düşük (${ratio}:1). Güvenilir tarama için en az ${MIN_CONTRAST_RATIO}:1 gereklidir.`,
      en: `Color contrast ratio is too low (${ratio}:1). Minimum ${MIN_CONTRAST_RATIO}:1 is required for reliable scanning.`,
    };
    return {
      valid: false,
      print_ready: false,
      inverted: false,
      contrast_ratio: ratio,
      dark_luminance: Number(lumDark.toFixed(4)),
      light_luminance: Number(lumLight.toFixed(4)),
      code: 'low_contrast',
      message: messages[loc],
    };
  }

  return {
    valid: true,
    print_ready: ratio >= RECOMMENDED_PRINT_CONTRAST,
    inverted: false,
    contrast_ratio: ratio,
    dark_luminance: Number(lumDark.toFixed(4)),
    light_luminance: Number(lumLight.toFixed(4)),
    code: ratio >= RECOMMENDED_PRINT_CONTRAST ? 'print_ready' : 'acceptable_digital',
    message: null,
  };
}

function normalizeExportOptions(query = {}) {
  const format = String(query.format || 'svg').trim().toLowerCase();
  if (!VALID_FORMATS.includes(format)) {
    return { error: 'Format must be svg or png.', code: 'invalid_format' };
  }

  const rawSize = query.size == null || query.size === '' ? 1024 : Number.parseInt(query.size, 10);
  if (!PRINT_SIZES.includes(rawSize)) {
    return {
      error: `Size must be one of: ${PRINT_SIZES.join(', ')} px.`,
      code: 'invalid_size',
    };
  }

  const ecc = String(query.ecc || 'H').trim().toUpperCase();
  if (!VALID_ECC_LEVELS.includes(ecc)) {
    return {
      error: `Error correction level must be one of: ${VALID_ECC_LEVELS.join(', ')}.`,
      code: 'invalid_ecc',
    };
  }

  const rawMargin = query.margin == null || query.margin === '' ? MIN_QUIET_ZONE : Number.parseInt(query.margin, 10);
  if (!Number.isInteger(rawMargin) || rawMargin < MIN_QUIET_ZONE || rawMargin > MAX_QUIET_ZONE) {
    return {
      error: `Quiet zone margin must be between ${MIN_QUIET_ZONE} and ${MAX_QUIET_ZONE} modules.`,
      code: 'invalid_margin',
    };
  }

  return {
    format,
    size: rawSize,
    ecc,
    margin: rawMargin,
  };
}

async function renderPrintQr({ url, format = 'svg', size = 1024, ecc = 'H', margin = MIN_QUIET_ZONE, colorDark = '#000000', colorLight = '#ffffff' }) {
  const targetUrl = String(url || '').trim();
  if (!targetUrl) {
    throw new Error('QR target URL is required');
  }
  const options = {
    width: size,
    margin,
    errorCorrectionLevel: ecc,
    color: {
      dark: colorDark,
      light: colorLight,
    },
  };

  if (format === 'svg') {
    const svg = await QRCode.toString(targetUrl, { ...options, type: 'svg' });
    return {
      contentType: 'image/svg+xml; charset=utf-8',
      body: svg,
      ext: 'svg',
      spec: {
        format: 'svg',
        size,
        ecc,
        quiet_zone_modules: margin,
        logo_safe_zone: LOGO_SAFE_ZONE,
      },
    };
  }

  const pngBuffer = await QRCode.toBuffer(targetUrl, { ...options, type: 'png' });
  return {
    contentType: 'image/png',
    body: pngBuffer,
    ext: 'png',
    spec: {
      format: 'png',
      size,
      ecc,
      quiet_zone_modules: margin,
      logo_safe_zone: LOGO_SAFE_ZONE,
    },
  };
}

function buildLifecycleNotice(event, lang = 'az') {
  const bucket = LIFECYCLE_NOTICES[event];
  if (!bucket) return '';
  return bucket[normalizeLang(lang)] || bucket.az;
}

function buildQrMetricsPayload({ qrRow, dailyRows = [], linkClicks = 0, scanUrl = null, campaign = null, lang = 'az' }) {
  const totalScans = Number(qrRow && qrRow.scans) || 0;
  const totalClicks = Number(linkClicks) || 0;
  return {
    qr: {
      id: qrRow.id,
      slug: qrRow.slug,
      short: qrRow.short,
      label: qrRow.label || '',
      scan_url: scanUrl,
      destination_url: qrRow.destination_url || null,
      active: !qrRow.deleted_at,
    },
    campaign: campaign || null,
    metrics: {
      qr_scans_total: totalScans,
      qr_scans_daily: (dailyRows || []).map((row) => ({
        day: row.day,
        scans: Number(row.scans) || 0,
      })),
      link_clicks_total: totalClicks,
    },
    methodology: {
      metrics_separated: true,
      qr_scans_source: 'qr_codes / qr_scan_daily (/q/:slug endpoint)',
      link_clicks_source: 'urls.clicks (canonical /:short redirect pipeline)',
      claims_sales_conversion: false,
      note: 'QR scans count /q/:slug redirects separately from canonical /:short link clicks and do not represent confirmed sales conversions.',
    },
    lifecycle_policy: {
      pro_expiry_preserves_assets: true,
      soft_delete_preserves_history: true,
      pro_expiry_notice: buildLifecycleNotice('pro_expired', lang),
    },
  };
}

module.exports = {
  PRINT_SIZES,
  VALID_ECC_LEVELS,
  VALID_FORMATS,
  MIN_QUIET_ZONE,
  MAX_QUIET_ZONE,
  MIN_CONTRAST_RATIO,
  RECOMMENDED_PRINT_CONTRAST,
  LOGO_SAFE_ZONE,
  parseHexColor,
  relativeLuminance,
  evaluateQrContrast,
  normalizeExportOptions,
  renderPrintQr,
  buildLifecycleNotice,
  buildQrMetricsPayload,
};
