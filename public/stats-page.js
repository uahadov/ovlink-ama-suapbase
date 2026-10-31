// Stats detail page logic (extracted from views/stats-page.ejs in W4.4).
// Configuration arrives from data-* attributes on <body>; the one-release inline
// fallback (STATS_PAGE_INLINE_JS=1) sets window.__OVLINK_STATS_PAGE__ instead.
(function () {
  const inlineCfg = (typeof window !== 'undefined' && window.__OVLINK_STATS_PAGE__) || {};
  const bodyCfg = (document.body && document.body.dataset) || {};
  const shortCode = typeof inlineCfg.shortCode !== 'undefined' ? inlineCfg.shortCode : (bodyCfg.shortCode || '');
  const essentialMarker = typeof inlineCfg.essentialMarker !== 'undefined' ? inlineCfg.essentialMarker : (bodyCfg.essentialMarker || '');


let analyticsRawData = null;
let currentRangeFilter = 'all'; // '24h' | '7d' | '30d' | 'all'
let currentGranularity = 'daily'; // 'hourly' | 'daily'
let currentChartType = 'line';   // 'line' | 'bar'
let currentTechTab = 'os';        // 'os' | 'browsers'
let timeChartInstance = null;

function t(key) {
  const lang = typeof currentLang === 'string' ? currentLang : 'az';
  if (typeof translations !== 'undefined' && translations[lang] && translations[lang][key]) {
    return translations[lang][key];
  }
  return key;
}

// Escapes values that are interpolated into the few HTML template strings
// below (country/city/OS labels originate from request headers and the
// User-Agent, which are attacker-controlled).
function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mapBucketLabel(value) {
  return value === essentialMarker ? t('stats_private_bucket') || 'Essential' : (value || 'Unknown');
}

// Country name resolution helper
const ISO_COUNTRIES = {
  'AZ': 'Azerbaijan', 'TR': 'Türkiye', 'US': 'United States', 'GB': 'United Kingdom',
  'DE': 'Germany', 'FR': 'France', 'IT': 'Italy', 'ES': 'Spain', 'RU': 'Russia',
  'CA': 'Canada', 'AU': 'Australia', 'BR': 'Brazil', 'NL': 'Netherlands', 'PL': 'Poland',
  'UA': 'Ukraine', 'IN': 'India', 'JP': 'Japan', 'KR': 'South Korea', 'CN': 'China',
  'GE': 'Georgia', 'KZ': 'Kazakhstan', 'UZ': 'Uzbekistan', 'IR': 'Iran', 'IQ': 'Iraq'
};

function resolveCountryName(code) {
  if (!code || code === essentialMarker) return mapBucketLabel(code);
  const upper = code.toUpperCase();
  return ISO_COUNTRIES[upper] || upper;
}

// High-res Unicode Flag Emoji Generator from ISO 3166-1 alpha-2 code
function getCountryFlag(code) {
  if (!code || typeof code !== 'string' || code.length !== 2 || code === essentialMarker) return '🌐';
  const upper = code.toUpperCase();
  const c0 = upper.charCodeAt(0);
  const c1 = upper.charCodeAt(1);
  if (c0 < 65 || c0 > 90 || c1 < 65 || c1 > 90) return '🌐';
  return String.fromCodePoint(127397 + c0, 127397 + c1);
}

// Technology Icon Resolver
function getTechIcon(name) {
  const lower = (name || '').toLowerCase();
  if (lower.includes('win')) return 'fa-brands fa-windows';
  if (lower.includes('mac') || lower.includes('ios') || lower.includes('iphone') || lower.includes('ipad') || lower.includes('apple')) return 'fa-brands fa-apple';
  if (lower.includes('android')) return 'fa-brands fa-android';
  if (lower.includes('linux') || lower.includes('ubuntu')) return 'fa-brands fa-linux';
  if (lower.includes('chrome')) return 'fa-brands fa-chrome';
  if (lower.includes('safari')) return 'fa-brands fa-safari';
  if (lower.includes('firefox')) return 'fa-brands fa-firefox';
  if (lower.includes('edge')) return 'fa-brands fa-edge';
  if (lower.includes('opera')) return 'fa-brands fa-opera';
  return 'fa-solid fa-laptop-code';
}

// Filters clicks by selected range (plus the active saved-segment buckets)
function getFilteredClicks() {
  if (!analyticsRawData || !Array.isArray(analyticsRawData.raw_clicks)) {
    return [];
  }
  const all = analyticsRawData.raw_clicks;
  const now = Date.now();
  let cutoffMs = 0;
  if (currentRangeFilter === '24h') {
    cutoffMs = now - (24 * 3600 * 1000);
  } else if (currentRangeFilter === '7d') {
    cutoffMs = now - (7 * 24 * 3600 * 1000);
  } else if (currentRangeFilter === '30d') {
    cutoffMs = now - (30 * 24 * 3600 * 1000);
  }

  const ranged = cutoffMs > 0
    ? all.filter(c => {
        const t = new Date(c.time).getTime();
        return Number.isFinite(t) && t >= cutoffMs;
      })
    : all;

  return applySegmentFilters(ranged);
}

// Saved segments narrow the already loaded slice (a "view preset"): the
// server-computed KPIs stay the authority for totals.
let segmentFilter = null;

function applySegmentFilters(clicks) {
  const f = segmentFilter;
  if (!f) return clicks;
  return clicks.filter((click) => {
    if (f.device && (click.device_type || '') !== f.device) return false;
    if (f.source && (click.source || '') !== f.source) return false;
    if (f.country && (click.country || '') !== f.country) return false;
    if (f.variant && (click.variant || '') !== f.variant) return false;
    return true;
  });
}

// Date formatting helpers
function getLocalDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getLocalHourKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  return `${y}-${m}-${d}-${h}`;
}

function formatRelativeTime(iso) {
  const d = new Date(iso);
  const now = Date.now();
  const diffMs = now - d.getTime();
  if (diffMs < 0) return t('stats_today') || 'Today';
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  const lang = typeof currentLang === 'string' ? currentLang : 'az';
  if (diffSec < 60) return lang === 'az' ? 'Az əvvəl' : (lang === 'tr' ? 'Az önce' : 'Just now');
  if (diffMin < 60) return `${diffMin} ${lang === 'az' ? 'dəq əvvəl' : (lang === 'tr' ? 'dk önce' : 'min ago')}`;
  if (diffHour < 24) return `${diffHour} ${lang === 'az' ? 'saat əvvəl' : (lang === 'tr' ? 'saat önce' : 'hours ago')}`;
  if (diffDay < 7) return `${diffDay} ${lang === 'az' ? 'gün əvvəl' : (lang === 'tr' ? 'gün önce' : 'days ago')}`;
  return d.toLocaleDateString(lang === 'az' ? 'az' : (lang === 'tr' ? 'tr' : 'en'), { month: 'short', day: 'numeric' });
}

// Builds aggregated stats object from filtered clicks
function computeStatsFromClicks(clicks) {
  const stats = {
    total_clicks: clicks.length,
    browsers: {},
    os: {},
    countries: {}
  };

  clicks.forEach(click => {
    const browser = click.browser || 'Unknown';
    const os = click.os || 'Unknown';
    const country = click.country || 'Unknown';

    stats.browsers[browser] = (stats.browsers[browser] || 0) + 1;
    stats.os[os] = (stats.os[os] || 0) + 1;
    stats.countries[country] = (stats.countries[country] || 0) + 1;
  });

  // Top country calculation
  let topCountry = '—';
  let topCountryCount = 0;
  Object.entries(stats.countries).forEach(([c, count]) => {
    if (count > topCountryCount) {
      topCountry = c;
      topCountryCount = count;
    }
  });
  const topCountryPercent = stats.total_clicks > 0
    ? Math.round((topCountryCount / stats.total_clicks) * 100)
    : 0;

  return {
    ...stats,
    // Unique visitors come from the server-side daily rollup; a ratio guess
    // here used to fabricate a number that did not match any real visitor.
    unique_visitors: 0,
    top_country: topCountry,
    top_country_percent: topCountryPercent,
    top_country_count: topCountryCount
  };
}

// Continuous Zero-Filled Timeline Engine
function buildZeroFilledTimeline(clicks, range, granularity) {
  const now = new Date();
  const slots = [];
  const lang = typeof currentLang === 'string' ? currentLang : 'az';
  const locale = lang === 'az' ? 'az' : (lang === 'tr' ? 'tr' : 'en');

  const isHourly = granularity === 'hourly' || range === '24h';

  if (isHourly) {
    // 24 continuous hourly slots ending at current hour
    const endHour = new Date(now);
    endHour.setMinutes(0, 0, 0, 0);
    for (let i = 23; i >= 0; i--) {
      const slotTime = new Date(endHour.getTime() - (i * 3600 * 1000));
      const key = getLocalHourKey(slotTime);
      const label = slotTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      slots.push({ key, label, count: 0 });
    }

    // Aggregate clicks into hourly slots
    clicks.forEach(c => {
      const d = new Date(c.time);
      if (Number.isFinite(d.getTime())) {
        const key = getLocalHourKey(d);
        const slot = slots.find(s => s.key === key);
        if (slot) slot.count += 1;
      }
    });
  } else {
    // Continuous Daily Slots
    let dayCount = 7;
    if (range === '30d') {
      dayCount = 30;
    } else if (range === 'all') {
      if (clicks.length > 0) {
        const minTime = Math.min(...clicks.map(c => new Date(c.time).getTime()).filter(Number.isFinite));
        const diffDays = Math.round((now.getTime() - minTime) / 86400000) + 1;
        dayCount = Math.min(60, Math.max(7, diffDays));
      } else {
        dayCount = 7;
      }
    }

    for (let i = dayCount - 1; i >= 0; i--) {
      const slotDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = getLocalDateKey(slotDate);
      const isToday = i === 0;
      const label = isToday ? (t('stats_today') || 'Today') : slotDate.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
      slots.push({ key, label, count: 0 });
    }

    // Aggregate clicks into daily slots
    clicks.forEach(c => {
      const d = new Date(c.time);
      if (Number.isFinite(d.getTime())) {
        const key = getLocalDateKey(d);
        const slot = slots.find(s => s.key === key);
        if (slot) slot.count += 1;
      }
    });
  }

  const labels = slots.map(s => s.label);
  const values = slots.map(s => s.count);
  const total = clicks.length;
  const peak = values.length ? Math.max(...values) : 0;
  const avg = values.length ? (total / values.length).toFixed(1) : '0';
  const rangeLabel = labels.length ? `${labels[0]} — ${labels[labels.length - 1]}` : '';

  return { labels, values, peak, avg, total, rangeLabel };
}

// Render KPI numbers and badges (4 High-Density Bento Cards)
function renderKpis(stats, clicks) {
  const totalDisplay = document.getElementById('totalClicksDisplay');
  const totalSub = document.getElementById('totalClicksSub');
  const uniqueDisplay = document.getElementById('uniqueVisitorsDisplay');
  const uniqueRate = document.getElementById('uniqueVisitorsRate');
  const uniqueSub = document.getElementById('uniqueVisitorsSub');
  const topLocFlag = document.getElementById('topLocationFlag');
  const topLocText = document.getElementById('topLocationText');
  const topLocSub = document.getElementById('topLocationSub');
  const topPlatformIcon = document.getElementById('topPlatformIcon');
  const topPlatformText = document.getElementById('topPlatformText');
  const topPlatformSub = document.getElementById('topPlatformSub');

  // Card 1: Total Clicks
  if (totalDisplay) {
    // "All" is served from the server rollup so the headline stays exact even
    // when only the newest raw clicks are shipped to the browser.
    const serverTotal = analyticsRawData ? Number(analyticsRawData.clicks_total) : NaN;
    const totalValue = (currentRangeFilter === 'all' && Number.isFinite(serverTotal))
      ? serverTotal
      : Number(stats.total_clicks || 0);
    totalDisplay.textContent = totalValue.toLocaleString();
  }
  if (totalSub) {
    let rangeText = t('stats_filter_all');
    if (currentRangeFilter === '24h') rangeText = t('stats_filter_24h');
    else if (currentRangeFilter === '7d') rangeText = t('stats_filter_7d');
    else if (currentRangeFilter === '30d') rangeText = t('stats_filter_30d');
    totalSub.textContent = rangeText;
  }

  // Card 2: Unique Visitors (server rollup per day — never a client guess)
  const uniqueCount = (function () {
    const data = analyticsRawData || {};
    if (currentRangeFilter === 'all') return Number(data.unique_visitors || 0);
    const series = Array.isArray(data.uniques_by_day) ? data.uniques_by_day : [];
    if (!series.length) return Number(data.unique_visitors || 0);
    if (currentRangeFilter === '24h') {
      return Number(series[series.length - 1].count || 0);
    }
    const days = currentRangeFilter === '7d' ? 7 : 30;
    const cutoff = Date.now() - (days * 86400000);
    return series.reduce((sum, item) => {
      const stamp = new Date(item.date + 'T00:00:00Z').getTime();
      return Number.isFinite(stamp) && stamp >= cutoff ? sum + Number(item.count || 0) : sum;
    }, 0);
  })();

  const uniquesAvailable = !(analyticsRawData && analyticsRawData.uniques_available === false);
  if (uniqueDisplay) {
    uniqueDisplay.textContent = uniquesAvailable ? Number(uniqueCount).toLocaleString() : '—';
  }
  if (uniqueRate) {
    const rate = uniquesAvailable && stats.total_clicks > 0
      ? Math.min(100, Math.round((uniqueCount / stats.total_clicks) * 100))
      : 0;
    uniqueRate.textContent = uniquesAvailable ? `${rate}% unikal` : '';
  }
  if (uniqueSub) {
    if (!uniquesAvailable) {
      uniqueSub.textContent = t('stats_no_data');
    } else {
      uniqueSub.textContent = stats.total_clicks > 0 ? `${uniqueCount} fərqli şəbəkə seansı` : t('stats_no_data');
    }
  }

  // Card 3: Top Location
  if (topLocText) {
    if (!stats.total_clicks || stats.top_country === '—') {
      if (topLocFlag) topLocFlag.textContent = '🌐';
      topLocText.textContent = '—';
      if (topLocSub) topLocSub.textContent = t('stats_no_data');
    } else {
      const flag = getCountryFlag(stats.top_country);
      const cName = resolveCountryName(stats.top_country);
      if (topLocFlag) topLocFlag.textContent = flag;
      topLocText.textContent = `${cName} (${stats.top_country_percent}%)`;
      if (topLocSub) topLocSub.textContent = `${stats.top_country_count} klik (${stats.top_country_percent}%)`;
    }
  }

  // Card 4: Top Platform / Device
  let topOs = '—';
  let topOsCount = 0;
  Object.entries(stats.os || {}).forEach(([os, count]) => {
    if (count > topOsCount) {
      topOs = os;
      topOsCount = count;
    }
  });

  let topBrowser = '—';
  let topBrowserCount = 0;
  Object.entries(stats.browsers || {}).forEach(([b, count]) => {
    if (count > topBrowserCount) {
      topBrowser = b;
      topBrowserCount = count;
    }
  });

  const topOsPercent = stats.total_clicks > 0 ? Math.round((topOsCount / stats.total_clicks) * 100) : 0;

  if (topPlatformText) {
    if (!stats.total_clicks || topOs === '—') {
      if (topPlatformIcon) topPlatformIcon.className = 'fa-solid fa-laptop-code';
      topPlatformText.textContent = '—';
      if (topPlatformSub) topPlatformSub.textContent = t('stats_no_data');
    } else {
      const osName = mapBucketLabel(topOs);
      const browserName = mapBucketLabel(topBrowser);
      if (topPlatformIcon) topPlatformIcon.className = `${getTechIcon(osName)} m-tech-icon`;
      topPlatformText.textContent = osName;
      if (topPlatformSub) topPlatformSub.textContent = `${browserName} • ${topOsPercent}% pay`;
    }
  }
}

// Render Clicks Over Time (Continuous Baseline + Spline Area or Bar)
function renderTimeChart(timelineData) {
  const canvas = document.getElementById('timeChart');
  if (!canvas) return;
  const wrap = canvas.parentElement;

  // Update stat strip
  const peakEl = document.getElementById('chartStatPeak');
  const avgEl = document.getElementById('chartStatAvg');
  const totalEl = document.getElementById('chartStatTotal');
  const metaContainer = document.getElementById('timeChartMeta');

  const isHourly = currentGranularity === 'hourly' || currentRangeFilter === '24h';
  const perUnitLabel = isHourly
    ? (currentLang === 'az' ? 'saat' : (currentLang === 'tr' ? 'saat' : 'hr'))
    : (currentLang === 'az' ? 'gün' : (currentLang === 'tr' ? 'gün' : 'day'));

  if (peakEl) peakEl.textContent = `${timelineData.peak} ${t('th_clicks') || 'klik'}`;
  if (avgEl) avgEl.textContent = `${timelineData.avg} / ${perUnitLabel}`;
  if (totalEl) totalEl.textContent = `${timelineData.total} ${t('th_clicks') || 'klik'}`;

  if (metaContainer) {
    metaContainer.innerHTML = '';
    if (timelineData.rangeLabel) {
      const rangeChip = document.createElement('span');
      rangeChip.className = 'm-meta-chip';
      rangeChip.textContent = timelineData.rangeLabel;
      metaContainer.appendChild(rangeChip);
    }
  }

  if (timeChartInstance) {
    timeChartInstance.destroy();
    timeChartInstance = null;
  }

  const ctx = canvas.getContext('2d');
  const isBar = currentChartType === 'bar';

  let dataset = {};
  if (isBar) {
    dataset = {
      label: t('th_clicks') || 'Clicks',
      data: timelineData.values,
      backgroundColor: 'rgba(255, 255, 255, 0.82)',
      hoverBackgroundColor: '#ffffff',
      borderRadius: 4,
      borderSkipped: false,
      maxBarThickness: 28
    };
  } else {
    const gradient = ctx.createLinearGradient(0, 0, 0, 270);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.18)');
    gradient.addColorStop(0.7, 'rgba(255, 255, 255, 0.03)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0.0)');

    dataset = {
      label: t('th_clicks') || 'Clicks',
      data: timelineData.values,
      borderColor: '#ffffff',
      borderWidth: 2,
      backgroundColor: gradient,
      fill: true,
      tension: 0.35,
      pointRadius: timelineData.values.length <= 14 ? 3.5 : 0,
      pointHoverRadius: 6,
      pointBackgroundColor: '#ffffff',
      pointHoverBackgroundColor: '#ffffff',
      pointHoverBorderColor: '#09090b',
      pointHoverBorderWidth: 2
    };
  }

  timeChartInstance = new Chart(ctx, {
    type: isBar ? 'bar' : 'line',
    data: {
      labels: timelineData.labels,
      datasets: [dataset]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#111114',
          titleColor: '#ffffff',
          bodyColor: '#a1a1aa',
          borderColor: 'rgba(255, 255, 255, 0.15)',
          borderWidth: 1,
          padding: 12,
          cornerRadius: 8,
          displayColors: false,
          titleFont: { family: 'Inter', size: 13, weight: '600' },
          bodyFont: { family: 'Inter', size: 12.5 },
          callbacks: {
            label: (c) => `${t('th_clicks') || 'Clicks'}: ${c.parsed.y}`
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          suggestedMax: Math.max(2, timelineData.peak + 1),
          ticks: {
            precision: 0,
            color: '#666666',
            font: { family: 'Inter', size: 11.5 }
          },
          grid: {
            color: 'rgba(255, 255, 255, 0.04)',
            drawBorder: false
          },
          border: { display: false }
        },
        x: {
          ticks: {
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 10,
            color: '#666666',
            font: { family: 'Inter', size: 11.5 }
          },
          grid: { display: false },
          border: { display: false }
        }
      }
    }
  });
}

