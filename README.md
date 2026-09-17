# Ovlink - Advanced URL Shortener & Analytics Suite

Ovlink is a robust, high-performance URL shortening and analytics platform designed with enterprise-grade security, comprehensive team features (Workspaces), advanced analytics, and multi-platform bot integrations (Telegram & Discord).

## 🚀 Features

- **Advanced URL Shortening**: Custom aliases, custom domains, password protection, and expiration dates.
- **Detailed Analytics**: Device, OS, browser, country tracking, and click timelines.
- **Team Workspaces**: Share domains and collaborate on link management securely with granular roles.
- **Enterprise SSO & Security**: SAML SSO support, 2FA (TOTP), Idempotency keys, HMAC Webhook signatures, and fail-closed authentication.
- **Bot Integrations**: Manage links and fetch analytics directly via Telegram and Discord bots.
- **I18N Ready**: Built-in support for Azerbaijani (az), Turkish (tr), and English (en).
- **Pro Tier**: Advanced API access, Webhook integration, unlimited links, and custom domains.

## 🛠 Tech Stack

- **Backend**: Node.js, Express.js
- **Database**: PostgreSQL / SQLite (for development), connect-pg-simple for session persistence
- **Frontend**: Vanilla JS, EJS Templates, Bootstrap 5.3, FontAwesome 6
- **Integrations**: Resend API (Email), Adsterra (Ads), Google OAuth2, SAML SSO

## 📦 Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run the application:
   ```bash
   npm run start
   ```

3. Run the test suite:
   ```bash
   npm test
   ```

## 🔒 Security

This repository maintains strict security rules:
- **No Path Traversal**: Ops documents like `AGENTS.md` are completely blocked via regex path normalization.
- **IDOR Prevention**: All modifications and CSV exports are strictly validated against workspace ownership SQL constraints.
- **Strict Role Validation**: Admin permissions are queried directly from the database on every sensitive request to prevent privilege persistence.
- **SSRF Prevention**: Outbound webhook URLs are strictly validated to prevent local/internal network scanning.

## 📑 Documentation

Please refer to the internal markdown documents for architecture details and deployment guides:
- `PROJECT_MEMORY.md`: Structural knowledge and business rules.
- `AGENTS.md`: Must-follow codebase constraints.
- `DEPLOYMENT_HARDENING.md`: Production deployment security rules.
- `GO_LIVE_CHECKLIST.md`: Pre-flight checklist.