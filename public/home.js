/* ============================================================
   Ovlink — Homepage controller ("Quiet Precision")
   Functional contract (unchanged):
   - POST /api/shorten, /api/report (JSON + CSRF header/body)
   - GET /api/qrcode, /api/domains, /api/me, /api/notifications,
     /api/csrf, /api/workspaces, /api/logout
   - localStorage keys: lang, theme, isLoggedIn, ovlink_floating_pricing_*,
     ovlink_home_workspace, ovlink_utm_templates, notif_last_seen_id, cookieConsent
   ============================================================ */

/* ---------- i18n helpers ---------- */
function getCurrentLang() {
  if (window.ovlinkI18n && typeof window.ovlinkI18n.getLang === "function") return window.ovlinkI18n.getLang();
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

/* ---------- Theme ---------- */
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
  document.querySelectorAll(".theme-toggle i").forEach((icon) => {
    icon.className = isDark ? "fa-solid fa-moon" : "fa-solid fa-sun";
  });
  document.querySelectorAll(".theme-toggle").forEach((btn) => {
    btn.setAttribute("aria-label", isDark ? "Switch to light" : "Switch to dark");
  });
}
function applyTheme(theme) {
  const normalizedTheme = theme === "dark" ? "dark" : "light";
  try { localStorage.setItem("theme", normalizedTheme); } catch {}
  syncThemeUi(normalizedTheme);
  window.dispatchEvent(new CustomEvent("ovlink:themeChanged", { detail: { theme: normalizedTheme } }));
}
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".theme-toggle");
  if (btn) {
    e.preventDefault();
    const isDark = (document.body && document.body.classList.contains("dark-mode")) || (document.documentElement && document.documentElement.classList.contains("dark-mode"));
    applyTheme(isDark ? "light" : "dark");
  }
});
(function themeBootstrap() {
  let theme = null;
  try { theme = localStorage.getItem("theme"); } catch {}
  if (!theme && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) theme = "dark";
  syncThemeUi(theme || "light");
})();

/* ---------- CSRF ---------- */
function getCsrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute("content");
}
function withCsrf(body = {}) {
  const token = getCsrfToken();
  if (!token) return body;
  return { ...body, _csrf: token };
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
  } catch { return null; }
}
async function postJsonWithCsrf(url, body) {
  const makeRequest = () =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "x-csrf-token": getCsrfToken() || "" },
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
function normalizeExpiryInput(raw) {
  const value = (raw || "").toString().trim();
  if (!value) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toISOString();
}

/* ---------- Floating promo chip (same keys) ---------- */
const FLOATING_PRICING_BANNER_DISMISS_MS = 60 * 60 * 1000;
const FLOATING_PRICING_BANNER_GUEST_ID_KEY = "ovlink_floating_pricing_guest_id";
const FLOATING_PRICING_BANNER_DISMISS_PREFIX = "ovlink_floating_pricing_banner_hidden_until";
function isProPlanActive() {
  const plan = window.__userPlan;
  if (!plan) return false;
  return (plan.tier || "").toString().toLowerCase() === "pro" && !!plan.isActive;
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
  } catch { return "guest"; }
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
  } catch { return 0; }
}
function isFloatingPricingBannerDismissed() {
  return getFloatingPricingBannerDismissUntil() > Date.now();
}
function dismissFloatingPricingBannerForOneHour() {
  try { localStorage.setItem(getFloatingPricingBannerDismissStorageKey(), String(Date.now() + FLOATING_PRICING_BANNER_DISMISS_MS)); } catch {}
}
function syncFloatingPricingBanner() {
  const banner = document.getElementById("floatingPricingBanner");
  if (!banner) return;
  const isPro = isProPlanActive();
  const hide = isPro || isFloatingPricingBannerDismissed();
  banner.classList.toggle("is-visible", !hide);
  banner.toggleAttribute("hidden", hide);
  banner.style.display = hide ? "none" : "";
  if (banner.dataset.closeBound !== "1") {
    banner.dataset.closeBound = "1";
    const closeBtn = banner.querySelector("[data-floating-pricing-close]");
    if (closeBtn) {
      closeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dismissFloatingPricingBannerForOneHour();
        syncFloatingPricingBanner();
      });
    }
  }
}

