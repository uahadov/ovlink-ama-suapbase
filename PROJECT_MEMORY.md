# OVLINK - PROJECT MEMORY & AI ARCHITECTURE DIRECTIVE

> **Note for AI Models & Assistants:** This document contains the complete structural knowledge, business rules, design patterns, critical constraints, and past bug resolution patterns for the Ovlink project. Read and adhere strictly to this document before making any changes to the codebase.

---

## 1. Project Overview & Technology Stack

* **Platform Name:** Ovlink (URL Shortener, QR Code Generator, Analytics & Bot Integration Suite)
* **Backend:** Node.js (v18+) with Express.js (`server.js`, `routes/admin.js`, `routes/auth.js`, `bots/telegram.js`, `bots/discord.js`).
* **Database:** PostgreSQL in production (`DATABASE_URL` / `SUPABASE_DATABASE_URL`), connect-pg-simple for session persistence.
* **Frontend:**
  * Vanilla JS: `public/script.js` (core dashboard & subpages), `public/home.js` (homepage), `public/lang.js` (i18n), `public/sw.js` (PWA Service Worker).
  * Vanilla CSS: `public/style.css` (custom design system tokens and glassmorphism styling).
  * Views: EJS template engine with Bootstrap 5.3 + FontAwesome 6.
* **Integrations:** Telegram Bot (`bots/telegram.js`), Discord Bot (`bots/discord.js`), Google OAuth2, Resend Email API, Adsterra Ads.

---

## 2. Hard Constraints & Must-Follow Rules (from AGENTS.md)

1. **Package Manager:** Always use `npm` with `package-lock.json`. Do NOT install or switch to `yarn` / `pnpm`.
2. **Secrets & Privacy:** Never commit `.env`, `.db`, session dumps, or runtime logs. `AGENTS.md` and ops documentation must NEVER be exposed over public HTTP routes.
3. **Session & Security Keys:**
   * `SESSION_SECRET` must be high entropy (minimum 64 random bytes).
   * Webhook secrets and derivative keys are generated via SHA-256 HKDF from `SESSION_SECRET` or `WEBHOOK_HASH_SECRET`.
4. **Proxy & Base URLs:**
   * Never set `app.set('trust proxy', true)`. Always use explicit hop count `TRUST_PROXY_HOPS` (`app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1))`).
   * Canonical URLs must be generated using `getPublicBaseUrl(req)` (configured via `PUBLIC_BASE_URL` or `BASE_URL`).
