function getCurrentLang() {
  if (window.ovlinkI18n && typeof window.ovlinkI18n.getLang === "function") {
    return window.ovlinkI18n.getLang();
  }
  const stored = localStorage.getItem("lang");
  return stored === "tr" || stored === "en" || stored === "az" ? stored : "az";
}

function tKey(key, fallback = "") {
  if (window.ovlinkI18n && typeof window.ovlinkI18n.translate === "function") {
    const v = window.ovlinkI18n.translate(key);
    if (v) return v;
  }
  return fallback;
}

function pickLang(az, tr, en) {
  const lang = getCurrentLang();
  return lang === "tr" ? tr : (lang === "en" ? en : az);
}

function applyTheme(theme) {
  if (theme === "dark") document.body.classList.add("dark-mode");
  else document.body.classList.remove("dark-mode");
  localStorage.setItem("theme", theme === "dark" ? "dark" : "light");
}

function toggleTheme() {
  const next = document.body.classList.contains("dark-mode") ? "light" : "dark";
  applyTheme(next);
}

function getCsrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
}

function withCsrf(body = {}) {
  const token = getCsrfToken();
  if (!token) return body;
  return { ...body, _csrf: token };
}

function normalizeExpiryInput(raw) {
  const value = (raw || "").toString().trim();
  if (!value) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toISOString();
}

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