/* ---------- Session ---------- */
function setClientSession() { localStorage.setItem("isLoggedIn", "1"); }
function clearClientSession() {
  localStorage.removeItem("isLoggedIn");
  window.__userPlan = null;
  window.__userEmail = "";
  window.__userId = null;
}
function getClientSession() {
  const userNav = document.getElementById("navAuthUser");
  const userNavMobile = document.getElementById("navAuthUserM");
  const ssrLoggedIn = !!(userNav && !userNav.hasAttribute("hidden")) || !!(userNavMobile && !userNavMobile.hasAttribute("hidden"));
  const localLoggedIn = localStorage.getItem("isLoggedIn") === "1";
  const hasWindowUser = !!(window.__userId || window.__userEmail);
  return { isLoggedIn: ssrLoggedIn || localLoggedIn || hasWindowUser };
}
async function trySyncSessionFromServer() {
  try {
    const res = await fetch("/api/me", { credentials: "include" });
    if (!res.ok) { clearClientSession(); return; }
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
      if (data.user.settings && data.user.settings.ui_theme) applyTheme(data.user.settings.ui_theme);
    } else {
      clearClientSession();
    }
  } catch {}
}
function renderNavbarAuth() {
  const s = getClientSession();
  const loginBtn = document.getElementById("navAuthGuestLogin");
  const regBtn = document.getElementById("navAuthGuestReg");
  const loginM = document.getElementById("navAuthGuestLoginM");
  const regM = document.getElementById("navAuthGuestRegM");
  const user = document.getElementById("navAuthUser");
  const userM = document.getElementById("navAuthUserM");
  const userProBadge = document.getElementById("navUserProBadge");
  const logoutBtnMobile = document.getElementById("navLogoutBtnMobile");
  const pricingItem = document.getElementById("navPricingItem");
  const pricingLink = document.getElementById("navPricingLink");
  const pricingLinkMobile = document.getElementById("navPricingLinkMobile");
  const pricingLinkItem = document.getElementById("navPricingLinkItem");
  const reportHint = document.getElementById("reportLoginHint");
  const isPro = isProPlanActive();
  const showPricingForLoggedIn = s.isLoggedIn && !isPro;
  if (s.isLoggedIn) {
    loginBtn?.setAttribute("hidden", "");
    regBtn?.setAttribute("hidden", "");
    loginM?.setAttribute("hidden", "");
    regM?.setAttribute("hidden", "");
    user?.removeAttribute("hidden");
    userM?.removeAttribute("hidden");
    logoutBtnMobile?.removeAttribute("hidden");
    pricingItem?.toggleAttribute("hidden", !showPricingForLoggedIn);
    pricingLink?.toggleAttribute("hidden", isPro);
    pricingLinkMobile?.toggleAttribute("hidden", isPro);
    pricingLinkItem?.toggleAttribute("hidden", isPro);
    userProBadge?.toggleAttribute("hidden", !isPro);
    reportHint?.setAttribute("hidden", "");
  } else {
    user?.setAttribute("hidden", "");
    userM?.setAttribute("hidden", "");
    logoutBtnMobile?.setAttribute("hidden", "");
    loginBtn?.removeAttribute("hidden");
    regBtn?.removeAttribute("hidden");
    loginM?.removeAttribute("hidden");
    regM?.removeAttribute("hidden");
    pricingItem?.removeAttribute("hidden");
    pricingLink?.removeAttribute("hidden");
    pricingLinkMobile?.removeAttribute("hidden");
    pricingLinkItem?.removeAttribute("hidden");
    userProBadge?.setAttribute("hidden", "");
    reportHint?.removeAttribute("hidden");
  }
  syncFloatingPricingBanner();
}
function showNotificationToast(notification) {
  if (!notification) return;
  const lang = getCurrentLang();
  const title = lang === "tr" ? (notification.title_tr || notification.title_az || notification.title_en || "") : (lang === "en" ? (notification.title_en || notification.title_az || notification.title_tr || "") : (notification.title_az || notification.title_tr || notification.title_en || ""));
  const body = lang === "tr" ? (notification.body_tr || notification.body_az || notification.body_en || "") : (lang === "en" ? (notification.body_en || notification.body_az || notification.body_tr || "") : (notification.body_az || notification.body_tr || notification.body_en || ""));
  const shortLabel = tKey("notif_short_label", lang === "en" ? "Short link:" : (lang === "tr" ? "Kısa link:" : "Qısa link:"));
  const originalLabel = tKey("notif_original_label", lang === "en" ? "Original link:" : (lang === "tr" ? "Orijinal link:" : "Orijinal link:"));
  const extra = [];
  if (notification.link_short) extra.push(`${shortLabel} ${notification.link_short}`);
  if (notification.original_url) extra.push(`${originalLabel} ${notification.original_url}`);
  let toast = document.getElementById("notifToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "notifToast";
    toast.className = "ovx-toast";
    toast.setAttribute("role", "status");
    toast.innerHTML = '<div class="ovx-toast-title"></div><div class="ovx-toast-body"></div>';
    document.body.appendChild(toast);
  }
  const titleEl = toast.querySelector(".ovx-toast-title");
  const bodyEl = toast.querySelector(".ovx-toast-body");
  if (titleEl) titleEl.textContent = title;
  if (bodyEl) bodyEl.textContent = [body, ...extra].filter(Boolean).join(" • ");
  toast.classList.add("is-visible");
  if (toast.__hideTimer) clearTimeout(toast.__hideTimer);
  toast.__hideTimer = setTimeout(() => toast.classList.remove("is-visible"), 6000);
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
  const setBadge = (el, value) => {
    if (!el) return;
    if (value > 0) { el.textContent = String(value); el.removeAttribute("hidden"); }
    else el.setAttribute("hidden", "");
  };
  try {
    const res = await fetch("/api/notifications", { credentials: "include" });
    if (!res.ok) {
      if (res.status === 401) {
        setBadge(document.getElementById("navNotifBadge"), 0);
        setBadge(document.getElementById("navNotifBadgeMenu"), 0);
      }
      return;
    }
    const data = await res.json().catch(() => ({}));
    const items = Array.isArray(data.notifications) ? data.notifications : [];
    const unreadCount = items.filter((n) => !n.read_at).length;
    setBadge(document.getElementById("navNotifBadge"), unreadCount);
    setBadge(document.getElementById("navNotifBadgeMenu"), unreadCount);
    maybeShowNotificationToast(items);
  } catch {}
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

/* ---------- Panel / menu manager (one open at a time) ---------- */
const PanelManager = {
  closeAll(except = null) {
    document.querySelectorAll(".ovx-nav-panel.is-open, .ovx-ws-panel.is-open, .m-lang-panel.open, .m-user-panel.open, .m-ws-panel.open").forEach((p) => {
      if (p === except) return;
      p.classList.remove("is-open", "open");
      const t = document.querySelector(`[aria-controls="${p.id}"]`);
      if (t) t.setAttribute("aria-expanded", "false");
    });
  },
  toggle(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    const trigger = document.querySelector(`[aria-controls="${panelId}"]`);
    const isOpen = panel.classList.contains("open") || panel.classList.contains("is-open");
    this.closeAll(panel);
    panel.classList.toggle("open", !isOpen);
    panel.classList.toggle("is-open", !isOpen);
    if (trigger) trigger.setAttribute("aria-expanded", String(!isOpen));
  },
};
document.addEventListener("click", (e) => {
  const trigger = e.target.closest("[aria-controls]");
  if (trigger && (trigger.closest(".ovx-ws") || trigger.closest(".m-ws-wrap") || trigger.id === "langToggleBtn" || trigger.id === "langToggleBtnMobile" || trigger.id === "navUserMenuBtn" || trigger.id === "homeWorkspaceDropdownBtn")) {
    e.preventDefault();
    PanelManager.toggle(trigger.getAttribute("aria-controls"));
    return;
  }
  if (!e.target.closest(".ovx-nav-panel, .ovx-ws-panel, .m-lang-panel, .m-user-panel, .m-ws-panel")) PanelManager.closeAll();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") PanelManager.closeAll();
});

/* ---------- Custom domains ---------- */
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
  domains.filter((d) => d && d.status === "active" && d.domain).forEach((d) => {
    const option = document.createElement("option");
    option.value = d.domain;
    option.textContent = d.domain;
    select.appendChild(option);
  });
  if (selected && [...select.options].some((o) => o.value === selected)) select.value = selected;
}
function refreshCustomDomainUi() { populateCustomDomainSelect(customDomainsState.domains); }
window.refreshCustomDomainUi = refreshCustomDomainUi;
async function loadCustomDomains() {
  const select = document.getElementById("customDomainSelect");
  if (!select) return;
  try {
    const res = await fetch("/api/domains", { credentials: "include" });
    if (!res.ok) { customDomainsState.domains = []; refreshCustomDomainUi(); return; }
    const data = await res.json().catch(() => ({}));
    customDomainsState.domains = Array.isArray(data.domains) ? data.domains : [];
    customDomainsState.targetHost = (data.target_host || "").toString();
    refreshCustomDomainUi();
  } catch {
    customDomainsState.domains = [];
    refreshCustomDomainUi();
  }
}