5. **Database Migrations:**
   * All database schema modifications must be written as idempotent SQL (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`) inside the startup migration runner (`ensureDbTables()`).
   * Never rely on one-off manual database queries.
6. **Required Syntax & Test Verification Before Finishing Any Task:**
   * `node --check server.js routes/admin.js routes/auth.js public/script.js public/home.js public/lang.js public/sw.js`
   * `npm test` (all 17 unit/integration tests must pass).

---

## 3. Deployment & Operational Workflow

### Git Remote Branches
* Main branch: `main`
* Feature branch: `feat/bot-integrations`
* When changes are made, they must be committed and pushed to both `feat/bot-integrations` and merged into `main`.

### Server Deployment Command (Linux VPS / PM2)
```bash
cd /var/www/ovlink && git fetch origin && git reset --hard origin/main && chmod -R 755 public && pm2 restart ovlink --update-env
```

---

## 4. Key Subsystems & Architecture Patterns

### A. Authentication & Navbar Sync (SSR + Client-Side)
* **Navbar Partial:** `views/partials/public-navbar.ejs` is used across all public views and account views.
* **Authentication State Desync Protection:**
  * When SSR renders the navbar with `user` data, `#navAuthUser` is displayed and `#navAuthGuestLogin` / `#navAuthGuestReg` receive `d-none`.
  * `getClientSession()` in `public/script.js` and `public/home.js` checks three layers:
    1. DOM SSR state: `!navAuthUser.classList.contains("d-none")`
    2. Embedded user ID: `window.__userId`
    3. Stored localStorage token
* **Session Invalidation:** All session revocations and logouts clear both localStorage and trigger `/api/logout` + session cleanup.

### B. Dark Mode & Theme Engine
* **Storage:** `localStorage.getItem("theme")` (`"dark"` vs `"light"`).
* **DOM Application:** Class `.dark-mode` is applied to BOTH `document.documentElement` and `document.body`.
* **Cross-Page Synchronization:**
  * Immediate execution in `public/script.js` and `public/home.js` prevents light-theme flash.
  * `syncThemeUi()` dynamically toggles `<i class="fa-solid fa-moon"></i>` and `<i class="fa-solid fa-sun"></i>` on all `.theme-toggle` elements.
  * Document-level capture click handler `document.addEventListener("click", ...)` guarantees that clicking `.theme-toggle` (or its child icons) works everywhere across all pages.

### C. Dashboard & Modal System
* **Modals Structure:** `#dashboardEditLinkModal` and `#dashboardMetaModal` are embedded directly into the SSR HTML of `/dashboard` inside `server.js` (preventing dynamic creation lag or missing DOM nodes).
* **Dual-Layer Modal Invocation:**
  * Primary: `bootstrap.Modal.getOrCreateInstance(el).show()`
  * Fallback: Pure CSS/DOM display (`display: block`, class `show`, dynamic backdrop creation `modalFallbackBackdrop`) with `openModalById(id)` and `closeModalById(id)`.
* **Quick Notifications:** `showQuickToast(message, type)` provides instant toast feedback for copy, edit, and metadata updates.
* **Table Row Action Buttons:**
  * Buttons contain explicit text spans: `<i class="fa-solid fa-pen"></i> <span data-i18n="edit_btn">Düzəliş</span>`.
  * Never attach `data-i18n` directly to the `<button>` element if it contains an icon, as translation scripts replace `textContent` and erase FontAwesome icons.

### D. Service Worker & Static Assets
* **PWA Service Worker (`public/sw.js`):**
  * Intercepts only same-origin HTTP/HTTPS requests (`url.origin === self.location.origin && url.protocol.startsWith('http')`).
  * Never intercepts or writes non-HTTP schemes (e.g. `chrome-extension://`), preventing Cache API crashes.
  * Bypasses `/api/`, `/admin`, `/bot/`, `/dashboard`, `/account`, and dynamic user routes.
  * Served with `Cache-Control: no-cache, no-store, must-revalidate` and `Service-Worker-Allowed: /`.
* **Static Assets Middleware in `server.js`:**
  * `express.static(publicDir)` is placed at the top of the middleware chain (right after Helmet and Permissions-Policy), before rate-limiters, session lookups, and DDoS IP filters.
  * Cache busting is driven by `ASSET_VERSION` query parameter (`?v=<%= assetVersion %>`).

### E. Telegram Bot Integration (`bots/telegram.js`)
* **Commands Supported:** `/start`, `/short <url>`, `/qr <text>`, `/search <query>`, `/delete <short>`, `/stats <short>`, `/bulk`, `/help`, `/lang`.
* **Quota Management:**
  * Free user link daily limit vs Pro user unlimited.
  * If a bulk creation exceeds remaining daily quota, error `bulk_daily_quota_exceeded` is shown with exact remaining quota numbers.
* **Multi-Language Support:** Telegram bot messages are localized in `az`, `tr`, `en`, and `ru`.

### F. Internationalization (`public/lang.js`)
* **Languages:** Azerbaijani (`az`, default), Turkish (`tr`), English (`en`).
* **Attributes:** Elements with `data-i18n="key"` are auto-translated.
* **Placeholders & Titles:** Use `data-i18n-placeholder` and `data-i18n-title`.

---

## 5. Summary of Resolved Critical Edge Cases

| Issue / Bug | Root Cause | Solution Implemented |
| :--- | :--- | :--- |
| **Service Worker Chrome Extension Crash** | `sw.js` intercepted all `fetch` events without checking URL origin and scheme. Chrome extensions crashed `cache.put()`. | Restricted `sw.js` to `url.origin === self.location.origin` and `http/https`. |
| **Static Files 403 Forbidden** | `express.static` was at the bottom of the middleware chain behind IP blacklists and rate-limiters. | Moved `express.static` to top after security headers with smart cache headers. |
| **Navbar SSR / Client Auth Desync** | Navbar rendered guest buttons on dynamic hydration when client session didn't match SSR. | Refactored `getClientSession()` to inspect DOM SSR state, `window.__userId`, and session token. |
| **Dashboard Action Buttons Inactivity** | Modals were dynamically injected on click and failed if Bootstrap instance failed; translation replaced icon HTML. | Modals embedded in SSR; dual-layer `openModalById`; translation moved to inner spans. |
| **Dark Mode Not Working on Subpages** | Theme toggle was bound via `querySelectorAll` on script load; no global delegation; subpages load `script.js`. | Unified `syncThemeUi()`, `applyTheme()`, `toggleTheme()`, and added document-level click delegation. |

---

*Keep this memory file updated whenever new architectural layers, bot features, or security invariants are added to the codebase.*
