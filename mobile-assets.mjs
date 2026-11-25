import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST_JSON = JSON.stringify(
  {
    name: 'Antigravity',
    short_name: 'Antigravity',
    description: 'Antigravity Local Relay',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0b0b0f',
    theme_color: '#0b0b0f',
    icons: [
      {
        src: '/relay-icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/relay-icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/relay-icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/relay-icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  },
  null,
  2,
);

export const ICON_192 = fs.readFileSync(path.join(import.meta.dirname, 'icon-192.png'));
export const ICON_512 = fs.readFileSync(path.join(import.meta.dirname, 'icon-512.png'));

export const MOBILE_CSS = `
html {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
  background: #0b0b0f;
}

@media (prefers-color-scheme: light) {
  html {
    background: #ffffff;
  }
}

html, body {
  overscroll-behavior: none;
  -webkit-tap-highlight-color: transparent;
  overflow-x: clip;
}

#root {
  box-sizing: border-box;
  height: 100dvh;
  height: var(--agy-vvh, 100dvh);
  min-height: 0;
  overflow-x: clip;
}

@media (pointer: coarse) {
  button, a, [role="button"] {
    touch-action: manipulation;
  }

  /* Prevent mobile browser auto-zoom on focus */
  input,
  textarea,
  select,
  [contenteditable="true"],
  [contenteditable=""],
  [contenteditable="plaintext-only"] {
    font-size: max(16px, 1em) !important;
  }

  /* Respect notch / status bar / gesture bar safe areas */
  #root {
    padding:
      env(safe-area-inset-top, 0px)
      env(safe-area-inset-right, 0px)
      env(safe-area-inset-bottom, 0px)
      env(safe-area-inset-left, 0px);
  }
}

@media (max-width: 768px) {
  main, article, section {
    min-width: 0;
  }

  pre, table {
    max-width: 100%;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  table {
    display: block;
  }

  pre code {
    white-space: pre;
  }

  a, code {
    overflow-wrap: anywhere;
  }

  img, video {
    max-width: 100%;
    height: auto;
  }
}

#agy-relay-net-banner {
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + 8px);
  left: 50%;
  max-width: calc(100vw - 24px);
  box-sizing: border-box;
  z-index: 2147483647;
  padding: 6px 14px;
  border-radius: 999px;
  background: rgba(24, 24, 32, 0.96);
  color: #f4f4f5;
  border: 1px solid rgba(255, 255, 255, 0.14);
  font: 500 12px/1.4 system-ui, -apple-system, sans-serif;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  opacity: 0;
  pointer-events: none;
  transform: translateX(-50%) translateY(-10px);
  transition: opacity 180ms ease, transform 180ms ease;
}
#agy-relay-net-banner[data-visible="1"] {
  opacity: 1;
  pointer-events: auto;
  transform: translateX(-50%) translateY(0);
}
#agy-relay-net-banner span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#agy-relay-net-banner button {
  flex-shrink: 0;
  cursor: pointer;
  background: rgba(122, 162, 247, 0.22);
  color: #a9c4ff;
  border: 0;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
}

@media (prefers-color-scheme: light) {
  #agy-relay-net-banner {
    background: rgba(255, 255, 255, 0.96);
    color: #18181b;
    border-color: rgba(0, 0, 0, 0.12);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
  }
  #agy-relay-net-banner button {
    background: rgba(37, 99, 235, 0.12);
    color: #1d4ed8;
  }
}
`;

export const MOBILE_JS = `(() => {
  if (window.__agyRelayMobileInit) return;
  window.__agyRelayMobileInit = true;

  // Bypass same-origin no-cors priming fetch before WebSocket dial
  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      if (init && init.mode === 'no-cors') {
        try {
          const rawUrl = typeof input === 'string' ? input : input?.url;
          if (rawUrl) {
            const u = new URL(rawUrl, location.href);
            if (u.origin === location.origin && u.pathname === '/connect-websocket') {
              return Promise.resolve(new Response(null, { status: 200 }));
            }
          }
        } catch {}
      }
      return origFetch(input, init);
    };
  }

  // Overlap /connect-websocket (WebTransport over HTTP/3 QUIC + wss:// fallback) with /main.js download & parse
  if (
    window === window.top &&
    typeof window.WebSocket === 'function' &&
    (location.protocol === 'https:' || location.protocol === 'http:')
  ) {
    const NativeWebSocket = window.WebSocket;
    const earlyWsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/connect-websocket';
    const wtUrl = 'https://' + location.host + '/wt-websocket';
    const canUseWT =
      location.protocol === 'https:' &&
      typeof window.WebTransport === 'function' &&
      typeof window.DecompressionStream === 'function' &&
      !/[?&]no-wt=1(?:&|$)/.test(location.search);

    const textDecoder = new TextDecoder();
    const textEncoder = new TextEncoder();

    class WebTransportWebSocket extends EventTarget {
      constructor(targetWtUrl, logicalWsUrl, onPreClaimFail) {
        super();
        this.url = logicalWsUrl;
        this.readyState = 0;
        this.binaryType = 'arraybuffer';
        this.bufferedAmount = 0;
        this.protocol = '';
        this.extensions = 'webtransport-quic';
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        this._claimed = false;
        this._wt = null;
        this._writer = null;
        this._reader = null;
        this._sendChain = Promise.resolve();
        this._onPreClaimFail = onPreClaimFail;
        this._connect(targetWtUrl);
      }

      _fire(name, ev) {
        const handler = this['on' + name];
        if (typeof handler === 'function') {
          try { handler.call(this, ev); } catch {}
        }
        this.dispatchEvent(ev);
      }

      async _connect(targetWtUrl) {
        let timer = 0;
        try {
          const wt = new WebTransport(targetWtUrl);
          this._wt = wt;
          await Promise.race([
            wt.ready,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('WT timeout')), 1500);
            }),
          ]);
          if (timer) { clearTimeout(timer); timer = 0; }
          if (this.readyState !== 0) {
            try { wt.close(); } catch {}
            return;
          }
          const bidi = await wt.createBidirectionalStream();
          if (this.readyState !== 0) {
            try { wt.close(); } catch {}
            return;
          }
          this._writer = bidi.writable.getWriter();
          this._reader = bidi.readable.getReader();
          this.readyState = 1;
          window.__agyActiveTransport = 'webtransport-quic';
          this._fire('open', new Event('open'));
          void this._readLoop();
          wt.closed.then(
            () => { if (this.readyState < 2) this._finishClose(1000, '', true); },
            () => { if (this.readyState < 2) this._finishClose(1006, '', false); },
          );
        } catch {
          if (timer) { clearTimeout(timer); timer = 0; }
          if (this.readyState === 0) {
            window.__agyWtDisabled = true;
            if (!this._claimed && typeof this._onPreClaimFail === 'function') {
              const cb = this._onPreClaimFail;
              this._onPreClaimFail = null;
              cb();
            }
          }
          this._fire('error', new Event('error'));
          this._finishClose(1006, '', false);
        }
      }

      async _readLoop() {
        let buf = new Uint8Array(0);
        const reader = this._reader;
        try {
          while (this.readyState === 1) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
              if (buf.length === 0) {
                buf = value;
              } else {
                const merged = new Uint8Array(buf.length + value.length);
                merged.set(buf, 0);
                merged.set(value, buf.length);
                buf = merged;
              }
              while (buf.length >= 5) {
                const flags = buf[0];
                const len = ((buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4]) >>> 0;
                if (buf.length < 5 + len) break;
                let payload = buf.subarray(5, 5 + len);
                buf = buf.subarray(5 + len);
                if (flags & 0x02) {
                  const ds = new DecompressionStream('deflate-raw');
                  const w = ds.writable.getWriter();
                  w.write(payload);
                  w.close();
                  payload = new Uint8Array(await new Response(ds.readable).arrayBuffer());
                }
                if (this.readyState !== 1) return;
                let msgData;
                if (flags & 0x01) {
                  if (this.binaryType === 'blob') {
                    msgData = new Blob([payload]);
                  } else {
                    const copy = new Uint8Array(payload.byteLength);
                    copy.set(payload);
                    msgData = copy.buffer;
                  }
                } else {
                  msgData = textDecoder.decode(payload);
                }
                this._fire('message', new MessageEvent('message', { data: msgData }));
              }
            }
          }
          if (this.readyState < 2) this._finishClose(1000, '', true);
        } catch {
          if (this.readyState < 2) this._finishClose(1006, '', false);
        }
      }

      send(data) {
        if (this.readyState !== 1 || !this._writer) return;
        let flags = 0;
        let bytes;
        if (typeof data === 'string') {
          bytes = textEncoder.encode(data);
        } else if (data instanceof ArrayBuffer) {
          flags = 0x01;
          bytes = new Uint8Array(data);
        } else if (ArrayBuffer.isView(data)) {
          flags = 0x01;
          bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        } else {
          bytes = textEncoder.encode(String(data));
        }
        const frame = new Uint8Array(5 + bytes.byteLength);
        frame[0] = flags;
        const n = bytes.byteLength;
        frame[1] = (n >>> 24) & 0xff;
        frame[2] = (n >>> 16) & 0xff;
        frame[3] = (n >>> 8) & 0xff;
        frame[4] = n & 0xff;
        frame.set(bytes, 5);
        this.bufferedAmount += frame.byteLength;
        const writer = this._writer;
        this._sendChain = this._sendChain.then(
          () => writer.write(frame).finally(() => { this.bufferedAmount = Math.max(0, this.bufferedAmount - frame.byteLength); }),
          () => { this.bufferedAmount = Math.max(0, this.bufferedAmount - frame.byteLength); },
        );
      }

      close(code = 1000, reason = '') {
        if (this.readyState >= 2) return;
        this.readyState = 2;
        this._finishClose(code, reason, true);
      }

      _finishClose(code, reason, wasClean) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        try { this._writer?.close()?.catch?.(() => {}); } catch {}
        try { this._reader?.cancel()?.catch?.(() => {}); } catch {}
        try { this._wt?.close?.(); } catch {}
        this._fire('close', new CloseEvent('close', { code, reason, wasClean }));
      }
    }
    WebTransportWebSocket.CONNECTING = 0;
    WebTransportWebSocket.OPEN = 1;
    WebTransportWebSocket.CLOSING = 2;
    WebTransportWebSocket.CLOSED = 3;

    let earlyWt = null;
    let earlyWs = null;
    let earlyCleanupTimer = 0;
    const clearEarlyTimer = () => {
      if (earlyCleanupTimer) {
        clearTimeout(earlyCleanupTimer);
        earlyCleanupTimer = 0;
      }
    };

    const startEarlyNativeWs = () => {
      if (earlyWs) return;
      try {
        earlyWs = new NativeWebSocket(earlyWsUrl);
        earlyWs.binaryType = 'arraybuffer';
        const dropEarly = () => {
          clearEarlyTimer();
          earlyWs = null;
        };
        earlyWs.addEventListener('error', dropEarly, { once: true });
        earlyWs.addEventListener('close', dropEarly, { once: true });
        earlyCleanupTimer = setTimeout(() => {
          earlyCleanupTimer = 0;
          if (earlyWs) {
            const stale = earlyWs;
            earlyWs = null;
            try { stale.close(); } catch {}
          }
        }, 15000);
      } catch {
        earlyWs = null;
      }
    };

    if (canUseWT && !window.__agyWtDisabled) {
      earlyWt = new WebTransportWebSocket(wtUrl, earlyWsUrl, () => {
        earlyWt = null;
        startEarlyNativeWs();
      });
      earlyCleanupTimer = setTimeout(() => {
        earlyCleanupTimer = 0;
        if (earlyWt && !earlyWt._claimed) {
          const stale = earlyWt;
          earlyWt = null;
          try { stale.close(); } catch {}
        }
      }, 15000);
    } else {
      startEarlyNativeWs();
    }

    const WrappedWebSocket = function(url, protocols) {
      if (protocols === undefined) {
        try {
          const targetUrl = new URL(String(url), location.href);
          if (targetUrl.href === earlyWsUrl) {
            if (earlyWt && (earlyWt.readyState === 0 || earlyWt.readyState === 1)) {
              const wt = earlyWt;
              earlyWt = null;
              wt._claimed = true;
              clearEarlyTimer();
              if (wt.readyState === 1) {
                queueMicrotask(() => {
                  if (wt.readyState === 1) wt._fire('open', new Event('open'));
                });
              }
              return wt;
            }
            if (earlyWs && (earlyWs.readyState === 0 || earlyWs.readyState === 1)) {
              const ws = earlyWs;
              earlyWs = null;
              clearEarlyTimer();
              window.__agyActiveTransport = 'websocket-tcp';
              if (ws.readyState === NativeWebSocket.OPEN) {
                queueMicrotask(() => {
                  if (ws.readyState === NativeWebSocket.OPEN) ws.dispatchEvent(new Event('open'));
                });
              }
              return ws;
            }
            if (canUseWT && !window.__agyWtDisabled) {
              const wt = new WebTransportWebSocket(wtUrl, earlyWsUrl);
              wt._claimed = true;
              return wt;
            }
            window.__agyActiveTransport = 'websocket-tcp';
          }
        } catch {}
      }
      return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    };
    WrappedWebSocket.prototype = NativeWebSocket.prototype;
    WrappedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
    WrappedWebSocket.OPEN = NativeWebSocket.OPEN;
    WrappedWebSocket.CLOSING = NativeWebSocket.CLOSING;
    WrappedWebSocket.CLOSED = NativeWebSocket.CLOSED;
    window.WebSocket = WrappedWebSocket;
  }

  // Rewrite localhost / 127.0.0.1 URLs (e.g. Swarm sidecar iframes, dev servers) to relay proxy
  function rewriteLocalUrl(raw) {
    if (typeof raw !== 'string' || !raw) return raw;
    const trimmed = raw.trim();
    const head = trimmed.slice(0, 8).toLowerCase();
    if (!head.startsWith('http://') && !head.startsWith('https://')) return raw;
    try {
      const u = new URL(trimmed);
      const h = u.hostname.toLowerCase();
      if (h !== 'localhost' && h !== '127.0.0.1' && h !== '[::1]' && h !== '::1' && !h.endsWith('.localhost')) {
        return raw;
      }
      const proto = u.protocol === 'https:' ? 'https' : 'http';
      const port = u.port || (proto === 'https' ? '443' : '80');
      const curPort = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
      if (u.hostname === window.location.hostname && String(port) === String(curPort)) {
        return raw;
      }
      return window.location.origin + '/_relay_local/' + proto + '/' + port + (u.pathname || '/') + u.search + u.hash;
    } catch {
      return raw;
    }
  }

  // Synchronous critical shims (must run before /main.js)
  if (typeof HTMLIFrameElement !== 'undefined' && HTMLIFrameElement.prototype) {
    const iframeSrcDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
    if (iframeSrcDesc && iframeSrcDesc.set && iframeSrcDesc.configurable) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
        configurable: true,
        enumerable: iframeSrcDesc.enumerable,
        get() {
          return iframeSrcDesc.get.call(this);
        },
        set(val) {
          return iframeSrcDesc.set.call(this, rewriteLocalUrl(String(val ?? '')));
        },
      });
    }
  }

  const origSetAttr = typeof Element !== 'undefined' && Element.prototype
    ? Element.prototype.setAttribute
    : null;
  if (origSetAttr) {
    Element.prototype.setAttribute = function(name, value) {
      const tag = this.tagName;
      if (tag === 'IFRAME' || tag === 'A') {
        const key = String(name).toLowerCase();
        if ((tag === 'IFRAME' && key === 'src') || (tag === 'A' && key === 'href')) {
          value = rewriteLocalUrl(String(value ?? ''));
        }
      }
      return origSetAttr.call(this, name, value);
    };
  }

  const origWindowOpen = window.open;
  if (typeof origWindowOpen === 'function') {
    window.open = function(url, target, features) {
      return origWindowOpen.call(this, rewriteLocalUrl(url), target, features);
    };
  }

  // Persist nativeStorage preferences in memory + browser localStorage when not in Electron
  if (!window.nativeStorage) {
    const PREFIX = 'agy_relay_ns:';
    const listeners = new Set();
    let cache = null;

    function parseStored(raw) {
      if (raw === null || raw === undefined) return raw;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }

    function ensureCache() {
      if (cache !== null) return cache;
      cache = Object.create(null);
      try {
        const len = localStorage.length;
        for (let i = 0; i < len; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(PREFIX)) {
            cache[k.slice(PREFIX.length)] = parseStored(localStorage.getItem(k));
          }
        }
      } catch {}
      return cache;
    }

    window.addEventListener?.('storage', (e) => {
      if (!cache || !e) return;
      if (e.key === null) {
        cache = null;
        return;
      }
      if (e.key.startsWith(PREFIX)) {
        const shortKey = e.key.slice(PREFIX.length);
        if (e.newValue === null) delete cache[shortKey];
        else cache[shortKey] = parseStored(e.newValue);
      }
    });

    window.nativeStorage = {
      getItems: async () => ({ ...ensureCache() }),
      updateItems: async (changes) => {
        if (!changes || typeof changes !== 'object') return;
        const c = ensureCache();
        for (const [k, v] of Object.entries(changes)) {
          if (v === null || v === undefined) {
            delete c[k];
            try { localStorage.removeItem(PREFIX + k); } catch {}
          } else {
            c[k] = v;
            try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch {}
          }
        }
        listeners.forEach((cb) => {
          try { cb(changes); } catch {}
        });
      },
      onChanged: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
  }

  // Fallback notification bridge when not in Electron
  if (!window.nativeNotifications) {
    window.nativeNotifications = {
      send: async (opts) => {
        if (!opts?.title || typeof Notification === 'undefined' || Notification.permission !== 'granted') {
          return;
        }
        const body = opts.body || '';
        try {
          if (typeof navigator !== 'undefined' && navigator.serviceWorker?.ready) {
            const reg = await Promise.race([
              navigator.serviceWorker.ready,
              new Promise((r) => setTimeout(() => r(null), 250)),
            ]);
            if (reg && typeof reg.showNotification === 'function') {
              await reg.showNotification(opts.title, { body });
              return;
            }
          }
        } catch {}
        try {
          new Notification(opts.title, { body });
        } catch {}
      },
      openSystemPreferences: async () => {},
      onClicked: () => () => {},
    };
  }

  // Deferred runtime setup (observers, viewport tracking, banner, SW, plugins)
  let pendingBanner = null;
  let bannerAction = null;

  function ensureBanner() {
    let el = document.getElementById('agy-relay-net-banner');
    if (el) return el;
    if (!document.body) return null;
    el = document.createElement('div');
    el.id = 'agy-relay-net-banner';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    const text = document.createElement('span');
    text.textContent = '连接已断开，等待恢复…';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '重连';
    btn.addEventListener('click', () => {
      if (typeof bannerAction === 'function') bannerAction();
      else location.reload();
    });
    el.append(text, btn);
    el._agyText = text;
    el._agyBtn = btn;
    document.body.appendChild(el);
    return el;
  }

  function setOfflineBanner(show, msg, btnLabel, onAction) {
    const el = ensureBanner();
    if (!el) {
      pendingBanner = { show, msg, btnLabel, onAction };
      return;
    }
    pendingBanner = null;
    const textEl = el._agyText || el.firstChild;
    if (msg && textEl) textEl.textContent = msg;
    const btnEl = el._agyBtn || el.lastChild;
    if (btnEl) btnEl.textContent = btnLabel || '重连';
    bannerAction = typeof onAction === 'function' ? onAction : null;
    if (el.dataset) el.dataset.visible = show ? '1' : '0';
    else el.setAttribute?.('data-visible', show ? '1' : '0');
  }

  function fetchWithTimeout(url, opts, ms) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
    }
    if (typeof AbortController !== 'undefined') {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), ms);
      return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(timer));
    }
    return fetch(url, opts);
  }

  const BACKOFF_MS = [2000, 4000, 8000, 15000, 15000];
  let healthInFlight = null;
  let retryCount = 0;
  let retryTimer = null;
  let updateAvailable = false;

  function clearRetryTimer() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleHealthRetry() {
    clearRetryTimer();
    if (document.visibilityState === 'hidden') return;
    if (retryCount >= BACKOFF_MS.length) return;
    const delay = BACKOFF_MS[retryCount++];
    retryTimer = setTimeout(() => {
      retryTimer = null;
      checkRelayHealth();
    }, delay);
  }

  function checkRelayHealth() {
    if (healthInFlight) return healthInFlight;
    healthInFlight = (async () => {
      try {
        const r = await fetchWithTimeout('/relay-health', { cache: 'no-store' }, 4000);
        if (r.ok) {
          retryCount = 0;
          clearRetryTimer();
          if (!updateAvailable) setOfflineBanner(false);
          return true;
        }
        if (r.status === 401) {
          clearRetryTimer();
          setOfflineBanner(true, '登录态已过期，请刷新重新认证', '刷新', () => location.reload());
          return false;
        }
        setOfflineBanner(true, '后端未就绪 (' + r.status + ')，正在重试…', '重连', () => location.reload());
        scheduleHealthRetry();
        return false;
      } catch {
        setOfflineBanner(true, '连接暂时中断，正在重试…', '重连', () => location.reload());
        scheduleHealthRetry();
        return false;
      } finally {
        healthInFlight = null;
      }
    })();
    return healthInFlight;
  }

  function patchFrame(f) {
    if (!origSetAttr) return;
    const cur = f.getAttribute('src');
    if (!cur) return;
    const next = rewriteLocalUrl(cur);
    if (next !== cur) origSetAttr.call(f, 'src', next);
  }

  function patchExistingFrames(root) {
    if (!root || typeof root.getElementsByTagName !== 'function') return;
    const frames = root.getElementsByTagName('iframe');
    for (let i = 0; i < frames.length; i++) {
      patchFrame(frames[i]);
    }
  }

  let deferredDone = false;
  function initDeferred() {
    if (deferredDone) return;
    deferredDone = true;

    if (pendingBanner) {
      const p = pendingBanner;
      pendingBanner = null;
      setOfflineBanner(p.show, p.msg, p.btnLabel, p.onAction);
    }

    document.addEventListener?.(
      'click',
      (e) => {
        const a = e.target?.closest?.('a[href]');
        if (!a || !origSetAttr) return;
        const rawHref = a.getAttribute('href');
        if (!rawHref) return;
        const nextHref = rewriteLocalUrl(rawHref);
        if (nextHref !== rawHref) {
          origSetAttr.call(a, 'href', nextHref);
        }
      },
      { capture: true, passive: true },
    );

    patchExistingFrames(document);

    if (typeof MutationObserver !== 'undefined' && document.documentElement) {
      const liveIframes =
        typeof document.getElementsByTagName === 'function'
          ? document.getElementsByTagName('iframe')
          : null;
      let rafScheduled = false;
      const scheduleFlush =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : (fn) => setTimeout(fn, 16);

      function flushLiveIframes() {
        rafScheduled = false;
        if (!liveIframes || liveIframes.length === 0) return;
        for (let i = 0; i < liveIframes.length; i++) {
          patchFrame(liveIframes[i]);
        }
      }

      new MutationObserver(() => {
        if (!liveIframes || liveIframes.length === 0 || rafScheduled) return;
        rafScheduled = true;
        scheduleFlush(flushLiveIframes);
      }).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }

    const vv = window.visualViewport;
    if (vv && document.documentElement?.style) {
      let vvRaf = 0;
      let lastVvh = '';
      let lastKb = '';
      const syncViewport = () => {
        vvRaf = 0;
        const rootStyle = document.documentElement.style;
        const scale = vv.scale || 1;
        if (scale > 1.01) {
          if (lastVvh !== 'remove') {
            lastVvh = 'remove';
            if (typeof rootStyle.removeProperty === 'function') {
              rootStyle.removeProperty('--agy-vvh');
            } else {
              rootStyle.setProperty('--agy-vvh', '100dvh');
            }
          }
          if (lastKb !== '0px') {
            lastKb = '0px';
            rootStyle.setProperty('--agy-kb-height', '0px');
          }
          return;
        }
        const nextVvh = Math.max(0, Math.round(vv.height)) + 'px';
        const nextKb = Math.max(0, Math.round(window.innerHeight - vv.height - (vv.offsetTop || 0))) + 'px';
        if (nextVvh !== lastVvh) {
          lastVvh = nextVvh;
          rootStyle.setProperty('--agy-vvh', nextVvh);
        }
        if (nextKb !== lastKb) {
          lastKb = nextKb;
          rootStyle.setProperty('--agy-kb-height', nextKb);
        }
      };
      const onVvChange = () => {
        if (vvRaf) return;
        if (typeof requestAnimationFrame === 'function') {
          vvRaf = requestAnimationFrame(syncViewport);
        } else {
          syncViewport();
        }
      };
      syncViewport();
      vv.addEventListener?.('resize', onVvChange, { passive: true });
      vv.addEventListener?.('scroll', onVvChange, { passive: true });
    }

    window.addEventListener?.('offline', () => {
      clearRetryTimer();
      setOfflineBanner(true, '网络已断开');
    });
    window.addEventListener?.('online', () => {
      retryCount = 0;
      checkRelayHealth();
    });
    document.addEventListener?.('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        retryCount = 0;
        checkRelayHealth();
      } else {
        clearRetryTimer();
      }
    });

    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && navigator.serviceWorker) {
      navigator.serviceWorker.register?.('/sw.js')?.catch?.(() => {});
      navigator.serviceWorker.addEventListener?.('message', (event) => {
        const data = event?.data;
        if (data && data.type === 'AGY_ASSET_UPDATED') {
          updateAvailable = true;
          setOfflineBanner(true, '发现新版本资源，建议刷新页面', '立即刷新', () => location.reload());
        }
      });
    }

    if (window === window.top) {
      const injectContextPlugin = () => {
        if (document.querySelector?.('script[data-agy-plugin="antigravity-context"]')) return;
        const script = document.createElement('script');
        script.src = '/relay-plugin/antigravity-context.js';
        script.defer = true;
        script.setAttribute('data-agy-plugin', 'antigravity-context');
        (document.head || document.documentElement)?.appendChild(script);
      };
      const scheduleContextPlugin = () => {
        setTimeout(() => {
          if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(injectContextPlugin, { timeout: 2000 });
          } else {
            injectContextPlugin();
          }
        }, 2500);
      };
      if (document.readyState === 'complete') {
        scheduleContextPlugin();
      } else {
        window.addEventListener?.('load', scheduleContextPlugin, { once: true });
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDeferred, { once: true });
  } else {
    initDeferred();
  }
})();`;

export const SW_JS = `const CACHE_NAME = 'agy-relay-static-v6';
const CACHE_PATHS = new Set([
  '/main.js',
  '/prism_bundle.js',
  '/jetbox.css',
  '/compiled_tailwind.css',
  '/antigravityCascadeDone.mp3',
  '/relay-icon-192.png',
  '/relay-icon-512.png',
  '/relay-mobile.css',
  '/relay-mobile.js',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

async function fetchWithRevalidate(cache, cacheKey, cached, timeoutMs) {
  const headers = new Headers();
  const prevEtag = cached?.headers.get('etag');
  if (prevEtag) headers.set('If-None-Match', prevEtag);
  const init = { headers, cache: 'no-store' };
  let timer = null;
  if (timeoutMs > 0 && typeof AbortController !== 'undefined') {
    const ac = new AbortController();
    init.signal = ac.signal;
    timer = setTimeout(() => ac.abort(), timeoutMs);
  }
  try {
    const resp = await fetch(cacheKey, init);
    if (resp && resp.status === 304 && cached) {
      return { resp: cached, updated: false, etag: prevEtag };
    }
    if (resp && resp.status === 200) {
      const nextEtag = resp.headers.get('etag');
      await cache.put(cacheKey, resp.clone());
      const changed = Boolean(cached && nextEtag && prevEtag !== nextEtag);
      return { resp, updated: changed, etag: nextEtag };
    }
    return { resp, updated: false, etag: null };
  } catch {
    return { resp: null, updated: false, etag: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function pruneOlderVersions(cache, pathname, keepKey) {
  try {
    const reqs = await cache.keys();
    for (const r of reqs) {
      const u = new URL(r.url);
      const key = u.pathname + u.search;
      if (u.pathname === pathname && key !== keepKey) {
        await cache.delete(r);
      }
    }
  } catch {}
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !CACHE_PATHS.has(url.pathname)) return;

  const hasVersion = url.searchParams.has('v');
  const cacheKey = hasVersion ? url.pathname + url.search : url.pathname;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(cacheKey);

    if (hasVersion) {
      if (cached) return cached;
      try {
        const resp = await fetch(req);
        if (resp && resp.status === 200) {
          await cache.put(cacheKey, resp.clone());
          event.waitUntil(pruneOlderVersions(cache, url.pathname, cacheKey));
        }
        return resp;
      } catch {
        const fallback = await cache.match(url.pathname);
        return fallback || Response.error();
      }
    }

    const revalidate = (async () => {
      const result = await fetchWithRevalidate(cache, url.pathname, cached, 0);
      if (url.pathname === '/main.js' && result.updated && result.etag) {
        try {
          const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
          for (const client of clients) {
            client.postMessage({
              type: 'AGY_ASSET_UPDATED',
              pathname: url.pathname,
              etag: result.etag,
            });
          }
        } catch {}
      }
      return result.resp;
    })();

    if (cached) {
      event.waitUntil(revalidate);
      return cached;
    }
    const netResp = await revalidate;
    return netResp || Response.error();
  })());
});`;

export function renderSetupHtml(bindIp, port) {
  const origin = `https://${bindIp}:${port}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Antigravity 手机端配置</title>
  <style>
    :root { color-scheme: dark light; }
    body {
      margin: 0;
      padding:
        calc(24px + env(safe-area-inset-top, 0px))
        calc(18px + env(safe-area-inset-right, 0px))
        calc(24px + env(safe-area-inset-bottom, 0px))
        calc(18px + env(safe-area-inset-left, 0px));
      background: #0b0b0f; color: #e4e4e7;
      font: 15px/1.6 system-ui, -apple-system, sans-serif;
      max-width: 560px; margin-inline: auto;
      box-sizing: border-box;
    }
    h1 { font-size: 20px; margin: 0 0 12px; color: #fff; }
    h2 { font-size: 14px; margin: 14px 0 6px; color: #c4c4d4; }
    .card {
      background: #14141c; border: 1px solid #27273a;
      border-radius: 14px; padding: 16px; margin-bottom: 14px;
    }
    a.btn {
      display: inline-block; padding: 11px 16px; border-radius: 10px;
      background: #7aa2f7; color: #0b0b0f; font-weight: 600;
      text-decoration: none; margin-top: 8px; margin-right: 8px;
    }
    a.btn.sec { background: #27273a; color: #e4e4e7; }
    ol { padding-left: 20px; margin: 8px 0 0; }
    li { margin-bottom: 4px; }
    code {
      background: #1e1e2c; padding: 2px 6px; border-radius: 6px;
      font-size: 13px; overflow-wrap: anywhere;
    }
    @media (prefers-color-scheme: light) {
      body { background: #f8fafc; color: #18181b; }
      h1 { color: #09090b; }
      h2 { color: #3f3f46; }
      .card { background: #ffffff; border-color: #e4e4e7; }
      a.btn.sec { background: #e4e4e7; color: #18181b; }
      code { background: #f1f5f9; }
    }
  </style>
</head>
<body>
  <h1>Antigravity EasyTier 手机端指引</h1>
  <div class="card">
    <strong>1. 安装本地根证书（消除浏览器安全警告、启用独立全屏 App）</strong>
    <p>本机中继使用专属私有 CA 签发 <code>${bindIp}</code> 证书。安装并信任根证书后，浏览器与 PWA 才能正常启用 Service Worker 与离线缓存：</p>
    <a class="btn" href="/ca.crt" download="agy-relay-ca.crt">下载 CA 证书 (agy-relay-ca.crt)</a>
    <h2>Android（Chrome / Via）</h2>
    <ol>
      <li>点击上方按钮下载证书文件。</li>
      <li>打开手机 <strong>设置 → 安全与隐私 → 更多安全设置 → 加密与凭据 → 安装证书 → CA 证书</strong>，选择刚下载的文件安装。</li>
      <li>返回浏览器重新打开 <code>${origin}/</code>，并在菜单里选择“添加到主屏幕 / 安装应用”。</li>
    </ol>
    <h2>iOS / iPadOS（Safari）</h2>
    <ol>
      <li>使用 Safari 点击上方按钮下载配置描述文件，弹窗提示时点击<strong>允许</strong>。</li>
      <li>打开 <strong>设置 → 已下载描述文件</strong>（或 <strong>设置 → 通用 → VPN 与设备管理</strong>）安装该 CA 证书。</li>
      <li>打开 <strong>设置 → 通用 → 关于本机 → 证书信任设置（Certificate Trust Settings）</strong>，开启对该根证书的<strong>完全信任</strong>。</li>
      <li>返回 Safari 重新打开 <code>${origin}/</code>，点击分享按钮 → <strong>添加到主屏幕</strong>。</li>
    </ol>
  </div>
  <div class="card">
    <strong>2. 直接进入工作台</strong>
    <p>如果已经在当前设备信任过根证书，可以直接进入：</p>
    <a class="btn sec" href="/">打开 Antigravity</a>
  </div>
</body>
</html>`;
}