// Render Ranked List (Top Countries)
function renderCountriesList(countriesMap, totalClicks) {
  const container = document.getElementById('countriesList');
  const tag = document.getElementById('countryTotalTag');
  if (!container) return;

  const entries = Object.entries(countriesMap || {})
    .sort((a, b) => b[1] - a[1]);

  if (tag) tag.textContent = `${entries.length} ölkə`;

  if (!entries.length || totalClicks === 0) {
    container.innerHTML = `
      <div class="m-list-empty">
        <i class="fa-solid fa-globe"></i>
        <span>${t('stats_no_data')}</span>
      </div>`;
    return;
  }

  container.innerHTML = entries.slice(0, 6).map(([code, count], idx) => {
    const pct = totalClicks > 0 ? Math.round((count / totalClicks) * 100) : 0;
    const name = resolveCountryName(code);
    const flag = getCountryFlag(code);
    const upperCode = (code || '—').toUpperCase();

    return `
      <div class="m-data-row">
        <div class="m-data-row-main">
          <div class="m-data-left">
            <span class="m-rank-index">${idx + 1}</span>
            <span class="m-flag-emoji" style="font-size: 15px;">${flag}</span>
            <span class="m-geo-tag">${escapeHtml(upperCode.slice(0, 3))}</span>
            <span>${escapeHtml(name)}</span>
          </div>
          <div class="m-data-right">
            <span class="m-pct-val">${pct}%</span>
            <span class="m-count-val">(${count})</span>
          </div>
        </div>
        <div class="m-hairline-track">
          <div class="m-hairline-fill" style="width: ${Math.max(4, pct)}%;"></div>
        </div>
      </div>
    `;
  }).join('');
}

