// =========================
// Theme Management (Synchronized across all pages & document-level click handler)
// =========================
function syncThemeUi(theme) {
  const current = theme || ((document.body && document.body.classList.contains("dark-mode")) || (document.documentElement && document.documentElement.classList.contains("dark-mode")) ? "dark" : (localStorage.getItem("theme") || "light"));
  const isDark = current === "dark";
  if (document.documentElement) {
    if (isDark) document.documentElement.classList.add("dark-mode");
    else document.documentElement.classList.remove("dark-mode");
  }
  if (document.body) {
    if (isDark) document.body.classList.add("dark-mode");
    else document.body.classList.remove("dark-mode");
  }
  document.querySelectorAll(".theme-toggle").forEach((btn) => {
    btn.innerHTML = isDark ? '<i class="fa-solid fa-moon"></i>' : '<i class="fa-solid fa-sun"></i>';
    btn.setAttribute("aria-label", isDark ? "Açıq rejimə keç" : "Qaranlıq rejimə keç");
  });
}

function applyTheme(theme) {
  const normalizedTheme = theme === "dark" ? "dark" : "light";
  try {
    localStorage.setItem("theme", normalizedTheme);
  } catch {}
  syncThemeUi(normalizedTheme);
  window.dispatchEvent(new CustomEvent("ovlink:themeChanged", { detail: { theme: normalizedTheme } }));
}

function toggleTheme() {
  const isDark = (document.body && document.body.classList.contains("dark-mode")) || (document.documentElement && document.documentElement.classList.contains("dark-mode"));
  const nextTheme = isDark ? "light" : "dark";
  applyTheme(nextTheme);
}

// Immediate initial execution to prevent any theme flash
try {
  const initialTheme = localStorage.getItem("theme");
  if (initialTheme === "dark" || (!initialTheme && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    if (document.documentElement) document.documentElement.classList.add("dark-mode");
    if (document.body) document.body.classList.add("dark-mode");
  }
} catch {}

// Document-level click handler for .theme-toggle (always works across all pages)
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".theme-toggle");
  if (btn) {
    e.preventDefault();
    toggleTheme();
  }
}, true);

// Initial UI sync on load
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => syncThemeUi());
} else {
  syncThemeUi();
}

window.addEventListener("ovlink:themeChanged", (e) => {
  const newTheme = e.detail.theme;
  const session = getClientSession();
  if (session && session.isLoggedIn) {
    fetch('/api/user/theme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withCsrf({ theme: newTheme }))
    }).catch(() => {});
  }
});


// Yardımcı: CSRF Token al
function getCsrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
}

function withCsrf(body = {}) {
  const token = getCsrfToken();
  if (!token) return body;
  return { ...body, _csrf: token };
}

function pickLang(az, tr, en) {
  return currentLang === "tr" ? tr : (currentLang === "en" ? en : az);
}


async function refreshCsrfToken() {
  try {
    const res = await fetch("/api/csrf", { credentials: "include" });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    if (!data || !data.csrfToken) return null;
    let meta = document.querySelector('meta[name="csrf-token"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "csrf-token");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", data.csrfToken);
    return data.csrfToken;
  } catch {
    return null;
  }
}

async function postJsonWithCsrf(url, body) {
  const makeRequest = () =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "x-csrf-token": getCsrfToken(),
      },
      credentials: "include",
      body: JSON.stringify(withCsrf(body)),
    });

  let res = await makeRequest();
  if (res.status === 403) {
    const peek = await res.clone().json().catch(() => ({}));
    const msg = ((peek && (peek.error || peek.message)) || "").toString().toLowerCase();
    if (msg.includes("csrf")) {
      await refreshCsrfToken();
      res = await makeRequest();
    }
  }
  return res;
}

function formatDuration(ms, lang) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "";
  }
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hour = Math.floor(min / 60);
  const day = Math.floor(hour / 24);
  const remHour = hour % 24;
  const remMin = min % 60;

  const isEn = lang === "en";
  const parts = [];
  if (day) {
    const dayLabel = isEn ? (day === 1 ? "day" : "days") : (lang === "tr" ? "gün" : "gün");
    parts.push(`${day} ${dayLabel}`);
  }
  if (remHour) {
    const hourLabel = isEn ? (remHour === 1 ? "hour" : "hours") : (lang === "tr" ? "saat" : "saat");
    parts.push(`${remHour} ${hourLabel}`);
  }
  if (!parts.length || remMin) {
    const minLabel = isEn ? (remMin === 1 ? "minute" : "minutes") : (lang === "tr" ? "dakika" : "dəqiqə");
    parts.push(`${remMin} ${minLabel}`);
  }
  return parts.join(" ");
}

function formatDateTime(iso, lang) {
  if (!iso) return "";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  const locale = lang === "tr" ? "tr-TR" : (lang === "en" ? "en-US" : "az-Latn-AZ");
  const formatted = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(dt);
  return formatted.replace(",", "");
}

function normalizeExpiryInput(raw) {
  const value = (raw || "").toString().trim();
  if (!value) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toISOString();
}

const PRO_UPSELL_TOAST_KEY = "ovlink_pro_upsell_toast_seen_at";
const PRO_UPSELL_TOAST_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PRO_UPSELL_ELIGIBLE_PATHS = new Set(["/", "/account", "/dashboard"]);
const TELEGRAM_SALES_USERNAME = "exlorin";
const FLOATING_PRICING_BANNER_DISMISS_MS = 60 * 60 * 1000;
const FLOATING_PRICING_BANNER_GUEST_ID_KEY = "ovlink_floating_pricing_guest_id";
const FLOATING_PRICING_BANNER_DISMISS_PREFIX = "ovlink_floating_pricing_banner_hidden_until";

function normalizePathname(pathname) {
  const raw = (pathname || "").toString().trim();
  if (!raw || raw === "/") return "/";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function currentPathname() {
  return normalizePathname(window.location && window.location.pathname ? window.location.pathname : "/");
}

function ensurePricingNavLink() {
  const navList = document.querySelector(".navbar .navbar-nav");
  if (!navList) return;

  let item = document.getElementById("navPricingItem");
  if (!item) {
    item = document.createElement("li");
    item.className = "nav-item";
    item.id = "navPricingItem";
    const link = document.createElement("a");
    link.className = "nav-link";
    link.href = "/pricing";

    const icon = document.createElement("i");
    icon.className = "fa-solid fa-crown";
    const text = document.createElement("span");
    text.setAttribute("data-i18n", "nav_pricing");
    text.textContent = "Pro Plan";

    link.appendChild(icon);
    link.appendChild(document.createTextNode(" "));
    link.appendChild(text);
    item.appendChild(link);
  }

  if (item.parentElement === navList) return;

  const guestReg = document.getElementById("navAuthGuestReg");
  const guestLogin = document.getElementById("navAuthGuestLogin");
  if (guestReg && guestReg.parentElement === navList) {
    guestReg.insertAdjacentElement("afterend", item);
  } else if (guestLogin && guestLogin.parentElement === navList) {
    guestLogin.insertAdjacentElement("afterend", item);
  } else {
    navList.appendChild(item);
  }
}

function isProPlanActive() {
  const plan = window.__userPlan;
  if (!plan) return false;
  return (plan.tier || "").toString().toLowerCase() === "pro" && !!plan.isActive;
}

function isFreeUpsellEligible() {
  const s = getClientSession();
  if (!s.isLoggedIn) return false;
  if (!window.__userPlan) return false;
  return !isProPlanActive();
}

function updatePricingBuyCta() {
  const btn = document.getElementById("pricingBuyBtn");
  if (!btn) return;

  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    const isLoggedIn = btn.getAttribute("data-is-logged-in") === "true";
    if (!isLoggedIn) {
      window.location.href = "/login?next=/pricing";
      return;
    }

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Yüklənir...';

    try {
      const res = await postJsonWithCsrf("/api/polar/create-checkout", {});
      const data = await res.json().catch(() => ({}));
      if (data && data.url) {
        window.location.href = data.url;
      } else if (res.status === 401 || (data && data.error === "unauthorized")) {
        window.location.href = "/login?next=/pricing";
      } else {
        alert("Xəta baş verdi: " + (data && data.error ? data.error : "Bilinməyən xəta"));
        btn.disabled = false;
        btn.textContent = originalText;
      }
    } catch (err) {
      alert("Xəta baş verdi. Lütfən yenidən yoxlayın.");
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
}

function updateProManageCta() {
  const btn = document.getElementById("proManageBtn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    const isLoggedIn = btn.getAttribute("data-is-logged-in") === "true";
    if (!isLoggedIn) {
      window.location.href = "/login?next=/pro";
      return;
    }

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Yüklənir...';

    try {
      const res = await postJsonWithCsrf("/api/polar/portal-session", {});
      const data = await res.json().catch(() => ({}));
      if (data && data.url) {
        window.location.href = data.url;
        return;
      }
      if (data && data.error === "no_subscription") {
        alert("Aktiv abunəlik tapılmadı.");
      } else {
        alert("Xəta baş verdi: " + (data && data.error ? data.error : "Bilinməyən xəta"));
      }
    } catch (err) {
      alert("Xəta baş verdi. Lütfən yenidən yoxlayın.");
    }
    btn.disabled = false;
    btn.textContent = originalText;
  });
}

function syncFloatingPricingBanner() {
  const banner = document.getElementById("floatingPricingBanner");
  if (!banner) return;
  bindFloatingPricingBannerClose();

  const path = currentPathname();
  const blockedPath = path === "/pricing" || path === "/pricing.html";
  const shouldHide = blockedPath || isProPlanActive() || isFloatingPricingBannerDismissed();
  banner.classList.toggle("d-none", shouldHide);
}

function getFloatingPricingGuestId() {
  try {
    const existing = localStorage.getItem(FLOATING_PRICING_BANNER_GUEST_ID_KEY);
    if (existing) return existing;
    const created = (window.crypto && typeof window.crypto.randomUUID === "function")
      ? window.crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
    localStorage.setItem(FLOATING_PRICING_BANNER_GUEST_ID_KEY, created);
    return created;
  } catch {
    return "guest";
  }
}

function getFloatingPricingBannerDismissStorageKey() {
  if (Number.isInteger(window.__userId) && window.__userId > 0) {
    return `${FLOATING_PRICING_BANNER_DISMISS_PREFIX}:user:${window.__userId}`;
  }
  return `${FLOATING_PRICING_BANNER_DISMISS_PREFIX}:guest:${getFloatingPricingGuestId()}`;
}

function getFloatingPricingBannerDismissUntil() {
  try {
    const raw = localStorage.getItem(getFloatingPricingBannerDismissStorageKey()) || "";
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function isFloatingPricingBannerDismissed() {
  return getFloatingPricingBannerDismissUntil() > Date.now();
}

function dismissFloatingPricingBannerForOneHour() {
  try {
    const hideUntil = Date.now() + FLOATING_PRICING_BANNER_DISMISS_MS;
    localStorage.setItem(getFloatingPricingBannerDismissStorageKey(), String(hideUntil));
  } catch {}
}

function bindFloatingPricingBannerClose() {
  const banner = document.getElementById("floatingPricingBanner");
  if (!banner || banner.dataset.closeBound === "1") return;
  banner.dataset.closeBound = "1";
  const closeBtn = banner.querySelector("[data-floating-pricing-close]");
  if (!closeBtn) return;

  const dismiss = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dismissFloatingPricingBannerForOneHour();
    syncFloatingPricingBanner();
  };

  closeBtn.addEventListener("click", dismiss);
  closeBtn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      dismiss(e);
    }
  });
}

function initPricingBuyFlow() {
  updatePricingBuyCta();
  updateProManageCta();
  const hint = document.getElementById("pricingBuyHint");
  if (hint) hint.classList.add("d-none");
}

function removeProUpsellUi() {
  const banner = document.getElementById("proUpsellBanner");
  const toast = document.getElementById("proUpsellToast");
  if (banner) banner.remove();
  if (toast) toast.remove();
}

function renderProUpsellBanner() {
  const path = currentPathname();
  if (!PRO_UPSELL_ELIGIBLE_PATHS.has(path) || !isFreeUpsellEligible()) {
    removeProUpsellUi();
    return;
  }
  if (document.getElementById("proUpsellBanner")) return;

  const banner = document.createElement("div");
  banner.id = "proUpsellBanner";
  banner.className = "pro-upsell-banner";
  const title = document.createElement("div");
  title.className = "pro-upsell-banner-title";
  title.setAttribute("data-i18n", "upsell_banner_title");
  title.textContent = "Ovlink Pro ilə daha çox idarəetmə";
  const body = document.createElement("p");
  body.className = "pro-upsell-banner-text mb-2";
  body.setAttribute("data-i18n", "upsell_banner_text");
  body.textContent = "API key, webhook axınları və inkişaf etmiş Pro panel idarəetməsi üçün planı yüksəldin.";
  const cta = document.createElement("a");
  cta.href = "/pricing";
  cta.className = "btn btn-sm btn-primary rounded-pill";
  cta.setAttribute("data-i18n", "upsell_banner_cta");
  cta.textContent = "Pro planı gör";
  banner.appendChild(title);
  banner.appendChild(body);
  banner.appendChild(cta);

  const root = path === "/"
    ? (document.querySelector(".home-form-card") || document.querySelector("#hero .col-lg-8"))
    : (document.querySelector(".app-shell") || document.querySelector(".app-main .container"));

  if (!root) return;

  if (path === "/" && root.parentElement) {
    root.parentElement.insertBefore(banner, root);
  } else {
    const head = root.querySelector(".policy-head");
    if (head && head.parentElement) {
      head.insertAdjacentElement("afterend", banner);
    } else {
      root.prepend(banner);
    }
  }

  if (typeof applyLanguage === "function") applyLanguage();
}

function showProUpsellToast() {
  const existing = document.getElementById("proUpsellToast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "proUpsellToast";
  toast.className = "pro-upsell-toast";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "pro-upsell-toast-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";
  const title = document.createElement("div");
  title.className = "pro-upsell-toast-title";
  title.setAttribute("data-i18n", "upsell_toast_title");
  title.textContent = "Ovlink Pro istəyirsiniz?";
  const body = document.createElement("div");
  body.className = "pro-upsell-toast-body";
  body.setAttribute("data-i18n", "upsell_toast_text");
  body.textContent = "Pro planla API və webhook imkanları açılır. İndi planları müqayisə edin.";
  const link = document.createElement("a");
  link.href = "/pricing";
  link.className = "pro-upsell-toast-link";
  link.setAttribute("data-i18n", "upsell_toast_cta");
  link.textContent = "Pro səhifəsinə keç";
  toast.appendChild(closeBtn);
  toast.appendChild(title);
  toast.appendChild(body);
  toast.appendChild(link);

  document.body.appendChild(toast);
  if (typeof applyLanguage === "function") applyLanguage();

  closeBtn.addEventListener("click", (e) => {
    e.preventDefault();
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 180);
  });

  requestAnimationFrame(() => {
    toast.classList.add("show");
  });
}

function maybeShowProUpsellToast() {
  const path = currentPathname();
  if (!PRO_UPSELL_ELIGIBLE_PATHS.has(path) || !isFreeUpsellEligible()) return;
  const now = Date.now();
  const seenAt = Number.parseInt(localStorage.getItem(PRO_UPSELL_TOAST_KEY) || "0", 10);
  if (Number.isFinite(seenAt) && seenAt > 0 && (now - seenAt) < PRO_UPSELL_TOAST_COOLDOWN_MS) return;
  localStorage.setItem(PRO_UPSELL_TOAST_KEY, String(now));
  showProUpsellToast();
}

function initProUpsellExperience() {
  updatePricingBuyCta();
  initPricingBuyFlow();
  removeProUpsellUi();
  syncFloatingPricingBanner();
}

function applyNotificationLanguage() {
  const items = document.querySelectorAll(".notif-item");
  if (!items.length) return;
  items.forEach((item) => {
    const title = currentLang === "tr"
      ? (item.getAttribute("data-tr-title") || item.getAttribute("data-az-title") || item.getAttribute("data-en-title") || "")
      : (currentLang === "en"
        ? (item.getAttribute("data-en-title") || item.getAttribute("data-az-title") || item.getAttribute("data-tr-title") || "")
        : (item.getAttribute("data-az-title") || item.getAttribute("data-tr-title") || item.getAttribute("data-en-title") || ""));
    const body = currentLang === "tr"
      ? (item.getAttribute("data-tr-body") || item.getAttribute("data-az-body") || item.getAttribute("data-en-body") || "")
      : (currentLang === "en"
        ? (item.getAttribute("data-en-body") || item.getAttribute("data-az-body") || item.getAttribute("data-tr-body") || "")
        : (item.getAttribute("data-az-body") || item.getAttribute("data-tr-body") || item.getAttribute("data-en-body") || ""));
    const created = item.getAttribute("data-created") || "";
    const shortLink = item.getAttribute("data-short") || "";
    const originalLink = item.getAttribute("data-original") || "";

    const titleEl = item.querySelector(".notif-title");
    const bodyEl = item.querySelector(".notif-body");
    const metaEl = item.querySelector(".notif-meta");
    const shortLabelEl = item.querySelector(".notif-short-label");
    const shortValueEl = item.querySelector(".notif-short-value");
    const originalLabelEl = item.querySelector(".notif-original-label");
    const originalValueEl = item.querySelector(".notif-original-value");

    const shortLabel = (translations[currentLang] && translations[currentLang]["notif_short_label"]) || (currentLang === "en" ? "Short link:" : (currentLang === "tr" ? "Kısa link:" : "Qısa link:"));
    const originalLabel = (translations[currentLang] && translations[currentLang]["notif_original_label"]) || (currentLang === "en" ? "Original link:" : (currentLang === "tr" ? "Orijinal link:" : "Orijinal link:"));

    if (titleEl) titleEl.textContent = title;
    if (bodyEl) bodyEl.textContent = body;
    if (metaEl) metaEl.textContent = formatDateTime(created, currentLang) || created;
    if (shortLabelEl) shortLabelEl.textContent = shortLabel;
    if (shortValueEl) shortValueEl.textContent = shortLink || "-";
    if (originalLabelEl) originalLabelEl.textContent = originalLabel;
    if (originalValueEl) originalValueEl.textContent = originalLink || "-";
  });

  const count = document.getElementById("notifCount");
  if (count && window.__unreadNotifCount > 0) {
    const label = (translations[currentLang] && translations[currentLang]["notif_unread_count"]) || (currentLang === "en" ? "Unread" : (currentLang === "tr" ? "Okunmamış" : "Oxunmamış"));
    count.textContent = `${label}: ${window.__unreadNotifCount}`;
  }
}

window.applyNotificationLanguage = applyNotificationLanguage;

function showNotificationToast(notification) {
  if (!notification) return;
  const title = currentLang === "tr" ? (notification.title_tr || notification.title_az || notification.title_en || "") : (currentLang === "en" ? (notification.title_en || notification.title_az || notification.title_tr || "") : (notification.title_az || notification.title_tr || notification.title_en || ""));
  const body = currentLang === "tr" ? (notification.body_tr || notification.body_az || notification.body_en || "") : (currentLang === "en" ? (notification.body_en || notification.body_az || notification.body_tr || "") : (notification.body_az || notification.body_tr || notification.body_en || ""));
  const shortLabel = (translations[currentLang] && translations[currentLang]["notif_short_label"]) || (currentLang === "en" ? "Short link:" : (currentLang === "tr" ? "Kısa link:" : "Qısa link:"));
  const originalLabel = (translations[currentLang] && translations[currentLang]["notif_original_label"]) || (currentLang === "en" ? "Original link:" : (currentLang === "tr" ? "Orijinal link:" : "Orijinal link:"));
  const extra = [];
  if (notification.link_short) extra.push(`${shortLabel} ${notification.link_short}`);
  if (notification.original_url) extra.push(`${originalLabel} ${notification.original_url}`);

  let toast = document.getElementById("notifToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "notifToast";
    toast.className = "notif-toast";
    toast.innerHTML = '<div class="notif-toast-title"></div><div class="notif-toast-body"></div>';
    document.body.appendChild(toast);
  }

  const titleEl = toast.querySelector(".notif-toast-title");
  const bodyEl = toast.querySelector(".notif-toast-body");
  if (titleEl) titleEl.textContent = title;
  if (bodyEl) bodyEl.textContent = [body, ...extra].filter(Boolean).join(" • ");

  toast.classList.add("show");
  if (toast.__hideTimer) clearTimeout(toast.__hideTimer);
  toast.__hideTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 6000);
}

function maybeShowNotificationToast(items) {
  if (!Array.isArray(items) || !items.length) return;
  const latest = items[0];
  if (!latest || !latest.id) return;
  const lastSeen = parseInt(localStorage.getItem("notif_last_seen_id") || "0", 10);
  if (latest.id <= lastSeen) return;
  if (latest.read_at) return;
  localStorage.setItem("notif_last_seen_id", String(latest.id));
  showNotificationToast(latest);
}


