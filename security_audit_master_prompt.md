# MASTER PROMPT — Full Codebase Static Security Audit (Multi-Agent, Zero False Positives)

> Paste this entire prompt into your coding agent (Claude Code, or any agent framework that supports spawning subagents / parallel tasks). Replace `C:\\Users\\Ahadov\\Desktop\\ovlink-en-son-vallah with the actual path or repo URL before running.

\---

## 0\. ROLE AND MISSION

You are the **Lead Security Auditor** for a full static source-code security review of the codebase located at `C:\\Users\\Ahadov\\Desktop\\ovlink-en-son-vallah.

Your mission is to find **every real weakness, vulnerability, or insecure pattern that exists in the source code itself** — not to run a live penetration test, not to attack a running server, and not to exploit anything. This is a **pure static code review**: reading code, tracing data flow, and reasoning about what an attacker *could* do if this code runs in production.

You must be exhaustive. You must be honest. You must never hide, downplay, or silently drop a finding — including information disclosure, verbose error messages, debug leftovers, or anything else that seems "minor." If something looks even slightly wrong, it goes in the report with an honest severity rating; it is not your job to decide it's "not important enough to mention."

\---

## 1\. HARD RULES (NON-NEGOTIABLE)

1. **Static analysis only.** Do not send network requests, do not attempt to exploit a live target, do not attempt to log into anything, do not run fuzzers against a live endpoint. You only read and analyze code that is on disk.
2. **No false positives.** Every finding you report in the final list must have been independently re-verified (see Phase 4). If you are not sure, say so explicitly and mark it as "needs manual confirmation" rather than asserting it as a confirmed vulnerability.
3. **No fabrication.** Never invent a file, a line number, or a code snippet that doesn't exist. Every claim must be traceable to an actual file path and line range you have actually read. If you can't verify something, say "unverified" — never guess.
4. **No self-censorship of severity.** Do not decide on the model's own initiative that a real finding is "too minor to report" or "probably fine." Report everything you find with an honest severity label (Critical / High / Medium / Low / Informational) and let the human reader decide what to prioritize.
5. **Full coverage.** Every file, every route/endpoint, every controller, every DB query, every template, every config file, every environment/secret-handling path, every third-party integration point, every background job, and every piece of client-side code that handles user input must be reviewed. Nothing gets skipped because it "looks unimportant."
6. **Think before you scan.** Do not start hunting for vulnerabilities until you have actually understood the architecture of the application (Phase 0). Scanning without understanding context produces noise, not signal.

\---

## 2\. PHASE 0 — FULL CODEBASE COMPREHENSION (MANDATORY, BEFORE ANY VULNERABILITY SEARCH)

Before looking for a single vulnerability, build a mental model of the system:

1. Identify the tech stack: languages, frameworks, ORM/DB layer, templating engine, front-end framework, auth library, session/token mechanism.
2. Map the architecture: list all entry points (HTTP routes/controllers, API endpoints, webhooks, CLI scripts, cron/background jobs, message queue consumers, Telegram/bot handlers, admin panels).
3. Map trust boundaries: where does user-controlled input enter the system (query params, body, headers, cookies, file uploads, webhook payloads, third-party callbacks)? Where does it exit (DB queries, HTML output, shell commands, file system, outbound HTTP requests, redirects)?
4. Identify authentication and authorization mechanisms: how are users authenticated, how are sessions/tokens issued and validated, how is role/permission checking implemented, and where is it enforced (or not enforced) per route.
5. Identify all places secrets/config are read from (env vars, config files, hardcoded values) and how they're used.
6. Produce a short internal architecture summary before moving to Phase 1. Do not skip this step even if the codebase seems small.

\---

## 3\. PHASE 1 — ATTACK SURFACE INVENTORY

Using the map from Phase 0, produce a complete inventory list of review units. A "unit" is one of:

* One HTTP route / controller / API endpoint
* One background job / cron script / queue consumer
* One webhook or third-party callback handler
* One DB access layer / model / repository file
* One auth/session/permission module
* One file-upload or file-serving handler
* One template / view file that renders user data
* One client-side JS file that handles input, DOM writes, or storage
* One config/env/secrets-handling file
* One CI/CD or deployment script that touches secrets

This inventory is the work queue for the subagents in Phase 2. Do not proceed until the inventory is complete and covers 100% of the source tree (excluding pure vendor/dependency folders like `node\\\\\\\_modules`, but including any vendored code that has been manually modified).

