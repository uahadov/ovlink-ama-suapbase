# OVLINK — Homepage Design System Reference
> **This document is for AI agents and developers.** It serves as the complete master reference to reproduce, extend, maintain, or update the UI, UX, CSS, HTML, typography, and motion animations of the homepage (`index.ejs`, `home.css`, `home-navbar.ejs`, `home-footer.ejs`) with exact consistency and high fidelity. Always read and adhere strictly to this specification before making any modifications to the homepage design.

---

## 1. Design Philosophy & Vision

**Codename:** `Monolith`  
**Aesthetic Core:** Dark-first, monochromatic black-and-white, ultra-minimalist, fluid motion, precision engineering.  
**Inspiration & Benchmarks:** resend.com, polar.sh, linear.app, vercel.com

### Golden Principles
1. **Pitch-black canvas with pure white accents.** Strictly monochrome. No random brand gradients or neon colors. The only subtle exceptions are tiny status/role badges (e.g. pastel green/blue in workspace mockups).
2. **Negative space is an active feature.** Elements must breathe freely. Generous padding, structured rhythm, and relaxed margins are non-negotiable.
3. **Every interaction demands tactile feedback.** Hover states, focus rings, clicks, and scrolls always provide visual acknowledgment.
4. **Purposeful motion.** Animations must feel natural, spring-damped, and physical—never chaotic or gratuitous.
5. **Authentic product homepage, not a generic landing page.** Full-viewport hero with immediate utility (URL shortening composer), followed by real capabilities (Bento grid, procedural steps, verified metrics, and interactive utility tools).
6. **Mobile-responsive from 320px.** Desktop features like custom pointer tracking and 3D card tilts are cleanly disabled on touch/mobile devices via `@media (hover: none)`.

---

## 2. Directory & Scope Architecture

```
views/
  index.ejs              ← Homepage HTML (EJS template engine)
  partials/
    home-navbar.ejs      ← Homepage-exclusive navigation bar
    home-footer.ejs      ← Homepage-exclusive footer & legal links

public/
  home.css               ← Homepage-exclusive styling (scoped strictly under .ovx)
  home.js                ← Homepage interactive handlers (form submission, QR, reporting)
  lang-home.js           ← Multi-language dictionaries (en, tr, az)
```

> **Important Scoping Rule:** `home.css` is encapsulated under the `.ovx` root class on `<body class="ovx home-page">`. It does NOT conflict with or bleed into inner app views, admin panels, or authentication routes.

---

## 3. CSS Token Design System

All visual rules strictly depend on `:root` tokens. Hardcoding arbitrary hex codes (`#ffffff`, `#111111`) directly into selectors is disallowed—always refer to these standardized design tokens:

```css
:root {
  /* Surfaces & Backgrounds */
  --c-bg:        #0a0a0a;   /* Deep void background */
  --c-surface:   #111111;   /* Card, container & sheet background */
  --c-surface-2: #1a1a1a;   /* Interactive hover layer & nested cards */

  /* Borders & Dividers */
  --c-border:    rgba(255,255,255,0.08);  /* Default hairline border */
  --c-border-hi: rgba(255,255,255,0.14);  /* Active, focus & hover border */

  /* Typography Colors */
  --c-text:      #f0f0f0;   /* Primary high-contrast body text */
  --c-muted:     #888888;   /* Secondary descriptive copy */
  --c-faint:     #555555;   /* Tertiary labels, placeholders, disabled states */
  --c-white:     #ffffff;   /* Pure white focus points & emphasis */
  --c-accent:    #ffffff;   /* Primary action highlight */

  /* Typography Family */
  --f-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;

  /* Layout Measurements */
  --nav-h:       60px;      /* Standard navigation height */
  --shell:       1080px;    /* Compact text & reading content width */
  --shell-wide:  1240px;    /* Bento grids, metrics & wide section width */
  --r:           12px;      /* Standard card corner radius */

  /* Motion & Easing Curves */
  --ease:    cubic-bezier(0.16, 1, 0.3, 1);   /* Smooth decel spring curve */
  --ease-in: cubic-bezier(0.4, 0, 1, 1);      /* Fast entry transition */
}
```

