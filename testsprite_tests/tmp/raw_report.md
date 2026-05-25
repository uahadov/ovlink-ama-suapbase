
# TestSprite AI Testing Report(MCP)

---

## 1️⃣ Document Metadata
- **Project Name:** öldü mence
- **Date:** 2026-03-02
- **Prepared by:** TestSprite AI Team

---

## 2️⃣ Requirement Validation Summary

#### Test TB001 Public policy routes respond successfully
- **Test Code:** [TB001_Public_policy_routes_respond_successfully.py](./TB001_Public_policy_routes_respond_successfully.py)
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/d0b4e9da-28bb-48ec-8718-597466a91c64/9b37ea46-5a07-44cd-aedf-81e30b236137
- **Status:** ✅ Passed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TB002 Unknown route returns non-success
- **Test Code:** [TB002_Unknown_route_returns_non_success.py](./TB002_Unknown_route_returns_non_success.py)
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/d0b4e9da-28bb-48ec-8718-597466a91c64/bae3f805-ef49-4fec-98bd-a3aa8e25a54a
- **Status:** ✅ Passed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TB003 Admin entrypoint is gated
- **Test Code:** [TB003_Admin_entrypoint_is_gated.py](./TB003_Admin_entrypoint_is_gated.py)
- **Test Error:** Traceback (most recent call last):
  File "/var/task/handler.py", line 258, in run_with_retry
    exec(code, exec_env)
  File "<string>", line 32, in <module>
  File "<string>", line 14, in test_admin_entrypoint_is_gated
AssertionError: Unauthenticated access to http://localhost:3000/admin returned status 200 instead of redirect or unauthorized.

- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/d0b4e9da-28bb-48ec-8718-597466a91c64/40932683-882f-4b4c-9084-9890c77b3526
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TB004 Domain API rejects anonymous caller
- **Test Code:** [TB004_Domain_API_rejects_anonymous_caller.py](./TB004_Domain_API_rejects_anonymous_caller.py)
- **Test Error:** Traceback (most recent call last):
  File "/var/task/handler.py", line 258, in run_with_retry
    exec(code, exec_env)
  File "<string>", line 24, in <module>
  File "<string>", line 19, in test_domain_api_rejects_anonymous_caller
AssertionError: Expected 401 Unauthorized or 403 Forbidden, got 404. Response body: <!doctype html>
<html lang="en">

<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="csrf-token" content="">
  <title>Page not found - Ovlink</title>
  <meta name="robots" content="noindex,nofollow" />
  <meta name="description" content="The page you are looking for does not exist or was moved." />
  <link rel="canonical" href="http://localhost:3000/api/custom-domains" />
  <link rel="alternate" hreflang="en" href="http://localhost:3000/api/custom-domains?lang=en" />
  <link rel="alternate" hreflang="az" href="http://localhost:3000/api/custom-domains?lang=az" />
  <link rel="alternate" hreflang="tr" href="http://localhost:3000/api/custom-domains?lang=tr" />
  <link rel="alternate" hreflang="x-default" href="http://localhost:3000/api/custom-domains?lang=en" />
  <link rel="icon" href="/logo.ico" />
  <link rel="manifest" href="/site.webmanifest" />
  <link rel="preconnect" href="https://cdn.jsdelivr.net">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" integrity="sha384-9ndCyUaIbzAi2FUVXJi0CjmCapSmO7SnpJef0486qhLnuZ2cdeRhO02iuK6FUUVM" crossorigin="anonymous" rel="stylesheet" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" integrity="sha384-iw3OoTErCYJJB9mCa8LNS2hbsQ7M3C0EpIsO/H5+EGAkPGc6rk+V8i04oW/K5xq0" crossorigin="anonymous" />
  <link rel="stylesheet" href="/style.css" />
  
</head>

