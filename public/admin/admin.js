(() => {
  const qs = (s, el = document) => el.querySelector(s);
  const qsa = (s, el = document) => Array.from(el.querySelectorAll(s));

  // Confirm dangerous actions
  qsa('[data-confirm]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const msg = el.getAttribute('data-confirm') || 'Are you sure?';
      if (!window.confirm(msg)) e.preventDefault();
    });
  });

  // Reveal/hide secrets (e.g. link passwords) without inline JS.
  qsa('[data-secret-toggle]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const id = btn.getAttribute('data-secret-toggle');
      if (!id) return;
      const el = qs('#' + CSS.escape(id));
      if (!el) return;

      const value = el.getAttribute('data-secret-value') || '';
      const isRevealed = el.getAttribute('data-secret-revealed') === '1';

      if (isRevealed) {
        el.textContent = '••••••';
        el.setAttribute('data-secret-revealed', '0');
        btn.textContent = 'Show';
      } else {
        el.textContent = value;
        el.setAttribute('data-secret-revealed', '1');
        btn.textContent = 'Hide';
      }
    });
  });



  const themeToggleBtn = qs('#adminThemeToggle');
  const themeToggleText = qs('#adminThemeToggleText');
  const THEME_KEY = 'admin_theme';

  const applyTheme = (mode) => {
    const isDark = mode === 'dark';
    document.body.classList.toggle('admin-dark', isDark);
    if (themeToggleText) themeToggleText.textContent = isDark ? 'Light mode' : 'Dark mode';
  };

  let storedTheme = 'light';
  try {
    storedTheme = localStorage.getItem(THEME_KEY) || 'light';
  } catch (_) {}
  applyTheme(storedTheme === 'dark' ? 'dark' : 'light');

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const next = document.body.classList.contains('admin-dark') ? 'light' : 'dark';
      try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
      applyTheme(next);
    });
  }

  // Auto-focus first input on admin login
  const first = qs('input[autofocus]');
  if (first) first.focus();
})();