### Typographic Contrast Scale
```
--c-white  → Headlines, CTA buttons, active states, metrics values
--c-text   → Body copy, list descriptions, card headlines
--c-muted  → Subtitles, navigation links, secondary metadata
--c-faint  → Input placeholders, kicker tags, subtle card numbers
```

---

## 4. CSS Class System (`m-*` Namespace)

All styles unique to the homepage use the `m-` prefix to prevent collision with other pages.

### 4.1 Structural & Layout Classes

```css
.shell            /* Max width: 1080px, horizontal padding: 28px */
.shell-wide       /* Max width: 1240px, horizontal padding: 28px */
.m-section        /* Standard section vertical rhythm (padding: 100px 0) */
.m-section-inner  /* Internal content wrapper */
```

### 4.2 Typography Classes

```css
.m-kicker         /* 11.5px, uppercase, 600 weight, 0.1em tracking — category eyebrow */
.m-section-h2     /* clamp(28px, 4vw, 48px), 700 weight, -0.03em tracking — section titles */
.m-section-sub    /* 16px, --c-muted, line-height 1.65 — supporting intro paragraph */
.m-hero-h1        /* clamp(42px, 7vw, 88px), 700 weight, text shimmer keyframe animation */
```

### 4.3 Button System

```css
/* Primary Action Button (Solid White) */
.m-cta.m-cta--white {
  background: var(--c-white);
  color: var(--c-bg);
  padding: 11px 22px;
  border-radius: 10px;
  /* Supports JS click ripple and hover translation */
}

/* Secondary Action Button (Outline) */
.m-cta.m-cta--outline {
  border: 1px solid var(--c-border);
  color: var(--c-muted);
  /* Hover: white text, brighter border */
}

/* Small Variant */
.m-cta.m-cta--sm {
  font-size: 13px;
  padding: 8px 16px;
}

/* Navbar Ghost Button */
.m-btn-ghost {
  font-size: 13.5px;
  color: var(--c-muted);
  padding: 7px 14px;
}

/* Navbar Solid Sign-Up Button */
.m-btn-solid {
  background: var(--c-white);
  color: #000;
  /* Magnetic cursor tracking on desktop */
}
```

### 4.4 Form & Composer Components

```css
.m-composer          /* Container: surface background, 1px border, 16px radius, 6px padding */
.m-composer-row      /* Flex container: icon, input field, and submit button */
.m-composer-icon     /* Left decorative icon container (--c-faint) */
.m-composer-input    /* Input field: transparent background, flex: 1, 15px */
.m-composer-submit   /* Submit button: solid white background, 10px radius */
.m-adv-toggle        /* "Advanced Settings" toggle button with rotating chevron */
.m-adv-panel         /* Expandable drawer: hidden by default, toggled via .open */
.m-adv-grid          /* 2-column responsive layout for link parameters */
.m-adv-field         /* Single input container: label + input field */
.m-adv-field--full   /* Spans across both columns (grid-column: 1 / -1) */
.m-adv-label         /* Form field label: 11.5px, 500 weight */
.m-adv-input         /* Form inputs & selects: dark background, hairline border */
.m-pro-tag           /* "PRO" label badge: solid white background, dark text */
```

---

## 5. Component Anatomy

### 5.1 Navigation (`home-navbar.ejs`)

- **Root:** `<nav class="m-nav" id="mNav">`
- **Dynamic Scroll State:** Triggered at `window.scrollY > 10` by applying `.scrolled` (enables `backdrop-filter: blur(18px)` and frosted surface tint).
- **Language Picker:** `<div class="m-lang-wrap">` with language buttons (`az`, `tr`, `en`) updating `localStorage.ovlink_lang`.
- **Mobile Menu:** Fullscreen sliding panel (`#mMobileMenu`) controlled by `#mBurger` with animated hamburger states.

### 5.2 Hero & Link Composer