/* ---------- UTM templates ---------- */
const BUILTIN_UTM_TEMPLATES = [
  { name: "Facebook & Instagram Ads", source: "facebook", medium: "cpc", campaign: "promo_feed" },
  { name: "Google Ads", source: "google", medium: "cpc", campaign: "search_ad" },
  { name: "TikTok Ads", source: "tiktok", medium: "paid_video", campaign: "reels_campaign" },
  { name: "Email Newsletter", source: "newsletter", medium: "email", campaign: "weekly_digest" },
  { name: "LinkedIn Post", source: "linkedin", medium: "social", campaign: "company_post" },
  { name: "Twitter / X", source: "twitter", medium: "social", campaign: "launch_tweet" },
  { name: "YouTube Video", source: "youtube", medium: "video_desc", campaign: "channel_promo" },
];
function loadUtmTemplates() {
  const utmSelect = document.getElementById("utmTemplateSelect");
  if (!utmSelect) return;
  const currentVal = utmSelect.value;
  const defaultText = (typeof tKey === "function" ? tKey("adv_utm_template_select") : null) || "Select Template";
  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.setAttribute("data-i18n", "adv_utm_template_select");
  defaultOpt.textContent = defaultText;
  if (typeof utmSelect.replaceChildren === "function") utmSelect.replaceChildren(defaultOpt);
  else { utmSelect.innerHTML = ""; utmSelect.appendChild(defaultOpt); }
  const builtInGroup = document.createElement("optgroup");
  builtInGroup.label = (typeof tKey === "function" ? tKey("adv_utm_popular_templates") : null) || "Popular Templates";
  BUILTIN_UTM_TEMPLATES.forEach((tpl, idx) => {
    const opt = document.createElement("option");
    opt.value = "builtin_" + idx;
    opt.textContent = tpl.name;
    builtInGroup.appendChild(opt);
  });
  utmSelect.appendChild(builtInGroup);
  try {
    const rawStored = localStorage.getItem("ovlink_utm_templates");
    const stored = rawStored ? JSON.parse(rawStored) : [];
    if (Array.isArray(stored) && stored.length > 0) {
      const customGroup = document.createElement("optgroup");
      customGroup.label = (typeof tKey === "function" ? tKey("adv_utm_custom_templates") : null) || "Custom Templates";
      stored.forEach((tpl, idx) => {
        if (!tpl || typeof tpl !== "object") return;
        const opt = document.createElement("option");
        opt.value = "custom_" + idx;
        opt.textContent = tpl.name || (pickLang("Şablon ", "Şablon ", "Template ") + (idx + 1));
        customGroup.appendChild(opt);
      });
      if (customGroup.children.length > 0) utmSelect.appendChild(customGroup);
    }
  } catch {}
  if (currentVal) {
    const exists = Array.from(utmSelect.options).some((o) => o.value === currentVal);
    utmSelect.value = exists ? currentVal : "";
  }
}
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
      let tpl = null;
      if (val.startsWith("builtin_")) tpl = BUILTIN_UTM_TEMPLATES[parseInt(val.replace("builtin_", ""), 10)];
      else if (val.startsWith("custom_")) {
        try {
          const rawStored = localStorage.getItem("ovlink_utm_templates");
          const stored = rawStored ? JSON.parse(rawStored) : [];
          tpl = Array.isArray(stored) ? stored[parseInt(val.replace("custom_", ""), 10)] : null;
        } catch {}
      }
      if (tpl) {
        if (sourceEl) sourceEl.value = tpl.source || "";
        if (mediumEl) mediumEl.value = tpl.medium || "";
        if (campaignEl) campaignEl.value = tpl.campaign || "";
      }
    });
  }
}