async function loadNotifications() {
  const list = document.getElementById("notificationsList");
  const empty = document.getElementById("notificationsEmpty");
  const count = document.getElementById("notifCount");
  const navBadge = document.getElementById("navNotifBadge");
  const menuBadge = document.getElementById("navNotifBadgeMenu");
  const pageBadge = document.getElementById("notifPageBadge");

  if (list) list.innerHTML = "";
  if (empty) empty.classList.add("d-none");
  if (count) {
    count.textContent = "";
    count.classList.add("d-none");
  }

  const setBadge = (el, value) => {
    if (!el) return;
    if (value > 0) {
      el.textContent = String(value);
      el.classList.remove("d-none");
    } else {
      el.classList.add("d-none");
    }
  };

  try {
    const res = await fetch("/api/notifications", { credentials: "include" });
    if (!res.ok) throw new Error("load failed");
    const data = await res.json();
    const items = Array.isArray(data.notifications) ? data.notifications : [];

    if (!items.length) {
      window.__unreadNotifCount = 0;
      if (empty) empty.classList.remove("d-none");
      setBadge(navBadge, 0);
      setBadge(menuBadge, 0);
      setBadge(pageBadge, 0);
      return;
    }

    const unreadCount = items.filter((n) => !n.read_at).length;
    window.__unreadNotifCount = unreadCount;
    setBadge(navBadge, unreadCount);
    setBadge(menuBadge, unreadCount);
    setBadge(pageBadge, unreadCount);

    if (count) {
      if (unreadCount > 0) {
        const label = (translations[currentLang] && translations[currentLang]["notif_unread_count"]) || (currentLang === "en" ? "Unread" : (currentLang === "tr" ? "Okunmamış" : "Oxunmamış"));
        count.textContent = `${label}: ${unreadCount}`;
        count.classList.remove("d-none");
      } else {
        count.textContent = "";
        count.classList.add("d-none");
      }
    }

    if (list) {
      items.forEach((n) => {
        const item = document.createElement("div");
        item.className = `notif-item${n.read_at ? "" : " notif-unread"}`;
        item.setAttribute("data-az-title", n.title_az || "");
        item.setAttribute("data-tr-title", n.title_tr || "");
        item.setAttribute("data-en-title", n.title_en || "");
        item.setAttribute("data-az-body", n.body_az || "");
        item.setAttribute("data-tr-body", n.body_tr || "");
        item.setAttribute("data-en-body", n.body_en || "");
        item.setAttribute("data-created", n.created_at || "");
        item.setAttribute("data-short", n.link_short || "");
        item.setAttribute("data-original", n.original_url || "");

        const titleEl = document.createElement("div");
        titleEl.className = "notif-title";

        const bodyEl = document.createElement("div");
        bodyEl.className = "notif-body";

        const linksEl = document.createElement("div");
        linksEl.className = "notif-links";

        const shortRow = document.createElement("div");
        shortRow.className = "notif-link";
        const shortLabel = document.createElement("span");
        shortLabel.className = "notif-short-label notif-label";
        const shortValue = document.createElement("span");
        shortValue.className = "notif-short-value notif-value";
        shortRow.appendChild(shortLabel);
        shortRow.appendChild(document.createTextNode(" "));
        shortRow.appendChild(shortValue);

        const originalRow = document.createElement("div");
        originalRow.className = "notif-link";
        const originalLabel = document.createElement("span");
        originalLabel.className = "notif-original-label notif-label";
        const originalValue = document.createElement("span");
        originalValue.className = "notif-original-value notif-value";
        originalRow.appendChild(originalLabel);
        originalRow.appendChild(document.createTextNode(" "));
        originalRow.appendChild(originalValue);

        linksEl.appendChild(shortRow);
        linksEl.appendChild(originalRow);

        const metaEl = document.createElement("div");
        metaEl.className = "notif-meta";

        item.appendChild(titleEl);
        item.appendChild(bodyEl);
        item.appendChild(linksEl);
        item.appendChild(metaEl);
        list.appendChild(item);
      });

      applyNotificationLanguage();
    }

    maybeShowNotificationToast(items);
  } catch {
    window.__unreadNotifCount = 0;
    setBadge(navBadge, 0);
    setBadge(menuBadge, 0);
    setBadge(pageBadge, 0);
    if (empty) empty.classList.remove("d-none");
  }
}

async function loadProfileSettings() {
  const form = document.getElementById("profileSettingsForm");
  if (!form) return;

  const emailEl = document.getElementById("profileEmail");
  const langEl = document.getElementById("profileLang");
  const themeEl = document.getElementById("profileTheme");
  const notifyReportEl = document.getElementById("notifyReport");
  const notifyLimitEl = document.getElementById("notifyLimit");
  const notifyDisabledEl = document.getElementById("notifyDisabled");

  try {
    const res = await fetch("/api/me", { credentials: "include" });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.user) return;

    if (emailEl) emailEl.value = data.user.email || "";

    const settings = data.user.settings || {};
    if (langEl && settings.ui_lang) langEl.value = settings.ui_lang;
    if (themeEl && settings.ui_theme) themeEl.value = settings.ui_theme;

    if (notifyReportEl) notifyReportEl.checked = settings.notify_report !== false;
    if (notifyLimitEl) notifyLimitEl.checked = settings.notify_limit !== false;
    if (notifyDisabledEl) notifyDisabledEl.checked = settings.notify_disabled !== false;


    const pwdTitle = document.getElementById("passwordSectionTitle");
    const currentGroup = document.getElementById("currentPasswordGroup");
    const pwdBtn = document.getElementById("passwordActionBtn");
    if (pwdTitle || currentGroup || pwdBtn) {
      const hasPassword = data.user.has_password !== false;
      if (!hasPassword) {
        if (currentGroup) currentGroup.classList.add("d-none");
        if (pwdTitle) {
          pwdTitle.setAttribute("data-i18n", "profile_password_create_title");
          pwdTitle.textContent = pickLang("Şifrə yaradın", "Şifre oluştur", "Create a password");
        }
        if (pwdBtn) {
          pwdBtn.setAttribute("data-i18n", "profile_password_create_save");
          pwdBtn.textContent = pickLang("Şifrə yaradın", "Şifre oluştur", "Create password");
        }
      } else {
        if (currentGroup) currentGroup.classList.remove("d-none");
        if (pwdTitle) {
          pwdTitle.setAttribute("data-i18n", "profile_password_title");
        }
        if (pwdBtn) {
          pwdBtn.setAttribute("data-i18n", "profile_password_save");
        }
        if (typeof applyLanguage === 'function') {
          applyLanguage();
        }
      }
    }
  } catch {
    // ignore
  }
}


async function loadActiveSessions() {
  const list = document.getElementById("activeSessionsList");
  const msgEl = document.getElementById("activeSessionsMsg");
  if (!list) return;

  list.innerHTML = "";
  if (msgEl) msgEl.textContent = "";

  try {
    const res = await fetch("/api/user/sessions", { credentials: "include" });
    if (!res.ok) {
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      throw new Error("load_failed");
    }

    const data = await res.json().catch(() => ({}));
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];

    if (!sessions.length) {
      const empty = document.createElement("div");
      empty.className = "text-muted small";
      empty.textContent = pickLang("Aktiv sessiya tapılmadı.", "Aktif oturum bulunamadı.", "No active sessions found.");
      list.appendChild(empty);
      return;
    }

    sessions.forEach((session) => {
      const row = document.createElement("div");
      row.className = "session-item";

      const left = document.createElement("div");
      left.className = "session-main";

      const title = document.createElement("div");
      title.className = "session-device";
      title.textContent = session.device_label || pickLang("Naməlum cihaz", "Bilinmeyen cihaz", "Unknown device");

      const meta = document.createElement("div");
      meta.className = "session-meta";
      const lastSeen = formatDateTime(session.last_seen_at, currentLang) || "-";
      const createdAt = formatDateTime(session.created_at, currentLang) || "-";
      const method = (session.last_login_method || "password").toString();
      const methodLabel = method === "google"
        ? pickLang("Google", "Google", "Google")
        : (method === "verify_email"
          ? pickLang("E-poçt təsdiqi", "E-posta doğrulaması", "Email verification")
          : (method === "session_restore"
            ? pickLang("Sessiya bərpası", "Oturum geri yükleme", "Session restore")
            : pickLang("Parol", "Parola", "Password")));
      const country = session.country || pickLang("Bilinmir", "Bilinmiyor", "Unknown");
      meta.textContent = `${pickLang("Son aktivlik", "Son aktivite", "Last active")}: ${lastSeen} · ${pickLang("Yaradılıb", "Oluşturuldu", "Created")}: ${createdAt} · ${pickLang("Metod", "Yöntem", "Method")}: ${methodLabel} · ${pickLang("Ölkə", "Ülke", "Country")}: ${country}`;

      left.appendChild(title);
      left.appendChild(meta);

      const right = document.createElement("div");
      right.className = "session-actions";

      if (session.is_current) {
        const badge = document.createElement("span");
        badge.className = "badge text-bg-primary";
        badge.textContent = pickLang("Cari sessiya", "Mevcut oturum", "Current session");
        right.appendChild(badge);
      }

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = session.is_current ? "btn btn-sm btn-outline-secondary" : "btn btn-sm btn-outline-danger";
      btn.setAttribute("data-session-revoke-id", String(session.id));
      btn.textContent = session.is_current
        ? pickLang("Bu sessiyadan çıx", "Bu oturumdan çık", "Sign out this session")
        : pickLang("Sessiyanı bağla", "Oturumu kapat", "Revoke session");
      right.appendChild(btn);

      row.appendChild(left);
      row.appendChild(right);
      list.appendChild(row);
    });
  } catch {
    if (msgEl) {
      msgEl.className = "small text-danger";
      msgEl.textContent = pickLang("Sessiyalar yüklənmədi.", "Oturumlar yüklenemedi.", "Sessions could not be loaded.");
    }
  }
}


let customDomainsState = {
  domains: [],
  targetHost: '',
};

function getText(key, fallback) {
  try {
    return (translations[currentLang] && translations[currentLang][key]) || fallback;
  } catch {
    return fallback;
  }
}

function setInlineMessage(el, message, type) {
  if (!el) return;
  el.textContent = message || '';
  if (!message) {
    el.className = 'small mt-3';
    return;
  }
  const styleType = type || 'info';
  el.className = `small mt-3 text-${styleType}`;
}

function formatIsoDateSafe(iso) {
  if (!iso) return '-';
  return formatDateTime(iso, currentLang) || iso;
}

function getDomainStatusLabel(status) {
  const value = (status || '').toString();
  if (value === 'active') return getText('custom_domain_status_active', 'Active');
  if (value === 'pending_routing') return getText('custom_domain_status_pending_routing', 'Pending routing');
  return getText('custom_domain_status_pending_verification', 'Pending verification');
}

function getDomainStatusClass(status) {
  const value = (status || '').toString();
  if (value === 'active') return 'text-bg-success';
  if (value === 'pending_routing') return 'text-bg-warning';
  return 'text-bg-secondary';
}

function updateDomainTargetBadge(targetHost) {
  const badge = document.getElementById('customDomainTargetBadge');
  if (!badge) return;
  const prefix = getText('custom_domain_target_badge', 'CNAME target');
  badge.textContent = `${prefix}: ${targetHost || '-'}`;
}

function populateCustomDomainSelect(domains) {
  const select = document.getElementById('customDomainSelect');
  if (!select) return;

  const selectedBefore = select.value || '';
  select.innerHTML = '';

  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = getText('shorten_domain_default', 'Default (ovlink.sbs)');
  select.appendChild(defaultOption);

  const activeDomains = (domains || []).filter((d) => (d && d.status === 'active' && d.domain));
  activeDomains.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = d.domain;
    opt.textContent = d.domain;
    select.appendChild(opt);
  });

  if (selectedBefore && activeDomains.some((d) => d.domain === selectedBefore)) {
    select.value = selectedBefore;
  } else {
    select.value = '';
  }

  select.disabled = false;
}

function renderCustomDomainList(domains) {
  const listEl = document.getElementById('customDomainList');
  if (!listEl) return;

  listEl.innerHTML = '';
  const items = Array.isArray(domains) ? domains : [];
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'alert alert-light border small mb-0';
    empty.textContent = getText('custom_domain_empty', 'No custom domains yet.');
    listEl.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'card border-0 shadow-sm custom-domain-card';

    const body = document.createElement('div');
    body.className = 'card-body p-3 p-md-4';

    const header = document.createElement('div');
    header.className = 'd-flex flex-wrap justify-content-between align-items-center gap-2 mb-2';

    const domainTitle = document.createElement('h6');
    domainTitle.className = 'mb-0 fw-bold';
    domainTitle.textContent = item.domain || '-';

    const statusBadge = document.createElement('span');
    statusBadge.className = `badge ${getDomainStatusClass(item.status)}`;
    statusBadge.textContent = getDomainStatusLabel(item.status);

    header.appendChild(domainTitle);
    header.appendChild(statusBadge);

    const meta = document.createElement('div');
    meta.className = 'small text-muted d-grid gap-1 mb-3';

    const createdRow = document.createElement('div');
    createdRow.textContent = `${getText('custom_domain_created', 'Created')}: ${formatIsoDateSafe(item.created_at)}`;
    meta.appendChild(createdRow);

    const verifiedRow = document.createElement('div');
    verifiedRow.textContent = `${getText('custom_domain_verified', 'Verified')}: ${item.verified_at ? formatIsoDateSafe(item.verified_at) : '-'}`;
    meta.appendChild(verifiedRow);

    const checkedRow = document.createElement('div');
    checkedRow.textContent = `${getText('custom_domain_last_checked', 'Last check')}: ${item.last_checked_at ? formatIsoDateSafe(item.last_checked_at) : '-'}`;
    meta.appendChild(checkedRow);

    body.appendChild(header);
    body.appendChild(meta);

    if (item.status !== 'active' && item.verification) {
      const dnsWrap = document.createElement('div');
      dnsWrap.className = 'custom-domain-dns p-3 rounded-3 mb-3';

      const txtLabel = document.createElement('div');
      txtLabel.className = 'small fw-semibold mb-1';
      txtLabel.textContent = getText('custom_domain_txt_record', 'TXT record');
      dnsWrap.appendChild(txtLabel);

      const txtCode = document.createElement('code');
      txtCode.className = 'd-block text-break';
      txtCode.textContent = `${item.verification.txt_host} = ${item.verification.txt_value}`;
      dnsWrap.appendChild(txtCode);

      const cnameLabel = document.createElement('div');
      cnameLabel.className = 'small fw-semibold mt-3 mb-1';
      cnameLabel.textContent = getText('custom_domain_cname_record', 'CNAME record');
      dnsWrap.appendChild(cnameLabel);

      const cnameCode = document.createElement('code');
      cnameCode.className = 'd-block text-break';
      cnameCode.textContent = `${item.domain} -> ${item.verification.cname_target || '-'}`;
      dnsWrap.appendChild(cnameCode);

      body.appendChild(dnsWrap);
    }

    const actions = document.createElement('div');
    actions.className = 'd-flex flex-wrap gap-2';

    const verifyBtn = document.createElement('button');
    verifyBtn.type = 'button';
    verifyBtn.className = 'btn btn-sm btn-outline-primary';
    verifyBtn.setAttribute('data-domain-action', 'verify');
    verifyBtn.setAttribute('data-domain-id', String(item.id));
    verifyBtn.textContent = getText('custom_domain_verify_btn', 'Verify');
    actions.appendChild(verifyBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-sm btn-outline-danger';
    deleteBtn.setAttribute('data-domain-action', 'delete');
    deleteBtn.setAttribute('data-domain-id', String(item.id));
    deleteBtn.textContent = getText('custom_domain_delete_btn', 'Delete');
    actions.appendChild(deleteBtn);

    body.appendChild(actions);
    card.appendChild(body);
    listEl.appendChild(card);
  });
}

function refreshCustomDomainUi() {
  renderCustomDomainList(customDomainsState.domains);
  populateCustomDomainSelect(customDomainsState.domains);
  updateDomainTargetBadge(customDomainsState.targetHost);
}

window.refreshCustomDomainUi = refreshCustomDomainUi;

async function loadCustomDomains() {
  const hasDomainUi = !!document.getElementById('customDomainSelect')
    || !!document.getElementById('customDomainList')
    || !!document.getElementById('customDomainTargetBadge');
  if (!hasDomainUi) return;

  try {
    const res = await fetch('/api/domains', { credentials: 'include' });
    if (!res.ok) {
      customDomainsState = { domains: [], targetHost: '' };
      refreshCustomDomainUi();
      return;
    }

    const data = await res.json().catch(() => ({}));
    customDomainsState = {
      domains: Array.isArray(data.domains) ? data.domains : [],
      targetHost: (data.target_host || '').toString(),
    };

    refreshCustomDomainUi();
  } catch {
    customDomainsState = { domains: [], targetHost: '' };
    refreshCustomDomainUi();
  }
}

let proOverviewState = null;
let proSecretModalInstance = null;
let proSecretRawValue = "";
let proSecretKind = "api_key";

function hideLegacyProRevealBoxes() {
  const apiReveal = document.getElementById("proApiKeyReveal");
  if (apiReveal) {
    apiReveal.classList.add("d-none");
    apiReveal.textContent = "";
  }
  const hookReveal = document.getElementById("proWebhookSecretReveal");
  if (hookReveal) {
    hookReveal.classList.add("d-none");
    hookReveal.textContent = "";
  }
}

function setProSecretCopyMessage(message, type = "") {
  const msgEl = document.getElementById("proSecretCopyMsg");
  if (!msgEl) return;
  msgEl.className = "small mb-2";
  if (type === "success") {
    msgEl.classList.add("text-success");
  } else if (type === "danger") {
    msgEl.classList.add("text-danger");
  } else {
    msgEl.classList.add("text-muted");
  }
  msgEl.textContent = message || "";
}

function updateProSecretToggleButton() {
  const input = document.getElementById("proSecretValue");
  const toggleBtn = document.getElementById("proSecretToggleBtn");
  if (!input || !toggleBtn) return;
  const hidden = input.type === "password";
  const icon = toggleBtn.querySelector("i");
  if (icon) {
    icon.className = hidden ? "fa-solid fa-eye" : "fa-solid fa-eye-slash";
  }
  const label = hidden
    ? getText("pro_secret_show_btn", pickLang("Göstər", "Göster", "Show"))
    : getText("pro_secret_hide_btn", pickLang("Gizlət", "Gizle", "Hide"));
  toggleBtn.setAttribute("aria-label", label);
  toggleBtn.setAttribute("title", label);
}

function updateProSecretModalContent() {
  const titleEl = document.getElementById("proSecretModalTitle");
  const descEl = document.getElementById("proSecretModalDesc");
  const hintEl = document.getElementById("proSecretModalHint");
  const copyBtn = document.getElementById("proSecretCopyBtn");

  if (titleEl) {
    titleEl.textContent = proSecretKind === "webhook"
      ? getText("pro_secret_modal_title_webhook", pickLang("Webhook secret yaradıldı", "Webhook secret oluşturuldu", "Webhook secret created"))
      : getText("pro_secret_modal_title_api_key", pickLang("API açarı yaradıldı", "API anahtarı oluşturuldu", "API key created"));
  }

  if (descEl) {
    descEl.textContent = proSecretKind === "webhook"
      ? getText("pro_secret_modal_desc_webhook", pickLang("Bu webhook secret yalnız bir dəfə göstərilir. İnteqrasiya tərəfdə təhlükəsiz saxlayın.", "Bu webhook secret yalnızca bir kez gösterilir. Entegrasyon tarafında güvenli saklayın.", "This webhook secret is shown only once. Store it securely in your integration."))
      : getText("pro_secret_modal_desc_api_key", pickLang("Bu açar yalnız bir dəfə göstərilir. Təhlükəsiz yerdə saxlayın.", "Bu anahtar yalnızca bir kez gösterilir. Güvenli bir yerde saklayın.", "This key is shown only once. Store it securely."));
  }

  if (hintEl) {
    hintEl.textContent = getText(
      "pro_secret_modal_hint",
      pickLang(
        "Təhlükəsizlik səbəbi ilə bu dəyər sonradan yenidən göstərilmir.",
        "Güvenlik nedeniyle bu değer daha sonra tekrar gösterilmez.",
        "For security reasons, this value cannot be shown again later."
      )
    );
  }

  if (copyBtn) {
    copyBtn.textContent = getText("pro_secret_copy_btn", pickLang("Kopyala", "Kopyala", "Copy"));
  }
}

function openProSecretModal(kind, value) {
  const modalEl = document.getElementById("proSecretModal");
  const input = document.getElementById("proSecretValue");
  if (!modalEl || !input) return;

  const safeValue = (value || "").toString().trim();
  if (!safeValue) return;

  hideLegacyProRevealBoxes();
  proSecretKind = kind === "webhook" ? "webhook" : "api_key";
  proSecretRawValue = safeValue;

  updateProSecretModalContent();
  setProSecretCopyMessage("");

  input.type = "password";
  input.value = proSecretRawValue;
  updateProSecretToggleButton();

  if (!proSecretModalInstance && typeof bootstrap !== "undefined" && bootstrap.Modal) {
    proSecretModalInstance = bootstrap.Modal.getOrCreateInstance(modalEl, {
      backdrop: "static",
      keyboard: false,
    });
  }

  if (proSecretModalInstance) {
    proSecretModalInstance.show();
  } else {
    modalEl.classList.add("show");
    modalEl.style.display = "block";
  }
}