- **Full Height:** 100svh centered section with background animated grid lines (80px × 80px) masked by a radial vignette.
- **Eyebrow Pill:** Animated pulsing indicator (`.m-hero-eyebrow::before`).
- **Composer Drawer:** Provides URL shortening, custom alias selection, UTM tags, password locks, device-specific targeting (iOS/Android), link expiration, and workspace assignment.

### 5.3 Features Bento Grid (6 Cards)

- **Layout Technique:** Built with `display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--c-border);` giving a seamless 1px hairline between all cards.
- **Card 01 - 03:** Row 1 single-column feature cards (Speed, Security, QR codes).
- **Card 04:** Row 2 wide 2-column card showcasing compact interactive analytics mockups and animated bar charts (`.m-bar-fill`).
- **Card 05:** Row 2 single-column Custom Domains card completing the 3-column row cleanly.
- **Card 06:** Row 3 full-width 3-column (`.m-bento-card--full`) Team Workspaces card with a split horizontal layout (`.m-ws-card-split`): information & action links on the left, live team member mockup & roles on the right. Zero dead/empty gaps.

### 5.4 Procedural Steps ("How It Works")

- 3-step grid connected by a hairline progress bar (`.m-steps::before`).
- Hovering step numbers triggers a smooth circle expansion with ripple rings (`@keyframes stepPulse`).

### 5.5 Verified Performance Band ("Stats")

- 4-column metric showcase with dynamic number counters triggered by `IntersectionObserver` via `data-counter="..."`.

### 5.6 Interactive Tools Duo (QR Code & Threat Reporting)

- 2-column side-by-side card system:
  - **Left Card:** Live QR code generator with hex color pickers and instant SVG preview.
  - **Right Card:** Threat intelligence, malware reporting, and abusive link takedown form.

### 5.7 Footer (`home-footer.ejs`)

- Structured 3-column navigation (Company, Legal, Resources).
- Automated copyright year, LaunchPact badge, floating cookie consent dialog, and promo banner.

---

## 6. Motion, Cursor & Interaction Engine

### 6.1 Custom Pointer (Mac-Style Outline Arrow)

Matches modern precision arrow pointers with crisp geometry and dynamic states:

```html
<!-- HTML Structure -->
<div id="mCursorArrow" aria-hidden="true">
  <svg width="30" height="30" viewBox="0 0 32 32" fill="none">
    <path d="M4.5 3.5L27 13.5L16.5 17.5L12 28.5L4.5 3.5Z" 
          fill="#0a0a0a" stroke="#ffffff" stroke-width="2.5" 
          stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
</div>
<div id="mCursorRing" aria-hidden="true"></div>
```

- **Coordinates & Anchor:** The arrow tip anchors directly at `(clientX, clientY)`.
- **States:**
  - `default`: Clean 30px pointer.
  - `hover`: Scales up by 15% over interactive elements (`a`, `button`, inputs).
  - `clicking`: Shrinks down smoothly by 12% on `mousedown`.
  - `hidden`: Automatically hides when the mouse leaves the browser window.
- **Trailing Aura (`#mCursorRing`):** Smooth radial glow tracking behind the cursor using linear interpolation (`lerp * 0.15`).

### 6.2 Ambient Background Glow (`#cursorGlow`)

- A fixed 600px × 600px radial gradient (`rgba(255,255,255,0.028)`) following the pointer across the entire viewport.

### 6.3 Scroll Progress Bar (`#mScrollBar-fill`)

- Fixed 2px bar positioned at the top of the viewport (`z-index: 200`), computing `scrollTop / (scrollHeight - clientHeight) * 100` dynamically.

### 6.4 3D Perspective Card Tilt

- Desktop cards (`.m-bento-card`, `.m-duo-card`) calculate pointer distance from card centers on `mousemove` to apply realistic 3D perspective rotation:
  ```js
  card.style.transform = `perspective(900px) rotateY(${dx * 4}deg) rotateX(${-dy * 4}deg) scale(1.01)`;
  ```

### 6.5 Magnetic Action Buttons

- Primary call-to-action buttons (`.m-btn-solid`, `.m-cta--white`) track nearby pointer coordinates within their bounding rect to create a subtle attraction pull.