/* ---------- Advanced settings: Save UTM template ---------- */
function initUtmTemplateSave() {
  const saveUtmBtn = document.getElementById("saveUtmTemplateBtn");
  if (saveUtmBtn) {
    saveUtmBtn.addEventListener("click", () => {
      const source = document.getElementById("utmSource")?.value?.trim() || "";
      const medium = document.getElementById("utmMedium")?.value?.trim() || "";
      const campaign = document.getElementById("utmCampaign")?.value?.trim() || "";
      if (!source && !medium && !campaign) {
        alert(tKey("adv_utm_no_params_alert", pickLang("Yadda saxlanılacaq UTM parametri tapılmadı!", "Kaydedilecek bir UTM parametresi bulunamadı!", "No UTM parameter found to save!")));
        return;
      }
      const name = prompt(tKey("adv_utm_prompt_name", pickLang("Bu şablon üçün ad daxil edin (Məs: Yay Endirimi):", "Bu şablon için bir isim girin (Örn: Yaz İndirimi):", "Enter a name for this template (e.g., Summer Sale):")));
      if (!name || !name.trim()) return;
      try {
        const rawStored = localStorage.getItem("ovlink_utm_templates");
        const stored = rawStored ? JSON.parse(rawStored) : [];
        const list = Array.isArray(stored) ? stored : [];
        list.push({ name: name.trim(), source, medium, campaign });
        localStorage.setItem("ovlink_utm_templates", JSON.stringify(list));
        loadUtmTemplates();
        const sel = document.getElementById("utmTemplateSelect");
        if (sel) sel.value = "custom_" + (list.length - 1);
      } catch {
        alert(tKey("adv_utm_save_error", pickLang("Şablon yadda saxlanılarkən xəta baş verdi.", "Şablon kaydedilirken bir hata oluştu.", "Error occurred while saving the template.")));
      }
    });
  }
}

/* ---------- Workspace selector ---------- */
let selectedHomeWorkspaceId = 0;
function initWorkspaceSelector() {
  const wrapper = document.getElementById("homeWorkspaceTopWrapper");
  const btn = document.getElementById("homeWorkspaceDropdownBtn");
  const icon = document.getElementById("homeWorkspaceBtnIcon");
  const text = document.getElementById("homeWorkspaceBtnText");
  const menu = document.getElementById("homeWorkspaceDropdownMenu");
  if (!wrapper || !btn || !menu || !icon || !text) return;
  const updateHwBtn = (id, name) => {
    icon.className = id === 0 ? "fa-regular fa-user" : "fa-solid fa-users";
    text.textContent = name;
    selectedHomeWorkspaceId = id;
    localStorage.setItem("ovlink_home_workspace", String(id));
  };

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    PanelManager.toggle("homeWorkspaceDropdownMenu");
  });

  (async () => {
    if (!getClientSession().isLoggedIn) return;
    try {
      const res = await fetch("/api/workspaces", { credentials: "include" });
      if (!res.ok) return;
      const data = await res.json();
      const workspaces = data.workspaces || [];
      if (!workspaces.length) return;
      wrapper.removeAttribute("hidden");
      const personalName = pickLang("Şəxsi hesab", "Kişisel hesap", "Personal account");
      menu.innerHTML = "";
      const personal = document.createElement("button");
      personal.type = "button";
      personal.className = "m-user-item";
      personal.setAttribute("role", "menuitem");
      personal.setAttribute("data-ws-id", "0");
      personal.innerHTML = '<i class="fa-regular fa-user"></i><span></span>';
      personal.querySelector("span").textContent = personalName;
      menu.appendChild(personal);
      workspaces.forEach((ws) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "m-user-item";
        item.setAttribute("role", "menuitem");
        item.setAttribute("data-ws-id", String(ws.id));
        item.innerHTML = '<i class="fa-solid fa-users"></i><span></span>';
        item.querySelector("span").textContent = ws.name;
        menu.appendChild(item);
      });
      const storedId = parseInt(localStorage.getItem("ovlink_home_workspace") || "0", 10);
      const activeWs = workspaces.find((w) => w.id === storedId);
      updateHwBtn(activeWs ? activeWs.id : 0, activeWs ? activeWs.name : personalName);
      menu.addEventListener("click", (e) => {
        const a = e.target.closest("[data-ws-id]");
        if (!a) return;
        e.preventDefault();
        const id = parseInt(a.getAttribute("data-ws-id"), 10) || 0;
        const name = a.querySelector("span")?.textContent || "";
        updateHwBtn(id, name);
        PanelManager.closeAll();
      });
    } catch {}
  })();
}

