// Preload for the game view (runs in an isolated world before any page script, on every navigation).
// 1) Remove the FedCM RP entry point from the game page so the Mobage SDK falls back to its
//    popup + postMessage login, which works in Electron. Runs only on game.granbluefantasy.jp.
// 2) Diagnostics: forward Mobage <-> game postMessage traffic and SDK call results to the main
//    process (nav.log). The game stubs console.*, so we use DOM message events + IPC instead.
const { webFrame, ipcRenderer } = require('electron');

// Mobage frames & popups: strip the CHIPS `Partitioned` attribute from JS-set cookies (server-set ones
// are handled in main.js via onHeadersReceived). Partitioned cookies would split Mobage's session
// between the login popup (top-level mobage.jp) and its iframes inside the game.
if (/(^|\.)(mobage\.jp|mbga\.jp|dena\.com)$/.test(location.hostname)) {
  webFrame.executeJavaScript(`
    (function () {
      try {
        const d = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
        if (d && d.set) Object.defineProperty(Document.prototype, 'cookie', {
          configurable: true, enumerable: d.enumerable, get: d.get,
          set(v) { return d.set.call(this, String(v).replace(/;\\s*partitioned\\s*(?=;|$)/ig, '')); }
        });
      } catch (e) {}
    })();
  `).catch(() => {});
}

if (/(^|\.)granbluefantasy\.jp$/.test(location.hostname)) {
  const redact = (s) => String(s).replace(/("?(?:access_token|id_token|code|refresh_token)"?\s*[:=]\s*"?)[^"&,}\s]+/g, '$1<redacted>');
  const diag = (kind, text) => { try { ipcRenderer.send('gbf:diag', kind, redact(text).slice(0, 600)); } catch {} };

  // Isolated world sees the same DOM events as the page: log what Mobage frames/popups post to us,
  // plus anything the main-world hooks below post to ourselves.
  window.addEventListener('message', (e) => {
    try {
      if (typeof e.data === 'string' && e.data.startsWith('[gbfwrap]')) return diag('sdk', e.data.slice(9));
      if (/\.mobage\.jp$|\.mbga\.jp$/.test(e.origin)) {
        let d; try { d = JSON.stringify(e.data); } catch { d = String(e.data); }
        diag('msg', e.origin + ' ' + d);
      }
    } catch {}
  }, true);

  webFrame.executeJavaScript(`
    (function () {
      try {
        delete window.IdentityCredential;
        if ('IdentityCredential' in window) {
          Object.defineProperty(window, 'IdentityCredential', { value: undefined, configurable: true, writable: true });
        }
      } catch (e) {}
      try {
        const orig = navigator.credentials.get.bind(navigator.credentials);
        navigator.credentials.get = function (opts) {
          if (opts && opts.identity) return Promise.reject(new DOMException('FedCM disabled in wrapper', 'NotSupportedError'));
          return orig(opts);
        };
      } catch (e) {}
      // SDK call tracing → window.postMessage('[gbfwrap]…') → picked up by the preload above.
      try {
        const say = (t) => { try { window.postMessage('[gbfwrap]' + t, location.origin); } catch (e) {} };
        const js = (v) => { try { return JSON.stringify(v); } catch (e) { return String(v); } };
        const hook = () => {
          const m = window.mobage; if (!m || !m.oauth || m.__gbfwrapHooked) return false;
          m.__gbfwrapHooked = true;
          say('hooked mobage.oauth');
          for (const fn of ['getConnectedStatus', 'connect', 'logout', 'getStatus']) {
            const orig = m.oauth[fn]; if (typeof orig !== 'function') continue;
            m.oauth[fn] = function (params, cb) {
              const stack = fn === 'logout' ? ' stack=' + String(new Error().stack).split(String.fromCharCode(10)).slice(1, 6).join(' | ') : '';
              say(fn + ' called ' + js(params || {}).slice(0, 200) + stack);
              return orig.call(this, params, function (err, res) {
                say(fn + ' -> err=' + js(err).slice(0, 300) + ' res=' + js(res).slice(0, 300));
                return cb && cb.apply(this, arguments);
              });
            };
          }
          // Also trace the game's own logout POST (lib/mobage-jssdk.js f("logout")).
          const XO = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function (method, url) {
            try { if (/logout|mobage|login|auth/i.test(String(url))) { const u = String(url); say('xhr ' + method + ' ' + u.slice(0, 120) + ' from=' + String(new Error().stack).split(String.fromCharCode(10)).slice(2, 5).join(' | ')); this.addEventListener('loadend', () => say('xhr done ' + u.slice(0, 80) + ' status=' + this.status + ' body=' + String(this.responseText || '').slice(0, 200))); } } catch (e) {}
            return XO.apply(this, arguments);
          };
          return true;
        };
        document.addEventListener('mobageReady', () => setTimeout(hook, 0));
        const iv = setInterval(() => { if (hook()) clearInterval(iv); }, 250);
        setTimeout(() => clearInterval(iv), 60000);
        say('preload injected');
      } catch (e) {}
    })();
  `).catch(() => {});
}