### 6.6 Ripple Animation

- Dynamically injects `.m-ripple` spans onto buttons during `click` events with expanding scale and opacity decay.

---

## 7. Responsive Breakpoints

| Viewport Width | Layout Adaptations |
|---|---|
| `<= 900px` | Desktop links hide; hamburger menu activates; Bento becomes 2 columns; Steps switch to vertical layout; Stats adapt to 2x2 grid. |
| `<= 600px` | Bento collapses to 1 column; Advanced grid stacks vertically; Cookie banner switches to stacked mode. |
| `@media (hover: none)` | Custom pointer, 3D card tilt, and magnetic button physics are automatically disabled on touch devices. |

---

## 8. Accessibility & Semantics

1. Every decorative graphic, SVG arrow, and aura must carry `aria-hidden="true"`.
2. Form inputs must include clear `aria-label` tags or connected `<label>` elements.
3. Interactive drawers require `aria-expanded` and `aria-controls` updates in JavaScript.
4. Native mouse pointers are restored automatically on touch-only devices (`cursor: auto`).
5. All inline `<script>` tags adhere to CSP via `nonce="<%= nonce %>"`.

---

## 9. Rules for Adding New Components

1. **Class Naming:** Always use the `m-` prefix inside the `.ovx` scope (e.g. `.ovx .m-custom-card`).
2. **Color Strictness:** Never use raw hex values (`#fff`, `#000`); use `var(--c-white)`, `var(--c-bg)`, `var(--c-surface)`.
3. **Motion Consistency:** Wrap entering sections with `.m-reveal` (and `.m-reveal-d1` / `.m-reveal-d2` for staggered entrances).
4. **Responsive Completeness:** Always provide `@media (max-width: 900px)` and `@media (max-width: 600px)` definitions.
5. **No Cross-File Leaks:** Keep homepage-specific CSS confined to `home.css`. Do not pollute `style.css`.

---

## 10. Complete Class Reference Index

```
LAYOUT:
  .shell, .shell-wide, .m-section, .m-section-inner

TYPOGRAPHY:
  .m-kicker, .m-section-h2, .m-section-sub, .m-hero-h1, .m-hero-sub, .m-hero-eyebrow

NAVIGATION:
  .m-nav, .m-nav-inner, .m-brand, .m-nav-links, .m-nav-end, .m-lang-wrap,
  .m-lang-btn, .m-lang-panel, .m-lang-item, .m-btn-ghost, .m-btn-solid,
  .m-burger, .m-mobile-menu, .m-user-wrap, .m-user-btn, .m-user-panel

COMPOSER & HERO:
  .m-hero, .m-composer-wrap, .m-composer, .m-composer-row, .m-composer-icon,
  .m-composer-input, .m-composer-submit, .m-composer-meta, .m-adv-toggle,
  .m-adv-panel, .m-adv-grid, .m-adv-field, .m-adv-field--full, .m-adv-label,
  .m-adv-input, .m-pro-tag, .m-trust-row

BENTO GRID:
  .m-bento, .m-bento-card, .m-bento-card--wide, .m-bento-glyph, .m-bento-num,
  .m-bento-card-h, .m-bento-card-p, .m-bento-card-link, .m-bento-vis,
  .m-bar-track, .m-bar-fill, .m-ws-mock, .m-ws-mock-row, .m-ws-mock-avatar

STEPS & STATS:
  .m-steps, .m-step, .m-step-num, .m-step-h, .m-step-p,
  .m-stats, .m-stat, .m-stat-val, .m-stat-label

TOOLS & ACTIONS:
  .m-duo, .m-duo-card, .m-duo-glyph, .m-duo-glyph--red, .m-duo-h, .m-duo-p,
  .m-cta, .m-cta--white, .m-cta--outline, .m-cta--sm, .m-ripple, .m-magnetic

CURSOR & MOTION IDS:
  #mCursorArrow, #mCursorRing, #cursorGlow, #mScrollBar, #mScrollBar-fill
```