<body class="home-page policy-page notfound-page">

  

  <nav class="navbar navbar-expand-lg navbar-light home-navbar shadow-sm">
    <div class="container">
      <a class="navbar-brand fw-bold d-flex align-items-center" href="/">
        <img src="/logo.webp" alt="Ovlink" class="home-brand-logo" />
      </a>
      <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#notFoundNavbarContent"
        aria-controls="notFoundNavbarContent" aria-expanded="false" aria-label="Menu toggle">
        <span class="navbar-toggler-icon"></span>
      </button>
      <div class="collapse navbar-collapse" id="notFoundNavbarContent">
        <ul class="navbar-nav ms-auto align-items-lg-center">
          <li class="nav-item" id="navAuthGuestLogin">
            <a class="nav-link" href="/login"><i class="fa-solid fa-right-to-bracket"></i> <span data-i18n="nav_login">Giriş</span></a>
          </li>
          <li class="nav-item" id="navAuthGuestReg">
            <a class="nav-link" href="/register"><i class="fa-solid fa-user-plus"></i> <span data-i18n="nav_register">Qeydiyyat</span></a>
          </li>
          <li class="nav-item dropdown nav-user-dropdown d-none" id="navAuthUser">
            <a class="nav-link dropdown-toggle position-relative" href="#" role="button" data-bs-toggle="dropdown" aria-expanded="false">
              <i class="fa-solid fa-user-circle me-1"></i>
              <span id="navUserEmail" data-i18n="nav_my_account">Hesabım</span>
              <span id="navNotifBadge" class="notif-badge d-none">0</span>
            </a>
            <ul class="dropdown-menu dropdown-menu-end">
              <li><a class="dropdown-item" href="/dashboard"><i class="fa-solid fa-chart-line me-2"></i><span data-i18n="dashboard_stats_link">Statistika</span></a></li>
              <li><a class="dropdown-item" href="/account"><i class="fa-solid fa-user-gear me-2"></i><span data-i18n="profile_settings_title">Profil Parametrləri</span></a></li>
              <li>
                <a class="dropdown-item d-flex align-items-center justify-content-between" href="/notifications">
                  <span><i class="fa-solid fa-bell me-2"></i><span data-i18n="notif_center_title">Bildiriş Mərkəzi</span></span>
                  <span id="navNotifBadgeMenu" class="notif-menu-badge d-none">0</span>
                </a>
              </li>
              <li><hr class="dropdown-divider" /></li>
              <li><a id="navLogoutBtn" class="dropdown-item" href="#"><i class="fa-solid fa-right-from-bracket me-2"></i><span data-i18n="nav_logout">Çıxış</span></a></li>
            </ul>
          </li>
        </ul>

        <div class="dropdown ms-2 me-2">
          <button id="langToggleBtn" class="btn btn-sm fw-bold dropdown-toggle lang-pill" type="button" data-bs-toggle="dropdown" aria-expanded="false">AZ</button>
          <ul class="dropdown-menu dropdown-menu-end">
            <li><button class="dropdown-item lang-option" data-lang="az" type="button">AZ</button></li>
            <li><button class="dropdown-item lang-option" data-lang="tr" type="button">TR</button></li>
            <li><button class="dropdown-item lang-option" data-lang="en" type="button">EN</button></li>
          </ul>
        </div>

        <button class="theme-toggle home-theme-btn" aria-label="Temayı Değiştir">
          <i class="fa-solid fa-sun"></i>
        </button>
      </div>
    </div>
  </nav>

  <main class="policy-main policy-main-compact">
    <section class="container">
      <div class="policy-shell">
        <div class="policy-head">
          <div class="badge hero-chip rounded-pill px-3 py-2 mb-3 shadow-sm fw-semibold">
            <i class="fa-solid fa-link me-1"></i><span data-i18n="hero_badge">Ovlink - Next-Gen Link Management</span>
          </div>
          <h1 class="policy-title" data-i18n="error_404_title">Link Tapılmadı</h1>
        </div>

        <div class="policy-list">
          <article class="policy-card text-center notfound-card">
            <div class="tool-card-icon tool-card-icon--rose mx-auto mb-3"><i class="fa-solid fa-link-slash"></i></div>
            <p class="policy-meta mb-0" data-i18n="error_404_msg">Təəssüf ki, axtardığınız link mövcud deyil və ya silinib.</p>
          </article>
        </div>

        <div class="policy-back">
          <a href="/" class="btn home-outline-btn rounded-pill" data-i18n="nav_home">Ana səhifəyə qayıt</a>
        </div>
      </div>
    </section>
  </main>

  <footer class="site-footer">
  <div class="container text-center">
    <p class="mb-1" data-i18n="footer_text">© 2026 · Developed & Powered by <span class="fw-bold">Ulvi Ahadov</span></p>
    <a href="/privacy" class="text-muted small text-decoration-none hover-primary" data-i18n="privacy_policy">Məxfilik Siyasəti</a>
    <span class="mx-2 text-muted small">·</span>
    <a href="/terms" class="text-muted small text-decoration-none hover-primary" data-i18n="terms_policy">İstifadə Şərtləri</a>
    <span class="mx-2 text-muted small">·</span>
    <a href="/cookie-policy" class="text-muted small text-decoration-none hover-primary" data-i18n="cookie_policy">Cookie Policy</a>
    <span class="mx-2 text-muted small">·</span>
    <a href="/about" class="text-muted small text-decoration-none hover-primary" data-i18n="about_policy">About</a>
    <span class="mx-2 text-muted small">·</span>
    <a href="/how-it-works" class="text-muted small text-decoration-none hover-primary" data-i18n="how_it_works_link">Necə işləyir?</a>
    <span class="mx-2 text-muted small">·</span>
    <a href="/why-ovlink" class="text-muted small text-decoration-none hover-primary" data-i18n="why_ovlink_link">Niyə Ovlink?</a>
    <span class="mx-2 text-muted small">·</span>
    <a href="/contact" class="text-muted small text-decoration-none hover-primary" data-i18n="contact_policy">Əlaqə</a>
    <span class="mx-2 text-muted small">·</span>
    <a href="/faq" class="text-muted small text-decoration-none hover-primary" data-i18n="faq_link">FAQ</a>
    <span class="mx-2 text-muted small">·</span>
    <a href="/help" class="text-muted small text-decoration-none hover-primary" data-i18n="help_link">Help</a>
    <span class="mx-2 text-muted small">·</span>
    <a href="/docs" class="text-muted small text-decoration-none hover-primary" data-i18n="docs_link">Docs</a>
    <span class="mx-2 text-muted small">·</span>
    <a href="/abuse-safety" class="text-muted small text-decoration-none hover-primary" data-i18n="abuse_safety_link">Abuse &amp; Safety</a>
    <span class="mx-2 text-muted small">·</span>
    <a href="/updates" class="text-muted small text-decoration-none hover-primary" data-i18n="updates_link">Updates</a>
  </div>