/* ---------- Shorten flow ---------- */
function initShorten() {
  const form = document.getElementById("shortenForm");
  if (!form || form.dataset.shortenBound === "true") return;
  form.dataset.shortenBound = "true";
  try {
    const urlParam = new URLSearchParams(window.location.search).get("url");
    if (urlParam) {
      const origInput = document.getElementById("originalUrl");
      if (origInput && !origInput.value) {
        origInput.value = decodeURIComponent(urlParam);
        setTimeout(() => {
          try { origInput.focus(); origInput.scrollIntoView({ behavior: "smooth", block: "center" }); } catch {}
        }, 150);
      }
    }
  } catch {}
  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    const resultDiv = document.getElementById("result");
    const shortUrlEl = document.getElementById("shortUrl");
    const hintEl = document.getElementById("shortenHint");
    const feedbackEl = document.getElementById("shortenFeedback");
    const submitBtn = document.getElementById("shortenSubmitBtn");
    const showFeedback = (msg, isError = true) => {
      const el = document.getElementById("shortenFeedback") || feedbackEl;
      if (!el) return;
      el.textContent = msg;
      el.className = `m-status ${isError ? "error" : "ok"}`;
      if (isError && resultDiv) { resultDiv.classList.remove("is-visible"); resultDiv.style.display = "none"; }
      try { el.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch {}
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
        const u = new URL(urlStr.startsWith("http") ? urlStr : "http://" + urlStr);
        if (utmSource) u.searchParams.set("utm_source", utmSource);
        if (utmMedium) u.searchParams.set("utm_medium", utmMedium);
        if (utmCampaign) u.searchParams.set("utm_campaign", utmCampaign);
        return u.toString();
      } catch { return urlStr; }
    };
    originalUrl = appendUtm(originalUrl);
    if (original_b) original_b = appendUtm(original_b);
    if (ios_url) ios_url = appendUtm(ios_url);
    if (android_url) android_url = appendUtm(android_url);
    const hasProFeature = Boolean(original_b || ios_url || android_url);
    const session = getClientSession();
    const isPro = isProPlanActive();
    if (hasProFeature && (!session.isLoggedIn || (window.__userPlan && !isPro))) {
      showFeedback(original_b ? tKey("pro_feature_required_ab", "A/B Test is only available for PRO users. Please upgrade to Pro.") : tKey("pro_feature_required_device", "Device Targeting is only available for PRO users. Please upgrade to Pro."));
      return;
    }
    if (submitBtn) { submitBtn.setAttribute("disabled", ""); }
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
        android_url,
      };
      if (typeof selectedHomeWorkspaceId !== "undefined" && selectedHomeWorkspaceId > 0) payload.workspaceId = selectedHomeWorkspaceId;
      const response = await postJsonWithCsrf("/api/shorten", payload);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) {
        let errorMsg = data.error || (response.status === 403 ? tKey("pro_feature_required_ab", "A/B Test is only available for PRO users. Please upgrade to Pro.") : pickLang("Sorğu uğursuz oldu", "İşlem başarısız", "Request failed"));
        if (errorMsg === pickLang("Bu xüsusi link istifadə olunub", "Bu özel link kullanımda", "This custom link is already in use")) errorMsg = tKey("error_alias_taken", errorMsg);
        else if (errorMsg === pickLang("Zəhmət olmasa düzgün bir URL daxil edin.", "Lütfen geçerli bir URL girin.", "Please enter a valid URL.")) errorMsg = tKey("error_invalid_url", errorMsg);
        showFeedback(errorMsg, true);
        return;
      }
      if (feedbackEl) feedbackEl.className = "m-status";
      let shortLink = data.shortUrl || data.short || null;
      if (!shortLink && typeof data.message === "string") {
        const match = data.message.match(/https?:\/\/\S+/i);
        if (match) shortLink = match[0];
      }
      if (!shortLink && data.code) shortLink = `${location.protocol}//${location.host}/${data.code}`;
      if (!shortLink) { showFeedback(pickLang("Qısaltma uğursuz oldu.", "Kısaltma sonucu alınamadı.", "Shortening failed."), true); return; }
      if (shortUrlEl) { shortUrlEl.href = shortLink; shortUrlEl.textContent = shortLink; }
      if (hintEl) {
        hintEl.textContent = pickLang(
          "Kopyala ilə sürətlə paylaşın, QR-a Göndər ilə bir toxunuşla QR yaradın.",
          "Kopyala ile hızlı paylaşın, QR'a gönder ile tek dokunuşla QR üretin.",
          "Share quickly with Copy, generate a QR with Send to QR."
        );
      }
      if (resultDiv) { resultDiv.classList.add("is-visible"); resultDiv.style.display = "block"; }
      if (getClientSession().isLoggedIn) {
        setTimeout(() => loadNotifications().catch(() => {}), 1200);
        setTimeout(() => loadNotifications().catch(() => {}), 3500);
      }
    } catch (err) {
      showFeedback(pickLang("Server xətası: ", "Sunucu hatası: ", "Server error: ") + (err?.message || ""));
    } finally {
      if (submitBtn) submitBtn.removeAttribute("disabled");
    }
  });
}

/* ---------- Copy / Send to QR ---------- */
document.addEventListener("click", async (e) => {
  const copyBtn = e.target.closest("#copyShortBtn");
  const qrBtn = e.target.closest("#sendToQrBtn");
  if (!copyBtn && !qrBtn) return;
  e.preventDefault();
  const shortUrlEl = document.getElementById("shortUrl");
  const text = shortUrlEl?.textContent?.trim();
  if (!text) return;
  if (copyBtn) {
    let copied = false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch (_) {}
    }
    if (!copied) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        ta.style.top = "-9999px";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        copied = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch (_) {}
    }
    if (copied) {
      const label = copyBtn.querySelector("span");
      const prev = label ? label.textContent : null;
      if (label) label.textContent = tKey("copied_msg", "Copied!");
      setTimeout(() => { if (label && prev) label.textContent = prev; }, 1200);
    }
  }
  if (qrBtn) {
    const shortCode = text.split("/").pop();
    const qrInput = document.getElementById("qrShortLink");
    const qrSection = document.getElementById("qrSection");
    if (qrInput) qrInput.value = shortCode;
    if (typeof window.__ovlinkGenerateQr === "function") void window.__ovlinkGenerateQr(shortCode);
    else {
      const qrForm = document.getElementById("qrForm");
      if (qrForm) qrForm.requestSubmit ? qrForm.requestSubmit() : qrForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    }
    if (qrSection) {
      const targetTop = Math.max(0, window.scrollY + qrSection.getBoundingClientRect().top - 84);
      window.scrollTo({ top: targetTop, behavior: "smooth" });
    }
  }
});

