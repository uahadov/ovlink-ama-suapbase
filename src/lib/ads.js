const SANDBOX_AD_FRAME_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "script-src https: 'unsafe-inline'",
  "connect-src https:",
  "img-src https: data: blob:",
  "style-src https: 'unsafe-inline'",
  "frame-src https:",
].join('; ');

function renderSandboxedAdFrame(res, bodyHtml, slotName) {
  const safeSlotName = JSON.stringify((slotName || '').toString());
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex,nofollow');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Content-Security-Policy', SANDBOX_AD_FRAME_CSP);
  return res.send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>html,body{margin:0;padding:0;overflow:hidden;background:transparent;}</style>
  </head>
  <body>${bodyHtml}
    <script>
      (function () {
        var slot = ${safeSlotName};
        var didMarkFilled = false;

        function postStatus(status, height) {
          try {
            if (window.parent && window.parent !== window) {
              window.parent.postMessage({
                __ovlinkAdFrame: true,
                slot: slot,
                status: status,
                height: Number.isFinite(height) ? height : 0
              }, '*');
            }
          } catch (_) {}
        }

        function detectFill() {
          var body = document.body;
          if (!body) return;
          var root = document.documentElement || body;
          var height = Math.max(root.scrollHeight || 0, body.scrollHeight || 0, body.offsetHeight || 0);
          var hasRenderableNode = !!body.querySelector('iframe, ins, img, canvas, video');
          var hasClickableNode = !!body.querySelector('a[href], [onclick]');
          var filled = hasRenderableNode || hasClickableNode || height > 60;

          if (filled) {
            didMarkFilled = true;
            postStatus('filled', height);
          } else {
            postStatus('empty', height);
          }
        }

        window.addEventListener('error', function () {
          postStatus('error', 0);
        }, true);

        window.addEventListener('load', function () {
          postStatus('loading', 0);
          setTimeout(detectFill, 1800);
          setTimeout(detectFill, 4500);
        });

        setTimeout(function () {
          if (!didMarkFilled) detectFill();
        }, 7000);
      })();
    </script>
  </body>
</html>`);
}

function renderEmptySandboxedAdFrame(res, slotName) {
  const safeSlotName = JSON.stringify((slotName || '').toString());
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex,nofollow');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Content-Security-Policy', SANDBOX_AD_FRAME_CSP);
  return res.status(200).send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>html,body{margin:0;padding:0;overflow:hidden;background:transparent;}</style>
  </head>
  <body>
    <script>
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ __ovlinkAdFrame: true, slot: ${safeSlotName}, status: 'error', height: 0 }, '*');
        }
      } catch (_) {}
    </script>
  </body>
</html>`);
}

module.exports = {
  SANDBOX_AD_FRAME_CSP,
  renderSandboxedAdFrame,
  renderEmptySandboxedAdFrame
};
