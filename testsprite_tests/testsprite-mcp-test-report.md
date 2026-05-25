
# TestSprite AI Testing Report (MCP)

---

## 1️⃣ Document Metadata
- **Project Name:** OvLink (URL Shortener)
- **Date:** 2026-03-02
- **Prepared by:** TestSprite AI Team

---

## 2️⃣ Requirement Validation Summary

### Requirement: User Registration
- **Description:** Allows users to register with email/password, validates inputs, and sends a verification code.

#### Test TC001 — Register a new user and see verification email sent confirmation
- **Test Code:** [TC001](./TC001_Register_a_new_user_and_see_verification_email_sent_confirmation.py)
- **Test Visualization and Result:** [View](https://www.testsprite.com/dashboard/mcp/tests/0f735be2-5d38-474a-b38a-35a417610aab/437d818c-b7c6-4d1e-888e-1b25405fde54)
- **Status:** ✅ Passed
- **Severity:** LOW
- **Analysis / Findings:** Registration form accepts valid email/password and shows verification code sent confirmation. Flow works as expected.
---

#### Test TC002 — Registration fails with already-registered email
- **Test Code:** [TC002](./TC002_Registration_fails_with_already_registered_email.py)
- **Test Visualization and Result:** [View](https://www.testsprite.com/dashboard/mcp/tests/0f735be2-5d38-474a-b38a-35a417610aab/b88a0c56-1675-4cf3-be88-6c3686a76bdd)
- **Status:** ✅ Passed
- **Severity:** LOW
- **Analysis / Findings:** Duplicate email registration correctly rejected with appropriate error message.
---

#### Test TC003 — Registration validation: missing email blocks submission
- **Test Code:** [TC003](./TC003_Registration_validation_missing_email_blocks_submission.py)
- **Test Visualization and Result:** [View](https://www.testsprite.com/dashboard/mcp/tests/0f735be2-5d38-474a-b38a-35a417610aab/71507ec4-2de5-464d-8205-f4e37485462d)
- **Status:** ✅ Passed
- **Severity:** LOW
- **Analysis / Findings:** Client-side validation correctly blocks submission when email field is empty.
---

#### Test TC004 — Registration validation: missing password blocks submission
- **Test Code:** [TC004](./TC004_Registration_validation_missing_password_blocks_submission.py)
- **Test Visualization and Result:** [View](https://www.testsprite.com/dashboard/mcp/tests/0f735be2-5d38-474a-b38a-35a417610aab/9b2f3ebe-1a49-4e57-9720-e18f20ebbde4)
- **Status:** ✅ Passed
- **Severity:** LOW
- **Analysis / Findings:** Client-side validation correctly blocks submission when password field is empty.
---

### Requirement: URL Shortening
- **Description:** Allows shortening URLs from the homepage with input validation.

#### Test TC009 — Attempt to shorten with empty input shows required validation
- **Test Code:** [TC009](./TC009_Attempt_to_shorten_with_empty_input_shows_required_validation.py)
- **Test Visualization and Result:** [View](https://www.testsprite.com/dashboard/mcp/tests/0f735be2-5d38-474a-b38a-35a417610aab/904b18fd-b45f-4a3b-b87c-3549d32c51d1)
- **Status:** ✅ Passed
- **Severity:** LOW
- **Analysis / Findings:** Empty URL input correctly triggers validation error preventing submission.
---

### Requirement: URL Analytics
- **Description:** View click statistics for shortened URLs with charts, breakdowns, and date filtering.

#### Test TC010 — View analytics for an owned short link (charts and breakdowns load)
- **Test Code:** [TC010](./TC010_View_analytics_for_an_owned_short_link_charts_and_breakdowns_load.py)
- **Test Visualization and Result:** [View](https://www.testsprite.com/dashboard/mcp/tests/0f735be2-5d38-474a-b38a-35a417610aab/4e2853b6-aedd-4012-a3e4-3a01b6b41325)
- **Status:** ✅ Passed
- **Severity:** LOW
- **Analysis / Findings:** Analytics page loads correctly for owned links, displaying charts and browser/OS/country breakdowns.
---

#### Test TC011 — Filter analytics by a valid date range
- **Test Code:** [TC011](./TC011_Filter_analytics_by_a_valid_date_range.py)
- **Test Visualization and Result:** [View](https://www.testsprite.com/dashboard/mcp/tests/0f735be2-5d38-474a-b38a-35a417610aab/d8cf34d7-9c5c-4335-bb8d-428b80c9c511)
- **Status:** ❌ Failed
- **Severity:** MEDIUM
- **Analysis / Findings:** Login failed during test execution — the sign-in form remained visible after multiple attempts. This blocked navigation to the statistics page, preventing date-range filter verification. Root cause is likely CSRF token handling or session configuration in the test environment.
---

#### Test TC015 — Access denied when selecting a short link owned by another user
- **Test Code:** [TC015](./TC015_Access_denied_when_selecting_a_short_link_owned_by_another_user.py)
- **Test Visualization and Result:** [View](https://www.testsprite.com/dashboard/mcp/tests/0f735be2-5d38-474a-b38a-35a417610aab/72df9d94-4984-4171-91c5-3165e82030c1)
- **Status:** ❌ Failed
- **Severity:** HIGH
- **Analysis / Findings:** The statistics page loaded content instead of showing an access-denied UI when viewed by a non-owner. This may indicate a missing authorization check, or the test was unable to authenticate properly to establish the necessary user context. Requires further investigation.
---

### Requirement: Admin Panel
- **Description:** Admin dashboard with user management, link management, reports, and site settings.

#### Test TC018 — Admin can log in and reach the admin dashboard from /admin
- **Test Code:** [TC018](./TC018_Admin_can_log_in_and_reach_the_admin_dashboard_from_admin.py)
- **Test Visualization and Result:** [View](https://www.testsprite.com/dashboard/mcp/tests/0f735be2-5d38-474a-b38a-35a417610aab/82d379c1-2c18-4d74-afb0-1d21fac4c80b)
- **Status:** ❌ Failed
- **Severity:** MEDIUM
- **Analysis / Findings:** Login did not navigate to the dashboard — URL remained at `/login` and the form stayed visible. The test attempted multiple login clicks without success. Likely caused by CSRF token mismatch or the test using incorrect admin credentials.
---

#### Test TC019 — Admin can open Users list from Admin dashboard
- **Test Code:** [TC019](./TC019_Admin_can_open_Users_list_from_Admin_dashboard.py)
- **Test Visualization and Result:** [View](https://www.testsprite.com/dashboard/mcp/tests/0f735be2-5d38-474a-b38a-35a417610aab/c0ac4ce3-9760-499c-b3ae-9fb65e178640)
- **Status:** ❌ Failed
- **Severity:** MEDIUM
- **Analysis / Findings:** Rate limit kicked in ("Çok fazla giriş denemesi. Lütfen 15 dakika sonra tekrar deneyin.") after prior failed login attempts from other tests. This cascading failure blocked authentication entirely.
---

#### Test TC020 — Admin can ban a user and see status updated
- **Test Code:** [TC020](./TC020_Admin_can_ban_a_user_and_see_status_updated.py)
- **Test Visualization and Result:** [View](https://www.testsprite.com/dashboard/mcp/tests/0f735be2-5d38-474a-b38a-35a417610aab/68abf67c-d034-4244-bcd0-7e3ea46dc95a)
- **Status:** ❌ Failed
- **Severity:** MEDIUM
- **Analysis / Findings:** Admin panel inaccessible from the test account — no "Admin" link found in navigation. The test user likely doesn't have admin privileges, making it impossible to reach the admin area.
---

### Requirement: Access Control
- **Description:** Non-admin users should be denied access to admin-only areas.

#### Test TC025 — Non-admin user is denied access to Admin area and shown unauthorized or admin login
- **Test Code:** [TC025](./TC025_Non_admin_user_is_denied_access_to_Admin_area_and_shown_unauthorized_or_admin_login.py)
- **Test Visualization and Result:** [View](https://www.testsprite.com/dashboard/mcp/tests/0f735be2-5d38-474a-b38a-35a417610aab/4a78cfcb-0194-4ffc-bbe0-73784e7d4847)
- **Status:** ✅ Passed
- **Severity:** LOW
- **Analysis / Findings:** Non-admin users correctly receive unauthorized/admin login page when attempting to access `/admin`. Access control works as expected.
---

### Requirement: Custom Domains
- **Description:** Users can add custom domains for their short links with DNS verification and validation.

#### Test TC026 — Add a custom domain and view DNS verification instructions
- **Test Code:** [TC026](./TC026_Add_a_custom_domain_and_view_DNS_verification_instructions.py)
- **Test Visualization and Result:** [View](https://www.testsprite.com/dashboard/mcp/tests/0f735be2-5d38-474a-b38a-35a417610aab/6c739e1d-5018-470d-8780-75f38f542ecf)
- **Status:** ✅ Passed
- **Severity:** LOW
- **Analysis / Findings:** Custom domain addition works correctly, DNS verification instructions are displayed after adding a domain.
---

#### Test TC027 — Custom domain entry is persisted and visible in the domain list after adding
- **Test Code:** [TC027](./TC027_Custom_domain_entry_is_persisted_and_visible_in_the_domain_list_after_adding.py)
- **Test Visualization and Result:** [View](https://www.testsprite.com/dashboard/mcp/tests/0f735be2-5d38-474a-b38a-35a417610aab/37ed8423-27a2-47c3-b77f-ee38f4a37f8c)
- **Status:** ❌ Failed
- **Severity:** MEDIUM
- **Analysis / Findings:** Login failed after two Sign In attempts — URL remained at `/login`. This blocked access to the custom domains section, preventing persistence verification. Same root cause as other auth-dependent test failures.
---

#### Test TC028 — Add custom domain with invalid domain format shows an error
- **Test Code:** [TC028](./TC028_Add_custom_domain_with_invalid_domain_format_shows_an_error.py)
- **Test Visualization and Result:** [View](https://www.testsprite.com/dashboard/mcp/tests/0f735be2-5d38-474a-b38a-35a417610aab/5566d82a-2e80-4423-af1b-326889a4a4b0)
- **Status:** ✅ Passed
- **Severity:** LOW
- **Analysis / Findings:** Invalid domain format correctly triggers an error message preventing submission.
---

## 3️⃣ Coverage & Matching Metrics

- **60%** of tests passed (9/15)

| Requirement        | Total Tests | ✅ Passed | ❌ Failed |
|--------------------|-------------|-----------|-----------|
| User Registration  | 4           | 4         | 0         |
| URL Shortening     | 1           | 1         | 0         |
| URL Analytics      | 3           | 1         | 2         |
| Admin Panel        | 3           | 0         | 3         |
| Access Control     | 1           | 1         | 0         |
| Custom Domains     | 3           | 2         | 1         |

---

## 4️⃣ Key Gaps / Risks

> **60% pass rate** — 9 of 15 tests passed.

> **Primary blocker:** 5 of the 6 failures stem from **authentication failures in the test environment**. The automated tests could not log in successfully, likely due to:
> 1. **CSRF token handling** — The `lusca` CSRF middleware may reject requests from the TestSprite browser automation.
> 2. **Rate limiting cascade** — `express-rate-limit` triggered after repeated failed login attempts across tests, blocking all subsequent auth-dependent tests.
> 3. **Missing test credentials** — Tests may not have had valid user/admin credentials configured.

> **Potential real bug (TC015):** The access-denied test for viewing another user's short link stats showed content instead of an unauthorized page. This warrants manual verification to determine if it's an actual authorization vulnerability or a test environment artifact.

> **Recommendation:** Configure test credentials and consider disabling rate limiting in the test environment to unblock the full test suite. Re-run after addressing the auth environment issues.
---