// Render Technology List (OS or Browsers)
function renderTechList(stats) {
  const container = document.getElementById('techList');
  const tag = document.getElementById('techTotalTag');
  if (!container) return;

  const sourceMap = currentTechTab === 'os' ? stats.os : stats.browsers;
  const entries = Object.entries(sourceMap || {})
    .sort((a, b) => b[1] - a[1]);

  if (tag) tag.textContent = `${entries.length} element`;

  if (!entries.length || stats.total_clicks === 0) {
    container.innerHTML = `
      <div class="m-list-empty">
        <i class="fa-solid fa-laptop-code"></i>
        <span>${t('stats_no_data')}</span>
      </div>`;
    return;
  }

  container.innerHTML = entries.slice(0, 6).map(([rawName, count]) => {
    const name = mapBucketLabel(rawName);
    const iconClass = getTechIcon(name);
    const pct = stats.total_clicks > 0 ? Math.round((count / stats.total_clicks) * 100) : 0;

    return `
      <div class="m-data-row">
        <div class="m-data-row-main">
          <div class="m-data-left">
            <i class="${iconClass} m-tech-icon"></i>
            <span>${escapeHtml(name)}</span>
          </div>
          <div class="m-data-right">
            <span class="m-pct-val">${pct}%</span>
            <span class="m-count-val">(${count})</span>
          </div>
        </div>
        <div class="m-hairline-track">
          <div class="m-hairline-fill" style="width: ${Math.max(4, pct)}%;"></div>
        </div>
      </div>
    `;
  }).join('');
}