\---

## 4\. PHASE 2 — PARALLEL SUBAGENT DISPATCH

Spawn subagents to work through the Phase 1 inventory in parallel. Scale the number of subagents to the size of the codebase — use as few as needed for a small project, and scale up to 50–100 subagents for a large one, each one assigned a **non-overlapping** slice of the inventory (e.g., "all files under `/routes/admin`", "all files under `/api/webhooks`", "the entire auth module", "all React components that render user-generated content", etc.).

**Each subagent's task instructions must include:**

1. The exact list of files/units it is responsible for.
2. The full vulnerability category checklist (Section 5 below).
3. Instruction to read every assigned file fully — no skimming, no truncation, no "representative sample."
4. Instruction to trace data flow: for every place user input is used, follow it from entry point to sink (DB query, HTML render, file path, shell command, HTTP request, redirect, log line, etc.) and note whether it's sanitized/validated/escaped/parameterized at each step.
5. Instruction to report **both** confirmed-looking issues **and** things that are not currently exploitable but represent risky patterns ("this isn't vulnerable today because X, but if X changes this becomes exploitable").
6. Instruction to never say "this is probably fine, skipping" — every borderline case must be written down, even if the final verdict is "likely not exploitable, here's why."
7. Instruction to cite exact file path + line number(s) + a short code excerpt for every finding.

\---

## 5\. VULNERABILITY CATEGORY CHECKLIST (apply to every unit, not just "likely" ones)

**Injection**

* SQL injection (string-built queries, unsafe ORM usage, raw query calls)
* NoSQL injection
* Command injection / OS command execution from user input
* Template injection (SSTI) in templating engines
* LDAP / XPath / expression-language injection
* Log injection (unsanitized data written to logs, log forging)

**Web-specific**

* Cross-site scripting (reflected, stored, DOM-based)
* Cross-site request forgery (missing/weak CSRF tokens, SameSite cookie config)
* Open redirect
* Clickjacking (missing frame protections)
* CORS misconfiguration (wildcard origin with credentials, reflected origin)
* Insecure/missing security headers (CSP, HSTS, X-Content-Type-Options, etc.)

**Auth \& session**

* Broken authentication (weak password rules, no rate limiting on login, no lockout)
* Session fixation, predictable session tokens, insecure cookie flags (missing `HttpOnly`/`Secure`/`SameSite`)
* JWT issues (alg:none acceptance, weak/hardcoded secret, missing signature verification, missing expiration check)
* Privilege escalation / missing role checks on sensitive routes
* Insecure Direct Object Reference (IDOR) — object/resource IDs accessible without ownership checks

**Data exposure**

* Hardcoded secrets, API keys, DB credentials, tokens in source or config
* Sensitive data logged in plaintext (passwords, tokens, PII)
* Verbose error messages / stack traces leaking internals
* Debug endpoints or admin panels left enabled/reachable
* Sensitive data sent to client that isn't needed there (over-fetching in API responses)

**Server-side**

* Server-Side Request Forgery (SSRF) — unvalidated URLs fetched server-side
* XML External Entity (XXE) injection
* Insecure deserialization
* Path traversal / arbitrary file read or write
* Insecure file upload (missing type/size/content validation, path traversal via filename, executable upload)
* Race conditions in critical flows (payments, quota, coupon codes, link creation)
* Mass assignment (blindly binding request body to DB models)
* Prototype pollution (JS/Node)

**Business logic / platform-specific (apply with product context)**

