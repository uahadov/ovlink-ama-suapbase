// Ovlink PWA Service Worker
const CACHE_NAME = 'ovlink-pwa-v6';

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
            '<!DOCTYPE html><html lang="az"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline | Ovlink</title><style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f172a;color:#f8fafc;text-align:center;padding:20px}button{background:#3b82f6;color:#fff;border:none;padding:10px 20px;border-radius:8px;font-size:16px;cursor:pointer;margin-top:16px}</style></head><body><div><h2>İnternet bağlantısı yoxdur</h2><p>Zəhmət olmasa internet bağlantınızı yoxlayın və ya səhifəni yenidən başladın.</p><button onclick="window.location.reload()">Yenilə</button></div></body></html>',
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