// Render Live Activity Stream Table (Canlı Klik Jurnalı)
function renderActivityTable(clicks) {
  const tbody = document.getElementById('activityTableBody');
  const countTag = document.getElementById('activityCountTag');
  if (!tbody) return;

  if (countTag) countTag.textContent = `${clicks.length} klik`;

  if (!clicks.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="m-table-empty">
          <i class="fa-solid fa-clock-rotate-left"></i>
          <span>${t('stats_no_data')}</span>
        </td>
      </tr>`;
    return;
  }

  // Display up to 50 clicks, newest first
  const recentClicks = clicks.slice().reverse().slice(0, 50);

  tbody.innerHTML = recentClicks.map((c, idx) => {
    const d = new Date(c.time);
    const timeValid = Number.isFinite(d.getTime());
    const exactTime = timeValid ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
    const relTime = timeValid ? formatRelativeTime(c.time) : (c.time || '—');
    const flag = getCountryFlag(c.country);
    const countryName = resolveCountryName(c.country);
    const cityStr = c.city ? `${c.city}, ` : '';
    const locFull = `${cityStr}${countryName}`;
    const osName = mapBucketLabel(c.os);
    const browserName = mapBucketLabel(c.browser);
    const osIcon = getTechIcon(osName);
    const browserIcon = getTechIcon(browserName);

    return `
      <tr>
        <td class="m-td-num">${idx + 1}</td>
        <td>
          <span class="m-td-time" title="${escapeHtml(c.time || '')}">
            <span>${escapeHtml(relTime)}</span>
            ${exactTime ? `<span class="m-td-subtime">(${escapeHtml(exactTime)})</span>` : ''}
          </span>
        </td>
        <td>
          <div class="m-td-badge">
            <span class="m-flag-emoji">${flag}</span>
            <span>${escapeHtml(locFull)}</span>
          </div>
        </td>
        <td>
          <div class="m-td-badge">
            <i class="${osIcon}"></i>
            <span>${escapeHtml(osName)}</span>
          </div>
        </td>
        <td>
          <div class="m-td-badge">
            <i class="${browserIcon}"></i>
            <span>${escapeHtml(browserName)}</span>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// Primary refresh function
// Builds one percentage row without interpolating untrusted text into HTML
// (referrer hosts come from the request's Referer header).
function buildInsightRow(container, index, label, count, total, iconClass) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;

  const row = document.createElement('div');
  row.className = 'm-data-row';

  const main = document.createElement('div');
  main.className = 'm-data-row-main';

  const left = document.createElement('div');
  left.className = 'm-data-left';

  const rank = document.createElement('span');
  rank.className = 'm-rank-index';
  rank.textContent = String(index + 1);

  const icon = document.createElement('i');
  icon.className = iconClass || 'fa-solid fa-chart-simple';
  icon.style.fontSize = '12px';
  icon.style.opacity = '0.7';

  const name = document.createElement('span');
  name.textContent = label;

  left.appendChild(rank);
  left.appendChild(icon);
  left.appendChild(name);

  const right = document.createElement('div');
  right.className = 'm-data-right';

  const pctEl = document.createElement('span');
  pctEl.className = 'm-pct-val';
  pctEl.textContent = pct + '%';

  const countEl = document.createElement('span');
  countEl.className = 'm-count-val';
  countEl.textContent = '(' + count + ')';

  right.appendChild(pctEl);
  right.appendChild(countEl);

  main.appendChild(left);
  main.appendChild(right);

  const track = document.createElement('div');
  track.className = 'm-hairline-track';
  const fill = document.createElement('div');
  fill.className = 'm-hairline-fill';
  fill.style.width = Math.max(4, pct) + '%';
  track.appendChild(fill);

  row.appendChild(main);
  row.appendChild(track);
  container.appendChild(row);
}

function renderInsightList(containerId, metaId, entries, iconClass) {
  const container = document.getElementById(containerId);
  const meta = metaId ? document.getElementById(metaId) : null;
  if (!container) return;

  container.textContent = '';
  const list = (entries || []).filter((item) => Number(item.count) > 0).slice(0, 6);
  const panelTotal = list.reduce((sum, item) => sum + Number(item.count || 0), 0);

  if (meta) meta.textContent = String(list.length);

  if (!list.length || panelTotal === 0) {
    const empty = document.createElement('div');
    empty.className = 'm-list-empty';
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-chart-simple';
    const span = document.createElement('span');
    span.textContent = t('stats_no_data');
    empty.appendChild(icon);
    empty.appendChild(span);
    container.appendChild(empty);
    return;
  }

  list.forEach((item, index) => {
    buildInsightRow(container, index, item.name, Number(item.count), panelTotal, iconClass);
  });
}

function sortEntries(map) {
  return Object.entries(map || {})
    .map(([name, count]) => ({ name, count: Number(count || 0) }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);
}

// Attribution / device / A-B panels. Values come from the server rollup, so
// they stay correct even when only a bounded slice of raw clicks is shipped.
function renderInsights() {
  const data = analyticsRawData || {};

  const sourceEntries = sortEntries(data.sources);
  renderInsightList('sourcesList', 'sourcesMeta', sourceEntries, 'fa-solid fa-share-nodes');

  const deviceEntries = sortEntries(data.devices)
    .filter((item) => item.name !== 'Unknown' && item.name !== 'unknown');
  renderInsightList('devicesList', 'devicesMeta', deviceEntries, 'fa-solid fa-laptop');

  const botsMeta = document.getElementById('botsMeta');
  if (botsMeta) {
    const bots = Number(data.bots_total || 0);
    const total = Number(data.clicks_total || 0) || Number(data.total_clicks || 0);
    const rate = total > 0 ? Math.round((bots / total) * 100) : 0;
    botsMeta.textContent = bots + ' bot · ' + rate + '%';
  }

  const abPanel = document.getElementById('abPanel');
  if (abPanel) {
    const variantClicks = data.variant_clicks || {};
    const aCount = Number(variantClicks.a || 0);
    const bCount = Number(variantClicks.b || 0);

    if (!aCount && !bCount) {
      abPanel.style.display = 'none';
    } else {
      abPanel.style.display = '';
      const entries = [
        { name: 'A — original', count: aCount },
        { name: 'B — variant', count: bCount },
      ];
      renderInsightList('abList', 'abMeta', entries, 'fa-solid fa-code-branch');

      const abMeta = document.getElementById('abMeta');
      if (abMeta) {
        const leader = bCount > aCount ? 'B' : (aCount > bCount ? 'A' : '—');
        abMeta.textContent = abSignificanceLabel(leader);
      }
    }
  }

  // Conversion goals — only meaningful once the destination pixel fires.
  const conversionPanel = document.getElementById('conversionPanel');
  if (conversionPanel) {
    const conversions = Number(data.conversions_range || 0);
    if (!conversions) {
      conversionPanel.style.display = 'none';
    } else {
      conversionPanel.style.display = '';
      renderInsightList('conversionList', null, sortEntries(data.goals), 'fa-solid fa-bullseye');

      const conversionMeta = document.getElementById('conversionMeta');
      if (conversionMeta) {
        conversionMeta.textContent = conversions + ' · ' + Number(data.conversion_rate || 0) + '%';
      }
      const pixelEl = document.getElementById('conversionPixel');
      if (pixelEl && data.conversion_pixel_path) {
        pixelEl.textContent = 'Pixel: ' + window.location.origin + data.conversion_pixel_path + '?goal=signup';
      }
    }
  }

  renderGeoMap(data.countries);
}

function applyAnalyticsView() {
  if (!analyticsRawData) return;

  const filteredClicks = getFilteredClicks();
  const stats = computeStatsFromClicks(filteredClicks);
  const timelineData = buildZeroFilledTimeline(filteredClicks, currentRangeFilter, currentGranularity);

  renderKpis(stats, filteredClicks);
  renderTimeChart(timelineData);
  renderCountriesList(stats.countries, stats.total_clicks);
  renderTechList(stats);
  renderActivityTable(filteredClicks);
  renderInsights();
}

// Copy link handler
const copyBtn = document.getElementById('copyLinkBtn');
if (copyBtn) {
  copyBtn.addEventListener('click', () => {
    const origin = window.location.origin;
    const fullUrl = `${origin}/${shortCode}`;
    navigator.clipboard.writeText(fullUrl).then(() => {
      copyBtn.classList.add('copied');
      copyBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
      setTimeout(() => {
        copyBtn.classList.remove('copied');
        copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i>';
      }, 2000);
    }).catch(() => {});
  });
}

// Time Range Switcher Event Handlers
document.querySelectorAll('.m-range-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.m-range-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentRangeFilter = btn.getAttribute('data-range') || 'all';

    // Auto sync granularity when picking 24h vs multi-day
    if (currentRangeFilter === '24h') {
      currentGranularity = 'hourly';
      const granH = document.getElementById('btnGranHourly');
      const granD = document.getElementById('btnGranDaily');
      if (granH) granH.classList.add('active');
      if (granD) granD.classList.remove('active');
    } else if (currentRangeFilter === '7d' || currentRangeFilter === '30d') {
      currentGranularity = 'daily';
      const granH = document.getElementById('btnGranHourly');
      const granD = document.getElementById('btnGranDaily');
      if (granD) granD.classList.add('active');
      if (granH) granH.classList.remove('active');
    }

    applyAnalyticsView();
    // The extra panels (funnel, visitors, A/B) are server-computed per
    // window, so they must follow the range switch.
    loadExtras();
  });
});