/* ---------- QR tool ---------- */
(function initQr() {
  const form = document.getElementById("qrForm");
  if (!form) return;

  /* ---------- Monolith Color Picker (aligned with DESIGN.md & native photo layout) ---------- */
  function initMonolithColorPicker() {
    const popover = document.getElementById("monolithColorPicker");
    const satBox = document.getElementById("cpSatBox");
    const satPointer = document.getElementById("cpSatPointer");
    const hueSlider = document.getElementById("cpHueSlider");
    const hueThumb = document.getElementById("cpHueThumb");
    const eyedropper = document.getElementById("cpEyedropper");
    const previewCircle = document.getElementById("cpPreviewCircle");
    const inputR = document.getElementById("cpInputR");
    const inputG = document.getElementById("cpInputG");
    const inputB = document.getElementById("cpInputB");
    const inputHex = document.getElementById("cpInputHex");
    const modeRgb = document.getElementById("cpModeRgb");
    const modeHex = document.getElementById("cpModeHex");
    const switcherBtn = document.getElementById("cpSwitcherBtn");

    const triggerDark = document.getElementById("triggerDark");
    const triggerLight = document.getElementById("triggerLight");
    const swatchDark = document.getElementById("swatchDark");
    const swatchLight = document.getElementById("swatchLight");
    const textDark = document.getElementById("textValDark");
    const textLight = document.getElementById("textValLight");
    const hiddenDark = document.getElementById("colorDark");
    const hiddenLight = document.getElementById("colorLight");

    if (!popover || !satBox || !hueSlider) return;

    let activeTarget = "dark"; // 'dark' | 'light'
    let hue = 0; // 0..360
    let sat = 0; // 0..1
    let val = 0; // 0..1
    let isRgbMode = true;

    function hsvToRgb(h, s, v) {
      h = (h % 360 + 360) % 360;
      const c = v * s;
      const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
      const m = v - c;
      let r = 0, g = 0, b = 0;
      if (0 <= h && h < 60) { r = c; g = x; b = 0; }
      else if (60 <= h && h < 120) { r = x; g = c; b = 0; }
      else if (120 <= h && h < 180) { r = 0; g = c; b = x; }
      else if (180 <= h && h < 240) { r = 0; g = x; b = c; }
      else if (240 <= h && h < 300) { r = x; g = 0; b = c; }
      else if (300 <= h && h < 360) { r = c; g = 0; b = x; }
      return {
        r: Math.round((r + m) * 255),
        g: Math.round((g + m) * 255),
        b: Math.round((b + m) * 255)
      };
    }

    function rgbToHsv(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const d = max - min;
      let h = 0;
      const s = max === 0 ? 0 : d / max;
      const v = max;
      if (max !== min) {
        switch (max) {
          case r: h = (g - b) / d + (g < b ? 6 : 0); break;
          case g: h = (b - r) / d + 2; break;
          case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
      }
      return { h: h * 360, s, v };
    }

    function rgbToHex(r, g, b) {
      return "#" + [r, g, b].map((x) => {
        const hx = Math.max(0, Math.min(255, Math.round(x))).toString(16);
        return hx.length === 1 ? "0" + hx : hx;
      }).join("").toUpperCase();
    }

    function hexToRgb(hex) {
      let s = String(hex || "").trim().replace(/^#/, "");
      if (s.length === 3) s = s.split("").map((c) => c + c).join("");
      if (s.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(s)) return null;
      const num = parseInt(s, 16);
      return {
        r: (num >> 16) & 255,
        g: (num >> 8) & 255,
        b: num & 255
      };
    }

    function syncUI(updateInputs = true) {
      satBox.style.backgroundColor = `hsl(${Math.round(hue)}, 100%, 50%)`;
      if (satPointer) {
        satPointer.style.left = `${Math.round(sat * 1000) / 10}%`;
        satPointer.style.top = `${Math.round((1 - val) * 1000) / 10}%`;
      }
      if (hueThumb) {
        hueThumb.style.left = `${Math.round((hue / 360) * 1000) / 10}%`;
      }

      const { r, g, b } = hsvToRgb(hue, sat, val);
      const hex = rgbToHex(r, g, b);

      if (previewCircle) {
        previewCircle.style.backgroundColor = hex;
      }

      if (updateInputs) {
        if (inputR) inputR.value = r;
        if (inputG) inputG.value = g;
        if (inputB) inputB.value = b;
        if (inputHex) inputHex.value = hex;
      }

      if (activeTarget === "dark") {
        if (hiddenDark) hiddenDark.value = hex;
        if (swatchDark) swatchDark.style.backgroundColor = hex;
        if (textDark) textDark.textContent = hex;
      } else {
        if (hiddenLight) hiddenLight.value = hex;
        if (swatchLight) swatchLight.style.backgroundColor = hex;
        if (textLight) textLight.textContent = hex;
      }
    }

    function setColorFromHex(hexStr) {
      const rgb = hexToRgb(hexStr);
      if (!rgb) return;
      const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      // Retain hue if saturation is 0 (pure gray/white/black) to avoid jarring hue resets
      if (hsv.s > 0.01) {
        hue = hsv.h;
      }
      sat = hsv.s;
      val = hsv.v;
      syncUI(true);
    }

    // Saturation/Value 2D pointer dragging
    function onSatPointer(e) {
      const rect = satBox.getBoundingClientRect();
      const clientX = e.clientX ?? (e.touches && e.touches[0] ? e.touches[0].clientX : null);
      const clientY = e.clientY ?? (e.touches && e.touches[0] ? e.touches[0].clientY : null);
      if (clientX == null || clientY == null) return;
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
      sat = rect.width ? x / rect.width : 0;
      val = rect.height ? 1 - (y / rect.height) : 0;
      syncUI(true);
    }

    if (window.PointerEvent) {
      satBox.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        try { satBox.setPointerCapture(e.pointerId); } catch {}
        onSatPointer(e);
        const onMove = (ev) => onSatPointer(ev);
        const onUp = (ev) => {
          try { satBox.releasePointerCapture(ev.pointerId); } catch {}
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });
    } else {
      satBox.addEventListener("mousedown", (e) => {
        e.preventDefault();
        onSatPointer(e);
        const onMove = (ev) => onSatPointer(ev);
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });
    }

    // Hue slider pointer dragging
    function onHuePointer(e) {
      const rect = hueSlider.getBoundingClientRect();
      const clientX = e.clientX ?? (e.touches && e.touches[0] ? e.touches[0].clientX : null);
      if (clientX == null) return;
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      hue = rect.width ? Math.min(360, Math.max(0, (x / rect.width) * 360)) : 0;
      syncUI(true);
    }

    if (window.PointerEvent) {
      hueSlider.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        try { hueSlider.setPointerCapture(e.pointerId); } catch {}
        onHuePointer(e);
        const onMove = (ev) => onHuePointer(ev);
        const onUp = (ev) => {
          try { hueSlider.releasePointerCapture(ev.pointerId); } catch {}
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });
    } else {
      hueSlider.addEventListener("mousedown", (e) => {
        e.preventDefault();
        onHuePointer(e);
        const onMove = (ev) => onHuePointer(ev);
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });
    }

    // Eyedropper
    if (eyedropper) {
      if (!window.EyeDropper) {
        eyedropper.style.display = "none";
      } else {
        eyedropper.addEventListener("click", async (e) => {
          e.preventDefault();
          try {
            const ed = new window.EyeDropper();
            const res = await ed.open();
            if (res && res.sRGBHex) {
              setColorFromHex(res.sRGBHex);
            }
          } catch {}
        });
      }
    }

    // RGB / HEX Mode Switcher
    if (switcherBtn) {
      switcherBtn.addEventListener("click", (e) => {
        e.preventDefault();
        isRgbMode = !isRgbMode;
        if (modeRgb) modeRgb.style.display = isRgbMode ? "flex" : "none";
        if (modeHex) modeHex.style.display = isRgbMode ? "none" : "flex";
      });
    }

    // RGB inputs
    const handleRgbInput = () => {
      const r = Math.max(0, Math.min(255, parseInt(inputR?.value, 10) || 0));
      const g = Math.max(0, Math.min(255, parseInt(inputG?.value, 10) || 0));
      const b = Math.max(0, Math.min(255, parseInt(inputB?.value, 10) || 0));
      const hsv = rgbToHsv(r, g, b);
      if (hsv.s > 0.01) hue = hsv.h;
      sat = hsv.s;
      val = hsv.v;
      syncUI(false);
      if (inputHex) inputHex.value = rgbToHex(r, g, b);
    };

    inputR?.addEventListener("input", handleRgbInput);
    inputG?.addEventListener("input", handleRgbInput);
    inputB?.addEventListener("input", handleRgbInput);

    // HEX input
    inputHex?.addEventListener("input", () => {
      let v = (inputHex.value || "").trim();
      if (!v.startsWith("#") && v.length > 0) v = "#" + v;
      const rgb = hexToRgb(v);
      if (rgb) {
        const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
        if (hsv.s > 0.01) hue = hsv.h;
        sat = hsv.s;
        val = hsv.v;
        syncUI(false);
        if (inputR) inputR.value = rgb.r;
        if (inputG) inputG.value = rgb.g;
        if (inputB) inputB.value = rgb.b;
      }
    });

    // Ensure color picker popover is portaled to document.body so no ancestor overflow:hidden or transform can clip it
    if (popover && popover.parentElement !== document.body) {
      document.body.appendChild(popover);
    }

    function positionPicker(triggerEl) {
      if (!triggerEl || !popover) return;
      const rect = triggerEl.getBoundingClientRect();
      const popoverWidth = 240;
      const popoverHeight = 250;

      // Horizontal position
      let left = activeTarget === "light"
        ? (rect.right - popoverWidth)
        : rect.left;

      // Keep within viewport horizontally with safe minimum
      const maxLeft = Math.max(8, window.innerWidth - popoverWidth - 8);
      if (left > maxLeft) left = maxLeft;
      if (left < 8) left = 8;

      // Vertical position: default below trigger, flip above if not enough room below
      let top = rect.bottom + 8;
      if (top + popoverHeight > window.innerHeight - 12) {
        if (rect.top - popoverHeight - 8 > 12) {
          top = rect.top - popoverHeight - 8;
        } else {
          top = Math.max(12, window.innerHeight - popoverHeight - 12);
        }
      }

      popover.style.top = `${Math.round(top)}px`;
      popover.style.left = `${Math.round(left)}px`;
    }

    // Opening / Closing popover
    function openPicker(target) {
      activeTarget = target;
      const isDark = target === "dark";
      const trigger = isDark ? triggerDark : triggerLight;
      popover.removeAttribute("hidden");
      positionPicker(trigger);

      if (triggerDark) triggerDark.setAttribute("aria-expanded", isDark ? "true" : "false");
      if (triggerLight) triggerLight.setAttribute("aria-expanded", !isDark ? "true" : "false");

      const currentColor = isDark ? (hiddenDark?.value || "#000000") : (hiddenLight?.value || "#ffffff");
      setColorFromHex(currentColor);
    }

    function closePicker() {
      popover.setAttribute("hidden", "");
      if (triggerDark) triggerDark.setAttribute("aria-expanded", "false");
      if (triggerLight) triggerLight.setAttribute("aria-expanded", "false");
    }

    const onScrollOrResize = () => {
      if (!popover.hasAttribute("hidden")) {
        const trigger = activeTarget === "dark" ? triggerDark : triggerLight;
        if (trigger) positionPicker(trigger);
      }
    };
    window.addEventListener("scroll", onScrollOrResize, { passive: true });
    window.addEventListener("resize", onScrollOrResize, { passive: true });

    const togglePickerTarget = (target) => {
      if (!popover.hasAttribute("hidden") && activeTarget === target) {
        closePicker();
      } else {
        openPicker(target);
      }
    };

    triggerDark?.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePickerTarget("dark");
    });

    triggerLight?.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePickerTarget("light");
    });

    const bindTriggerKey = (trigger, target) => {
      trigger?.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
          e.preventDefault();
          e.stopPropagation();
          togglePickerTarget(target);
        }
      });
    };
    bindTriggerKey(triggerDark, "dark");
    bindTriggerKey(triggerLight, "light");

    // Dismiss on click outside
    document.addEventListener("click", (e) => {
      if (popover.hasAttribute("hidden")) return;
      if (e.target.closest("#monolithColorPicker") || e.target.closest("#triggerDark") || e.target.closest("#triggerLight")) {
        return;
      }
      closePicker();
    });

    // Dismiss on Escape key
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !popover.hasAttribute("hidden")) {
        closePicker();
      }
    });

    // Initialize triggers with default values
    if (swatchDark && hiddenDark) swatchDark.style.backgroundColor = hiddenDark.value;
    if (textDark && hiddenDark) textDark.textContent = hiddenDark.value.toUpperCase();
    if (swatchLight && hiddenLight) swatchLight.style.backgroundColor = hiddenLight.value;
    if (textLight && hiddenLight) textLight.textContent = hiddenLight.value.toUpperCase();
  }

  initMonolithColorPicker();

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
    qrFeedback.className = `m-status ${isError ? "error" : "ok"}`;
    if (isError && qrResultDiv) { qrResultDiv.classList.remove("is-visible"); qrResultDiv.style.display = "none"; }
    if (isError && qrDownloadBtn) qrDownloadBtn.classList.remove("is-visible");
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
        if (qrFeedback) qrFeedback.className = "m-status";
        qrImage.src = data.qrCode;
        if (qrResultDiv) { qrResultDiv.classList.remove("is-visible"); void qrResultDiv.offsetWidth; qrResultDiv.classList.add("is-visible"); qrResultDiv.style.display = "block"; }
        if (qrDownloadBtn) qrDownloadBtn.classList.add("is-visible");
      } else {
        let errorMsg = pickLang("QR kod yaradıla bilmədi.", "QR Kod oluşturulamadı.", "QR code could not be created.");
        if (response.status === 404) errorMsg = tKey("error_link_not_found", errorMsg);
        showQrFeedback(errorMsg);
      }
    } catch (err) {
      showQrFeedback(pickLang("QR kod xətası: ", "QR Kod oluşturma hatası: ", "QR code error: ") + (err?.message || ""));
    }
  };
  window.__ovlinkGenerateQr = runQrGeneration;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await runQrGeneration();
  });
})();