function isProPlanActive() {
  const plan = window.__userPlan;
  if (!plan) return false;
  return (plan.tier || "").toString().toLowerCase() === "pro" && !!plan.isActive;
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

function syncFloatingPricingBanner() {
  const banner = document.getElementById("floatingPricingBanner");
  if (!banner) return;
  bindFloatingPricingBannerClose();
  const path = currentPathname();
  const shouldHide = path === "/pricing" || path === "/pricing.html" || isProPlanActive() || isFloatingPricingBannerDismissed();
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
        "x-csrf-token": getCsrfToken() || "",
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

const customDomainsState = { domains: [], targetHost: "" };

function populateCustomDomainSelect(domains) {
  const select = document.getElementById("customDomainSelect");
  if (!select) return;

  const selected = select.value;
  select.innerHTML = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = tKey("shorten_domain_default", "Default (ovlink.sbs)");
  select.appendChild(defaultOption);

  domains
    .filter((d) => d && d.status === "active" && d.domain)
    .forEach((d) => {
      const option = document.createElement("option");
      option.value = d.domain;
      option.textContent = d.domain;
      select.appendChild(option);
    });

  if (selected && [...select.options].some((o) => o.value === selected)) {
    select.value = selected;
  }
}

function refreshCustomDomainUi() {
  populateCustomDomainSelect(customDomainsState.domains);
}
window.refreshCustomDomainUi = refreshCustomDomainUi;

async function loadCustomDomains() {
  const select = document.getElementById("customDomainSelect");
  if (!select) return;

  try {
    const res = await fetch("/api/domains", { credentials: "include" });
    if (!res.ok) {
      customDomainsState.domains = [];
      refreshCustomDomainUi();
      return;
    }

    const data = await res.json().catch(() => ({}));
    customDomainsState.domains = Array.isArray(data.domains) ? data.domains : [];
    customDomainsState.targetHost = (data.target_host || "").toString();
    refreshCustomDomainUi();
  } catch {
    customDomainsState.domains = [];
    refreshCustomDomainUi();
  }
}

function setClientSession() {
  localStorage.setItem("isLoggedIn", "1");
}

function clearClientSession() {
  localStorage.removeItem("isLoggedIn");
  window.__userPlan = null;
  window.__userEmail = "";
  window.__userId = null;
}

function getClientSession() {
  return { isLoggedIn: localStorage.getItem("isLoggedIn") === "1" };
}

async function trySyncSessionFromServer() {
  try {
    const res = await fetch("/api/me", { credentials: "include" });
    if (!res.ok) {
      clearClientSession();
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (data && data.user) {
      setClientSession();
      window.__userEmail = data.user.email || "";
      window.__userId = Number.isInteger(data.user.id) ? data.user.id : null;
      window.__userPlan = {
        tier: (data.user.planTier || "free").toString().toLowerCase(),
        status: (data.user.planStatus || "active").toString().toLowerCase(),
        isActive: !!data.user.proActive,
        expiresAt: data.user.proExpiresAt || null,
      };
      if (data.user.settings && data.user.settings.ui_lang && window.ovlinkI18n?.setLang) {
        window.ovlinkI18n.setLang(data.user.settings.ui_lang);
      }
      if (data.user.settings && data.user.settings.ui_theme) {
        applyTheme(data.user.settings.ui_theme);
      }
    } else {
      clearClientSession();
    }
  } catch {
    // ignore network issue
  }
}

function renderNavbarAuth() {
  ensurePricingNavLink();
  const loginBtn = document.getElementById("navAuthGuestLogin");
  const regBtn = document.getElementById("navAuthGuestReg");
  const pricingItem = document.getElementById("navPricingItem");
  const user = document.getElementById("navAuthUser");
  const emailEl = document.getElementById("navUserEmail");
  const s = getClientSession();
  const showPricingForLoggedIn = s.isLoggedIn && !isProPlanActive();

  if (s.isLoggedIn) {
    loginBtn?.classList.add("d-none");
    regBtn?.classList.add("d-none");
    pricingItem?.classList.toggle("d-none", !showPricingForLoggedIn);
    user?.classList.remove("d-none");
    if (emailEl) emailEl.textContent = tKey("nav_my_account", "My Account");
  } else {
    user?.classList.add("d-none");
    loginBtn?.classList.remove("d-none");
    regBtn?.classList.remove("d-none");
    pricingItem?.classList.remove("d-none");
  }
  syncFloatingPricingBanner();
}

async function clientLogout() {
  try {
    const res = await postJsonWithCsrf("/api/logout", { lang: getCurrentLang() });
    if (!res.ok) throw new Error("logout_failed");
    clearClientSession();
    location.href = "/";
  } catch {
    await trySyncSessionFromServer();
    renderNavbarAuth();
  }
}

window.addEventListener("DOMContentLoaded", () => {
  if (localStorage.getItem("theme") === "dark") {
    document.body.classList.add("dark-mode");
  }

  const themeBtn = document.querySelector(".theme-toggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      toggleTheme();
    });
  }

  const logoutBtn = document.getElementById("navLogoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", (e) => {
      e.preventDefault();
      clientLogout();
    });
  }

  const initAsync = async () => {
    if (!getCsrfToken()) await refreshCsrfToken();
    await trySyncSessionFromServer();
    renderNavbarAuth();
    if (getClientSession().isLoggedIn) {
      await loadCustomDomains();
    }
  };

  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(() => {
      void initAsync();
    }, { timeout: 1000 });
  } else {
    setTimeout(() => void initAsync(), 180);
  }

  ensurePricingNavLink();
  syncFloatingPricingBanner();
});

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
        lang: getCurrentLang(),
        original: originalUrl,
        customLink: customAlias || undefined,
        custom_domain: selectedCustomDomain || undefined,
        link_password: linkPassword || undefined,
        expires_at: normalizeExpiryInput(document.getElementById("expiresAt")?.value),
        max_clicks: document.getElementById("maxClicks")?.value || undefined,
      });

      const data = await response.json().catch(() => ({}));
      const feedbackEl = document.getElementById("shortenFeedback");
      const showFeedback = (msg, isError = true) => {
        if (!feedbackEl) return;
        feedbackEl.textContent = msg;
        feedbackEl.className = `alert mt-3 py-2 mb-0 small fw-bold text-center rounded-pill ${isError ? "alert-danger" : "alert-success"}`;
        feedbackEl.classList.remove("d-none");
        if (isError && resultDiv) resultDiv.classList.add("hidden");
      };

      if (!response.ok || data.error) {
        let errorMsg = data.error || pickLang("Əməliyyat alınmadı", "İşlem başarısız", "Request failed");
        if (errorMsg === "Bu xüsusi link istifadə olunub") {
          errorMsg = tKey("error_alias_taken", errorMsg);
        } else if (errorMsg === "Zəhmət olmasa düzgün bir URL daxil edin.") {
          errorMsg = tKey("error_invalid_url", errorMsg);
        }
        showFeedback(errorMsg);
        return;
      }

      if (feedbackEl) feedbackEl.classList.add("d-none");

      let shortLink = data.shortUrl || data.short || null;
      if (!shortLink && typeof data.message === "string") {
        const match = data.message.match(/https?:\/\/\S+/i);
        if (match) shortLink = match[0];
      }
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
        hintEl.textContent = pickLang(
          "Kopyala ilə sürətli paylaşın, QR-ə göndər ilə tək toxunuşla QR yaradın.",
          "Kopyala ile hızlı paylaşın, QR'a gönder ile tek dokunuşla QR üretin.",
          "Share quickly with Copy, generate a QR with Send to QR."
        );
      }
      if (resultDiv) resultDiv.classList.remove("hidden");
    } catch (err) {
      const feedbackEl = document.getElementById("shortenFeedback");
      if (feedbackEl) {
        feedbackEl.textContent = pickLang("Server xətası: ", "Sunucu hatası: ", "Server error: ") + (err?.message || "");
        feedbackEl.className = "alert alert-danger mt-3 py-2 mb-0 small fw-bold text-center rounded-pill";
        feedbackEl.classList.remove("d-none");
      }
    }
  });
})();

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
      const msg = tKey("copied_msg", "Copied!");
      copyBtn.innerHTML = `<i class="fa-solid fa-check me-1"></i> ${msg}`;
      setTimeout(() => {
        copyBtn.innerHTML = `<i class="fa-solid fa-copy me-1"></i> ${tKey("copy_btn", "Copy")}`;
      }, 1200);
    } catch {
      // ignore
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
    qrFeedback.className = `alert mt-3 py-2 mb-0 small fw-bold text-center rounded-pill ${isError ? "alert-danger" : "alert-success"}`;
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
      } catch {
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
        let errorMsg = pickLang("QR Kod yaradıla bilmədi.", "QR Kod oluşturulamadı.", "QR code could not be created.");
        if (response.status === 404) {
          errorMsg = tKey("error_link_not_found", errorMsg);
        }
        showQrFeedback(errorMsg);
      }
    } catch (err) {
      showQrFeedback(pickLang("QR Kod yaratma xətası: ", "QR Kod oluşturma hatası: ", "QR code error: ") + (err?.message || ""));
    }
  };

  window.__ovlinkGenerateQr = runQrGeneration;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await runQrGeneration();
  });
})();