// Granularity Toggle Buttons (Hourly vs Daily)
const btnGranHourly = document.getElementById('btnGranHourly');
const btnGranDaily = document.getElementById('btnGranDaily');
if (btnGranHourly && btnGranDaily) {
  btnGranHourly.addEventListener('click', () => {
    btnGranHourly.classList.add('active');
    btnGranDaily.classList.remove('active');
    currentGranularity = 'hourly';
    if (analyticsRawData) {
      const filteredClicks = getFilteredClicks();
      const timelineData = buildZeroFilledTimeline(filteredClicks, currentRangeFilter, currentGranularity);
      renderTimeChart(timelineData);
    }
  });

  btnGranDaily.addEventListener('click', () => {
    btnGranDaily.classList.add('active');
    btnGranHourly.classList.remove('active');
    currentGranularity = 'daily';
    if (analyticsRawData) {
      const filteredClicks = getFilteredClicks();
      const timelineData = buildZeroFilledTimeline(filteredClicks, currentRangeFilter, currentGranularity);
      renderTimeChart(timelineData);
    }
  });
}

// Chart Type Toggle Buttons (Area vs Bar)
const btnTypeArea = document.getElementById('btnTypeArea');
const btnTypeBar = document.getElementById('btnTypeBar');
if (btnTypeArea && btnTypeBar) {
  btnTypeArea.addEventListener('click', () => {
    btnTypeArea.classList.add('active');
    btnTypeBar.classList.remove('active');
    currentChartType = 'line';
    if (analyticsRawData) {
      const filteredClicks = getFilteredClicks();
      const timelineData = buildZeroFilledTimeline(filteredClicks, currentRangeFilter, currentGranularity);
      renderTimeChart(timelineData);
    }
  });

  btnTypeBar.addEventListener('click', () => {
    btnTypeBar.classList.add('active');
    btnTypeArea.classList.remove('active');
    currentChartType = 'bar';
    if (analyticsRawData) {
      const filteredClicks = getFilteredClicks();
      const timelineData = buildZeroFilledTimeline(filteredClicks, currentRangeFilter, currentGranularity);
      renderTimeChart(timelineData);
    }
  });
}