function initProSecretModalBindings() {
  const modalEl = document.getElementById("proSecretModal");
  if (!modalEl) return;
  if (modalEl.dataset.bound === "1") return;
  modalEl.dataset.bound = "1";

  const input = document.getElementById("proSecretValue");
  const toggleBtn = document.getElementById("proSecretToggleBtn");
  const copyBtn = document.getElementById("proSecretCopyBtn");

  if (toggleBtn && input) {
    toggleBtn.addEventListener("click", () => {
      input.type = input.type === "password" ? "text" : "password";
      updateProSecretToggleButton();
    });
  }

  if (copyBtn && input) {
    copyBtn.addEventListener("click", async () => {
      const text = input.value || proSecretRawValue || "";
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        setProSecretCopyMessage(
          getText("pro_secret_copy_success", pickLang("Açar kopyalandı.", "Anahtar kopyalandı.", "Secret copied.")),
          "success"
        );
      } catch {
        setProSecretCopyMessage(
          getText("pro_secret_copy_fail", pickLang("Kopyalama alınmadı.", "Kopyalama başarısız.", "Copy failed.")),
          "danger"
        );
      }
    });
  }

  modalEl.addEventListener("hidden.bs.modal", () => {
    proSecretRawValue = "";
    proSecretKind = "api_key";
    if (input) {
      input.value = "";
      input.type = "password";
    }
    updateProSecretToggleButton();
    setProSecretCopyMessage("");
  });
}

function setProPanelMessage(message, type = "info") {
  const el = document.getElementById("proPanelMsg");
  if (!el) return;
  if (!message) {
    el.className = "small";
    el.textContent = "";
    return;
  }
  el.className = `small text-${type}`;
  el.textContent = message;
}

function formatProPlanMeta(plan, limits) {
  if (!plan) return "";
  const expiresAt = plan.expires_at ? formatDateTime(plan.expires_at, currentLang) : "-";
  const retries = limits && Number.isFinite(limits.webhook_retry_attempts) ? limits.webhook_retry_attempts : 5;
  const keyLimit = limits && Number.isFinite(limits.api_keys_max_active) ? limits.api_keys_max_active : 2;
  const hookLimit = limits && Number.isFinite(limits.webhooks_max_active) ? limits.webhooks_max_active : 10;
  if (plan.tier === "pro" && plan.is_active) {
    return getText(
      "pro_plan_meta_active",
      pickLang(
        `Pro aktivdir. Bitmə: ${expiresAt}. API açar limiti: ${keyLimit}. Webhook limiti: ${hookLimit}. Webhook retry: ${retries}.`,
        `Pro aktif. Bitiş: ${expiresAt}. API anahtarı limiti: ${keyLimit}. Webhook limiti: ${hookLimit}. Webhook retry: ${retries}.`,
        `Pro is active. Expires: ${expiresAt}. API key limit: ${keyLimit}. Webhook limit: ${hookLimit}. Webhook retries: ${retries}.`
      )
    );
  }
  if (plan.tier === "pro" && plan.status === "paused") {
    return getText(
      "pro_plan_meta_paused",
      pickLang(
        "Pro plan pausadadır. Resume edilənə qədər API və webhook istifadəsi bloklanır.",
        "Pro plan duraklatıldı. Devam edene kadar API ve webhook kullanımı engellenir.",
        "Pro plan is paused. API and webhook usage are blocked until resumed."
      )
    );
  }
  if (plan.tier === "pro") {
    return getText(
      "pro_plan_meta_expired",
      pickLang(
        "Pro müddəti bitib. Giriş səviyyəsi Free olaraq tətbiq olunur.",
        "Pro süresi bitti. Erişim Free olarak uygulanır.",
        "Pro has expired. Access is enforced as Free."
      )
    );
  }
  return getText(
    "pro_plan_meta_free",
    pickLang(
      "Hal-hazırda Free plandasınız. Pro bölməsi aktiv planla açılır.",
      "Şu anda Free plandasınız. Pro bölümü aktif planla açılır.",
      "You are currently on Free. The Pro section unlocks with an active plan."
    )
  );
}

