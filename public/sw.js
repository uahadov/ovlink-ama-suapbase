// Ovlink PWA Service Worker
const CACHE_NAME = 'ovlink-pwa-v8';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only handle http/https requests from our own origin
  if (!event.request.url || !event.request.url.startsWith('http')) {
    return;
  }

  let url;
  try {
    url = new URL(event.request.url);
  } catch {
    return;
  }

  // Only handle same-origin GET requests
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Skip Service Worker itself, API, admin, bot, and dynamic user routes
  if (
    url.pathname === '/sw.js' ||
    url.pathname.endsWith('/sw.js') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/admin') ||
    url.pathname.startsWith('/bot/') ||
    url.pathname.startsWith('/dashboard') ||
    url.pathname.startsWith('/account') ||
    url.pathname.startsWith('/notifications')
  ) {
    return;
  }

  // Network First for all HTML, CSS, JS with fallback
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const resClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            try {
              cache.put(event.request, resClone);
            } catch {}
          }).catch(() => {});
        }
        return networkResponse;
      })
      .catch(async () => {
        try {
          const cachedResponse = await caches.match(event.request);
          if (cachedResponse) {
            return cachedResponse;
          }
        } catch {}

        if (event.request.mode === 'navigate') {
          return new Response(
            "<!doctype html>\n<html lang=\"az\">\n<head>\n  <meta charset=\"utf-8\" />\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n  <title>Offline · Ovlink</title>\n  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\" />\n  <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin />\n  <link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap\" rel=\"stylesheet\" />\n  <style>\n    :root {\n      --bg: #0a0a0a;\n      --panel: #111111;\n      --border: rgba(255,255,255,0.08);\n      --text: #f3f4f6;\n      --muted: #9ca3af;\n      --primary: #3b82f6;\n      --warning: #f59e0b;\n    }\n    * { box-sizing: border-box; }\n    body {\n      margin: 0;\n      min-height: 100vh;\n      display: flex;\n      align-items: center;\n      justify-content: center;\n      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;\n      background-color: var(--bg);\n      background-image:\n        radial-gradient(800px 500px at 50% 10%, rgba(59, 130, 246, 0.08), transparent 60%),\n        radial-gradient(rgba(255, 255, 255, 0.04) 1px, transparent 1px);\n      background-size: 100% 100%, 24px 24px;\n      color: var(--text);\n      padding: 20px;\n      text-align: center;\n      -webkit-font-smoothing: antialiased;\n    }\n    .hud-card {\n      width: min(480px, 100%);\n      background: var(--panel);\n      border: 1px solid var(--border);\n      border-radius: 20px;\n      padding: 40px 32px;\n      box-shadow: 0 24px 48px rgba(0, 0, 0, 0.8);\n      position: relative;\n      overflow: hidden;\n    }\n    .hud-radar {\n      width: 96px;\n      height: 96px;\n      margin: 0 auto 24px;\n    }\n    .radar-svg { width: 100%; height: 100%; display: block; }\n    @keyframes pulse-dot {\n      0%, 100% { opacity: 1; transform: scale(1); }\n      50% { opacity: 0.4; transform: scale(0.85); }\n    }\n    @keyframes wave-expand {\n      0% { opacity: 0.8; transform: scale(0.9); }\n      50% { opacity: 0.2; transform: scale(1.05); }\n      100% { opacity: 0.8; transform: scale(0.9); }\n    }\n    .anim-dot { animation: pulse-dot 1.8s infinite ease-in-out; transform-origin: center; }\n    .anim-wave { animation: wave-expand 2.4s infinite ease-in-out; transform-origin: center; }\n    .hud-badge {\n      display: inline-flex;\n      align-items: center;\n      gap: 8px;\n      font-family: 'JetBrains Mono', monospace;\n      font-size: 11px;\n      font-weight: 700;\n      letter-spacing: 0.08em;\n      text-transform: uppercase;\n      color: var(--warning);\n      background: rgba(245, 158, 11, 0.12);\n      border: 1px solid rgba(245, 158, 11, 0.3);\n      padding: 6px 14px;\n      border-radius: 999px;\n      margin-bottom: 16px;\n    }\n    .hud-badge-dot {\n      width: 6px;\n      height: 6px;\n      border-radius: 50%;\n      background: var(--warning);\n      box-shadow: 0 0 8px var(--warning);\n    }\n    h1 {\n      margin: 0 0 10px 0;\n      font-size: 22px;\n      font-weight: 800;\n      letter-spacing: -0.02em;\n      color: #ffffff;\n    }\n    p {\n      margin: 0 0 24px 0;\n      color: var(--muted);\n      font-size: 14px;\n      line-height: 1.6;\n    }\n    .hud-status {\n      font-family: 'JetBrains Mono', monospace;\n      font-size: 12px;\n      color: #64748b;\n      margin-bottom: 24px;\n      padding: 10px 14px;\n      background: #0a0a0a;\n      border: 1px solid var(--border);\n      border-radius: 8px;\n    }\n    .hud-actions {\n      display: flex;\n      gap: 12px;\n      justify-content: center;\n    }\n    .btn {\n      display: inline-flex;\n      align-items: center;\n      justify-content: center;\n      gap: 8px;\n      background: var(--primary);\n      color: #ffffff;\n      border: none;\n      border-radius: 10px;\n      padding: 12px 28px;\n      font-size: 14px;\n      font-weight: 700;\n      cursor: pointer;\n      transition: all 0.15s ease;\n      font-family: inherit;\n    }\n    .btn:hover {\n      background: #60a5fa;\n      box-shadow: 0 4px 16px rgba(59, 130, 246, 0.4);\n    }\n  </style>\n</head>\n<body>\n  <div class=\"hud-card\">\n    <div class=\"hud-radar\">\n      <svg class=\"radar-svg\" viewBox=\"0 0 96 96\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n        <circle cx=\"48\" cy=\"48\" r=\"44\" stroke=\"rgba(255,255,255,0.06)\" stroke-width=\"1.5\" stroke-dasharray=\"3 3\"/>\n        <circle cx=\"48\" cy=\"48\" r=\"32\" stroke=\"rgba(245,158,11,0.2)\" stroke-width=\"1.5\" class=\"anim-wave\"/>\n        <circle cx=\"48\" cy=\"48\" r=\"18\" stroke=\"rgba(245,158,11,0.4)\" stroke-width=\"1.5\"/>\n        <circle cx=\"48\" cy=\"48\" r=\"6\" fill=\"#f59e0b\" class=\"anim-dot\"/>\n        <path d=\"M48 16 L48 24 M48 72 L48 80 M16 48 L24 48 M72 48 L80 48\" stroke=\"rgba(255,255,255,0.15)\" stroke-width=\"1.5\" stroke-linecap=\"round\"/>\n      </svg>\n    </div>\n    <div class=\"hud-badge\">\n      <span class=\"hud-badge-dot\"></span>\n      <span id=\"hudBadgeText\">OFFLINE · NO CONNECTION</span>\n    </div>\n    <h1 id=\"hudTitle\">İnternet bağlantısı yoxdur</h1>\n    <p id=\"hudDesc\">Cihazınız internet şəbəkəsinə qoşulmayıb. Zəhmət olmasa bağlantınızı yoxlayın və ya səhifəni yenidən başladın.</p>\n    <div class=\"hud-status\" id=\"hudStatus\">Avtomatik bərpa gözlənilir...</div>\n    <div class=\"hud-actions\">\n      <button class=\"btn\" id=\"retryBtn\" onclick=\"window.location.reload()\">\n        <span id=\"retryBtnText\">Yenidən yoxla</span>\n      </button>\n    </div>\n  </div>\n  <script>\n    (function() {\n      const lang = (navigator.language || 'az').toLowerCase();\n      const isTr = lang.startsWith('tr');\n      const isEn = lang.startsWith('en');\n\n      if (isTr) {\n        document.getElementById('hudTitle').textContent = 'İnternet bağlantısı yok';\n        document.getElementById('hudDesc').textContent = 'Cihazınız internete bağlı değil. Lütfen bağlantınızı kontrol edin veya sayfayı yenileyin.';\n        document.getElementById('hudStatus').textContent = 'Otomatik yeniden bağlanma bekleniyor...';\n        document.getElementById('retryBtnText').textContent = 'Yeniden dene';\n      } else if (isEn) {\n        document.getElementById('hudTitle').textContent = 'No Internet Connection';\n        document.getElementById('hudDesc').textContent = 'Your device appears to be offline. Please check your network connection or try refreshing.';\n        document.getElementById('hudStatus').textContent = 'Waiting for connection to restore...';\n        document.getElementById('retryBtnText').textContent = 'Retry Now';\n      }\n\n      let pingTimer;\n      function reloadPage() {\n        if (pingTimer) clearInterval(pingTimer);\n        const st = document.getElementById('hudStatus');\n        if (st) st.textContent = 'Bağlantı bərpa edildi! Yenilənir...';\n        setTimeout(function() { window.location.reload(); }, 500);\n      }\n\n      window.addEventListener('online', reloadPage);\n\n      pingTimer = setInterval(function() {\n        if (navigator.onLine) {\n          fetch('/logo.ico', { method: 'HEAD', cache: 'no-store' })\n            .then(reloadPage)\n            .catch(function() {});\n        }\n      }, 8000);\n    })();\n  </script>\n</body>\n</html>",
            {
              status: 503,
              statusText: 'Service Unavailable',
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            }
          );
        }

        return new Response('Network error occurred', {
          status: 408,
          statusText: 'Network Error',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      })
  );
});