// Tech Tab Buttons (OS vs Browsers)
const tabOsBtn = document.getElementById('tabOsBtn');
const tabBrowsersBtn = document.getElementById('tabBrowsersBtn');
if (tabOsBtn && tabBrowsersBtn) {
  tabOsBtn.addEventListener('click', () => {
    tabOsBtn.classList.add('active');
    tabOsBtn.setAttribute('aria-selected', 'true');
    tabBrowsersBtn.classList.remove('active');
    tabBrowsersBtn.setAttribute('aria-selected', 'false');
    currentTechTab = 'os';
    if (analyticsRawData) {
      const stats = computeStatsFromClicks(getFilteredClicks());
      renderTechList(stats);
    }
  });

  tabBrowsersBtn.addEventListener('click', () => {
    tabBrowsersBtn.classList.add('active');
    tabBrowsersBtn.setAttribute('aria-selected', 'true');
    tabOsBtn.classList.remove('active');
    tabOsBtn.setAttribute('aria-selected', 'false');
    currentTechTab = 'browsers';
    if (analyticsRawData) {
      const stats = computeStatsFromClicks(getFilteredClicks());
      renderTechList(stats);
    }
  });
}

// Weekly e-mail digest toggle (opt-in, stored per account)
const weeklyReportBtn = document.getElementById('weeklyReportBtn');
const weeklyReportLabel = document.getElementById('weeklyReportLabel');
let weeklyReportEnabled = false;

function paintWeeklyReport(enabled) {
  if (!weeklyReportBtn) return;
  weeklyReportBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  weeklyReportBtn.style.opacity = enabled ? '1' : '0.6';
  if (weeklyReportLabel) {
    weeklyReportLabel.textContent = enabled
      ? (t('stats_weekly_report_on') || 'Hesabat aktiv')
      : (t('stats_weekly_report') || 'Həftəlik hesabat');
  }
}

if (weeklyReportBtn) {
  fetch('/api/user/stats-report', { credentials: 'include' })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (!data) return;
      weeklyReportEnabled = !!data.enabled;
      paintWeeklyReport(weeklyReportEnabled);
    })
    .catch(function () {});

  weeklyReportBtn.addEventListener('click', function () {
    weeklyReportEnabled = !weeklyReportEnabled;
    const csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
    fetch('/api/user/stats-report', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ enabled: weeklyReportEnabled })
    })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error('toggle_failed')); })
      .then(function (data) {
        weeklyReportEnabled = !!data.enabled;
        paintWeeklyReport(weeklyReportEnabled);
      })
      .catch(function () {
        weeklyReportEnabled = !weeklyReportEnabled;
        paintWeeklyReport(weeklyReportEnabled);
      });
  });
}

// Export CSV Handler — the server builds the file so attribution columns,
// the full range and injection-safe escaping are guaranteed.
function currentExportDays() {
  if (currentRangeFilter === '24h') return 1;
  if (currentRangeFilter === '7d') return 7;
  if (currentRangeFilter === '30d') return 30;
  return 'all';
}

const exportCsvBtn = document.getElementById('exportCsvBtn');
if (exportCsvBtn) {
  exportCsvBtn.addEventListener('click', () => {
    const params = new URLSearchParams({ format: 'csv', days: String(currentExportDays()) });
    window.location.href = '/api/stats/' + encodeURIComponent(shortCode) + '/export?' + params.toString();
  });
}

// Export JSON Handler
const exportJsonBtn = document.getElementById('exportJsonBtn');
if (exportJsonBtn) {
  exportJsonBtn.addEventListener('click', () => {
    const params = new URLSearchParams({ format: 'json', days: String(currentExportDays()) });
    window.location.href = '/api/stats/' + encodeURIComponent(shortCode) + '/export?' + params.toString();
  });
}

// Anomaly panel — read-only server detection (spike/drop) plus the last
// destination health probe. Values are rendered with textContent only.
let anomalyPayload = null;

function anomalyKindLabel(kind) {
  if (kind === 'spike') return t('stats_anomaly_spike') || 'Click spike';
  if (kind === 'drop') return t('stats_anomaly_drop') || 'Click drop';
  if (kind === 'limit') return t('stats_anomaly_limit') || 'Limit warning';
  if (kind === 'health') return t('stats_anomaly_health') || 'Destination failure';
  return String(kind || '');
}

