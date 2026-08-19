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

// Document-level click handler for .theme-toggle (always works across all pages)
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".theme-toggle");
  if (btn) {
    e.preventDefault();
    toggleTheme();
  }
}, true);

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
  const userNav = document.getElementById("navAuthUser");
  const ssrLoggedIn = !!(userNav && !userNav.classList.contains("d-none"));
  const localLoggedIn = localStorage.getItem("isLoggedIn") === "1";
  const hasWindowUser = !!(window.__userId || window.__userEmail);
  return { isLoggedIn: ssrLoggedIn || localLoggedIn || hasWindowUser };
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
  syncThemeUi();

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

function initShorten() {
  const form = document.getElementById("shortenForm");
  if (!form || form.dataset.shortenBound === "true") return;
  form.dataset.shortenBound = "true";

  // --- Home Workspace Selector Logic ---
  const hwWrapper = document.getElementById("homeWorkspaceTopWrapper");
  const hwBtn = document.getElementById("homeWorkspaceDropdownBtn");
  const hwIcon = document.getElementById("homeWorkspaceBtnIcon");
  const hwText = document.getElementById("homeWorkspaceBtnText");
  const hwMenu = document.getElementById("homeWorkspaceDropdownMenu");
  let selectedHomeWorkspaceId = 0;

  if (hwWrapper && hwBtn && hwMenu && hwIcon && hwText) {
    const updateHwBtn = (id, name) => {
      hwIcon.className = id === 0 ? "fa-solid fa-user text-muted me-1" : "fa-solid fa-users text-primary me-1";
      hwText.textContent = name;
      selectedHomeWorkspaceId = id;
      localStorage.setItem("ovlink_home_workspace", id);
    };

    (async () => {
      const session = typeof getClientSession === "function" ? getClientSession() : { isLoggedIn: false };
      if (!session.isLoggedIn) return;
      try {
        const res = await fetch("/api/workspaces", { credentials: "include" });
        if (!res.ok) return; // not logged in or error
        const data = await res.json();
        const workspaces = data.workspaces || [];
        if (workspaces.length === 0) return; // no workspaces, keep hidden

        hwWrapper.classList.remove("d-none");
        
        // Populate menu
        const personalName = window.pickLang ? window.pickLang("Şəxsi hesab", "Kişisel hesap", "Personal account") : "Şəxsi hesab";
        hwMenu.innerHTML = `
          <li><a class="dropdown-item py-2 d-flex align-items-center gap-2" href="#" data-ws-id="0"><i class="fa-solid fa-user text-muted"></i> <span class="fw-medium">${personalName}</span></a></li>
          <li><hr class="dropdown-divider"></li>
        `;
        
        workspaces.forEach(ws => {
          const wsName = ws.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
          hwMenu.innerHTML += `<li><a class="dropdown-item py-2 d-flex align-items-center gap-2" href="#" data-ws-id="${ws.id}"><i class="fa-solid fa-users text-primary"></i> <span class="fw-medium">${wsName}</span></a></li>`;
        });

        // Set initial selection
        const storedId = parseInt(localStorage.getItem("ovlink_home_workspace") || "0", 10);
        const activeWs = workspaces.find(w => w.id === storedId);
        if (activeWs) {
          updateHwBtn(activeWs.id, activeWs.name);
        } else {
          updateHwBtn(0, personalName);
        }

        // Handle clicks
        hwMenu.addEventListener("click", (e) => {
          const a = e.target.closest("a.dropdown-item");
          if (!a) return;
          e.preventDefault();
          const id = parseInt(a.getAttribute("data-ws-id"), 10) || 0;
          const name = a.querySelector("span").textContent;
          updateHwBtn(id, name);
        });

      } catch (err) {
        // ignore errors
      }
    })();
  }

  // --- UTM Templates Logic ---
  const BUILTIN_UTM_TEMPLATES = [
    { name: "Facebook & Instagram Ads", source: "facebook", medium: "cpc", campaign: "promo_feed" },
    { name: "Google Ads", source: "google", medium: "cpc", campaign: "search_ad" },
    { name: "TikTok Ads", source: "tiktok", medium: "paid_video", campaign: "reels_campaign" },
    { name: "Email Newsletter", source: "newsletter", medium: "email", campaign: "weekly_digest" },
    { name: "LinkedIn Post", source: "linkedin", medium: "social", campaign: "company_post" },
    { name: "Twitter / X", source: "twitter", medium: "social", campaign: "launch_tweet" },
    { name: "YouTube Video", source: "youtube", medium: "video_desc", campaign: "channel_promo" }
  ];

  const loadUtmTemplates = () => {
    const utmSelect = document.getElementById("utmTemplateSelect");
    if (!utmSelect) return;
    const currentVal = utmSelect.value;

    const defaultText = (typeof tKey === "function" ? tKey("adv_utm_template_select") : null) ||
      (typeof pickLang === "function" ? pickLang("Şablon Seç", "Şablon Seç", "Select Template") : "Select Template");

    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.setAttribute("data-i18n", "adv_utm_template_select");
    defaultOpt.textContent = defaultText;

    // Properly reset children without leaving orphaned optgroup elements
    if (typeof utmSelect.replaceChildren === "function") {
      utmSelect.replaceChildren(defaultOpt);
    } else {
      utmSelect.innerHTML = "";
      utmSelect.appendChild(defaultOpt);
    }

    // Pre-defined group
    const builtInGroup = document.createElement("optgroup");
    builtInGroup.label = (typeof tKey === "function" ? tKey("adv_utm_popular_templates") : null) ||
      (typeof pickLang === "function" ? pickLang("Populyar Şablonlar", "Popüler Şablonlar", "Popular Templates") : "Populyar Şablonlar");

    BUILTIN_UTM_TEMPLATES.forEach((tpl, idx) => {
      const opt = document.createElement("option");
      opt.value = "builtin_" + idx;
      opt.textContent = tpl.name;
      builtInGroup.appendChild(opt);
    });
    utmSelect.appendChild(builtInGroup);

    // Custom user templates group
    try {
      const rawStored = localStorage.getItem("ovlink_utm_templates");
      const stored = rawStored ? JSON.parse(rawStored) : [];
      if (Array.isArray(stored) && stored.length > 0) {
        const customGroup = document.createElement("optgroup");
        customGroup.label = (typeof tKey === "function" ? tKey("adv_utm_custom_templates") : null) ||
          (typeof pickLang === "function" ? pickLang("Şəxsi Şablonlarım", "Özel Şablonlarım", "Custom Templates") : "Şəxsi Şablonlarım");

        stored.forEach((tpl, idx) => {
          if (!tpl || typeof tpl !== "object") return;
          const opt = document.createElement("option");
          opt.value = "custom_" + idx;
          opt.textContent = tpl.name || ("Template " + (idx + 1));
          customGroup.appendChild(opt);
        });

        if (customGroup.children.length > 0) {
          utmSelect.appendChild(customGroup);
        }
      }
    } catch (e) {}

    // Restore previous selected value if valid
    if (currentVal) {
      const exists = Array.from(utmSelect.options).some((o) => o.value === currentVal);
      if (exists) {
        utmSelect.value = currentVal;
      } else {
        utmSelect.value = "";
      }
    }
  };

  window.loadUtmTemplatesUi = loadUtmTemplates;

  function setupUtmListeners() {
    const utmSelect = document.getElementById("utmTemplateSelect");
    if (utmSelect && !utmSelect.dataset.utmBound) {
      utmSelect.dataset.utmBound = "true";
      utmSelect.addEventListener("change", (e) => {
        const val = e.target.value;
        const sourceEl = document.getElementById("utmSource");
        const mediumEl = document.getElementById("utmMedium");
        const campaignEl = document.getElementById("utmCampaign");

        if (!val) {
          if (sourceEl) sourceEl.value = "";
          if (mediumEl) mediumEl.value = "";
          if (campaignEl) campaignEl.value = "";
          return;
        }

        if (val.startsWith("builtin_")) {
          const idx = parseInt(val.replace("builtin_", ""), 10);
          const tpl = BUILTIN_UTM_TEMPLATES[idx];
          if (tpl) {
            if (sourceEl) sourceEl.value = tpl.source || "";
            if (mediumEl) mediumEl.value = tpl.medium || "";
            if (campaignEl) campaignEl.value = tpl.campaign || "";
          }
        } else if (val.startsWith("custom_")) {
          const idx = parseInt(val.replace("custom_", ""), 10);
          try {
            const rawStored = localStorage.getItem("ovlink_utm_templates");
            const stored = rawStored ? JSON.parse(rawStored) : [];
            const tpl = Array.isArray(stored) ? stored[idx] : null;
            if (tpl) {
              if (sourceEl) sourceEl.value = tpl.source || "";
              if (mediumEl) mediumEl.value = tpl.medium || "";
              if (campaignEl) campaignEl.value = tpl.campaign || "";
            }
          } catch (e) {}
        }
      });
    }

    const saveUtmBtn = document.getElementById("saveUtmTemplateBtn");
    if (saveUtmBtn && !saveUtmBtn.dataset.utmBound) {
      saveUtmBtn.dataset.utmBound = "true";
      saveUtmBtn.addEventListener("click", () => {
        const source = document.getElementById("utmSource")?.value?.trim() || "";
        const medium = document.getElementById("utmMedium")?.value?.trim() || "";
        const campaign = document.getElementById("utmCampaign")?.value?.trim() || "";
        if (!source && !medium && !campaign) {
          const noParamsMsg = (typeof tKey === "function" ? tKey("adv_utm_no_params_alert") : null) ||
            (typeof pickLang === "function" ? pickLang("Yadda saxlanılacaq UTM parametri tapılmadı!", "Kaydedilecek bir UTM parametresi bulunamadı!", "No UTM parameter found to save!") : "No UTM parameter found to save!");
          alert(noParamsMsg);
          return;
        }
        const promptMsg = (typeof tKey === "function" ? tKey("adv_utm_prompt_name") : null) ||
          (typeof pickLang === "function" ? pickLang("Bu şablon üçün ad daxil edin (Məs: Yay Endirimi):", "Bu şablon için bir isim girin (Örn: Yaz İndirimi):", "Enter a name for this template (e.g., Summer Sale):") : "Enter a name for this template (e.g., Summer Sale):");
        const name = prompt(promptMsg);
        if (!name || !name.trim()) return;
        try {
          const rawStored = localStorage.getItem("ovlink_utm_templates");
          const stored = rawStored ? JSON.parse(rawStored) : [];
          const list = Array.isArray(stored) ? stored : [];
          list.push({ name: name.trim(), source, medium, campaign });
          localStorage.setItem("ovlink_utm_templates", JSON.stringify(list));
          loadUtmTemplates();
          const sel = document.getElementById("utmTemplateSelect");
          if (sel) {
            sel.value = "custom_" + (list.length - 1);
          }
        } catch (e) {
          const errMsg = (typeof tKey === "function" ? tKey("adv_utm_save_error") : null) ||
            (typeof pickLang === "function" ? pickLang("Şablon yadda saxlanılarkən xəta baş verdi.", "Şablon kaydedilirken bir hata oluştu.", "Error occurred while saving the template.") : "Error occurred while saving the template.");
          alert(errMsg);
        }
      });
    }
  }

  // Load UTM templates immediately and attach listeners
  loadUtmTemplates();
  setupUtmListeners();

  if (typeof window !== "undefined") {
    window.addEventListener("ovlink:languageChanged", () => {
      loadUtmTemplates();
    });
  }

  form.addEventListener("submit", async function (e) {
    try {
      if (e && typeof e.preventDefault === "function") {
        e.preventDefault();
      }
    } catch {}

    const resultDiv = document.getElementById("result");
    const shortUrlEl = document.getElementById("shortUrl");
    const hintEl = document.getElementById("shortenHint");
    const feedbackEl = document.getElementById("shortenFeedback");

    const showFeedback = (msg, isError = true) => {
      const el = document.getElementById("shortenFeedback") || feedbackEl;
      if (!el) return;
      el.textContent = msg;
      el.className = `alert mt-3 py-2 mb-0 small fw-bold text-center rounded-pill ${isError ? "alert-danger" : "alert-success"}`;
      el.classList.remove("d-none");
      if (isError && resultDiv) {
        resultDiv.classList.add("hidden", "d-none");
        resultDiv.style.display = "none";
      }
      try {
        el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } catch {}
    };

    let originalUrl = document.getElementById("originalUrl")?.value?.trim();
    const customAlias = document.getElementById("customAlias")?.value?.trim();
    const linkPassword = document.getElementById("linkPassword")?.value?.trim();
    const selectedCustomDomain = document.getElementById("customDomainSelect")?.value?.trim();

    const utmSource = document.getElementById("utmSource")?.value?.trim();
    const utmMedium = document.getElementById("utmMedium")?.value?.trim();
    const utmCampaign = document.getElementById("utmCampaign")?.value?.trim();

    let original_b = document.getElementById("originalB")?.value?.trim() || undefined;
    const ab_split_percent = document.getElementById("abSplitPercent")?.value?.trim() || undefined;

    let ios_url = document.getElementById("iosUrl")?.value?.trim() || undefined;
    let android_url = document.getElementById("androidUrl")?.value?.trim() || undefined;

    const appendUtm = (urlStr) => {
      if (!urlStr) return urlStr;
      if (!utmSource && !utmMedium && !utmCampaign) return urlStr;
      try {
        const u = new URL(urlStr.startsWith('http') ? urlStr : 'http://' + urlStr);
        if (utmSource) u.searchParams.set('utm_source', utmSource);
        if (utmMedium) u.searchParams.set('utm_medium', utmMedium);
        if (utmCampaign) u.searchParams.set('utm_campaign', utmCampaign);
        return u.toString();
      } catch {
        return urlStr;
      }
    };

    originalUrl = appendUtm(originalUrl);
    if (original_b) original_b = appendUtm(original_b);
    if (ios_url) ios_url = appendUtm(ios_url);
    if (android_url) android_url = appendUtm(android_url);

    // Client-side PRO check for A/B testing or Device targeting
    const hasProFeature = Boolean(original_b || ios_url || android_url);
    const session = typeof getClientSession === "function" ? getClientSession() : { isLoggedIn: false };
    const isPro = typeof isProPlanActive === "function" && isProPlanActive();

    if (hasProFeature && (!session.isLoggedIn || (window.__userPlan && !isPro))) {
      let proMsg = "";
      if (original_b) {
        proMsg = tKey(
          "pro_feature_required_ab",
          "A/B Test yalnız PRO istifadəçilər üçündür. Zəhmət olmasa Pro plana keçin."
        );
      } else {
        proMsg = tKey(
          "pro_feature_required_device",
          "Cihaz Hədəfləməsi yalnız PRO istifadəçilər üçündür. Zəhmət olmasa Pro plana keçin."
        );
      }
      showFeedback(proMsg, true);
      return;
    }

    try {
      const payload = {
        lang: getCurrentLang(),
        original: originalUrl,
        customLink: customAlias || undefined,
        custom_domain: selectedCustomDomain || undefined,
        link_password: linkPassword || undefined,
        expires_at: normalizeExpiryInput(document.getElementById("expiresAt")?.value),
        max_clicks: document.getElementById("maxClicks")?.value || undefined,
        original_b,
        ab_split_percent,
        ios_url,
        android_url
      };
      
      if (typeof selectedHomeWorkspaceId !== 'undefined' && selectedHomeWorkspaceId > 0) {
        payload.workspaceId = selectedHomeWorkspaceId;
      }

      const response = await postJsonWithCsrf("/api/shorten", payload);
      const data = await response.json().catch(() => ({}));

      if (!response.ok || data.error) {
        let errorMsg = data.error || (response.status === 403
          ? (original_b ? tKey("pro_feature_required_ab", "A/B Test yalnız PRO istifadəçilər üçündür. Zəhmət olmasa Pro plana keçin.") : tKey("pro_feature_required_device", "Cihaz Hədəfləməsi yalnız PRO istifadəçilər üçündür. Zəhmət olmasa Pro plana keçin."))
          : pickLang("Əməliyyat alınmadı", "İşlem başarısız", "Request failed"));

        if (errorMsg === pickLang("Bu xüsusi link istifadə olunub", "Bu özel link kullanımda", "This custom link is already in use")) {
          errorMsg = tKey("error_alias_taken", errorMsg);
        } else if (errorMsg === pickLang("Zəhmət olmasa düzgün bir URL daxil edin.", "Lütfen geçerli bir URL girin.", "Please enter a valid URL.")) {
          errorMsg = tKey("error_invalid_url", errorMsg);
        }
        showFeedback(errorMsg, true);
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
        showFeedback(pickLang("Qısaltma nəticəsi alınmadı.", "Kısaltma sonucu alınamadı.", "Shortening failed."), true);
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
      if (resultDiv) {
        resultDiv.classList.remove("hidden", "d-none");
        resultDiv.style.display = "block";
      }
    } catch (err) {
      showFeedback(
        pickLang("Server xətası: ", "Sunucu hatası: ", "Server error: ") + (err?.message || ""),
        true
      );
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initShorten);
} else {
  initShorten();
}

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
    if (isError && qrResultDiv) {
      qrResultDiv.classList.add("hidden", "d-none");
      qrResultDiv.style.display = "none";
    }
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
        if (qrResultDiv) {
          qrResultDiv.classList.remove("hidden", "d-none");
          qrResultDiv.style.display = "block";
        }
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
        } else if (displayMsg === pickLang("Raporunuz göndərildi.", "Raporunuz gönderildi.", "Your report has been sent.")) {
          displayMsg = pickLang("Şikayətiniz göndərildi.", pickLang("Raporunuz göndərildi.", "Raporunuz gönderildi.", "Your report has been sent."), "Your report has been submitted.");
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