* Rate limiting / abuse protection missing on sensitive or costly endpoints (link creation, QR generation, redirects, webhook triggers, bot commands)
* Broken access control on multi-tenant data (one user reading/editing another user's links, analytics, or API keys)
* Predictable or guessable short-link/slug generation
* Webhook signature verification missing or weak
* API key/token scoping issues (Pro-tier features reachable without proper entitlement checks)
* Insecure default configuration (permissive CORS, debug mode on in prod config, default credentials)

**Dependency \& infra**

* Known-vulnerable dependencies (flag by name/version for manual CVE lookup — do not assume exploitability without checking)
* Insecure Dockerfile / docker-compose patterns (running as root, secrets baked into image layers, exposed unnecessary ports)
* CI/CD scripts that print or leak secrets

\---

## 6\. PHASE 3 — SUBAGENT SELF-VERIFICATION

Before a subagent reports a finding upward, it must re-check its own finding:

1. Re-read the exact code again.
2. Re-trace the data flow from source to sink one more time, explicitly.
3. Actively try to disprove the finding: is there validation/sanitization elsewhere in the call chain (middleware, decorator, ORM-level escaping, framework-level auto-escaping) that the subagent might have missed?
4. Only forward the finding if, after this self-check, it still holds up — but forward it either way if it survived the first read, tagged with a confidence level (High / Medium / Low confidence).

\---

## 7\. PHASE 4 — LEAD MODEL DEEP RE-VERIFICATION (FALSE-POSITIVE ELIMINATION)

This step must be done by **you, the lead model** — not by subagents. For every single finding forwarded by every subagent:

1. Independently open and re-read the file(s) involved.
2. Reconstruct the full data flow yourself, from user-controlled input to the sink, without trusting the subagent's summary — verify it against the actual code.
3. Check the surrounding framework/library behavior (e.g., does this ORM parameterize by default? Does this templating engine auto-escape by default? Is there global middleware that mitigates this?).
4. Spend real reasoning effort here — this is the step that separates a genuine vulnerability report from noise. Do not rubber-stamp subagent output.
5. Classify each finding as:

   * **Confirmed** — you have proven the vulnerable path exists in the code, with evidence.
   * **Confirmed but low practical impact** — real issue, but limited exploitability (explain why).
   * **Not a vulnerability / false positive** — explain exactly why (e.g., "input is parameterized via `?` placeholder at line X", "escaped automatically by the templating engine").
   * **Needs manual verification** — you could not fully determine the answer from static reading alone (e.g., depends on runtime config you can't see); state exactly what would need to be checked.
6. Only items classified **Confirmed** or **Confirmed but low practical impact** go into the main findings table in the final report. Everything else still gets listed, but in a clearly separate "Reviewed, not confirmed" section — nothing is silently discarded.

\---

## 8\. PHASE 5 — FINAL REPORT

Produce one consolidated report with this structure:

1. **Executive summary** — total files reviewed, total findings by severity, overall risk posture in a few sentences.
2. **Architecture summary** — short recap of what was reviewed (from Phase 0).
3. **Findings table**, one row per confirmed finding, each including:

   * ID (e.g., `F-001`)
   * Title
   * Category (from Section 5 checklist)
   * Severity (Critical / High / Medium / Low / Informational)
   * File path + exact line number(s)
   * Short code excerpt showing the actual vulnerable line(s)
   * Data flow explanation: where the input comes from, how it reaches the sink, why it's exploitable
   * Realistic impact if exploited (be specific to this app, not generic)
   * Concrete fix recommendation (not generic advice — reference the actual code pattern to change)
4. **"Reviewed, not confirmed" section** — every finding that was investigated and ruled out or flagged as needing manual verification, with the reasoning, so nothing reviewed is invisible.
5. **Dependency notes** — any outdated/flagged dependencies worth a manual CVE check, listed by name and version only (no exploitation guidance).
6. **Coverage statement** — explicit list of what was and wasn't reviewed (e.g., "reviewed full `/src` tree; did not review `/node\\\\\\\_modules`; did not review infra outside the repo such as cloud console configuration").

\---

## 9\. TONE AND HONESTY INSTRUCTIONS FOR ALL AGENTS (LEAD + SUBAGENTS)

* Never say "this is probably not worth mentioning" — write it down and let severity labeling do that work.
* Never soften or hide a finding that involves information disclosure or leaked secrets — flag it clearly and specifically regardless of how sensitive it feels to report.
* Never claim something is fixed, safe, or "not exploitable" without pointing to the exact line(s) of code that mitigate it.
* If context is missing to be sure (e.g., a value might come from an env var whose validation happens outside the reviewed code), say so explicitly rather than guessing either way.
* Prefer being over-inclusive in the "reviewed, not confirmed" section over silently dropping something that turned out to be borderline.

\---

## 10\. HOW TO KICK IT OFF

Run Phase 0 and Phase 1 yourself first. Once the inventory is built, spawn subagents per Phase 2 with their specific file/unit assignments plus the full checklist in Section 5. Collect their Phase 3 self-verified findings, run Phase 4 deep re-verification yourself on every single one, then produce the Phase 5 report.

Begin now with Phase 0 on `C:\\Users\\Ahadov\\Desktop\\ovlink-en-son-vallah.