function renderAnomalies(payload) {
  const list = document.getElementById('anomalyList');
  const meta = document.getElementById('anomalyMeta');
  const health = document.getElementById('destinationHealth');
  if (!list) return;

  const anomalies = Array.isArray(payload && payload.anomalies)
    ? payload.anomalies.slice(-6).reverse()
    : [];
  list.textContent = '';

  if (!anomalies.length) {
    const empty = document.createElement('div');
    empty.className = 'm-list-empty';
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-shield';
    const span = document.createElement('span');
    span.textContent = t('stats_anomaly_none') || 'No anomalies';
    empty.appendChild(icon);
    empty.appendChild(span);
    list.appendChild(empty);
    if (meta) meta.textContent = '0';
  } else {
    if (meta) meta.textContent = String(anomalies.length);
    anomalies.forEach(function (flag) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid rgba(127,127,127,0.18);';

      const label = document.createElement('span');
      const dot = document.createElement('i');
      dot.className = flag.kind === 'spike' ? 'fa-solid fa-arrow-trend-up' : 'fa-solid fa-arrow-trend-down';
      dot.style.marginRight = '8px';
      dot.style.color = flag.severity === 'critical' ? '#ef4444' : '#f59e0b';
      const text = document.createElement('span');
      text.textContent = anomalyKindLabel(flag.kind) + ' · ' + String(flag.day || '');
      label.appendChild(dot);
      label.appendChild(text);

      const value = document.createElement('span');
      const delta = flag.delta_percent;
      value.textContent = String(Number(flag.clicks || 0)) +
        (delta === null || delta === undefined ? '' : ' (' + (delta > 0 ? '+' : '') + delta + '%)');
      value.style.fontVariantNumeric = 'tabular-nums';
      value.style.color = flag.severity === 'critical' ? '#ef4444' : '#f59e0b';

      row.appendChild(label);
      row.appendChild(value);
      list.appendChild(row);
    });
  }

  if (health) {
    const destination = (payload && payload.destination) || {};
    const status = Number(destination.status || 0);
    if (status >= 400) {
      health.textContent = (t('stats_destination_down') || 'Destination failing') + ' · HTTP ' + status;
      health.style.color = '#ef4444';
    } else if (destination.checked_at) {
      health.textContent = (t('stats_destination_ok') || 'Destination healthy') + ' · HTTP ' + status;
      health.style.color = '#22c55e';
    } else {
      health.textContent = '';
    }
  }
}

function loadAnomalies() {
  fetch('/api/stats/' + encodeURIComponent(shortCode) + '/anomalies?days=30', { credentials: 'include' })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (!data) return;
      anomalyPayload = data;
      renderAnomalies(data);
    })
    .catch(function () {});
}

loadAnomalies();

// -----------------------------------------------------------------------
// Analytics v2 extras: funnel, visitors, A/B significance, geo map, live
// feed, saved segments and the access log. Every panel stays hidden until
// its endpoint answers, so a failure never leaves a broken page.
// -----------------------------------------------------------------------
let abExtras = null;
let funnelPayload = null;
let visitorsPayload = null;

function abSignificanceLabel(leader) {
  const base = leader === '—' ? t('stats_ab_tie') : (t('stats_ab_leader') + ': ' + leader);
  if (!abExtras || !abExtras.available) return base;
  if (abExtras.insufficient_data) return base + ' · ' + t('stats_ab_insufficient');
  if (abExtras.significant) return base + ' · ' + Number(abExtras.confidence).toFixed(1) + '% ' + t('stats_ab_confidence');
  return base + ' · ' + t('stats_ab_not_significant');
}

function renderVisitors(payload) {
  visitorsPayload = payload;
  const display = document.getElementById('newReturningDisplay');
  const sub = document.getElementById('newReturningSub');
  if (!display) return;
  if (!payload || payload.available === false) {
    display.textContent = '—';
    return;
  }
  const newCount = Number(payload.new_visitors || 0);
  const returningCount = Number(payload.returning_visitors || 0);
  display.textContent = newCount.toLocaleString() + ' / ' + returningCount.toLocaleString();
  if (sub) {
    sub.textContent = t('stats_new_visitors') + ': ' + newCount.toLocaleString() +
      ' · ' + t('stats_returning_visitors') + ': ' + returningCount.toLocaleString();
  }
}

function renderFunnel(payload) {
  funnelPayload = payload;
  const panel = document.getElementById('funnelPanel');
  const list = document.getElementById('funnelList');
  if (!panel || !list) return;
  if (!payload || !payload.available || !Array.isArray(payload.steps) || !payload.steps.length) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';
  list.textContent = '';
  const max = Math.max.apply(null, payload.steps.map((step) => Number(step.visitors || 0)).concat([1]));

  payload.steps.forEach((step) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:8px 0;border-bottom:1px solid rgba(127,127,127,0.14);';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;gap:10px;font-size:13px;';
    const label = document.createElement('span');
    label.textContent = t('stats_funnel_step') + ' ' + step.step;
    const value = document.createElement('span');
    value.style.fontVariantNumeric = 'tabular-nums';
    value.textContent = Number(step.visitors || 0).toLocaleString() + ' · ' + Number(step.percent_of_base || 0) + '%';
    head.appendChild(label);
    head.appendChild(value);

    const bar = document.createElement('div');
    bar.style.cssText = 'height:6px;border-radius:100px;background:rgba(127,127,127,0.18);overflow:hidden;';
    const fill = document.createElement('div');
    fill.style.cssText = 'height:100%;border-radius:100px;background:rgba(255,255,255,0.55);';
    fill.style.width = Math.max(2, Math.round((Number(step.visitors || 0) / max) * 100)) + '%';
    bar.appendChild(fill);

    row.appendChild(head);
    row.appendChild(bar);
    list.appendChild(row);
  });

  const meta = document.getElementById('funnelMeta');
  if (meta) meta.textContent = payload.steps.length + ' ' + t('stats_funnel_steps');
  const hint = document.getElementById('funnelHint');
  if (hint && payload.hint) hint.textContent = 'Pixel: ' + window.location.origin + payload.hint;
}

function renderGeoMap(countries) {
  const panel = document.getElementById('geoPanel');
  const target = document.getElementById('geoMap');
  if (!panel || !target) return;
  if (!window.OvlinkWorldMap || !countries || typeof countries !== 'object') {
    panel.style.display = 'none';
    return;
  }
  const rendered = window.OvlinkWorldMap.render(target, countries, { emptyLabel: t('stats_no_data') });
  panel.style.display = rendered ? '' : 'none';
}

function renderAb(payload) {
  abExtras = payload;
  if (analyticsRawData) renderInsights();
}

function loadExtras() {
  const days = encodeURIComponent(String(currentExportDays()));
  const base = '/api/stats/' + encodeURIComponent(shortCode);
  const get = (path, onData) => fetch(path, { credentials: 'include' })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => { if (data) onData(data); })
    .catch(() => {});

  get(base + '/funnel?days=' + days, renderFunnel);
  get(base + '/visitors?days=' + days, renderVisitors);
  get(base + '/ab-significance?days=' + days, renderAb);
}

// Live feed: newest rows after a cursor, polled only while the tab is visible.
let liveAfterId = 0;
let liveTimer = null;
let liveFailures = 0;