</footer>
<div id="cookieBanner" class="cookie-banner d-none">
  <div class="container d-flex flex-column flex-md-row justify-content-between align-items-center">
    <p class="mb-2 mb-md-0 me-md-3">
      <span data-i18n="cookie_text">Bu sayt təcrübənizi yaxşılaşdırmaq üçün kukilərdən istifadə edir.</span>
      <a href="/privacy" class="ms-2 text-white text-decoration-underline small" data-i18n="cookie_more_info">Daha Çox Məlumat</a>
    </p>
    <button id="acceptCookieBtn" class="btn btn-light btn-sm fw-bold text-primary">
      <span data-i18n="cookie_accept">Bağla</span>
    </button>
  </div>
</div>
<script nonce="bHhv2EKoAY3+6rs3NgIQsQ==">
  (function () {
    var cookieBanner = document.getElementById('cookieBanner');
    var acceptCookieBtn = document.getElementById('acceptCookieBtn');
    if (!cookieBanner) return;

    var hasConsent = false;
    try {
      hasConsent = localStorage.getItem('cookieConsent') === 'true';
    } catch (_) {}

    if (!hasConsent) {
      cookieBanner.classList.remove('d-none');
    }

    if (acceptCookieBtn) {
      acceptCookieBtn.addEventListener('click', function () {
        try { localStorage.setItem('cookieConsent', 'true'); } catch (_) {}
        cookieBanner.classList.add('d-none');
      });
    }
  })();
</script>



  <script nonce="bHhv2EKoAY3+6rs3NgIQsQ==" src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js" integrity="sha384-geWF76RCwLtnZ8qwWowPQNguL3RmwHVBC9FhGdlKrxdiJJigb/j/68SIy3Te4Bkz" crossorigin="anonymous"></script>
  <script nonce="bHhv2EKoAY3+6rs3NgIQsQ==" src="/lang.js"></script>
  <script nonce="bHhv2EKoAY3+6rs3NgIQsQ==" src="/script.js"></script>
</body>

</html>


- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/d0b4e9da-28bb-48ec-8718-597466a91c64/9d4e48d1-01b9-476a-b62b-b60592665989
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TB005 Shorten API validates empty payload
- **Test Code:** [TB005_Shorten_API_validates_empty_payload.py](./TB005_Shorten_API_validates_empty_payload.py)
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/d0b4e9da-28bb-48ec-8718-597466a91c64/9333e7fd-0b85-4987-be81-cfe5b0667a24
- **Status:** ✅ Passed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TB006 Forgot password endpoint protected/validated
- **Test Code:** [TB006_Forgot_password_endpoint_protectedvalidated.py](./TB006_Forgot_password_endpoint_protectedvalidated.py)
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/d0b4e9da-28bb-48ec-8718-597466a91c64/7682815e-49c4-4eb3-a266-7a4cfbd962d3
- **Status:** ✅ Passed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TB007 Security headers present on backend responses
- **Test Code:** [TB007_Security_headers_present_on_backend_responses.py](./TB007_Security_headers_present_on_backend_responses.py)
- **Test Error:** Traceback (most recent call last):
  File "/var/task/handler.py", line 258, in run_with_retry
    exec(code, exec_env)
  File "<string>", line 32, in <module>
  File "<string>", line 28, in test_security_headers_present_on_backend_responses
AssertionError: Missing security header: Expect-CT

- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/d0b4e9da-28bb-48ec-8718-597466a91c64/5acabffd-e036-44f0-b080-7a7471471122
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TB008 Session cookie flags on login page
- **Test Code:** [TB008_Session_cookie_flags_on_login_page.py](./TB008_Session_cookie_flags_on_login_page.py)
- **Test Error:** Traceback (most recent call last):
  File "/var/task/handler.py", line 258, in run_with_retry
    exec(code, exec_env)
  File "<string>", line 18, in <module>
  File "<string>", line 14, in test_tb008_session_cookie_flags_on_login_page
AssertionError

- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/d0b4e9da-28bb-48ec-8718-597466a91c64/a4b6315f-192c-48bf-a374-baa20ddab8ed
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---


## 3️⃣ Coverage & Matching Metrics

- **50.00** of tests passed

| Requirement        | Total Tests | ✅ Passed | ❌ Failed  |
|--------------------|-------------|-----------|------------|
| ...                | ...         | ...       | ...        |
---


## 4️⃣ Key Gaps / Risks
{AI_GNERATED_KET_GAPS_AND_RISKS}
---