function renderProApiKeys(items) {
  const list = document.getElementById("proApiKeyList");
  if (!list) return;
  list.innerHTML = "";

  if (!Array.isArray(items) || !items.length) {
    const empty = document.createElement("div");
    empty.className = "text-muted small";
    empty.textContent = getText("pro_api_keys_empty", pickLang("API açarı yoxdur.", "API anahtarı yok.", "No API keys yet."));
    list.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "pro-item-card border rounded-3 p-2";

    const top = document.createElement("div");
    top.className = "d-flex flex-wrap justify-content-between align-items-center gap-2";
    const name = document.createElement("strong");
    name.className = "pro-item-title";
    name.textContent = item.name || "API key";
    const mask = document.createElement("code");
    mask.className = "pro-item-code";
    mask.textContent = `${item.key_prefix || "ovk_"}...${item.last4 || "----"}`;
    top.appendChild(name);
    top.appendChild(mask);

    const meta = document.createElement("div");
    meta.className = "small text-muted mt-1";
    const created = item.created_at ? formatDateTime(item.created_at, currentLang) : "-";
    const used = item.last_used_at ? formatDateTime(item.last_used_at, currentLang) : getText("pro_api_keys_never_used", "never used");
    meta.textContent = `${getText("pro_created_label", "Created")}: ${created} · ${getText("pro_last_used_label", "Last used")}: ${used}`;

    const actions = document.createElement("div");
    actions.className = "d-flex gap-2 mt-2 flex-wrap";

    if (item.revoked_at) {
      const revoked = document.createElement("span");
      revoked.className = "badge text-bg-secondary";
      revoked.textContent = getText("pro_api_key_revoked", "Revoked");
      actions.appendChild(revoked);
    } else {
      const rotateBtn = document.createElement("button");
      rotateBtn.type = "button";
      rotateBtn.className = "btn btn-sm btn-outline-primary";
      rotateBtn.setAttribute("data-pro-key-action", "rotate");
      rotateBtn.setAttribute("data-pro-key-id", String(item.id));
      rotateBtn.textContent = getText("pro_api_key_rotate_btn", "Rotate");
      actions.appendChild(rotateBtn);

      const revokeBtn = document.createElement("button");
      revokeBtn.type = "button";
      revokeBtn.className = "btn btn-sm btn-outline-danger";
      revokeBtn.setAttribute("data-pro-key-action", "revoke");
      revokeBtn.setAttribute("data-pro-key-id", String(item.id));
      revokeBtn.textContent = getText("pro_api_key_revoke_btn", "Revoke");
      actions.appendChild(revokeBtn);
    }

    row.appendChild(top);
    row.appendChild(meta);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

function normalizeProWebhookLocale(rawValue) {
  const value = (rawValue || "").toString().trim().toLowerCase();
  if (value === "az" || value === "tr" || value === "en" || value === "auto") return value;
  return "auto";
}

const PRO_WEBHOOK_EVENT_OPTIONS = Object.freeze(["link.created", "link.updated", "link.deleted", "webhook.test", "*"]);
const PRO_WEBHOOK_DEFAULT_EVENTS = Object.freeze(["link.created", "link.updated", "link.deleted", "webhook.test"]);

function normalizeProWebhookEvents(rawValue) {
  const source = Array.isArray(rawValue) ? rawValue : `${rawValue || ""}`.split(",");
  const selected = [];
  source.forEach((item) => {
    const value = (item || "").toString().trim().toLowerCase();
    if (!value) return;
    if (!PRO_WEBHOOK_EVENT_OPTIONS.includes(value)) return;
    if (!selected.includes(value)) selected.push(value);
  });
  if (selected.includes("*")) return ["*"];
  if (!selected.length) return [...PRO_WEBHOOK_DEFAULT_EVENTS];
  return selected;
}

function getProWebhookLocaleLabel(localeRaw) {
  const locale = normalizeProWebhookLocale(localeRaw);
  if (locale === "az") return getText("pro_webhook_locale_az", "Azerbaijani");
  if (locale === "tr") return getText("pro_webhook_locale_tr", "Turkish");
  if (locale === "en") return getText("pro_webhook_locale_en", "English");
  return getText("pro_webhook_locale_auto", "Auto (profile language)");
}

function renderProWebhooks(items) {
  const list = document.getElementById("proWebhookList");
  if (!list) return;
  list.innerHTML = "";

  if (!Array.isArray(items) || !items.length) {
    const empty = document.createElement("div");
    empty.className = "text-muted small";
    empty.textContent = getText("pro_webhooks_empty", pickLang("Webhook yoxdur.", "Webhook yok.", "No webhooks yet."));
    list.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "pro-item-card border rounded-3 p-2";
    row.setAttribute("data-pro-webhook-id", String(item.id));
    row.setAttribute("data-pro-webhook-url", item.url || "");
    row.setAttribute("data-pro-webhook-events", Array.isArray(item.events) ? item.events.join(",") : "");
    row.setAttribute("data-pro-webhook-locale", normalizeProWebhookLocale(item.message_locale || "auto"));
    row.setAttribute("data-pro-webhook-template", (item.message_template || "").toString());
    row.setAttribute("data-pro-webhook-v2", item.signature_v2_enabled ? "1" : "0");

    const header = document.createElement("div");
    header.className = "d-flex flex-wrap justify-content-between align-items-center gap-2";

    const left = document.createElement("div");
    left.className = "pro-webhook-main";
    const urlEl = document.createElement("strong");
    urlEl.className = "pro-webhook-url";
    urlEl.textContent = item.url || "-";
    left.appendChild(urlEl);

    const eventsEl = document.createElement("div");
    eventsEl.className = "small text-muted mt-1";
    eventsEl.textContent = `${getText("pro_webhook_events_short", "Events")}: ${(item.events || []).join(", ") || "-"}`;
    left.appendChild(eventsEl);

    const localeEl = document.createElement("div");
    localeEl.className = "small text-muted mt-1";
    localeEl.textContent = `${getText("pro_webhook_locale_short", "Message language")}: ${getProWebhookLocaleLabel(item.message_locale || "auto")}`;
    left.appendChild(localeEl);

    if (item.message_template) {
      const templateEl = document.createElement("div");
      templateEl.className = "small text-muted mt-1";
      const preview = `${item.message_template}`.slice(0, 110);
      templateEl.textContent = `${getText("pro_webhook_template_short", "Template")}: ${preview}`;
      left.appendChild(templateEl);
    }
    if (!item.signature_v2_enabled) {
      const sigWarn = document.createElement("div");
      sigWarn.className = "small text-warning mt-1";
      sigWarn.textContent = getText(
        "pro_webhook_signature_legacy_warning",
        pickLang(
          "Bu webhook köhnə signature rejimindədir. Daha güclü v2 imza üçün secret rotasiya edin.",
          "Bu webhook eski imza modunda. Daha güçlü v2 imza için secret döndürün.",
          "This webhook is in legacy signature mode. Rotate secret to enable stronger v2 signatures."
        )
      );
      left.appendChild(sigWarn);
    }

    const badge = document.createElement("span");
    badge.className = item.is_active ? "badge text-bg-success" : "badge text-bg-secondary";
    badge.textContent = item.is_active ? getText("pro_webhook_active", "Active") : getText("pro_webhook_inactive", "Inactive");

    header.appendChild(left);
    header.appendChild(badge);

    const actions = document.createElement("div");
    actions.className = "d-flex flex-wrap gap-2 mt-2";

    const testBtn = document.createElement("button");
    testBtn.type = "button";
    testBtn.className = "btn btn-sm btn-outline-primary";
    testBtn.setAttribute("data-pro-webhook-action", "test");
    testBtn.setAttribute("data-pro-webhook-id", String(item.id));
    testBtn.textContent = getText("pro_webhook_test_btn", "Test");
    actions.appendChild(testBtn);

    const rotateSecretBtn = document.createElement("button");
    rotateSecretBtn.type = "button";
    rotateSecretBtn.className = "btn btn-sm btn-outline-primary";
    rotateSecretBtn.setAttribute("data-pro-webhook-action", "rotate_secret");
    rotateSecretBtn.setAttribute("data-pro-webhook-id", String(item.id));
    rotateSecretBtn.textContent = getText("pro_webhook_rotate_secret_btn", "Rotate secret");
    actions.appendChild(rotateSecretBtn);

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn btn-sm btn-outline-secondary";
    editBtn.setAttribute("data-pro-webhook-action", "edit");
    editBtn.setAttribute("data-pro-webhook-id", String(item.id));
    editBtn.textContent = getText("pro_webhook_edit_btn", "Edit");
    actions.appendChild(editBtn);

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "btn btn-sm btn-outline-secondary";
    toggleBtn.setAttribute("data-pro-webhook-action", "toggle");
    toggleBtn.setAttribute("data-pro-webhook-id", String(item.id));
    toggleBtn.setAttribute("data-pro-webhook-active", item.is_active ? "1" : "0");
    toggleBtn.textContent = item.is_active ? getText("pro_webhook_disable_btn", "Disable") : getText("pro_webhook_enable_btn", "Enable");
    actions.appendChild(toggleBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn-sm btn-outline-danger";
    deleteBtn.setAttribute("data-pro-webhook-action", "delete");
    deleteBtn.setAttribute("data-pro-webhook-id", String(item.id));
    deleteBtn.textContent = getText("pro_webhook_delete_btn", "Delete");
    actions.appendChild(deleteBtn);

    if (item.url) {
      const copyUrlBtn = document.createElement("button");
      copyUrlBtn.type = "button";
      copyUrlBtn.className = "btn btn-sm btn-outline-secondary";
      copyUrlBtn.setAttribute("data-copy-text", item.url || "");
      copyUrlBtn.textContent = getText("pro_webhook_copy_url_btn", pickLang("URL kopyala", "URL kopyala", "Copy URL"));
      actions.appendChild(copyUrlBtn);
    }

    row.appendChild(header);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

function renderProDeliveries(items) {
  const list = document.getElementById("proDeliveryList");
  if (!list) return;
  list.innerHTML = "";

  if (!Array.isArray(items) || !items.length) {
    const empty = document.createElement("div");
    empty.className = "text-muted small";
    empty.textContent = getText("pro_deliveries_empty", pickLang("Çatdırılma qeydi yoxdur.", "Teslimat kaydı yok.", "No delivery history yet."));
    list.appendChild(empty);
    return;
  }

  items.slice(0, 15).forEach((item) => {
    const row = document.createElement("div");
    row.className = "small pro-item-card border rounded-3 p-2";
    const created = item.created_at ? formatDateTime(item.created_at, currentLang) : "-";
    const retry = item.next_retry_at ? formatDateTime(item.next_retry_at, currentLang) : "-";
    row.textContent = `#${item.id} · ${item.event_type || "-"} · ${item.status || "queued"} · ${getText("pro_attempt_label", "attempt")}: ${item.attempt || 0} · HTTP: ${item.http_status || "-"} · ${created} · ${getText("pro_next_retry_label", "next retry")}: ${retry}`;
    list.appendChild(row);
  });
}

function getProApiUsageErrorTypeLabel(typeRaw) {
  const type = (typeRaw || "").toString().trim().toLowerCase();
  if (type === "rate_limited") return getText("pro_api_usage_err_rate_limited", "Rate limited");
  if (type === "validation" || type === "bad_request") return getText("pro_api_usage_err_validation", "Validation");
  if (type === "unauthorized") return getText("pro_api_usage_err_unauthorized", "Unauthorized");
  if (type === "forbidden") return getText("pro_api_usage_err_forbidden", "Forbidden");
  if (type === "server_error") return getText("pro_api_usage_err_server", "Server error");
  if (type === "conflict") return getText("pro_api_usage_err_conflict", "Conflict");
  if (type === "not_found") return getText("pro_api_usage_err_not_found", "Not found");
  if (type === "client_error") return getText("pro_api_usage_err_client", "Client error");
  return getText("pro_api_usage_err_other", "Other");
}

function renderProApiUsage(apiUsage, limits) {
  const readWindowEl = document.getElementById("proApiUsageReadWindow");
  const readRemainingEl = document.getElementById("proApiUsageReadRemaining");
  const writeWindowEl = document.getElementById("proApiUsageWriteWindow");
  const writeRemainingEl = document.getElementById("proApiUsageWriteRemaining");
  const last24hEl = document.getElementById("proApiUsageLast24h");
  const last24hErrorsEl = document.getElementById("proApiUsageLast24hErrors");
  const errorTypesEl = document.getElementById("proApiUsageErrorTypes");
  const statusCodesEl = document.getElementById("proApiUsageStatusCodes");
  if (!readWindowEl || !writeWindowEl || !last24hEl || !errorTypesEl || !statusCodesEl) return;

  const usage = apiUsage && typeof apiUsage === "object" ? apiUsage : {};
  const readLimit = Number.isFinite(Number(usage.read_limit_per_window))
    ? Number(usage.read_limit_per_window)
    : (Number.isFinite(Number(limits && limits.api_read_limit_per_window)) ? Number(limits.api_read_limit_per_window) : 0);
  const writeLimit = Number.isFinite(Number(usage.write_limit_per_window))
    ? Number(usage.write_limit_per_window)
    : (Number.isFinite(Number(limits && limits.api_write_limit_per_window)) ? Number(limits.api_write_limit_per_window) : 0);
  const readUsed = Number.isFinite(Number(usage.read_used_current_window)) ? Number(usage.read_used_current_window) : 0;
  const writeUsed = Number.isFinite(Number(usage.write_used_current_window)) ? Number(usage.write_used_current_window) : 0;
  const readRemaining = Number.isFinite(Number(usage.read_remaining_current_window)) ? Number(usage.read_remaining_current_window) : Math.max(0, readLimit - readUsed);
  const writeRemaining = Number.isFinite(Number(usage.write_remaining_current_window)) ? Number(usage.write_remaining_current_window) : Math.max(0, writeLimit - writeUsed);
  const last24hTotal = Number.isFinite(Number(usage.last_24h_total)) ? Number(usage.last_24h_total) : 0;
  const last24hErrors = Number.isFinite(Number(usage.last_24h_errors)) ? Number(usage.last_24h_errors) : 0;

  readWindowEl.textContent = `${readUsed} / ${readLimit}`;
  if (readRemainingEl) {
    readRemainingEl.textContent = `${getText("pro_api_usage_remaining", "Remaining")}: ${readRemaining}`;
  }
  writeWindowEl.textContent = `${writeUsed} / ${writeLimit}`;
  if (writeRemainingEl) {
    writeRemainingEl.textContent = `${getText("pro_api_usage_remaining", "Remaining")}: ${writeRemaining}`;
  }
  last24hEl.textContent = `${last24hTotal} ${getText("pro_api_usage_requests_label", "requests")}`;
  if (last24hErrorsEl) {
    last24hErrorsEl.textContent = `${getText("pro_api_usage_errors_label", "Errors")}: ${last24hErrors}`;
  }

  errorTypesEl.innerHTML = "";
  const errorTypes = Array.isArray(usage.error_types) ? usage.error_types : [];
  if (!errorTypes.length) {
    const empty = document.createElement("span");
    empty.className = "text-muted small";
    empty.textContent = getText("pro_api_usage_no_errors", "No API errors in the last 24h.");
    errorTypesEl.appendChild(empty);
  } else {
    errorTypes.forEach((item) => {
      const chip = document.createElement("span");
      chip.className = "badge text-bg-light border";
      chip.textContent = `${getProApiUsageErrorTypeLabel(item && item.type)}: ${Number.parseInt(item && item.count, 10) || 0}`;
      errorTypesEl.appendChild(chip);
    });
  }

  statusCodesEl.innerHTML = "";
  const statusCodes = Array.isArray(usage.status_codes) ? usage.status_codes : [];
  if (!statusCodes.length) {
    const empty = document.createElement("span");
    empty.className = "text-muted small";
    empty.textContent = getText("pro_api_usage_no_status_breakdown", "No HTTP error status to show.");
    statusCodesEl.appendChild(empty);
  } else {
    statusCodes.forEach((item) => {
      const code = Number.parseInt(item && item.code, 10) || 0;
      const count = Number.parseInt(item && item.count, 10) || 0;
      const chip = document.createElement("span");
      chip.className = "badge text-bg-light border";
      chip.textContent = `${code}: ${count}`;
      statusCodesEl.appendChild(chip);
    });
  }
}

function renderProPanel(overview) {
  const badge = document.getElementById("proPlanBadge");
  const meta = document.getElementById("proPlanMeta");
  const locked = document.getElementById("proLockedNotice");
  const wrap = document.getElementById("proFeatureWrap");
  if (!badge || !meta || !locked || !wrap) return;

  const plan = overview && overview.plan ? overview.plan : { tier: "free", status: "active", is_active: false };
  const active = plan && plan.tier === "pro" && plan.is_active;

  if (active) {
    badge.className = "badge text-bg-success";
    badge.textContent = getText("pro_badge_active", "Pro Active");
  } else if (plan.tier === "pro" && plan.status === "paused") {
    badge.className = "badge text-bg-warning";
    badge.textContent = getText("pro_badge_paused", "Pro Paused");
  } else if (plan.tier === "pro") {
    badge.className = "badge text-bg-secondary";
    badge.textContent = getText("pro_badge_expired", "Pro Expired");
  } else {
    badge.className = "badge text-bg-light border";
    badge.textContent = getText("pro_badge_free", "Free Plan");
  }

  meta.textContent = formatProPlanMeta(plan, overview && overview.limits ? overview.limits : null);

  if (active) {
    locked.classList.add("d-none");
    wrap.classList.remove("d-none");
  } else {
    wrap.classList.add("d-none");
    locked.classList.remove("d-none");
  }

  renderProApiKeys(overview && overview.api_keys ? overview.api_keys : []);
  renderProWebhooks(overview && overview.webhooks ? overview.webhooks : []);
  renderProDeliveries(overview && overview.deliveries ? overview.deliveries : []);
  renderProApiUsage(overview && overview.api_usage ? overview.api_usage : null, overview && overview.limits ? overview.limits : null);
}

async function loadProOverview() {
  const panel = document.getElementById("proPanelSection");
  if (!panel) return;

  try {
    const cacheBust = Date.now();
    const res = await fetch(`/api/pro/overview?ts=${cacheBust}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) {
      if (res.status === 401) return;
      const data = await res.json().catch(() => ({}));
      setProPanelMessage(data.error || getText("pro_load_error", pickLang("Pro məlumatları yüklənmədi.", "Pro verileri yüklenemedi.", "Could not load Pro data.")), "danger");
      return;
    }

    const data = await res.json().catch(() => ({}));
    proOverviewState = data || {};
    renderProPanel(proOverviewState);
    setProPanelMessage("");
  } catch {
    setProPanelMessage(getText("pro_load_error", pickLang("Pro məlumatları yüklənmədi.", "Pro verileri yüklenemedi.", "Could not load Pro data.")), "danger");
  }
}

function setClientSession({ email, isAdmin } = {}) {
  localStorage.setItem("isLoggedIn", "1");
  // Hassas verileri localStorage'dan kaldırıyoruz (ZAP bulgusu)
  // Sadece UI için gerekliyse res.locals veya /api/me kullanılmalı
}

function clearClientSession() {
  localStorage.removeItem("isLoggedIn");
  window.__userEmail = "";
  window.__userId = null;
  window.__userPlan = null;
}

function getClientSession() {
  const userNav = document.getElementById("navAuthUser");
  const ssrLoggedIn = !!(userNav && !userNav.classList.contains("d-none"));
  const localLoggedIn = localStorage.getItem("isLoggedIn") === "1";
  const hasWindowUser = !!(window.__userId || window.__userEmail);
  return {
    isLoggedIn: ssrLoggedIn || localLoggedIn || hasWindowUser,
  };
}

async function trySyncSessionFromServer() {
  try {
    const res = await fetch("/api/me", { credentials: "include" });
    if (!res.ok) {
      if (res.status === 401) {
        clearClientSession();
        renderNavbarAuth();
      }
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (data && data.user) {
      setClientSession({
        email: data.user.email,
        isAdmin: !!data.user.isAdmin,
      });
      if (data.user.settings) {
        window.__userSettings = data.user.settings;
        if (data.user.settings.ui_lang) {
          currentLang = data.user.settings.ui_lang;
          localStorage.setItem("lang", currentLang);
        }
        if (data.user.settings.ui_theme) {
          applyTheme(data.user.settings.ui_theme);
        }
        if (typeof applyLanguage === 'function') {
          applyLanguage();
        }
      }
      window.__userEmail = data.user.email || '';
      window.__userId = Number.isInteger(data.user.id) ? data.user.id : null;
      window.__userPlan = {
        tier: (data.user.planTier || "free").toString().toLowerCase(),
        status: (data.user.planStatus || "active").toString().toLowerCase(),
        isActive: !!data.user.proActive,
        expiresAt: data.user.proExpiresAt || null,
      };
      updatePricingBuyCta();
      renderNavbarAuth();
    } else {
      const userNav = document.getElementById("navAuthUser");
      const isSsrPrivatePage = document.body.classList.contains("app-page") || !!document.getElementById("dashboardStats") || !!document.getElementById("profileSettingsForm");
      if (!isSsrPrivatePage) {
        clearClientSession();
        renderNavbarAuth();
      }
    }
  } catch {
    // ignore
  }
}

function renderNavbarAuth() {
  ensurePricingNavLink();
  const loginBtn = document.getElementById("navAuthGuestLogin");
  const regBtn = document.getElementById("navAuthGuestReg");
  const pricingItem = document.getElementById("navPricingItem");
  const user = document.getElementById("navAuthUser");
  const emailEl = document.getElementById("navUserEmail");
  const adminLink = document.getElementById("navAdminLink");

  const s = getClientSession();
  const showPricingForLoggedIn = s.isLoggedIn && !isProPlanActive();
  if (s.isLoggedIn) {
    loginBtn?.classList.add("d-none");
    regBtn?.classList.add("d-none");
    pricingItem?.classList.toggle("d-none", !showPricingForLoggedIn);
    user?.classList.remove("d-none");
    if (emailEl) {
      if (typeof tKey === 'function') {
        emailEl.textContent = tKey("nav_my_account", "Hesabım");
      } else if (typeof getText === 'function') {
        emailEl.textContent = getText("nav_my_account", "Hesabım");
      }
    }
  } else {
    user?.classList.add("d-none");
    loginBtn?.classList.remove("d-none");
    regBtn?.classList.remove("d-none");
    pricingItem?.classList.remove("d-none");
    if (adminLink) adminLink.classList.add("d-none");
  }
  syncFloatingPricingBanner();
}

async function clientLogout() {
  try {
    const res = await postJsonWithCsrf("/api/logout", { lang: currentLang });
    if (!res.ok) throw new Error("logout_failed");
    clearClientSession();
    location.href = "/";
    return;
  } catch {
    await trySyncSessionFromServer();
    renderNavbarAuth();
  }
}

function initScrollReveal() {
  document.documentElement.classList.add("js-reveal");
  const revealElements = document.querySelectorAll(".reveal, .reveal-left, .reveal-right, .reveal-scale, .stagger-children");
  const activateReveal = (el) => el.classList.add("active");

  if (revealElements.length && "IntersectionObserver" in window) {
    const revealObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          activateReveal(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.05, rootMargin: "0px 0px -20px 0px" });

    revealElements.forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight + 100) {
        activateReveal(el);
      } else {
        revealObserver.observe(el);
      }
    });
  } else {
    revealElements.forEach(activateReveal);
  }
}

function initScriptApp() {
  if (localStorage.getItem("theme") === "dark") {
    document.body.classList.add("dark-mode");
  }

  if (!getCsrfToken()) {
    refreshCsrfToken();
  }

  initScrollReveal();
  renderNavbarAuth();
  updatePricingBuyCta();
  initPricingBuyFlow();
  syncFloatingPricingBanner();

  void trySyncSessionFromServer().then(() => {
    renderNavbarAuth();
    initProUpsellExperience();
  });

  const bootNonCritical = async () => {
    const isLoggedIn = getClientSession().isLoggedIn;

    const tasks = [
      loadProfileSettings(),
      loadActiveSessions(),
    ];
    if (isLoggedIn) {
      tasks.push(loadCustomDomains());
      tasks.push(loadProOverview());
    }

    const shouldLoadNotifications = !!document.getElementById("notificationsList")
      || isLoggedIn;
    if (shouldLoadNotifications) {
      tasks.push(loadNotifications());
    }

    await Promise.allSettled(tasks);
    initProUpsellExperience();
    initScrollReveal();
  };

  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(() => {
      void bootNonCritical();
    }, { timeout: 1200 });
  } else {
    setTimeout(() => {
      void bootNonCritical();
    }, 220);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initScriptApp);
} else {
  initScriptApp();
}

  const apiSampleTabs = Array.from(document.querySelectorAll("[data-api-sample-tab]"));
  const apiSamplePanels = Array.from(document.querySelectorAll("[data-api-sample-panel]"));
  if (apiSampleTabs.length && apiSamplePanels.length) {
    const setActiveApiSample = (sampleKey) => {
      const key = (sampleKey || "").toString().trim().toLowerCase();
      apiSampleTabs.forEach((btn) => {
        const btnKey = (btn.getAttribute("data-api-sample-tab") || "").trim().toLowerCase();
        const active = btnKey === key;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
        btn.setAttribute("tabindex", active ? "0" : "-1");
      });

      apiSamplePanels.forEach((panel) => {
        const panelKey = (panel.getAttribute("data-api-sample-panel") || "").trim().toLowerCase();
        const active = panelKey === key;
        panel.classList.toggle("is-active", active);
        panel.hidden = !active;
      });
    };

    apiSampleTabs.forEach((btn) => {
      btn.addEventListener("click", () => {
        setActiveApiSample(btn.getAttribute("data-api-sample-tab"));
      });
    });

    const defaultSampleTab = apiSampleTabs.find((btn) => ((btn.getAttribute("data-api-sample-tab") || "").toLowerCase() === "curl"))
      || apiSampleTabs[0];
    if (defaultSampleTab) {
      setActiveApiSample(defaultSampleTab.getAttribute("data-api-sample-tab"));
    }
  }

  const markAllReadBtn = document.getElementById("notifMarkAllReadBtn");
  if (markAllReadBtn) {
    markAllReadBtn.addEventListener("click", async () => {
      try {
        await postJsonWithCsrf("/api/notifications/mark-all", { status: "read" });
        await loadNotifications();
      } catch {}
    });
  }

  const markAllUnreadBtn = document.getElementById("notifMarkAllUnreadBtn");
  if (markAllUnreadBtn) {
    markAllUnreadBtn.addEventListener("click", async () => {
      try {
        await postJsonWithCsrf("/api/notifications/mark-all", { status: "unread" });
        await loadNotifications();
      } catch {}
    });
  }

  const deleteAllBtn = document.getElementById("notifDeleteAllBtn");
  if (deleteAllBtn) {
    deleteAllBtn.addEventListener("click", async () => {
      const confirmMsg = pickLang("Bütün bildirişlər silinsin?", "Tüm bildirimler silinsin mi?", "Delete all notifications?");
      if (!confirm(confirmMsg)) return;
      try {
        await postJsonWithCsrf("/api/notifications/delete-all", {});
        await loadNotifications();
      } catch {}
    });
  }

  const logoutBtn = document.getElementById("navLogoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", (e) => {
    e.preventDefault();
    clientLogout();
  });

  const activeSessionsList = document.getElementById("activeSessionsList");
  if (activeSessionsList) {
    activeSessionsList.addEventListener("click", async (e) => {
      const revokeBtn = e.target.closest("[data-session-revoke-id]");
      if (!revokeBtn) return;

      const sessionId = parseInt(revokeBtn.getAttribute("data-session-revoke-id") || "0", 10);
      if (!sessionId) return;

      const confirmMsg = pickLang(
        "Bu sessiya bağlansın?",
        "Bu oturum kapatılsın mı?",
        "Revoke this session?"
      );
      if (!confirm(confirmMsg)) return;

      revokeBtn.disabled = true;
      const msgEl = document.getElementById("activeSessionsMsg");

      try {
        const res = await postJsonWithCsrf("/api/user/sessions/revoke", {
          session_id: sessionId,
          lang: currentLang,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (msgEl) {
            msgEl.className = "small text-danger";
            msgEl.textContent = data.error || pickLang("Sessiya bağlana bilmədi.", "Oturum kapatılamadı.", "Session could not be revoked.");
          }
          revokeBtn.disabled = false;
          return;
        }

        if (data.logged_out) {
          window.location.href = "/login";
          return;
        }

        await loadActiveSessions();
      } catch {
        if (msgEl) {
          msgEl.className = "small text-danger";
          msgEl.textContent = pickLang("Sessiya bağlana bilmədi.", "Oturum kapatılamadı.", "Session could not be revoked.");
        }
        revokeBtn.disabled = false;
      }
    });
  }

  const revokeOtherSessionsBtn = document.getElementById("revokeOtherSessionsBtn");
  if (revokeOtherSessionsBtn) {
    revokeOtherSessionsBtn.addEventListener("click", async () => {
      const confirmMsg = pickLang(
        "Cari sessiya xaric digər bütün sessiyalar bağlansın?",
        "Mevcut oturum dışında tüm oturumlar kapatılsın mı?",
        "Revoke all other sessions?"
      );
      if (!confirm(confirmMsg)) return;

      revokeOtherSessionsBtn.disabled = true;
      const msgEl = document.getElementById("activeSessionsMsg");

      try {
        const res = await postJsonWithCsrf("/api/user/sessions/revoke-others", { lang: currentLang });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (msgEl) {
            msgEl.className = "small text-danger";
            msgEl.textContent = data.error || pickLang("Sessiyalar bağlana bilmədi.", "Oturumlar kapatılamadı.", "Sessions could not be revoked.");
          }
          return;
        }

        if (msgEl) {
          msgEl.className = "small text-success";
          msgEl.textContent = pickLang(
            `Digər sessiyalar bağlandı: ${data.revoked || 0}`,
            `Diğer oturumlar kapatıldı: ${data.revoked || 0}`,
            `Other sessions revoked: ${data.revoked || 0}`
          );
        }
        await loadActiveSessions();
      } catch {
        if (msgEl) {
          msgEl.className = "small text-danger";
          msgEl.textContent = pickLang("Sessiyalar bağlana bilmədi.", "Oturumlar kapatılamadı.", "Sessions could not be revoked.");
        }
      } finally {
        revokeOtherSessionsBtn.disabled = false;
      }
    });
  }


  const dashboardSearch = document.getElementById("dashboardSearch");
  const dashboardFilter = document.getElementById("dashboardFilter");
  const dashboardSort = document.getElementById("dashboardSort");
  const dashboardBody = document.getElementById("dashboardTableBody");
  const dashboardNoResults = document.getElementById("dashboardNoResults");
  const dashboardFilterForm = document.getElementById("dashboardFilterForm");
  let dashboardFolderFilter = null;
  let dashboardTagFilter = null;
  let dashboardMetaModal = null;
  let dashboardMetaModalEl = null;
  const dashboardMetaModalState = {
    short: "",
    row: null,
    button: null,
  };

  const normalizeMetaToken = (value) => (value || "").toString().trim().toLocaleLowerCase("en-US");

  const parseMetaTagsFromRow = (row) => {
    const raw = row && row.getAttribute ? row.getAttribute("data-tags-json") : "[]";
    try {
      const parsed = JSON.parse(raw || "[]");
      if (Array.isArray(parsed)) {
        return parsed.map((v) => (v || "").toString().trim()).filter(Boolean);
      }
    } catch {}
    return [];
  };

  const updateDashboardRowMetaAttributes = (row, folderName, tags) => {
    const safeFolder = (folderName || "").toString().trim();
    const safeTags = Array.isArray(tags) ? tags.map((v) => (v || "").toString().trim()).filter(Boolean) : [];
    row.setAttribute("data-folder-raw", safeFolder);
    row.setAttribute("data-folder", normalizeMetaToken(safeFolder));
    row.setAttribute("data-tags-json", JSON.stringify(safeTags));
    row.setAttribute("data-tags", safeTags.map((v) => normalizeMetaToken(v)).join(", "));
  };

  const renderDashboardRowMetaCells = (row) => {
    if (!row) return;
    const cells = row.querySelectorAll("td");
    if (!cells || cells.length < 5) return;
    const folderCell = cells[3];
    const tagsCell = cells[4];
    if (!folderCell || !tagsCell) return;

    const folderRaw = (row.getAttribute("data-folder-raw") || "").trim();
    const tags = parseMetaTagsFromRow(row);

    folderCell.innerHTML = "";
    if (folderRaw) {
      const folderBtn = document.createElement("button");
      folderBtn.type = "button";
      folderBtn.className = "btn btn-sm btn-link p-0 text-decoration-none dashboard-meta-chip";
      folderBtn.setAttribute("data-meta-filter-folder", normalizeMetaToken(folderRaw));
      folderBtn.textContent = folderRaw;
      folderCell.appendChild(folderBtn);
    } else {
      const empty = document.createElement("span");
      empty.className = "text-muted small";
      empty.textContent = "-";
      folderCell.appendChild(empty);
    }

    tagsCell.innerHTML = "";
    if (!tags.length) {
      const empty = document.createElement("span");
      empty.className = "text-muted small";
      empty.textContent = "-";
      tagsCell.appendChild(empty);
      return;
    }

    tags.forEach((tag) => {
      const tagBtn = document.createElement("button");
      tagBtn.type = "button";
      tagBtn.className = "badge rounded-pill text-bg-light border me-1 dashboard-tag-chip";
      tagBtn.setAttribute("data-meta-filter-tag", normalizeMetaToken(tag));
      tagBtn.textContent = tag;
      tagsCell.appendChild(tagBtn);
    });
  };

  const collectDashboardMetaOptions = () => {
    if (!dashboardBody) return { folders: [], tags: [] };
    const rows = Array.from(dashboardBody.querySelectorAll("tr[data-short]"));
    const folders = new Map();
    const tags = new Map();

    rows.forEach((row) => {
      const folderRaw = (row.getAttribute("data-folder-raw") || "").trim();
      if (folderRaw) {
        const token = normalizeMetaToken(folderRaw);
        if (!folders.has(token)) folders.set(token, folderRaw);
      }

      parseMetaTagsFromRow(row).forEach((tag) => {
        const token = normalizeMetaToken(tag);
        if (token && !tags.has(token)) tags.set(token, tag);
      });
    });

    return {
      folders: Array.from(folders.entries()).sort((a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: "base" })),
      tags: Array.from(tags.entries()).sort((a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: "base" })),
    };
  };

  const rebuildDashboardMetaFilterOptions = () => {
    if (!dashboardFolderFilter || !dashboardTagFilter) return;
    const { folders, tags } = collectDashboardMetaOptions();
    const previousFolder = dashboardFolderFilter.value || "all";
    const previousTag = dashboardTagFilter.value || "all";

    dashboardFolderFilter.innerHTML = "";
    const allFolderOption = document.createElement("option");
    allFolderOption.value = "all";
    allFolderOption.textContent = getText("dashboard_meta_all_folders", pickLang("Bütün qovluqlar", "Tüm klasörler", "All folders"));
    dashboardFolderFilter.appendChild(allFolderOption);
    folders.forEach(([token, label]) => {
      const option = document.createElement("option");
      option.value = token;
      option.textContent = label;
      dashboardFolderFilter.appendChild(option);
    });
    dashboardFolderFilter.value = folders.some(([token]) => token === previousFolder) ? previousFolder : "all";

    dashboardTagFilter.innerHTML = "";
    const allTagOption = document.createElement("option");
    allTagOption.value = "all";
    allTagOption.textContent = getText("dashboard_meta_all_tags", pickLang("Bütün teqlər", "Tüm etiketler", "All tags"));
    dashboardTagFilter.appendChild(allTagOption);
    tags.forEach(([token, label]) => {
      const option = document.createElement("option");
      option.value = token;
      option.textContent = label;
      dashboardTagFilter.appendChild(option);
    });
    dashboardTagFilter.value = tags.some(([token]) => token === previousTag) ? previousTag : "all";
  };

  const mountDashboardMetaFilters = () => {
    if (!dashboardFilterForm || !dashboardBody) return;
    let filtersRow = document.getElementById("dashboardMetaFilters");
    if (!filtersRow) {
      filtersRow = document.createElement("div");
      filtersRow.id = "dashboardMetaFilters";
      filtersRow.className = "col-12 d-flex flex-wrap align-items-end gap-2";
      filtersRow.innerHTML = `
        <div class="dashboard-meta-filter-field">
          <label class="form-label small fw-bold text-muted mb-1" for="dashboardFolderFilter" data-i18n="dashboard_meta_filter_folder_label">Qovluq</label>
          <select id="dashboardFolderFilter" class="form-select form-select-sm"></select>
        </div>
        <div class="dashboard-meta-filter-field">
          <label class="form-label small fw-bold text-muted mb-1" for="dashboardTagFilter" data-i18n="dashboard_meta_filter_tag_label">Teq</label>
          <select id="dashboardTagFilter" class="form-select form-select-sm"></select>
        </div>
        <button type="button" id="dashboardMetaFilterClear" class="btn btn-outline-secondary btn-sm" data-i18n="dashboard_meta_filter_clear">Təmizlə</button>
      `;
      dashboardFilterForm.appendChild(filtersRow);
      if (typeof applyLanguage === "function") applyLanguage();
    }

    dashboardFolderFilter = document.getElementById("dashboardFolderFilter");
    dashboardTagFilter = document.getElementById("dashboardTagFilter");
    const clearBtn = document.getElementById("dashboardMetaFilterClear");

    rebuildDashboardMetaFilterOptions();
    dashboardFolderFilter?.addEventListener("change", applyDashboardFilters);
    dashboardTagFilter?.addEventListener("change", applyDashboardFilters);
    clearBtn?.addEventListener("click", () => {
      if (dashboardFolderFilter) dashboardFolderFilter.value = "all";
      if (dashboardTagFilter) dashboardTagFilter.value = "all";
      applyDashboardFilters();
    });
  };

  const buildMetaTagsInput = (raw) => {
    const seen = new Set();
    const out = [];
    (raw || "").split(",").forEach((part) => {
      const value = (part || "").toString().trim();
      const token = normalizeMetaToken(value);
      if (!token || seen.has(token)) return;
      seen.add(token);
      out.push(value.length > 40 ? value.slice(0, 40) : value);
    });
    return out.slice(0, 20);
  };

  const refreshDashboardMetaSuggestions = () => {
    const folderList = document.getElementById("dashboardMetaFolderSuggestions");
    const tagList = document.getElementById("dashboardMetaTagSuggestions");
    if (!folderList || !tagList) return;
    const { folders, tags } = collectDashboardMetaOptions();

    folderList.innerHTML = "";
    folders.forEach(([, label]) => {
      const option = document.createElement("option");
      option.value = label;
      folderList.appendChild(option);
    });

    tagList.innerHTML = "";
    tags.forEach(([, label]) => {
      const option = document.createElement("option");
      option.value = label;
      tagList.appendChild(option);
    });
  };

  function showQuickToast(message, type = 'success') {
    let toast = document.getElementById("ovlinkQuickToast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "ovlinkQuickToast";
      toast.style.cssText = "position:fixed;bottom:24px;right:24px;z-index:999999;padding:12px 22px;border-radius:12px;font-weight:600;font-size:14px;box-shadow:0 10px 25px rgba(0,0,0,0.25);transition:all 0.3s cubic-bezier(0.4, 0, 0.2, 1);opacity:0;transform:translateY(20px);pointer-events:none;";
      document.body.appendChild(toast);
    }
    toast.style.backgroundColor = type === 'danger' ? '#ef4444' : '#10b981';
    toast.style.color = '#ffffff';
    toast.textContent = message;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    if (toast.__timer) clearTimeout(toast.__timer);
    toast.__timer = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(20px)';
    }, 2200);
  }

  function openModalById(modalId) {
    const modalEl = document.getElementById(modalId);
    if (!modalEl) return null;
    if (typeof bootstrap !== 'undefined' && bootstrap.Modal) {
      try {
        const inst = bootstrap.Modal.getOrCreateInstance ? bootstrap.Modal.getOrCreateInstance(modalEl) : new bootstrap.Modal(modalEl);
        if (inst) {
          inst.show();
          return inst;
        }
      } catch (err) {
        console.warn('Bootstrap modal error, using fallback:', err);
      }
    }
    modalEl.style.display = 'block';
    modalEl.classList.add('show');
    modalEl.removeAttribute('aria-hidden');
    modalEl.setAttribute('aria-modal', 'true');
    let backdrop = document.getElementById('modalFallbackBackdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'modalFallbackBackdrop';
      backdrop.className = 'modal-backdrop fade show';
      document.body.appendChild(backdrop);
    }
    return {
      hide: () => closeModalById(modalId)
    };
  }

  function closeModalById(modalId) {
    const modalEl = document.getElementById(modalId);
    if (!modalEl) return;
    if (typeof bootstrap !== 'undefined' && bootstrap.Modal) {
      try {
        const inst = bootstrap.Modal.getInstance ? bootstrap.Modal.getInstance(modalEl) : null;
        if (inst) {
          inst.hide();
          return;
        }
      } catch {}
    }
    modalEl.style.display = 'none';
    modalEl.classList.remove('show');
    modalEl.setAttribute('aria-hidden', 'true');
    modalEl.removeAttribute('aria-modal');
    const backdrop = document.getElementById('modalFallbackBackdrop');
    if (backdrop) backdrop.remove();
  }

  document.addEventListener('click', (e) => {
    const dismissBtn = e.target.closest('[data-bs-dismiss="modal"]');
    if (dismissBtn) {
      const modal = dismissBtn.closest('.modal');
      if (modal) {
        closeModalById(modal.id);
      }
    }
  });

  const dashboardEditModalState = {
    short: "",
    row: null,
    button: null,
  };

  const ensureDashboardEditModal = () => {
    let dashboardEditModalEl = document.getElementById("dashboardEditLinkModal");
    if (!dashboardEditModalEl) {
      const modalWrapper = document.createElement("div");
      modalWrapper.innerHTML = `
        <div class="modal fade" id="dashboardEditLinkModal" tabindex="-1" aria-hidden="true">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title" data-i18n="dashboard_edit_modal_title">Hədəf Linki Yenilə</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
              </div>
              <div class="modal-body">
                <div class="mb-3">
                  <label class="form-label fw-semibold small text-muted">Qısa Kod</label>
                  <input id="dashboardEditShortDisplay" class="form-control bg-light" type="text" readonly disabled>
                </div>
                <div class="mb-3">
                  <label class="form-label fw-semibold" for="dashboardEditOriginalInput" data-i18n="dashboard_edit_url_label">Yeni Hədəf URL</label>
                  <input id="dashboardEditOriginalInput" class="form-control" type="url" placeholder="https://example.com/yeni-link" data-i18n="dashboard_edit_url_placeholder" required>
                </div>
                <div id="dashboardEditMsg" class="small"></div>
              </div>
              <div class="modal-footer">
                <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal" data-i18n="cancel_btn">Ləğv et</button>
                <button type="button" class="btn btn-primary" id="dashboardEditSaveBtn" data-i18n="dashboard_edit_save">Yenilə</button>
              </div>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modalWrapper.firstElementChild);
      dashboardEditModalEl = document.getElementById("dashboardEditLinkModal");
    }
    if (typeof applyLanguage === "function") applyLanguage();

    const saveBtn = document.getElementById("dashboardEditSaveBtn");
    const originalInput = document.getElementById("dashboardEditOriginalInput");
    const msgEl = document.getElementById("dashboardEditMsg");

    if (saveBtn && !saveBtn.dataset.bound) {
      saveBtn.dataset.bound = "1";
      saveBtn.addEventListener("click", async () => {
        if (!dashboardEditModalState.short) return;
        const newUrl = (originalInput?.value || "").trim();
        if (!newUrl) {
          if (msgEl) {
            msgEl.className = "small text-danger";
            msgEl.textContent = pickLang("URL boş ola bilməz.", "URL boş olamaz.", "URL cannot be empty.");
          }
          return;
        }

        saveBtn.disabled = true;
        if (msgEl) {
          msgEl.className = "small text-muted";
          msgEl.textContent = pickLang("Yenilənir...", "Güncelleniyor...", "Updating...");
        }

        try {
          const res = await postJsonWithCsrf("/api/user/link/update", {
            short: dashboardEditModalState.short,
            original: newUrl,
            lang: currentLang,
            _csrf: getCsrfToken()
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            if (msgEl) {
              msgEl.className = "small text-danger";
              msgEl.textContent = data.error || pickLang("Link yenilənə bilmədi.", "Link güncellenemedi.", "Link could not be updated.");
            }
            return;
          }

          if (dashboardEditModalState.row) {
            const originalCell = dashboardEditModalState.row.querySelector("td:nth-child(3)");
            if (originalCell) {
              originalCell.textContent = newUrl;
            }
            dashboardEditModalState.row.setAttribute("data-original", newUrl.toLowerCase());
          }
          if (dashboardEditModalState.button) {
            dashboardEditModalState.button.setAttribute("data-edit-original", encodeURIComponent(newUrl));
          }

          if (msgEl) {
            msgEl.className = "small text-success";
            msgEl.textContent = data.message || pickLang("Link yeniləndi.", "Link güncellendi.", "Link updated.");
          }
          showQuickToast(pickLang("Link yeniləndi!", "Link güncellendi!", "Link updated!"));
          window.setTimeout(() => {
            closeModalById("dashboardEditLinkModal");
          }, 400);
        } catch (err) {
          if (msgEl) {
            msgEl.className = "small text-danger";
            msgEl.textContent = (currentLang === "tr" ? "Hata: " : (currentLang === "en" ? "Error: " : "Xəta: ")) + err.message;
          }
        } finally {
          saveBtn.disabled = false;
        }
      });
    }
  };

  const ensureDashboardMetaModal = () => {
    let dashboardMetaModalEl = document.getElementById("dashboardMetaModal");
    if (!dashboardMetaModalEl) {
      const modalWrapper = document.createElement("div");
      modalWrapper.innerHTML = `
        <div class="modal fade" id="dashboardMetaModal" tabindex="-1" aria-hidden="true">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title" data-i18n="dashboard_meta_modal_title">Qovluq və teq düzəlişi</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
              </div>
              <div class="modal-body">
                <div class="mb-3">
                  <label class="form-label" for="dashboardMetaFolderInput" data-i18n="dashboard_meta_folder_label">Qovluq</label>
                  <input id="dashboardMetaFolderInput" class="form-control" list="dashboardMetaFolderSuggestions" data-i18n="dashboard_meta_folder_placeholder" placeholder="Məs: kampaniyalar">
                  <datalist id="dashboardMetaFolderSuggestions"></datalist>
                </div>
                <div class="mb-2">
                  <label class="form-label" for="dashboardMetaTagsInput" data-i18n="dashboard_meta_tags_label">Teqlər</label>
                  <input id="dashboardMetaTagsInput" class="form-control" list="dashboardMetaTagSuggestions" data-i18n="dashboard_meta_tags_placeholder" placeholder="Məs: reklam, instagram, yaz">
                  <datalist id="dashboardMetaTagSuggestions"></datalist>
                </div>
                <div id="dashboardMetaMsg" class="small"></div>
              </div>
              <div class="modal-footer">
                <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal" data-i18n="dashboard_meta_cancel">Ləğv et</button>
                <button type="button" class="btn btn-primary" id="dashboardMetaSaveBtn" data-i18n="dashboard_meta_save">Yadda saxla</button>
              </div>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modalWrapper.firstElementChild);
      dashboardMetaModalEl = document.getElementById("dashboardMetaModal");
    }
    if (typeof applyLanguage === "function") applyLanguage();

    const saveBtn = document.getElementById("dashboardMetaSaveBtn");
    const folderInput = document.getElementById("dashboardMetaFolderInput");
    const tagsInput = document.getElementById("dashboardMetaTagsInput");
    const msgEl = document.getElementById("dashboardMetaMsg");

    if (saveBtn && !saveBtn.dataset.bound) {
      saveBtn.dataset.bound = "1";
      saveBtn.addEventListener("click", async () => {
        if (!dashboardMetaModalState.short) return;
        const folderName = (folderInput?.value || "").trim();
        const tags = buildMetaTagsInput(tagsInput?.value || "");
        const tagsRaw = tags.join(", ");

        saveBtn.disabled = true;
        if (msgEl) {
          msgEl.className = "small text-muted";
          msgEl.textContent = pickLang("Yadda saxlanılır...", "Kaydediliyor...", "Saving...");
        }
        try {
          const res = await postJsonWithCsrf("/api/user/link/meta", {
            short: dashboardMetaModalState.short,
            folder_name: folderName,
            tags: tagsRaw,
            lang: currentLang,
            _csrf: getCsrfToken(),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            if (msgEl) {
              msgEl.className = "small text-danger";
              msgEl.textContent = data.error || pickLang("Link məlumatları yenilənmədi.", "Link bilgileri güncellenemedi.", "Link metadata could not be updated.");
            }
            return;
          }

          if (dashboardMetaModalState.row) {
            updateDashboardRowMetaAttributes(dashboardMetaModalState.row, folderName, tags);
            renderDashboardRowMetaCells(dashboardMetaModalState.row);
          }
          if (dashboardMetaModalState.button) {
            dashboardMetaModalState.button.setAttribute("data-meta-folder", folderName);
            dashboardMetaModalState.button.setAttribute("data-meta-tags", JSON.stringify(tags));
          }
          rebuildDashboardMetaFilterOptions();
          applyDashboardFilters();

          if (msgEl) {
            msgEl.className = "small text-success";
            msgEl.textContent = data.message || pickLang("Link məlumatları yeniləndi.", "Link bilgileri güncellendi.", "Link metadata updated.");
          }
          showQuickToast(pickLang("Məlumatlar yadda saxlanıldı!", "Bilgiler kaydedildi!", "Metadata updated!"));
          window.setTimeout(() => closeModalById("dashboardMetaModal"), 400);
        } catch (err) {
          if (msgEl) {
            msgEl.className = "small text-danger";
            msgEl.textContent = (currentLang === "tr" ? "Hata: " : (currentLang === "en" ? "Error: " : "Xəta: ")) + err.message;
          }
        } finally {
          saveBtn.disabled = false;
        }
      });
    }
  };

  const ensureDashboardMetaButtons = () => {
    const body = document.getElementById("dashboardTableBody");
    if (!body) return;

    const rows = Array.from(body.querySelectorAll("tr"));
    rows.forEach((row) => {
      if (row.id === "dashboardNoResults") return;

      const actionsHost =
        row.querySelector("td.text-end.pe-4 .d-inline-flex") ||
        row.querySelector("td.text-end .d-inline-flex") ||
        row.querySelector("td.text-end.pe-4") ||
        row.querySelector("td.text-end") ||
        row.querySelector("td:last-child .d-inline-flex") ||
        row.querySelector("td:last-child");
      if (!actionsHost) return;
      if (actionsHost.querySelector("[data-meta-short]")) return;

      let short = (row.getAttribute("data-short") || "").trim();
      if (!short) {
        const shortAnchor = row.querySelector("td:nth-child(2) a");
        if (shortAnchor) {
          const textShort = (shortAnchor.textContent || "").trim();
          if (textShort) short = textShort;
        }
      }
      if (!short) return;

      const metaBtn = document.createElement("button");
      metaBtn.type = "button";
      metaBtn.className = "btn btn-sm btn-light border d-inline-flex align-items-center gap-1";
      metaBtn.setAttribute("data-meta-short", short);
      metaBtn.setAttribute("data-meta-folder", row.getAttribute("data-folder-raw") || "");
      metaBtn.setAttribute("data-meta-tags", row.getAttribute("data-tags-json") || "[]");
      metaBtn.setAttribute("aria-label", "Metadata");

      const icon = document.createElement("i");
      icon.className = "fa-solid fa-tags";
      const label = document.createElement("span");
      label.setAttribute("data-i18n", "dashboard_meta_btn");
      label.textContent = getText("dashboard_meta_btn", pickLang("Qovluq/Teq", "Klasör/Etiket", "Folder/Tags"));

      metaBtn.appendChild(icon);
      metaBtn.appendChild(label);

      const copyBtn = actionsHost.querySelector("[data-copy-text]");
      if (copyBtn) {
        copyBtn.insertAdjacentElement("beforebegin", metaBtn);
      } else {
        actionsHost.appendChild(metaBtn);
      }
    });
  };

  const applyDashboardFilters = () => {
    if (!dashboardBody) return;
    const rows = Array.from(dashboardBody.querySelectorAll("tr[data-short]"));
    const query = (dashboardSearch && dashboardSearch.value || "").trim().toLowerCase();
    const filter = dashboardFilter ? dashboardFilter.value : "all";
    const sort = dashboardSort ? dashboardSort.value : "newest";
    const folderFilter = dashboardFolderFilter ? dashboardFolderFilter.value : "all";
    const tagFilter = dashboardTagFilter ? dashboardTagFilter.value : "all";

    let visible = [];
    rows.forEach((row) => {
      const shortVal = (row.getAttribute("data-short") || "").toLowerCase();
      const originalVal = (row.getAttribute("data-original") || "").toLowerCase();
      const folderVal = (row.getAttribute("data-folder") || "").toLowerCase();
      const tagsVal = (row.getAttribute("data-tags") || "").toLowerCase();
      const folderToken = normalizeMetaToken(row.getAttribute("data-folder-raw") || "");
      const tagTokens = parseMetaTagsFromRow(row).map((tag) => normalizeMetaToken(tag));
      const reports = parseInt(row.getAttribute("data-reports") || "0", 10) || 0;
      const hasPassword = row.getAttribute("data-password") === "1";
      const isDisabled = row.getAttribute("data-disabled") === "1";

      let ok = true;
      if (query) {
        ok = shortVal.includes(query) || originalVal.includes(query) || folderVal.includes(query) || tagsVal.includes(query);
      }
      if (ok && filter === "reported") ok = reports > 0;
      if (ok && filter === "password") ok = hasPassword;
      if (ok && filter === "disabled") ok = isDisabled;
      if (ok && folderFilter !== "all") ok = folderToken === folderFilter;
      if (ok && tagFilter !== "all") ok = tagTokens.includes(tagFilter);

      if (ok) {
        row.classList.remove("d-none");
        visible.push(row);
      } else {
        row.classList.add("d-none");
      }
    });

    const parseDate = (row) => {
      const raw = row.getAttribute("data-created") || "";
      const t = Date.parse(raw);
      return Number.isNaN(t) ? 0 : t;
    };

    visible.sort((a, b) => {
      const ra = parseInt(a.getAttribute("data-reports") || "0", 10) || 0;
      const rb = parseInt(b.getAttribute("data-reports") || "0", 10) || 0;
      const da = parseDate(a);
      const db = parseDate(b);
      if (sort === "oldest") return da - db;
      if (sort === "reports") return (rb - ra) || (db - da);
      return db - da;
    });

    visible.forEach((row) => dashboardBody.appendChild(row));

    if (dashboardNoResults) {
      if (visible.length === 0) {
        dashboardNoResults.classList.remove("d-none");
      } else {
        dashboardNoResults.classList.add("d-none");
      }
    }
  };

  if (dashboardBody) {
    ensureDashboardMetaButtons();
    Array.from(dashboardBody.querySelectorAll("tr[data-short]")).forEach((row) => {
      renderDashboardRowMetaCells(row);
    });
    mountDashboardMetaFilters();
  }

  if (dashboardSearch || dashboardFilter || dashboardSort || dashboardFolderFilter || dashboardTagFilter) {
    dashboardSearch && dashboardSearch.addEventListener("input", applyDashboardFilters);
    dashboardFilter && dashboardFilter.addEventListener("change", applyDashboardFilters);
    dashboardSort && dashboardSort.addEventListener("change", applyDashboardFilters);
    applyDashboardFilters();
  }

  const profileForm = document.getElementById("profileSettingsForm");
  if (profileForm) {
    profileForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msgEl = document.getElementById("profileSettingsMsg");
      const langEl = document.getElementById("profileLang");
      const themeEl = document.getElementById("profileTheme");
      const notifyReportEl = document.getElementById("notifyReport");
      const notifyLimitEl = document.getElementById("notifyLimit");
      const notifyDisabledEl = document.getElementById("notifyDisabled");

      const payload = {
        lang: langEl ? langEl.value : currentLang,
        theme: themeEl ? themeEl.value : (localStorage.getItem("theme") || "light"),
        notify_report: notifyReportEl && notifyReportEl.checked ? "1" : "0",
        notify_limit: notifyLimitEl && notifyLimitEl.checked ? "1" : "0",
        notify_disabled: notifyDisabledEl && notifyDisabledEl.checked ? "1" : "0",
      };

      try {
        const res = await postJsonWithCsrf("/api/user/settings", payload);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (msgEl) {
            msgEl.className = "small text-danger";
            msgEl.textContent = data.error || pickLang("Ayarlar yadda saxlanıla bilmədi.", "Ayarlar kaydedilemedi.", "Settings could not be saved.");
          }
          return;
        }

        if (msgEl) {
          msgEl.className = "small text-success";
          msgEl.textContent = data.message || pickLang("Ayarlar yadda saxlanıldı.", "Ayarlar kaydedildi.", "Settings saved.");
        }

        if (payload.lang) {
          currentLang = payload.lang;
          localStorage.setItem("lang", payload.lang);
          if (typeof applyLanguage === 'function') {
            applyLanguage();
          }
          applyNotificationLanguage();
          await loadActiveSessions();
          await loadProOverview();
        }

        if (payload.theme) {
          applyTheme(payload.theme);
        }
      } catch (err) {
        if (msgEl) {
          msgEl.className = "small text-danger";
          msgEl.textContent = pickLang("Ayarlar yadda saxlanıla bilmədi.", "Ayarlar kaydedilemedi.", "Settings could not be saved.");
        }
      }
    });
  }


const customDomainForm = document.getElementById("customDomainForm");
if (customDomainForm) {
  customDomainForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("customDomainInput");
    const msgEl = document.getElementById("customDomainMsg");
    const domainValue = input ? input.value.trim() : "";

    if (!domainValue) {
      setInlineMessage(msgEl, getText("custom_domain_error_required", pickLang("Domen daxil edin.", "Alan adı girin.", "Enter a domain.")), "danger");
      return;
    }

    try {
      const res = await postJsonWithCsrf("/api/domains/add", { domain: domainValue, lang: currentLang });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInlineMessage(msgEl, data.error || getText("custom_domain_generic_error", pickLang("Əməliyyat uğursuz oldu.", "İşlem başarısız oldu.", "Operation failed.")), "danger");
        return;
      }

      if (input) input.value = "";
      setInlineMessage(msgEl, data.message || getText("custom_domain_added", pickLang("Domen əlavə edildi.", "Alan adı eklendi.", "Domain added.")), "success");
      await loadCustomDomains();
    } catch {
      setInlineMessage(msgEl, getText("custom_domain_generic_error", pickLang("Əməliyyat uğursuz oldu.", "İşlem başarısız oldu.", "Operation failed.")), "danger");
    }
  });
}

const customDomainList = document.getElementById("customDomainList");
if (customDomainList) {
  customDomainList.addEventListener("click", async (e) => {
    const actionBtn = e.target.closest("[data-domain-action]");
    if (!actionBtn) return;

    const action = actionBtn.getAttribute("data-domain-action");
    const domainId = Number.parseInt(actionBtn.getAttribute("data-domain-id") || "", 10);
    const msgEl = document.getElementById("customDomainMsg");
    if (!Number.isInteger(domainId) || domainId <= 0) return;

    if (action === "verify") {
      actionBtn.disabled = true;
      try {
        const res = await postJsonWithCsrf("/api/domains/verify", { domain_id: domainId, lang: currentLang });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setInlineMessage(msgEl, data.error || getText("custom_domain_generic_error", pickLang("Əməliyyat uğursuz oldu.", "İşlem başarısız oldu.", "Operation failed.")), "danger");
        } else {
          setInlineMessage(msgEl, data.message || getText("custom_domain_verified", pickLang("Domen yeniləndi.", "Alan adı güncellendi.", "Domain updated.")), "success");
        }
      } catch {
        setInlineMessage(msgEl, getText("custom_domain_generic_error", pickLang("Əməliyyat uğursuz oldu.", "İşlem başarısız oldu.", "Operation failed.")), "danger");
      } finally {
        actionBtn.disabled = false;
        await loadCustomDomains();
      }
    }

    if (action === "delete") {
      const confirmMsg = getText("custom_domain_delete_confirm", pickLang("Bu domen silinsin? Bu domenə bağlı linklər avtomatik əsas domenə keçəcək.", "Bu alan adı silinsin mi? Bu alana bağlı linkler otomatik ana domaine geçecek.", "Delete this domain? Links assigned to it will move to the default domain."));
      if (!confirm(confirmMsg)) return;

      actionBtn.disabled = true;
      try {
        const res = await postJsonWithCsrf("/api/domains/delete", { domain_id: domainId, lang: currentLang });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setInlineMessage(msgEl, data.error || getText("custom_domain_generic_error", pickLang("Əməliyyat uğursuz oldu.", "İşlem başarısız oldu.", "Operation failed.")), "danger");
        } else {
          setInlineMessage(msgEl, data.message || getText("custom_domain_deleted", pickLang("Domen silindi.", "Alan adı silindi.", "Domain deleted.")), "success");
        }
      } catch {
        setInlineMessage(msgEl, getText("custom_domain_generic_error", pickLang("Əməliyyat uğursuz oldu.", "İşlem başarısız oldu.", "Operation failed.")), "danger");
      } finally {
        actionBtn.disabled = false;
        await loadCustomDomains();
      }
    }
  });
}

  initProSecretModalBindings();

  const proApiKeyForm = document.getElementById("proApiKeyForm");
  if (proApiKeyForm) {
    proApiKeyForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const nameEl = document.getElementById("proApiKeyName");
      const btn = document.getElementById("proApiKeyCreateBtn");
      const name = nameEl ? nameEl.value.trim() : "";
      if (!name) {
        setProPanelMessage(getText("pro_api_key_name_required", pickLang("Açar adı daxil edin.", "Anahtar adı girin.", "Enter a key name.")), "danger");
        return;
      }
      if (btn) btn.disabled = true;
      try {
        const res = await postJsonWithCsrf("/api/pro/api-keys/create", { name, lang: currentLang });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setProPanelMessage(data.error || getText("pro_generic_error", pickLang("Əməliyyat uğursuz oldu.", "İşlem başarısız oldu.", "Operation failed.")), "danger");
          return;
        }
        openProSecretModal("api_key", data.api_key || "");
        if (nameEl) nameEl.value = "";
        setProPanelMessage(data.message || getText("pro_success_saved", "Saved."), "success");
        await loadProOverview();
      } catch {
        setProPanelMessage(getText("pro_generic_error", pickLang("Əməliyyat uğursuz oldu.", "İşlem başarısız oldu.", "Operation failed.")), "danger");
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  const proApiKeyList = document.getElementById("proApiKeyList");
  if (proApiKeyList) {
    proApiKeyList.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-pro-key-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-pro-key-action");
      const keyId = Number.parseInt(btn.getAttribute("data-pro-key-id") || "", 10);
      if (!Number.isInteger(keyId) || keyId <= 0) return;

      if (action === "revoke") {
        const ok = confirm(getText("pro_api_key_revoke_confirm", pickLang("Bu API açarı ləğv edilsin?", "Bu API anahtarı iptal edilsin mi?", "Revoke this API key?")));
        if (!ok) return;
      }

      btn.disabled = true;
      try {
        if (action === "rotate") {
          const res = await postJsonWithCsrf("/api/pro/api-keys/rotate", { key_id: keyId, lang: currentLang });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            setProPanelMessage(data.error || getText("pro_generic_error", pickLang("Əməliyyat uğursuz oldu.", "İşlem başarısız oldu.", "Operation failed.")), "danger");
            return;
          }
          openProSecretModal("api_key", data.api_key || "");
          setProPanelMessage(data.message || getText("pro_success_saved", "Saved."), "success");
        } else if (action === "revoke") {
          const res = await postJsonWithCsrf("/api/pro/api-keys/revoke", { key_id: keyId, lang: currentLang });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            setProPanelMessage(data.error || getText("pro_generic_error", pickLang("Əməliyyat uğursuz oldu.", "İşlem başarısız oldu.", "Operation failed.")), "danger");
            return;
          }
          setProPanelMessage(data.message || getText("pro_success_saved", "Saved."), "success");
        }
        await loadProOverview();
      } catch {
        setProPanelMessage(getText("pro_generic_error", pickLang("Əməliyyat uğursuz oldu.", "İşlem başarısız oldu.", "Operation failed.")), "danger");
      } finally {
        btn.disabled = false;
      }
    });
  }

  const proWebhookForm = document.getElementById("proWebhookForm");
  if (proWebhookForm) {
    const eventsEl = document.getElementById("proWebhookEvents");
    const eventButtons = Array.from(proWebhookForm.querySelectorAll("[data-webhook-event-option]"));
    const templateEl = document.getElementById("proWebhookTemplate");
    const templateTokenButtons = Array.from(proWebhookForm.querySelectorAll("[data-template-token]"));

    const syncWebhookEventButtons = (raw) => {
      const selected = normalizeProWebhookEvents(raw);
      if (eventsEl) eventsEl.value = selected.join(", ");
      const selectedSet = new Set(selected);
      eventButtons.forEach((button) => {
        const value = (button.getAttribute("data-webhook-event-option") || "").toLowerCase();
        const active = selectedSet.has(value);
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      });
    };

    if (eventButtons.length) {
      eventButtons.forEach((button) => {
        button.addEventListener("click", () => {
          const value = (button.getAttribute("data-webhook-event-option") || "").toLowerCase();
          const current = normalizeProWebhookEvents(eventsEl ? eventsEl.value : "");
          let next = current.slice();

          if (value === "*") {
            next = current.includes("*") ? [...PRO_WEBHOOK_DEFAULT_EVENTS] : ["*"];
          } else {
            next = next.filter((eventName) => eventName !== "*");
            if (next.includes(value)) {
              next = next.filter((eventName) => eventName !== value);
            } else {
              next.push(value);
            }
            if (!next.length) next = [...PRO_WEBHOOK_DEFAULT_EVENTS];
          }
          syncWebhookEventButtons(next.join(","));
        });
      });
      syncWebhookEventButtons(eventsEl ? eventsEl.value : "");
    }

    if (templateEl && templateTokenButtons.length) {
      templateTokenButtons.forEach((button) => {
        button.addEventListener("click", () => {
          const token = (button.getAttribute("data-template-token") || "").toString();
          if (!token) return;
          const input = templateEl;
          const currentValue = input.value || "";
          const start = Number.isInteger(input.selectionStart) ? input.selectionStart : currentValue.length;
          const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : currentValue.length;
          input.value = `${currentValue.slice(0, start)}${token}${currentValue.slice(end)}`;
          const nextPos = start + token.length;
          input.focus();
          input.setSelectionRange(nextPos, nextPos);
        });
      });
    }

    proWebhookForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const urlEl = document.getElementById("proWebhookUrl");
      const localeEl = document.getElementById("proWebhookLocale");
      const btn = document.getElementById("proWebhookCreateBtn");
      const url = urlEl ? urlEl.value.trim() : "";
      const events = normalizeProWebhookEvents(eventsEl ? eventsEl.value : "").join(",");
      const messageLocale = normalizeProWebhookLocale(localeEl ? localeEl.value : "auto");
      const messageTemplate = templateEl ? templateEl.value.trim() : "";
      if (!url) {
        setProPanelMessage(getText("pro_webhook_url_required", pickLang("Webhook URL daxil edin.", "Webhook URL girin.", "Enter a webhook URL.")), "danger");
        return;
      }
      if (btn) btn.disabled = true;
      try {
        const res = await postJsonWithCsrf("/api/pro/webhooks/create", {
          url,
          events,
          message_locale: messageLocale,
          message_template: messageTemplate,
          lang: currentLang,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setProPanelMessage(data.error || getText("pro_generic_error", pickLang("Əməliyyat uğursuz oldu.", "İşlem başarısız oldu.", "Operation failed.")), "danger");
          return;
        }
        openProSecretModal("webhook", data.webhook_secret || "");
        if (urlEl) urlEl.value = "";
        syncWebhookEventButtons(PRO_WEBHOOK_DEFAULT_EVENTS.join(","));
        if (localeEl) localeEl.value = "auto";
        if (templateEl) templateEl.value = "";
        setProPanelMessage(data.message || getText("pro_success_saved", "Saved."), "success");
        await loadProOverview();
      } catch {
        setProPanelMessage(getText("pro_generic_error", pickLang("Əməliyyat uğursuz oldu.", "İşlem başarısız oldu.", "Operation failed.")), "danger");
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  const proWebhookList = document.getElementById("proWebhookList");
  if (proWebhookList) {
    proWebhookList.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-pro-webhook-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-pro-webhook-action");
      const hookId = Number.parseInt(btn.getAttribute("data-pro-webhook-id") || "", 10);
      if (!Number.isInteger(hookId) || hookId <= 0) return;
      btn.disabled = true;

      try {
        if (action === "delete") {
          const ok = confirm(getText("pro_webhook_delete_confirm", pickLang("Bu webhook silinsin?", "Bu webhook silinsin mi?", "Delete this webhook?")));
          if (!ok) return;
          const res = await postJsonWithCsrf("/api/pro/webhooks/delete", { webhook_id: hookId, lang: currentLang });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            setProPanelMessage(data.error || getText("pro_generic_error", pickLang("Əməliyyat uğursuz oldu.", "İşlem başarısız oldu.", "Operation failed.")), "danger");
            return;
          }
          setProPanelMessage(data.message || getText("pro_success_saved", "Saved."), "success");
        } else if (action === "test") {
          const res = await postJsonWithCsrf("/api/pro/webhooks/test", { webhook_id: hookId, lang: currentLang });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            setProPanelMessage(data.error || getText("pro_generic_error", pickLang("Əməliyyat uğursuz oldu.", "İşlem başarısız oldu.", "Operation failed.")), "danger");
            return;
          }
          setProPanelMessage(data.message || getText("pro_success_saved", "Saved."), "success");
        } else if (action === "rotate_secret") {
          const ok = confirm(getText(
            "pro_webhook_rotate_secret_confirm",
            pickLang(
              "Webhook secret yenilənsin? Köhnə secret ilə yoxlamalar işləməyəcək.",
              "Webhook secret yenilensin mi? Eski secret ile doğrulamalar çalışmayacak.",
              "Rotate webhook secret? Verifications using the old secret will stop working."
            )
          ));
          if (!ok) return;
          const res = await postJsonWithCsrf("/api/pro/webhooks/rotate-secret", { webhook_id: hookId, lang: currentLang });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            setProPanelMessage(data.error || getText("pro_generic_error", pickLang("Əməliyyat uğursuz oldu.", "İşlem başarısız oldu.", "Operation failed.")), "danger");
            return;
          }
          openProSecretModal("webhook", data.webhook_secret || "");
          setProPanelMessage(data.message || getText("pro_success_saved", "Saved."), "success");
        } else if (action === "toggle") {
          const current = btn.getAttribute("data-pro-webhook-active") === "1";
          const res = await postJsonWithCsrf("/api/pro/webhooks/update", { webhook_id: hookId, is_active: current ? "0" : "1", lang: currentLang });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            setProPanelMessage(data.error || getText("pro_generic_error", pickLang("Əməliyyat uğursuz oldu.", "İşlem başarısız oldu.", "Operation failed.")), "danger");
            return;
          }
          setProPanelMessage(data.message || getText("pro_success_saved", "Saved."), "success");
        } else if (action === "edit") {
          const card = btn.closest("[data-pro-webhook-id]");
          const currentUrl = card ? (card.getAttribute("data-pro-webhook-url") || "") : "";
          const currentEvents = card ? (card.getAttribute("data-pro-webhook-events") || "") : "";
          const currentLocale = card ? normalizeProWebhookLocale(card.getAttribute("data-pro-webhook-locale") || "auto") : "auto";
          const currentTemplate = card ? (card.getAttribute("data-pro-webhook-template") || "") : "";
          const nextUrl = window.prompt(getText("pro_webhook_edit_url_prompt", pickLang("Yeni webhook URL daxil edin:", "Yeni webhook URL girin:", "Enter new webhook URL:")), currentUrl);
          if (nextUrl === null) return;
          const nextEvents = window.prompt(getText("pro_webhook_edit_events_prompt", pickLang("Eventləri vergüllə daxil edin:", "Etkinlikleri virgülle girin:", "Enter events comma-separated:")), currentEvents);
          if (nextEvents === null) return;
          const nextLocaleRaw = window.prompt(
            getText(
              "pro_webhook_edit_locale_prompt",
              pickLang(
                "Mesaj dili daxil edin (auto/az/tr/en):",
                "Mesaj dili girin (auto/az/tr/en):",
                "Enter message locale (auto/az/tr/en):"
              )
            ),
            currentLocale
          );
          if (nextLocaleRaw === null) return;
          const nextLocale = normalizeProWebhookLocale(nextLocaleRaw);
          const nextTemplate = window.prompt(
            getText(
              "pro_webhook_edit_template_prompt",
              pickLang(
                "Öz mesaj şablonu (boş burax = standart):",
                "Özel mesaj şablonu (boş bırak = varsayılan):",
                "Custom message template (leave empty for default):"
              )
            ),
            currentTemplate
          );
          if (nextTemplate === null) return;
          const res = await postJsonWithCsrf("/api/pro/webhooks/update", {
            webhook_id: hookId,
            url: nextUrl,
            events: nextEvents,
            message_locale: nextLocale,
            message_template: nextTemplate,
            lang: currentLang,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            setProPanelMessage(data.error || getText("pro_generic_error", pickLang("Əməliyyat uğursuz oldu.", "İşlem başarısız oldu.", "Operation failed.")), "danger");
            return;
          }
          setProPanelMessage(data.message || getText("pro_success_saved", "Saved."), "success");
        }
        await loadProOverview();
      } catch {
        setProPanelMessage(getText("pro_generic_error", pickLang("Əməliyyat uğursuz oldu.", "İşlem başarısız oldu.", "Operation failed.")), "danger");
      } finally {
        btn.disabled = false;
      }
    });
  }

  window.addEventListener("ovlink:languageChanged", () => {
    if (proOverviewState) {
      renderProPanel(proOverviewState);
    }
    if (proSecretRawValue) {
      updateProSecretModalContent();
      updateProSecretToggleButton();
    }
    updatePricingBuyCta();
    initPricingBuyFlow();
    syncFloatingPricingBanner();
  });

  const passwordForm = document.getElementById("passwordChangeForm");
  if (passwordForm) {
    passwordForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msgEl = document.getElementById("passwordChangeMsg");
      const currentEl = document.getElementById("currentPassword");
      const newEl = document.getElementById("newPassword");
      const confirmEl = document.getElementById("newPasswordConfirm");

      const payload = {
        current_password: currentEl ? currentEl.value : "",
        new_password: newEl ? newEl.value : "",
        new_password_confirm: confirmEl ? confirmEl.value : "",
        lang: currentLang,
      };

      try {
        const res = await postJsonWithCsrf("/api/user/password", payload);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (msgEl) {
            msgEl.className = "small text-danger";
            msgEl.textContent = data.error || pickLang("Şifrə dəyişdirilə bilmədi.", "Şifre değiştirilemedi.", "Password could not be changed.");
          }
          return;
        }

        if (msgEl) {
          msgEl.className = "small text-success";
          msgEl.textContent = data.message || pickLang("Şifrə yeniləndi.", "Şifre güncellendi.", "Password updated.");
        }
        if (currentEl) currentEl.value = "";
        if (newEl) newEl.value = "";
        if (confirmEl) confirmEl.value = "";
      } catch {
        if (msgEl) {
          msgEl.className = "small text-danger";
          msgEl.textContent = pickLang("Şifrə dəyişdirilə bilmədi.", "Şifre değiştirilemedi.", "Password could not be changed.");
        }
      }
    });
  }


  const forgotForm = document.getElementById("forgotPasswordForm");
  if (forgotForm) {
    forgotForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msgEl = document.getElementById("forgotPasswordMsg");
      const emailEl = document.getElementById("forgotEmail");
      const email = emailEl ? emailEl.value.trim() : "";

      try {
        const res = await postJsonWithCsrf("/api/forgot-password", { email, lang: currentLang });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (msgEl) {
            msgEl.className = "text-center small text-danger";
            msgEl.textContent = data.error || pickLang("Sorğu uğursuz oldu.", "İstek başarısız.", "Request failed.");
          }
          return;
        }
        if (msgEl) {
          msgEl.className = "text-center small text-success";
          msgEl.textContent = data.message || pickLang("Link göndərildi.", "Bağlantı gönderildi.", "Link sent.");
        }
      } catch {
        if (msgEl) {
          msgEl.className = "text-center small text-danger";
          msgEl.textContent = pickLang("Sorğu uğursuz oldu.", "İstek başarısız.", "Request failed.");
        }
      }
    });
  }

  const resetForm = document.getElementById("resetPasswordForm");
  if (resetForm) {
    resetForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msgEl = document.getElementById("resetPasswordMsg");
      const tokenEl = document.getElementById("resetToken");
      const passEl = document.getElementById("resetNewPassword");
      const confirmEl = document.getElementById("resetNewPasswordConfirm");

      const payload = {
        token: tokenEl ? tokenEl.value : "",
        new_password: passEl ? passEl.value : "",
        new_password_confirm: confirmEl ? confirmEl.value : "",
        lang: currentLang,
      };

      try {
        const res = await postJsonWithCsrf("/api/reset-password", payload);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (msgEl) {
            msgEl.className = "text-center small text-danger";
            msgEl.textContent = data.error || pickLang("Şifrə sıfırlana bilmədi.", "Şifre sıfırlanamadı.", "Password could not be reset.");
          }
          return;
        }
        if (msgEl) {
          msgEl.className = "text-center small text-success";
          msgEl.textContent = data.message || pickLang("Şifrə yeniləndi.", "Şifre güncellendi.", "Password updated.");
        }
      } catch {
        if (msgEl) {
          msgEl.className = "text-center small text-danger";
          msgEl.textContent = pickLang("Şifrə sıfırlana bilmədi.", "Şifre sıfırlanamadı.", "Password could not be reset.");
        }
      }
    });
  }

  async function copyTextToClipboard(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-999999px";
      textArea.style.top = "-999999px";
      textArea.setAttribute("readonly", "");
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const successful = document.execCommand("copy");
      textArea.remove();
      return !!successful;
    } catch {
      return false;
    }
  }

  // Dashboard ve diger yerlerdeki butonlar (Copy, Edit, Meta, Filtreler)
  document.addEventListener("click", async (e) => {
    // 1. Kopyalama Butonu (Copy)
    const copyBtn = e.target.closest("[data-copy-text], [data-copy-target]");
    if (copyBtn) {
      let text = copyBtn.getAttribute("data-copy-text") || "";
      if (!text) {
        const targetId = copyBtn.getAttribute("data-copy-target") || "";
        if (targetId) {
          const target = document.getElementById(targetId);
          if (target) {
            text = (target.textContent || target.value || "").trim();
          }
        }
      }
      if (!text) return;

      const copied = await copyTextToClipboard(text);
      if (copied) {
        showQuickToast(pickLang("Link kopyalandı!", "Link kopyalandı!", "Link copied!"));
        const icon = copyBtn.querySelector("i");
        const originalIconClass = icon ? icon.className : "";
        if (icon) {
          icon.className = "fa-solid fa-check text-success";
        }
        copyBtn.classList.add("border-success");
        setTimeout(() => {
          if (icon) icon.className = originalIconClass;
          copyBtn.classList.remove("border-success");
        }, 1500);
      }
      return;
    }

    // 2. Qovluq/Teq Modal Butonu (Meta)
    const metaBtn = e.target.closest("[data-meta-short]");
    if (metaBtn) {
      ensureDashboardMetaModal();

      const short = (metaBtn.getAttribute("data-meta-short") || "").trim();
      if (!short) return;
      const folderCurrent = (metaBtn.getAttribute("data-meta-folder") || "").trim();
      const row = metaBtn.closest("tr[data-short]");
      const tagsCurrent = parseMetaTagsFromRow(row || metaBtn);
      const folderInput = document.getElementById("dashboardMetaFolderInput");
      const tagsInput = document.getElementById("dashboardMetaTagsInput");
      const msgEl = document.getElementById("dashboardMetaMsg");

      dashboardMetaModalState.short = short;
      dashboardMetaModalState.row = row || null;
      dashboardMetaModalState.button = metaBtn;

      if (folderInput) folderInput.value = folderCurrent;
      if (tagsInput) tagsInput.value = tagsCurrent.join(", ");
      if (msgEl) {
        msgEl.className = "small";
        msgEl.textContent = "";
      }
      refreshDashboardMetaSuggestions();
      openModalById("dashboardMetaModal");
      return;
    }

    // 3. Link Düzəliş Butonu (Edit)
    const editBtn = e.target.closest("[data-edit-short]");
    if (editBtn) {
      ensureDashboardEditModal();

      const short = (editBtn.getAttribute("data-edit-short") || "").trim();
      if (!short) return;
      const encodedOriginal = editBtn.getAttribute("data-edit-original") || "";
      let currentOriginal = "";
      try { currentOriginal = decodeURIComponent(encodedOriginal); } catch { currentOriginal = ""; }

      const row = editBtn.closest("tr[data-short]");
      if (!currentOriginal && row) {
        const originalCell = row.querySelector("td:nth-child(3)");
        if (originalCell) currentOriginal = (originalCell.textContent || "").trim();
      }

      dashboardEditModalState.short = short;
      dashboardEditModalState.row = row || null;
      dashboardEditModalState.button = editBtn;

      const shortDisplay = document.getElementById("dashboardEditShortDisplay");
      const originalInput = document.getElementById("dashboardEditOriginalInput");
      const msgEl = document.getElementById("dashboardEditMsg");

      if (shortDisplay) shortDisplay.value = short;
      if (originalInput) originalInput.value = currentOriginal;
      if (msgEl) {
        msgEl.className = "small";
        msgEl.textContent = "";
      }

      openModalById("dashboardEditLinkModal");
      return;
    }

    // 4. Folder & Tag Filters
    const folderFilterBtn = e.target.closest("[data-meta-filter-folder]");
    if (folderFilterBtn && dashboardFolderFilter) {
      dashboardFolderFilter.value = folderFilterBtn.getAttribute("data-meta-filter-folder") || "all";
      applyDashboardFilters();
      return;
    }

    const tagFilterBtn = e.target.closest("[data-meta-filter-tag]");
    if (tagFilterBtn && dashboardTagFilter) {
      dashboardTagFilter.value = tagFilterBtn.getAttribute("data-meta-filter-tag") || "all";
      applyDashboardFilters();
      return;
    }
  });

  const bulkSelectAll = document.getElementById("bulkSelectAll");
  if (bulkSelectAll) {
    bulkSelectAll.addEventListener("change", () => {
      const checked = bulkSelectAll.checked;
      document.querySelectorAll(".bulk-select").forEach((cb) => {
        if (!cb.disabled) cb.checked = checked;
      });
    });
  }

  const updateSelectAll = () => {
    if (!bulkSelectAll) return;
    const items = Array.from(document.querySelectorAll(".bulk-select")).filter((cb) => !cb.disabled);
    if (!items.length) {
      bulkSelectAll.checked = false;
      bulkSelectAll.indeterminate = false;
      return;
    }
    const checked = items.filter((cb) => cb.checked).length;
    bulkSelectAll.checked = checked === items.length;
    bulkSelectAll.indeterminate = checked > 0 && checked < items.length;
  };

  document.addEventListener("change", (e) => {
    if (e.target && e.target.classList && e.target.classList.contains("bulk-select")) {
      updateSelectAll();
    }
  });

  const bulkDeleteBtn = document.getElementById("bulkDeleteBtn");
  if (bulkDeleteBtn) {
    bulkDeleteBtn.addEventListener("click", async () => {
      const selected = Array.from(document.querySelectorAll(".bulk-select"))
        .filter((cb) => cb.checked)
        .map((cb) => cb.value);

      if (!selected.length) {
        const msg = pickLang("Zəhmət olmasa silmək üçün link seçin.", "Lütfen silmek için link seçin.", "Please select links to delete.");
        alert(msg);
        return;
      }

      const confirmMsg = pickLang("Seçilən linklər silinsin?", "Seçilen linkler silinsin mi?", "Delete selected links?");
      if (!confirm(confirmMsg)) return;

      try {
        const res = await postJsonWithCsrf("/api/user/delete-bulk", { shorts: selected, lang: currentLang, _csrf: getCsrfToken() });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          alert(data.error || pickLang("Silmə əməliyyatı alınmadı.", "Silme işlemi başarısız.", "Delete operation failed."));
          return;
        }
        location.reload();
      } catch (err) {
        alert((currentLang === "tr" ? "Hata: " : (currentLang === "en" ? "Error: " : "Xəta: ")) + err.message);
      }
    });
  }

  const bulkImportBtn = document.getElementById("bulkImportBtn");
  const bulkImportModalEl = document.getElementById("bulkImportModal");
  const bulkImportSubmit = document.getElementById("bulkImportSubmit");
  const bulkImportInput = document.getElementById("bulkImportInput");
  const bulkImportMsg = document.getElementById("bulkImportMsg");
  const bulkImportResults = document.getElementById("bulkImportResults");
  const bulkImportLinks = document.getElementById("bulkImportLinks");
  const bulkImportCopyAll = document.getElementById("bulkImportCopyAll");
  let bulkImportModal = null;

  if (bulkImportBtn && bulkImportModalEl && typeof bootstrap !== "undefined" && bootstrap.Modal) {
    bulkImportModal = bootstrap.Modal.getOrCreateInstance(bulkImportModalEl);
    bulkImportBtn.addEventListener("click", () => {
      if (bulkImportMsg) bulkImportMsg.textContent = "";
      if (bulkImportResults) bulkImportResults.classList.add("d-none");
      if (bulkImportLinks) bulkImportLinks.innerHTML = "";
      bulkImportModal.show();
    });
  }

  if (bulkImportSubmit && bulkImportInput) {
    bulkImportSubmit.addEventListener("click", async () => {
      const rows = (bulkImportInput.value || "").trim();
      if (!rows) {
        const msg = pickLang("Import üçün ən az bir URL daxil edin.", "İçe aktarma için en az bir URL girin.", "Enter at least one URL.");
        if (bulkImportMsg) {
          bulkImportMsg.className = "small text-danger mt-2";
          bulkImportMsg.textContent = msg;
        } else {
          alert(msg);
        }
        return;
      }

      bulkImportSubmit.disabled = true;
      try {
        const res = await postJsonWithCsrf("/api/user/import", { rows, lang: currentLang, _csrf: getCsrfToken() });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = data.error || pickLang("Import alınmadı.", "İçe aktarma başarısız.", "Import failed.");
          if (bulkImportMsg) {
            bulkImportMsg.className = "small text-danger mt-2";
            bulkImportMsg.textContent = msg;
          } else {
            alert(msg);
          }
          return;
        }

        const okMsg = data.message || pickLang("Import tamamlandı.", "İçe aktarma tamamlandı.", "Import completed.");
        if (bulkImportMsg) {
          bulkImportMsg.className = "small text-success mt-2";
          bulkImportMsg.textContent = okMsg;
        }

        const links = Array.isArray(data.created_links) ? data.created_links : [];
        currentBulkCreatedLinks = links;
        if (bulkImportLinks) {
          bulkImportLinks.innerHTML = "";
          links.forEach((item) => {
            const row = document.createElement("div");
            row.className = "list-group-item d-flex align-items-center justify-content-between gap-2 py-2";

            const left = document.createElement("div");
            left.className = "text-truncate";
            left.style.maxWidth = "70%";
            
            const origDiv = document.createElement("div");
            origDiv.className = "text-muted small text-truncate";
            origDiv.textContent = item.original || "";
            
            const a = document.createElement("a");
            a.href = item.shortUrl;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.className = "text-decoration-none fw-bold";
            a.textContent = item.shortUrl;
            
            left.appendChild(a);
            left.appendChild(origDiv);

            const copyBtn = document.createElement("button");
            copyBtn.type = "button";
            copyBtn.className = "btn btn-sm btn-outline-secondary rounded-pill";
            copyBtn.setAttribute("data-copy-text", item.shortUrl || "");
            copyBtn.innerHTML = `<i class="fa-solid fa-copy me-1"></i>${pickLang("Kopyala", "Kopyala", "Copy")}`;

            row.appendChild(left);
            row.appendChild(copyBtn);
            bulkImportLinks.appendChild(row);
          });
        }

        if (bulkImportResults) {
          if (links.length > 0) bulkImportResults.classList.remove("d-none");
          else bulkImportResults.classList.add("d-none");
        }
      } catch (err) {
        const msg = (currentLang === "tr" ? "Hata: " : (currentLang === "en" ? "Error: " : "Xəta: ")) + err.message;
        if (bulkImportMsg) {
          bulkImportMsg.className = "small text-danger mt-2";
          bulkImportMsg.textContent = msg;
        } else {
          alert(msg);
        }
      } finally {
        bulkImportSubmit.disabled = false;
      }
    });
  }

  let currentBulkCreatedLinks = [];
  const bulkImportDownloadCsv = document.getElementById("bulkImportDownloadCsv");

  if (bulkImportDownloadCsv) {
    bulkImportDownloadCsv.addEventListener("click", () => {
      if (!currentBulkCreatedLinks || !currentBulkCreatedLinks.length) return;
      const header = "Original URL,Short URL,Short Code,Created At\r\n";
      const now = new Date().toISOString();
      const rows = currentBulkCreatedLinks.map(item => {
        const orig = `"${(item.original || '').replace(/"/g, '""')}"`;
        const shortUrl = `"${(item.shortUrl || '').replace(/"/g, '""')}"`;
        const short = `"${(item.short || '').replace(/"/g, '""')}"`;
        return `${orig},${shortUrl},${short},"${now}"`;
      }).join("\r\n");

      const blob = new Blob(["\uFEFF" + header + rows], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ovlink-bulk-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  if (bulkImportCopyAll) {
    bulkImportCopyAll.addEventListener("click", async () => {
      const links = Array.from((bulkImportLinks && bulkImportLinks.querySelectorAll("a")) || []).map((a) => a.href).filter(Boolean);
      if (!links.length) return;
      try {
        await navigator.clipboard.writeText(links.join("\n"));
        if (bulkImportMsg) {
          bulkImportMsg.className = "small text-success mt-2";
          bulkImportMsg.textContent = pickLang("Yaradılan linklər kopyalandı.", "Oluşturulan linkler kopyalandı.", "Created links copied.");
        }
      } catch {
        if (bulkImportMsg) {
          bulkImportMsg.className = "small text-danger mt-2";
          bulkImportMsg.textContent = pickLang("Kopyalama alınmadı.", "Kopyalama başarısız.", "Copy failed.");
        }
      }
    });
  }


  const banUntilEl = document.querySelector(".js-ban-until");
  if (banUntilEl) {
    const iso = banUntilEl.getAttribute("data-iso") || "";
    if (iso) {
      banUntilEl.textContent = formatDateTime(iso, currentLang);
      const remainingEl = document.querySelector(".js-ban-remaining");
      if (remainingEl) {
        const ms = Date.parse(iso) - Date.now();
        const remainingText = formatDuration(ms, currentLang);
        if (remainingText) {
          remainingEl.textContent = remainingText;
        } else {
          remainingEl.textContent = '';
        }
      }
    }
  }

// =========================
// URL Shorten
// =========================
(function initShorten() {
  const form = document.getElementById("shortenForm");
  if (!form) return;

  form.addEventListener("submit", async function (e) {
    e.preventDefault();

    const originalUrl = document.getElementById("originalUrl")?.value?.trim();
    const customAlias = document.getElementById("customAlias")?.value?.trim();
    const linkPassword = document.getElementById("linkPassword")?.value?.trim();
    const selectedCustomDomain = document.getElementById("customDomainSelect")?.value?.trim();

    const resultDiv = document.getElementById("result");
    const shortUrlEl = document.getElementById("shortUrl");
    const hintEl = document.getElementById("shortenHint");

    try {
      const response = await postJsonWithCsrf("/api/shorten", {
        lang: currentLang,
        original: originalUrl,
        customLink: customAlias || undefined,
        custom_domain: selectedCustomDomain || undefined,
        link_password: linkPassword || undefined,
        expires_at: normalizeExpiryInput(document.getElementById("expiresAt")?.value),
        max_clicks: document.getElementById("maxClicks")?.value || undefined
      });

      const data = await response.json().catch(() => ({}));

      const feedbackEl = document.getElementById("shortenFeedback");
      const showFeedback = (msg, isError = true) => {
        if (!feedbackEl) return;
        feedbackEl.textContent = msg;
        feedbackEl.className = `alert mt-3 py-2 mb-0 small fw-bold text-center rounded-pill ${isError ? 'alert-danger' : 'alert-success'}`;
        feedbackEl.classList.remove("d-none");
        // Hata durumunda sonuç alanını gizle
        if (isError && resultDiv) {
          resultDiv.classList.add("hidden", "d-none");
          resultDiv.style.display = "none";
        }
      };

      if (!response.ok || data.error) {
        let errorMsg = data.error || "İşlem başarısız";

        // Sunucudan gelen sabit mesajları yakala ve tercüme et
        if (errorMsg === "Bu xüsusi link istifadə olunub") {
          errorMsg = translations[currentLang]?.error_alias_taken || errorMsg;
        } else if (errorMsg === "Zəhmət olmasa düzgün bir URL daxil edin.") {
          errorMsg = translations[currentLang]?.error_invalid_url || errorMsg;
        }

        // Mesajı doğrudan göster (Xəta/Hata prefixi olmadan)
        showFeedback(errorMsg);
        return;
      }

      // Her yeni başarılı işlemde hatayı gizle
      if (feedbackEl) feedbackEl.classList.add("d-none");

      // 1) Tercih: backend shortUrl veya short alanlari
      let shortLink = data.shortUrl || data.short || null;

      // 2) Eski cevap: message icinden URL yakala
      if (!shortLink && typeof data.message === "string") {
        const match = data.message.match(/https?:\/\/\S+/i);
        if (match) shortLink = match[0];
      }

      // 3) code/alias varsa link uret
      if (!shortLink && data.code) {
        shortLink = `${location.protocol}//${location.host}/${data.code}`;
      }

      if (!shortLink) {
        showFeedback(pickLang("Qısaltma nəticəsi alınmadı.", "Kısaltma sonucu alınamadı.", "Shortening failed."));
        return;
      }

      if (shortUrlEl) {
        shortUrlEl.href = shortLink;
        shortUrlEl.textContent = shortLink;
      }
      if (hintEl) {
        hintEl.textContent = currentLang === 'az'
          ? "Kopyala ilə sürətli paylaşın, QR-ə göndər ilə tək toxunuşla QR yaradın."
          : (currentLang === 'en'
            ? "Share quickly with Copy, generate a QR with Send to QR."
            : "Kopyala ile hızlı paylaş, QR’ye gönder ile tek tık QR üret.");
      }
      if (resultDiv) {
        resultDiv.classList.remove("hidden", "d-none");
        resultDiv.style.display = "block";
      }
    } catch (err) {
      const feedbackEl = document.getElementById("shortenFeedback");
      if (feedbackEl) {
        feedbackEl.textContent = (currentLang === 'az' ? "Server xətası: " : (currentLang === 'en' ? "Server error: " : "Sunucu hatası: ")) + err.message;
        feedbackEl.className = "alert alert-danger mt-3 py-2 mb-0 small fw-bold text-center rounded-pill";
        feedbackEl.classList.remove("d-none");
      }
    }
  });
})();

// =========================
// Copy + Send to QR (optional buttons)
// =========================
document.addEventListener("click", async (e) => {
  const copyBtn = e.target.closest("#copyShortBtn");
  const qrBtn = e.target.closest("#sendToQrBtn");
  if (!copyBtn && !qrBtn) return;
  e.preventDefault();

  const shortUrlEl = document.getElementById("shortUrl");
  const text = shortUrlEl?.textContent?.trim();
  if (!text) return;

  if (copyBtn) {
    try {
      await navigator.clipboard.writeText(text);
      const msg = (translations[currentLang] && translations[currentLang]['copied_msg']) || 'Kopyalandı!';
      copyBtn.innerHTML = `<i class="fa-solid fa-check me-1"></i> ${msg}`;
      setTimeout(() => {
        const btnText = (translations[currentLang] && translations[currentLang]['copy_btn']) || 'Kopyala';
        copyBtn.innerHTML = `<i class="fa-solid fa-copy me-1"></i> ${btnText}`;
      }, 1200);
    } catch {
      console.error("Copy failed");
    }
  }

  if (qrBtn) {
    const shortCode = text.split("/").pop();
    const qrInput = document.getElementById("qrShortLink");
    const qrSection = document.getElementById("qrSection");

    if (qrInput) qrInput.value = shortCode;
    if (typeof window.__ovlinkGenerateQr === "function") {
      void window.__ovlinkGenerateQr(shortCode);
    } else {
      const qrForm = document.getElementById("qrForm");
      if (qrForm) qrForm.requestSubmit ? qrForm.requestSubmit() : qrForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    }

    if (qrSection) {
      const targetTop = Math.max(0, window.scrollY + qrSection.getBoundingClientRect().top - 84);
      window.scrollTo({ top: targetTop, behavior: "smooth" });
    }
  }
});

// =========================
// QR Code
// =========================
(function initQr() {
  const form = document.getElementById("qrForm");
  if (!form) return;

  const qrImage = document.getElementById("qrImage");
  const qrResultDiv = document.getElementById("qrResult");
  const qrFeedback = document.getElementById("qrFeedback");
  const qrDownloadBtn = document.getElementById("qrDownloadBtn");

  const getQrFileName = () => {
    const rawInput = document.getElementById("qrShortLink")?.value?.trim() || "";
    const shortCodeRaw = (rawInput.split("/").pop() || "ovlink-qr").trim();
    const shortCodeSafe = shortCodeRaw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "ovlink-qr";
    return `${shortCodeSafe}-qr.png`;
  };

  const showQrFeedback = (msg, isError = true) => {
    if (!qrFeedback) return;
    qrFeedback.textContent = msg;
    qrFeedback.className = `alert mt-3 py-2 mb-0 small fw-bold text-center rounded-pill ${isError ? 'alert-danger' : 'alert-success'}`;
    qrFeedback.classList.remove("d-none");
    if (isError && qrResultDiv) qrResultDiv.classList.add("hidden");
    if (isError && qrDownloadBtn) qrDownloadBtn.classList.add("d-none");
  };

  if (qrDownloadBtn) {
    qrDownloadBtn.addEventListener("click", () => {
      if (!qrImage || !qrImage.src) {
        showQrFeedback(pickLang("QR kod mövcud deyil.", "QR kod mevcut değil.", "QR code is not available."));
        return;
      }

      try {
        const anchor = document.createElement("a");
        anchor.href = qrImage.src;
        anchor.download = getQrFileName();
        anchor.rel = "noopener";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } catch (err) {
        showQrFeedback(pickLang("QR kod endirilə bilmədi.", "QR kod indirilemedi.", "QR code could not be downloaded."));
      }
    });
  }

  const runQrGeneration = async (forcedShortCode = "") => {
    const qrShortLink = (forcedShortCode || document.getElementById("qrShortLink")?.value || "").trim();

    try {
      const shortCode = (qrShortLink || "").split("/").pop();
      const colorDark = document.getElementById("colorDark")?.value || "#000000";
      const colorLight = document.getElementById("colorLight")?.value || "#ffffff";

      const response = await fetch(`/api/qrcode?short=${encodeURIComponent(shortCode)}&colorDark=${encodeURIComponent(colorDark)}&colorLight=${encodeURIComponent(colorLight)}`);
      const data = await response.json().catch(() => ({}));

      if (data.qrCode && qrImage) {
        if (qrFeedback) qrFeedback.classList.add("d-none");
        qrImage.src = data.qrCode;
        if (qrResultDiv) qrResultDiv.classList.remove("hidden");
        if (qrDownloadBtn) qrDownloadBtn.classList.remove("d-none");
      } else {
        let errorMsg = currentLang === 'az' ? "QR Kod yaradıla bilmədi." : (currentLang === 'en' ? "QR code could not be created." : "QR Kod oluşturulamadı.");
        if (response.status === 404) {
          errorMsg = translations[currentLang]?.error_link_not_found || errorMsg;
        }
        showQrFeedback(errorMsg);
      }
    } catch (err) {
      showQrFeedback((currentLang === 'az' ? "QR Kod yaratma xətası: " : (currentLang === 'en' ? "QR code error: " : "QR Kod oluşturma hatası: ")) + err.message);
    }
  };

  window.__ovlinkGenerateQr = runQrGeneration;

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    await runQrGeneration();
  });
})();

// =========================
// Report
// =========================
(function initReport() {
  const form = document.getElementById("reportForm");
  if (!form) return;

  form.addEventListener("submit", async function (e) {
    e.preventDefault();

    const reportLink = document.getElementById("reportLink")?.value?.trim();
    const reportReason = document.getElementById("reportReason")?.value?.trim();
    const reportMessage = document.getElementById("reportMessage");

    try {
      const response = await postJsonWithCsrf("/api/report", {
        short: reportLink,
        reason: reportReason,
        lang: currentLang
      });

      const data = await response.json().catch(() => ({}));
      if (reportMessage) {
        let displayMsg = data.message || data.error || pickLang("Bilinməyən cavab", "Bilinmeyen yanıt", "Unknown response");

        // Raporlama hatası için de çeviri ekle
        if (displayMsg === "Belə Bir Link Tapılmadı") {
          displayMsg = translations[currentLang]?.error_link_not_found || displayMsg;
        } else if (displayMsg === 'Raporunuz gönderildi.') {
          displayMsg = currentLang === 'az' ? 'Şikayətiniz göndərildi.' : (currentLang === 'en' ? 'Your report has been submitted.' : 'Raporunuz gönderildi.');
        }

        reportMessage.textContent = displayMsg;
        reportMessage.style.color = data.error ? "red" : "green";
      }
    } catch (err) {
      if (reportMessage) {
        reportMessage.textContent = (currentLang === 'az' ? "Xəta: " : (currentLang === 'en' ? "Error: " : "Hata: ") ) + err.message;
        reportMessage.style.color = "red";
      }
    }
  });
})();

/* ========================
   Animations (from home.js)
   ======================== */
(function initAnimations() {
  const revealElements = document.querySelectorAll('.reveal, .reveal-left, .reveal-right, .reveal-scale, .stagger-children');
  
  const activateReveal = (el) => el.classList.add('active');
  
  if (revealElements.length && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          activateReveal(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });
    
    revealElements.forEach(el => {
      if (el.getBoundingClientRect().top < window.innerHeight) {
        activateReveal(el);
      } else {
        observer.observe(el);
      }
    });
  } else {
    revealElements.forEach(activateReveal);
  }

  const particlesContainer = document.getElementById('particlesContainer') || document.querySelector('.particles-container');
  if (particlesContainer && !document.querySelector('.particle')) {
    const particleCount = window.innerWidth < 768 ? 10 : 20;
    for (let i = 0; i < particleCount; i++) {
      const particle = document.createElement('div');
      particle.className = 'particle';
      particle.style.left = Math.random() * 100 + '%';
      particle.style.animationDuration = (Math.random() * 12 + 20) + 's';
      particle.style.animationDelay = (Math.random() * 15) + 's';
      particle.style.willChange = 'transform';
      particlesContainer.appendChild(particle);
    }
  }

  document.querySelectorAll('.btn-animated, .btn-glow').forEach(btn => {
    btn.addEventListener('click', function(e) {
      const ripple = document.createElement('span');
      ripple.className = 'btn-ripple';
      const rect = this.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      ripple.style.width = ripple.style.height = size + 'px';
      ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
      ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
      this.appendChild(ripple);
      setTimeout(() => ripple.remove(), 600);
    });
  });

  document.querySelectorAll('form').forEach(form => {
    form.addEventListener('submit', function() {
      const submitBtn = this.querySelector('button[type="submit"]');
      if (submitBtn && !submitBtn.classList.contains('btn-loading')) {
        submitBtn.classList.add('btn-loading');
        setTimeout(() => submitBtn.classList.remove('btn-loading'), 3000);
      }
    });
  });

  const counterElements = document.querySelectorAll('[data-counter]');
  if (counterElements.length && 'IntersectionObserver' in window) {
    const counterObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const target = parseInt(entry.target.dataset.counter, 10);
          let current = 0;
          const increment = target / 50;
          const timer = setInterval(() => {
            current += increment;
            if (current >= target) {
              entry.target.textContent = target;
              clearInterval(timer);
            } else {
              entry.target.textContent = Math.floor(current);
            }
          }, 30);
          counterObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.5 });
    counterElements.forEach(el => counterObserver.observe(el));
  }

  const animatedInputs = document.querySelectorAll('.form-control-animated');
  animatedInputs.forEach(input => {
    input.addEventListener('focus', () => input.style.transform = 'scale(1.02)');
    input.addEventListener('blur', () => input.style.transform = 'scale(1)');
  });

  document.querySelectorAll('.btn-magnetic').forEach(btn => {
    btn.addEventListener('mousemove', function(e) {
      const rect = this.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width / 2;
      const y = e.clientY - rect.top - rect.height / 2;
      this.style.transform = `translate(${x * 0.15}px, ${y * 0.15}px)`;
    });
    btn.addEventListener('mouseleave', function() {
      this.style.transform = '';
    });
  });

  document.querySelectorAll('.btn-stagger').forEach((btn, i) => {
    btn.style.opacity = '0';
    btn.style.transform = 'translateY(12px)';
    btn.style.transition = 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            setTimeout(() => {
              entry.target.style.opacity = '1';
              entry.target.style.transform = 'translateY(0)';
            }, i * 80);
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.1 });
      observer.observe(btn);
    } else {
      btn.style.opacity = '1';
      btn.style.transform = '';
    }
  });

  // Register PWA Service Worker for App Installation & Offline Caching
  if ('serviceWorker' in navigator && (window.location.protocol === 'https:' || window.location.hostname === 'localhost')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
})();