function buildLiveRow(click) {
  const tr = document.createElement('tr');
  const cells = [
    '#' + click.id,
    formatRelativeTime(click.time),
    click.country || '—',
    (click.device_type || '—') + (click.os ? ' · ' + click.os : ''),
    click.browser || '—',
  ];
  cells.forEach((value) => {
    const td = document.createElement('td');
    td.textContent = value;
    tr.appendChild(td);
  });
  if (click.is_bot) tr.style.opacity = '0.55';
  return tr;
}

function pollLive(prime) {
  if (!prime && document.visibilityState === 'hidden') return;
  const limit = prime ? 1 : 25;
  const after = prime ? 0 : liveAfterId;
  fetch('/api/stats/' + encodeURIComponent(shortCode) + '/live?after_id=' + after + '&limit=' + limit, { credentials: 'include' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error('live'))))
    .then((data) => {
      liveFailures = 0;
      const next = Number(data.next_after_id || 0);
      if (prime) {
        liveAfterId = next;
        return;
      }
      if (next > liveAfterId) liveAfterId = next;
      const body = document.getElementById('activityTableBody');
      if (!body || !Array.isArray(data.clicks) || !data.clicks.length) return;
      const fragment = document.createDocumentFragment();
      data.clicks.forEach((click) => fragment.appendChild(buildLiveRow(click)));
      body.insertBefore(fragment, body.firstChild);
      while (body.children.length > 50) body.removeChild(body.lastChild);
    })
    .catch(() => {
      liveFailures += 1;
      if (liveFailures >= 3 && liveTimer) {
        clearInterval(liveTimer);
        liveTimer = null;
      }
    });
}

function startLiveFeed() {
  if (liveTimer) return;
  pollLive(true);
  liveTimer = setInterval(() => pollLive(false), 10000);
}

// Saved segments (view presets over the already loaded slice).
const segmentsCache = new Map();

function applySegment(segment) {
  if (!segment) {
    segmentFilter = null;
    applyAnalyticsView();
    return;
  }
  const filters = segment.filters || {};
  if (filters.days === 'all') {
    currentRangeFilter = 'all';
  } else {
    const value = Number(filters.days) || 30;
    currentRangeFilter = value <= 1 ? '24h' : (value <= 7 ? '7d' : '30d');
  }
  segmentFilter = {
    device: filters.device || '',
    source: filters.source || '',
    country: filters.country || '',
    variant: filters.variant || '',
  };
  document.querySelectorAll('.m-range-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-range') === currentRangeFilter);
  });
  applyAnalyticsView();
}

function loadSegments() {
  fetch('/api/segments', { credentials: 'include' })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const select = document.getElementById('segmentSelect');
      if (!select || !data) return;
      const placeholder = select.querySelector('option');
      select.textContent = '';
      if (placeholder) select.appendChild(placeholder);
      segmentsCache.clear();
      (data.segments || []).forEach((segment) => {
        segmentsCache.set(Number(segment.id), segment);
        const option = document.createElement('option');
        option.value = String(segment.id);
        option.textContent = segment.name;
        select.appendChild(option);
      });
    })
    .catch(() => {});
}

function saveCurrentSegment() {
  const name = window.prompt(t('stats_segments_name_placeholder'), '');
  if (!name) return;
  const csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
  fetch('/api/segments', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({
      name,
      filters: Object.assign({ days: currentExportDays(), bots: 'include' }, segmentFilter || {}),
    }),
  })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error('segment'))))
    .then(() => loadSegments())
    .catch(() => {});
}

// Access log (owner / workspace members).
let auditLoaded = false;

function loadAudit() {
  const panel = document.getElementById('auditPanel');
  const list = document.getElementById('auditList');
  if (!panel || !list || auditLoaded) return;
  fetch('/api/stats/' + encodeURIComponent(shortCode) + '/audit?limit=30', { credentials: 'include' })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data) return;
      auditLoaded = true;
      list.textContent = '';
      const entries = Array.isArray(data.entries) ? data.entries : [];
      if (!entries.length) return;
      const labels = {
        'stats.view': 'stats_audit_view',
        'stats.export': 'stats_audit_export',
        'stats.share.create': 'stats_audit_share',
        'stats.share.revoke': 'stats_audit_share',
        'stats.shared.view': 'stats_audit_share',
        'stats.embed.view': 'stats_audit_share',
        'stats.api.read': 'stats_audit_api',
      };
      entries.forEach((entry) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;gap:10px;padding:6px 0;font-size:12.5px;border-bottom:1px solid rgba(127,127,127,0.12);';
        const label = document.createElement('span');
        label.textContent = t(labels[entry.action] || 'stats_audit_view');
        const when = document.createElement('span');
        when.style.color = 'var(--c-faint,#888)';
        when.textContent = formatRelativeTime(entry.created_at);
        row.appendChild(label);
        row.appendChild(when);
        list.appendChild(row);
      });
      panel.style.display = '';
    })
    .catch(() => {});
}

const segmentSelectEl = document.getElementById('segmentSelect');
if (segmentSelectEl) {
  segmentSelectEl.addEventListener('change', () => {
    const id = Number(segmentSelectEl.value);
    applySegment(id ? segmentsCache.get(id) : null);
  });
}
const segmentSaveBtn = document.getElementById('segmentSaveBtn');
if (segmentSaveBtn) segmentSaveBtn.addEventListener('click', saveCurrentSegment);
const auditToggle = document.getElementById('auditToggle');
if (auditToggle) auditToggle.addEventListener('click', loadAudit);

loadSegments();
loadAudit();
startLiveFeed();

// Initial Data Fetch — 90 days of raw rows (bounded) keeps every client-side
// range filter exact; all-time KPIs come from the server rollup.
fetch('/api/stats/' + encodeURIComponent(shortCode) + '?days=90&limit=2000', { credentials: 'include' })
  .then(res => {
    if (!res.ok) throw new Error('stats_fetch_failed');
    return res.json();
  })
  .then(data => {
    analyticsRawData = data || {};
    applyAnalyticsView();
    loadExtras();
  })
  .catch(() => {
    const display = document.getElementById('totalClicksDisplay');
    if (display) display.textContent = '0';
  });

window.addEventListener('ovlink:languageChanged', applyAnalyticsView);
window.addEventListener('ovlink:languageChanged', function () {
  if (anomalyPayload) renderAnomalies(anomalyPayload);
  if (funnelPayload) renderFunnel(funnelPayload);
  if (visitorsPayload) renderVisitors(visitorsPayload);
  if (abExtras) renderAb(abExtras);
});
window.addEventListener('ovlink:themeChanged', applyAnalyticsView);
})();