(function initReport() {
  const form = document.getElementById("reportForm");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const reportLink = document.getElementById("reportLink")?.value?.trim();
    const reportReason = document.getElementById("reportReason")?.value?.trim();
    const reportMessage = document.getElementById("reportMessage");

    try {
      const response = await postJsonWithCsrf("/api/report", {
        short: reportLink,
        reason: reportReason,
        lang: getCurrentLang(),
      });

      const data = await response.json().catch(() => ({}));
      if (reportMessage) {
        let displayMsg = data.message || data.error || pickLang("Bilinməyən cavab", "Bilinmeyen yanıt", "Unknown response");
        if (displayMsg === "Belə Bir Link Tapılmadı") {
          displayMsg = tKey("error_link_not_found", displayMsg);
        } else if (displayMsg === "Raporunuz gönderildi.") {
          displayMsg = pickLang("Şikayətiniz göndərildi.", "Raporunuz gönderildi.", "Your report has been submitted.");
        }
        reportMessage.textContent = displayMsg;
        reportMessage.style.color = data.error ? "red" : "green";
      }
    } catch (err) {
      if (reportMessage) {
        reportMessage.textContent = pickLang("Xəta: ", "Hata: ", "Error: ") + (err?.message || "");
        reportMessage.style.color = "red";
      }
    }
  });
})();

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
    }, {
      threshold: 0.1,
      rootMargin: '0px 0px -50px 0px'
    });
    
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
  
  const animatedInputs = document.querySelectorAll('.form-control-animated');
  animatedInputs.forEach(input => {
    input.addEventListener('focus', () => input.style.transform = 'scale(1.02)');
    input.addEventListener('blur', () => input.style.transform = 'scale(1)');
  });
  
  const copyButtons = document.querySelectorAll('[id="copyShortBtn"]');
  copyButtons.forEach(btn => {
    btn.addEventListener('click', function() {
      this.classList.add('copy-success');
      setTimeout(() => this.classList.remove('copy-success'), 400);
    });
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
  });
})();