/* ---------- Report tool ---------- */
(function initReport() {
  const form = document.getElementById("reportForm");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const session = getClientSession();
    const reportMessage = document.getElementById("reportMessage");
    if (!session.isLoggedIn) {
      if (reportMessage) {
        reportMessage.textContent = pickLang(
          "Şikayət göndərmək üçün hesabınıza daxil olmalısınız.",
          "Bildirim göndermek için hesabınıza giriş yapmalısınız.",
          "You must be logged in to submit a report."
        );
        reportMessage.className = "m-report-msg error";
      }
      return;
    }
    const reportLink = document.getElementById("reportLink")?.value?.trim();
    const reportReason = document.getElementById("reportReason")?.value?.trim();
    try {
      const response = await postJsonWithCsrf("/api/report", { short: reportLink, reason: reportReason, lang: getCurrentLang() });
      const data = await response.json().catch(() => ({}));
      if (reportMessage) {
        let displayMsg = data.message || data.error || pickLang("Bilinməyən cavab", "Bilinmeyen yanıt", "Unknown response");
        if (displayMsg === "Belə Bir Link Tapılmadı") displayMsg = tKey("error_link_not_found", displayMsg);
        reportMessage.textContent = displayMsg;
        reportMessage.className = "m-report-msg " + (data.error ? "error" : "ok");
      }
    } catch (err) {
      if (reportMessage) {
        reportMessage.textContent = pickLang("Xəta: ", "Hata: ", "Error: ") + (err?.message || "");
        reportMessage.className = "m-report-msg error";
      }
    }
  });
})();

/* ---------- Scroll reveals, counters & motion (delegated to index.ejs inline script) ---------- */
function initMotion() {
  // Motion & counter loops are handled natively in index.ejs to avoid duplicate/conflicting animations
}

/* ---------- Boot ---------- */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
function boot() {
  initMotion();
  initShorten();
  setupUtmListeners();
  loadUtmTemplates();
  initWorkspaceSelector();
  const logoutBtn = document.getElementById("navLogoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", (e) => { e.preventDefault(); clientLogout(); });
  const initAsync = async () => {
    if (!getCsrfToken()) await refreshCsrfToken();
    await trySyncSessionFromServer();
    renderNavbarAuth();
    if (getClientSession().isLoggedIn) {
      await loadCustomDomains();
      await loadNotifications();
      if (!window.__notifPollerActive) {
        window.__notifPollerActive = true;
        setInterval(() => {
          if (document.visibilityState === "visible" && getClientSession().isLoggedIn) loadNotifications().catch(() => {});
        }, 20000);
      }
    }
  };
  void initAsync();
  syncFloatingPricingBanner();
}
window.addEventListener("ovlink:languageChanged", () => { loadUtmTemplates(); });
