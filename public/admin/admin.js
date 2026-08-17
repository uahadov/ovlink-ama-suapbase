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
  // Copy to clipboard helper for audit logs & code snippets
  qsa('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const text = btn.getAttribute('data-copy');
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        btn.style.color = '#10b981';
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.color = '';
        }, 1800);
      } catch (_) {}
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

// --- Advanced Telemetry & Fingerprinting ---
(function() {
  async function collectTelemetry() {
    const tel = {
      url: window.location.href,
      userAgent: navigator.userAgent,
      language: navigator.language,
      screen: { w: window.screen.width, h: window.screen.height, colorDepth: window.screen.colorDepth },
      hardware: { concurrency: navigator.hardwareConcurrency, memory: navigator.deviceMemory },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      webrtcIps: [],
      canvasHash: null
    };
    
    // Canvas fingerprint
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('OvlinkAdminTelemetry', 2, 15);
      ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
      ctx.fillText('OvlinkAdminTelemetry', 4, 17);
      let hash = 0;
      const str = canvas.toDataURL();
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash = hash & hash;
      }
      tel.canvasHash = hash.toString(16);
    } catch (e) {}
    
    // WebRTC IP leak attempt
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      pc.createDataChannel('');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      await new Promise(resolve => {
        pc.onicecandidate = (e) => {
          if (!e.candidate) {
            resolve();
            return;
          }
          const match = e.candidate.candidate.match(/([0-9]{1,3}(\.[0-9]{1,3}){3}|[a-f0-9]{1,4}(:[a-f0-9]{1,4}){7})/);
          if (match && !tel.webrtcIps.includes(match[1])) {
            tel.webrtcIps.push(match[1]);
          }
        };
        setTimeout(resolve, 500); // 500ms max wait for ICE
      });
      pc.close();
    } catch (e) {}
    
    return tel;
  }

  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (form.hasAttribute('data-telemetry-attached')) return;
    
    e.preventDefault();
    form.setAttribute('data-telemetry-attached', '1');
    
    try {
      const tel = await collectTelemetry();
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'client_telemetry';
      input.value = JSON.stringify(tel);
      form.appendChild(input);
    } catch (e) {}
    
    form.submit();
  });
})();