// =========================
// Workspaces (Pro team accounts) — dashboard switcher + /workspaces management page
// =========================
(function initWorkspaces() {
  const hasWorkspacePage = !!document.getElementById("wsLoading") || !!document.getElementById("wsCreateSection");
  const hasDashboardScope = !!document.getElementById("workspaceScopeSelect");

  function wsEscapeHtml(value) {
    return (value || "").toString().replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[ch]);
  }

  async function wsRequest(method, url, body) {
    const makeRequest = () => fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "Accept": "application/json", "x-csrf-token": getCsrfToken() },
      credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(withCsrf(body || {})),
    });
    let res = await makeRequest();
    if (res.status === 403) {
      const peek = await res.clone().json().catch(() => ({}));
      const msg = ((peek && (peek.error || peek.message)) || "").toString().toLowerCase();
      if (msg.includes("csrf")) {
        await refreshCsrfToken();
        res = await makeRequest();
      }
    }
    return res;
  }

  function setMsg(el, text, isError) {
    if (!el) return;
    el.textContent = text || "";
    el.classList.remove("text-danger", "text-success");
    if (text) el.classList.add(isError === false ? "text-success" : "text-danger");
  }

  function wsRoleLabel(role) {
    if (role === "owner") return pickLang("Sahib", "Sahip", "Owner");
    if (role === "admin") return pickLang("Admin", "Admin", "Admin");
    return pickLang("Üzv", "Üye", "Member");
  }

  // --- Dashboard: workspace scope switcher + quick create ---
  if (hasDashboardScope) {
    const scopeSelect = document.getElementById("workspaceScopeSelect");
    scopeSelect.addEventListener("change", () => {
      const value = scopeSelect.value;
      window.location.href = value ? `/dashboard?ws=${encodeURIComponent(value)}` : "/dashboard";
    });

    const quickForm = document.getElementById("dashboardQuickCreateForm");
    if (quickForm) {
      quickForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const msgEl = document.getElementById("dashboardQuickMsg");
        const urlInput = document.getElementById("dashboardQuickUrl");
        const aliasInput = document.getElementById("dashboardQuickAlias");
        const original = (urlInput.value || "").trim();
        if (!original) return;
        const workspaceId = parseInt(quickForm.getAttribute("data-workspace-id"), 10) || 0;
        const body = { original, lang: (typeof currentLang !== "undefined" ? currentLang : "az") };
        if (workspaceId > 0) body.workspaceId = workspaceId;
        const alias = (aliasInput.value || "").trim();
        if (alias) body.customLink = alias;
        setMsg(msgEl, pickLang("Yaradılır...", "Oluşturuluyor...", "Creating..."));
        try {
          const res = await postJsonWithCsrf("/api/shorten", body);
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMsg(msgEl, (data && data.error) || pickLang("Link qısaldıla bilmədi.", "Link kısaltılamadı.", "Link could not be shortened."), true);
            return;
          }
          setMsg(msgEl, pickLang("Yaradıldı! Yenilənir...", "Oluşturuldu! Yenileniyor...", "Created! Reloading..."), false);
          setTimeout(() => window.location.reload(), 700);
        } catch {
          setMsg(msgEl, pickLang("Şəbəkə xətası.", "Ağ hatası.", "Network error."), true);
        }
      });
    }
  }

  if (!hasWorkspacePage) return;

  const loadingEl = document.getElementById("wsLoading");
  const upsellEl = document.getElementById("wsUpsellSection");
  const createSection = document.getElementById("wsCreateSection");
  const detailSection = document.getElementById("wsDetailSection");
  let wsDetail = null;

  async function loadWorkspaceState() {
    let data = null;
    try {
      const res = await fetch("/api/workspaces", { credentials: "include" });
      if (res.ok) data = await res.json();
    } catch {}
    loadingEl.classList.add("d-none");

    const list = (data && data.workspaces) || [];
    if (!list.length) {
      const isPro = !!(window.__wsPlanIsPro);
      if (isPro) {
        createSection.classList.remove("d-none");
      } else {
        upsellEl.classList.remove("d-none");
      }
      return;
    }
    renderWorkspaceDetail(list[0].id);
  }

  async function renderWorkspaceDetail(workspaceId) {
    let detail = null;
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}`, { credentials: "include" });
      if (res.ok) detail = await res.json();
    } catch {}
    if (!detail) {
      upsellEl.classList.remove("d-none");
      return;
    }
    wsDetail = detail;
    createSection.classList.add("d-none");
    detailSection.classList.remove("d-none");

    document.getElementById("wsDisplayName").textContent = detail.name;
    document.getElementById("wsMyRole").textContent = wsRoleLabel(detail.my_role);
    document.getElementById("wsOpenDashboardBtn").href = `/dashboard?ws=${detail.id}`;

    const isOwner = detail.my_role === "owner";
    const isAdmin = isOwner || detail.my_role === "admin";
    document.getElementById("wsRenameBtn").classList.toggle("d-none", !isOwner);
    document.getElementById("wsInviteCard").classList.toggle("d-none", !isAdmin);
    document.getElementById("wsSsoCard").classList.toggle("d-none", !isAdmin);
    document.getElementById("wsDangerCard").classList.toggle("d-none", !isOwner);
    document.getElementById("wsProWarning").classList.toggle("d-none", !!detail.pro_active);

    const membersBody = document.getElementById("wsMembersBody");
    membersBody.innerHTML = "";
    (detail.members || []).forEach((member) => {
      const tr = document.createElement("tr");
      const canManage = isAdmin && member.role !== "owner" && (isOwner || member.role !== "admin");
      const roleControls = isOwner && member.role !== "owner"
        ? `<select class="form-select form-select-sm w-auto" data-ws-member-role="${member.user_id}">
             <option value="member" ${member.role === "member" ? "selected" : ""}>${wsEscapeHtml(wsRoleLabel("member"))}</option>
             <option value="admin" ${member.role === "admin" ? "selected" : ""}>${wsEscapeHtml(wsRoleLabel("admin"))}</option>
           </select>`
        : wsEscapeHtml(wsRoleLabel(member.role));
      tr.innerHTML = `
        <td class="text-truncate" style="max-width:260px">${wsEscapeHtml(member.email)}</td>
        <td>${roleControls}</td>
        <td class="small text-muted">${member.joined_at ? wsEscapeHtml(new Date(member.joined_at).toLocaleDateString()) : "-"}</td>
        <td class="text-end">${canManage ? `<button type="button" class="btn btn-outline-danger btn-sm rounded-pill" data-ws-remove-member="${member.user_id}">${wsEscapeHtml(pickLang("Çıxar", "Çıkar", "Remove"))}</button>` : "-"}</td>`;
      membersBody.appendChild(tr);
    });

    membersBody.querySelectorAll("select[data-ws-member-role]").forEach((select) => {
      select.addEventListener("change", async () => {
        const targetUserId = select.getAttribute("data-ws-member-role");
        const res = await wsRequest("PATCH", `/api/workspaces/${detail.id}/members/${targetUserId}`, { role: select.value });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          alert((err && err.error) || "Role update failed.");
          loadWorkspaceState();
          return;
        }
        renderWorkspaceDetail(detail.id);
      });
    });
    membersBody.querySelectorAll("button[data-ws-remove-member]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const targetUserId = btn.getAttribute("data-ws-remove-member");
        if (!confirm(pickLang("Bu üzvü workspace-dən çıxarmaq istədiyinizə əminsiniz?", "Bu üyeyi workspace'ten çıkarmak istediğinize emin misiniz?", "Remove this member from the workspace?"))) return;
        const res = await wsRequest("DELETE", `/api/workspaces/${detail.id}/members/${targetUserId}`);
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          alert((err && err.error) || "Remove failed.");
          return;
        }
        renderWorkspaceDetail(detail.id);
      });
    });

    const pendingWrap = document.getElementById("wsPendingInvitesWrap");
    const pendingList = document.getElementById("wsPendingInvitesList");
    const pending = (detail.invitations || []).filter((inv) => !inv.accepted_at && !inv.revoked_at);
    pendingWrap.classList.toggle("d-none", !pending.length || !isAdmin);
    pendingList.innerHTML = "";
    pending.forEach((inv) => {
      if (new Date(inv.expires_at).getTime() < Date.now()) return;
      const li = document.createElement("li");
      li.className = "list-group-item d-flex justify-content-between align-items-center px-0 py-2";
      li.innerHTML = `
        <span class="text-truncate" style="max-width:280px">${wsEscapeHtml(inv.email)} <span class="badge text-bg-light border ms-1">${wsEscapeHtml(wsRoleLabel(inv.role))}</span></span>
        <button type="button" class="btn btn-outline-danger btn-sm rounded-pill" data-ws-revoke-invite="${inv.id}">${wsEscapeHtml(pickLang("Ləğv et", "İptal et", "Revoke"))}</button>`;
      pendingList.appendChild(li);
    });
    pendingList.querySelectorAll("button[data-ws-revoke-invite]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const inviteId = btn.getAttribute("data-ws-revoke-invite");
        const res = await wsRequest("DELETE", `/api/workspaces/${detail.id}/invitations/${inviteId}`);
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          alert((err && err.error) || "Revoke failed.");
          return;
        }
        renderWorkspaceDetail(detail.id);
      });
    });

    const ssoStatusWrap = document.getElementById("wsSsoStatusWrap");
    const ssoForm = document.getElementById("wsSsoForm");
    const ssoRemoveBtn = document.getElementById("wsSsoRemoveBtn");
    const sso = detail.sso;
    if (sso && sso.configured) {
      ssoStatusWrap.innerHTML = `
        <div class="alert alert-success py-2 px-3 small mb-2">${wsEscapeHtml(pickLang("SSO konfiqurasiya edilib.", "SSO yapılandırıldı.", "SSO is configured."))}</div>
        <div class="small"><strong>ACS URL:</strong> <code class="text-break">${wsEscapeHtml(sso.acs_url)}</code></div>
        <div class="small"><strong>Entity ID:</strong> <code class="text-break">${wsEscapeHtml(sso.sp_entity_id)}</code></div>
        <div class="small"><strong>Metadata:</strong> <a href="${wsEscapeHtml(sso.metadata_url)}" target="_blank" rel="noopener">${wsEscapeHtml(pickLang("SP metadata XML", "SP metadata XML", "SP metadata XML"))}</a></div>
        <div class="small"><strong>Okta test:</strong> <a href="${wsEscapeHtml(sso.login_url)}">${wsEscapeHtml(pickLang("SSO girişini sına", "SSO girişini test et", "Test SSO login"))}</a></div>`;
      ssoForm.classList.remove("d-none");
      ssoRemoveBtn.classList.remove("d-none");
    } else {
      ssoStatusWrap.innerHTML = `<div class="alert alert-secondary py-2 px-3 small mb-2">${wsEscapeHtml(pickLang("SSO hələ konfiqurasiya edilməyib.", "SSO henüz yapılandırılmadı.", "SSO is not configured yet."))}</div>`;
      ssoForm.classList.remove("d-none");
      ssoRemoveBtn.classList.add("d-none");
    }
  }

  // The plan flag is embedded by the page for the create-vs-upsell decision.
  window.__wsPlanIsPro = window.__wsPlanIsPro || false;

  const createForm = document.getElementById("wsCreateForm");
  if (createForm) {
    createForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msgEl = document.getElementById("wsCreateMsg");
      const name = (document.getElementById("wsCreateName").value || "").trim();
      if (name.length < 3) {
        setMsg(msgEl, pickLang("Ad ən azı 3 simvol olmalıdır.", "Ad en az 3 karakter olmalıdır.", "Name must be at least 3 characters."), true);
        return;
      }
      const res = await postJsonWithCsrf("/api/workspaces", { name, lang: (typeof currentLang !== "undefined" ? currentLang : "az") });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(msgEl, (data && data.error) || "Error", true);
        return;
      }
      createSection.classList.add("d-none");
      renderWorkspaceDetail(data.id);
    });
  }

  const renameBtn = document.getElementById("wsRenameBtn");
  if (renameBtn) {
    renameBtn.addEventListener("click", () => {
      const form = document.getElementById("wsRenameForm");
      const input = document.getElementById("wsRenameInput");
      input.value = wsDetail ? wsDetail.name : "";
      form.classList.toggle("d-none");
    });
    document.getElementById("wsRenameForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!wsDetail) return;
      const name = (document.getElementById("wsRenameInput").value || "").trim();
      const res = await wsRequest("PATCH", `/api/workspaces/${wsDetail.id}`, { name });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert((data && data.error) || "Rename failed.");
        return;
      }
      renderWorkspaceDetail(wsDetail.id);
    });
  }

  const inviteForm = document.getElementById("wsInviteForm");
  if (inviteForm) {
    inviteForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msgEl = document.getElementById("wsInviteMsg");
      if (!wsDetail) return;
      const email = (document.getElementById("wsInviteEmail").value || "").trim();
      const role = document.getElementById("wsInviteRole").value || "member";
      const res = await postJsonWithCsrf(`/api/workspaces/${wsDetail.id}/invitations`, { email, role, lang: (typeof currentLang !== "undefined" ? currentLang : "az") });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(msgEl, (data && data.error) || "Error", true);
        return;
      }
      const inviteUrl = (data && data.invite_url) || "";
      msgEl.classList.remove("text-danger");
      msgEl.classList.add("text-success");
      msgEl.innerHTML = "";
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "btn btn-outline-secondary btn-sm rounded-pill ms-2";
      copyBtn.textContent = pickLang("Dəvət linkini köçür", "Davet linkini kopyala", "Copy invite link");
      copyBtn.addEventListener("click", () => {
        try { navigator.clipboard.writeText(inviteUrl); copyBtn.textContent = pickLang("Köçürüldü", "Kopyalandı", "Copied"); } catch {}
      });
      msgEl.appendChild(document.createTextNode(pickLang("Dəvət göndərildi. ", "Davet gönderildi. ", "Invitation sent. ")));
      msgEl.appendChild(copyBtn);
      document.getElementById("wsInviteEmail").value = "";
      setTimeout(() => renderWorkspaceDetail(wsDetail.id), 1500);
    });
  }

  const ssoForm = document.getElementById("wsSsoForm");
  if (ssoForm) {
    ssoForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msgEl = document.getElementById("wsSsoMsg");
      if (!wsDetail) return;
      const metadataXml = (document.getElementById("wsSsoMetadata").value || "").toString();
      setMsg(msgEl, pickLang("Yoxlanılır...", "Doğrulanıyor...", "Validating..."));
      const res = await wsRequest("PUT", `/api/workspaces/${wsDetail.id}/sso`, { metadataXml });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(msgEl, (data && data.error) || "Error", true);
        return;
      }
      setMsg(msgEl, pickLang("SSO konfiqurasiya edildi.", "SSO yapılandırıldı.", "SSO configured."), false);
      renderWorkspaceDetail(wsDetail.id);
    });
    const ssoRemoveBtn = document.getElementById("wsSsoRemoveBtn");
    ssoRemoveBtn.addEventListener("click", async () => {
      if (!wsDetail) return;
      if (!confirm(pickLang("SSO konfiqurasiyası silinsin?", "SSO yapılandırması silinsin?", "Delete SSO configuration?"))) return;
      const res = await wsRequest("DELETE", `/api/workspaces/${wsDetail.id}/sso`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert((err && err.error) || "Delete failed.");
        return;
      }
      renderWorkspaceDetail(wsDetail.id);
    });
  }

  const deleteBtn = document.getElementById("wsDeleteBtn");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      if (!wsDetail) return;
      if (!confirm(pickLang("Workspace silinsin? Bu geri qaytarıla bilməz.", "Workspace silinsin? Bu geri alınamaz.", "Delete this workspace? This cannot be undone."))) return;
      const res = await wsRequest("DELETE", `/api/workspaces/${wsDetail.id}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert((err && err.error) || "Delete failed.");
        return;
      }
      window.location.href = "/workspaces";
    });
  }

  loadWorkspaceState();
})();
