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
  const notifClickListeners = new Set();
  const pendingNotifClicks = [];
  function dispatchCascadeOpen(cascadeId, fallbackUrl) {
    if (cascadeId && notifClickListeners.size > 0) {
      for (const cb of notifClickListeners) {
        try { cb({ cascadeId }); } catch {}
      }
      return true;
    }
    const urlStr = fallbackUrl || (cascadeId ? '/c/' + encodeURIComponent(cascadeId) : '');
    let target = null;
    if (urlStr) {
      try { target = new URL(urlStr, location.origin); } catch {}
    }
    if (cascadeId) {
      const item = { cascadeId, fallbackUrl: urlStr, at: Date.now() };
      pendingNotifClicks.push(item);
      setTimeout(() => {
        const idx = pendingNotifClicks.indexOf(item);
        if (idx === -1) return;
        pendingNotifClicks.splice(idx, 1);
        if (target && target.origin === location.origin && location.pathname !== target.pathname) {
          location.assign(target.pathname + target.search);
        }
      }, 1200);
      return false;
    }
    if (target && target.origin === location.origin && target.pathname !== location.pathname) {
      location.assign(target.pathname + target.search);
    }
    return false;
  }

  if (!window.nativeNotifications) {
    window.nativeNotifications = {
      send: async (opts) => {
        if (!opts?.title || typeof Notification === 'undefined' || Notification.permission !== 'granted') {
          return;
        }
        const body = opts.body || '';
        const cascadeId = opts.payload?.cascadeId || '';
        const tag = cascadeId ? 'agy-finished-' + cascadeId : undefined;
        const notifOpts = {
          body,
          badge: '/relay-icon-192.png',
          silent: true,
          ...(tag ? { tag, renotify: true } : {}),
          data: {
            cascadeId,
            url: cascadeId ? '/c/' + encodeURIComponent(cascadeId) : '/',
          },
        };
        try {
          if (typeof navigator !== 'undefined' && navigator.serviceWorker?.ready) {
            const reg = await Promise.race([
              navigator.serviceWorker.ready,
              new Promise((r) => setTimeout(() => r(null), 250)),
            ]);
            if (reg && typeof reg.showNotification === 'function') {
              await reg.showNotification(opts.title, notifOpts);
              return;
            }
          }
        } catch {}
        try {
          new Notification(opts.title, notifOpts);
        } catch {}
      },
      openSystemPreferences: async () => {
        try {
          const w = window.open('/push', '_blank');
          if (!w) location.href = '/push';
        } catch {
          location.href = '/push';
        }
      },
      onClicked: (cb) => {
        if (typeof cb !== 'function') return () => {};
        notifClickListeners.add(cb);
        if (pendingNotifClicks.length > 0) {
          const items = pendingNotifClicks.splice(0);
          queueMicrotask(() => {
            for (const item of items) {
              try { cb({ cascadeId: item.cascadeId }); } catch {}
            }
          });
        }
        return () => notifClickListeners.delete(cb);
      },
    };
  }
