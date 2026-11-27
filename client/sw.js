const CACHE_NAME = 'agy-relay-static-v12';
const APP_SHELL_KEY = '/__agy_app_shell';
const CONVO_IDB_NAME = 'agy-relay-cache-v1';
const CONVO_IDB_STORE = 'snapshots';
const CONVO_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  '/relay-plugin/antigravity-context.js',
]);

function isSpaNavigatePath(pathname) {
  if (pathname === '/' || pathname.startsWith('/c/')) return true;
  if (
    pathname.startsWith('/relay-') ||
    pathname.startsWith('/_relay_local/') ||
    pathname === '/push' ||
    pathname === '/setup' ||
    pathname === '/ca.crt'
  ) {
    return false;
  }
  return !/\.[a-z0-9]+$/i.test(pathname);
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) output[i] = rawData.charCodeAt(i);
  return output;
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()).then(() => {
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(APP_SHELL_KEY).then((hit) => hit || revalidateAppShell(cache, null)),
      ).catch(() => {});
    }),
  );
});

function writeIdbSnapshot(key, data) {
  if (!key || data === undefined || typeof indexedDB === 'undefined' || !indexedDB?.open) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    try {
      const openReq = indexedDB.open(CONVO_IDB_NAME, 1);
      openReq.onupgradeneeded = () => {
        try {
          const db = openReq.result;
          if (!db.objectStoreNames.contains(CONVO_IDB_STORE)) {
            db.createObjectStore(CONVO_IDB_STORE, { keyPath: 'key' });
          }
        } catch {}
      };
      openReq.onerror = () => resolve();
      openReq.onblocked = () => resolve();
      openReq.onsuccess = () => {
        const db = openReq.result;
        try {
          const tx = db.transaction(CONVO_IDB_STORE, 'readwrite');
          const store = tx.objectStore(CONVO_IDB_STORE);
          store.put({ key, data, updatedAt: Date.now() });
          if (key.startsWith('convo:')) {
            const keysReq = store.getAllKeys ? store.getAllKeys() : null;
            if (keysReq) {
              keysReq.onsuccess = () => {
                const convoKeys = (keysReq.result || []).filter((k) => typeof k === 'string' && k.startsWith('convo:'));
                if (convoKeys.length <= 8) return;
                Promise.all(
                  convoKeys.map(
                    (k) =>
                      new Promise((r) => {
                        try {
                          const g = store.get(k);
                          g.onsuccess = () => r(g.result || null);
                          g.onerror = () => r(null);
                        } catch {
                          r(null);
                        }
                      }),
                  ),
                ).then((recs) => {
                  const sorted = recs.filter(Boolean).sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
                  for (let i = 0; i < sorted.length - 8; i++) {
                    try { store.delete(sorted[i].key); } catch {}
                  }
                });
              };
            }
          }
          const finish = () => {
            try { db.close(); } catch {}
            resolve();
          };
          tx.oncomplete = finish;
          tx.onerror = finish;
          tx.onabort = finish;
        } catch {
          try { db.close(); } catch {}
          resolve();
        }
      };
    } catch {
      resolve();
    }
  });
}

async function prewarmNotificationAssets(cascadeId) {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), 4000) : 0;
  const tasks = [
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.match(APP_SHELL_KEY).then((hit) => revalidateAppShell(cache, hit)))
      .catch(() => {}),
  ];
  if (typeof cascadeId === 'string' && CONVO_UUID_RE.test(cascadeId)) {
    tasks.push(
      fetch('/relay-cache/convo/' + encodeURIComponent(cascadeId), {
        credentials: 'same-origin',
        cache: 'no-store',
        ...(ac ? { signal: ac.signal } : {}),
      })
        .then((resp) => (resp && resp.ok ? resp.json() : null))
        .then((json) => (json ? writeIdbSnapshot('convo:' + cascadeId, json) : null))
        .catch(() => {}),
    );
  }
  try {
    await Promise.allSettled(tasks);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      try {
        data = { body: event.data.text() };
      } catch {}
    }
  }
  const title = data.title || 'Antigravity';
  const body = data.body || '有新的任务状态提醒';
  const force = Boolean(data.force);
  const tag = data.tag || 'agy-relay-push';

  event.waitUntil((async () => {
    let skipShow = false;
    if (!force) {
      try {
        const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        skipShow = list.some((c) => c.focused === true);
      } catch {}
    }
    if (!skipShow) {
      await self.registration.showNotification(title, {
        body,
        badge: '/relay-icon-192.png',
        tag,
        renotify: Boolean(data.tag),
        silent: true,
        data: {
          url: data.url || '/',
          cascadeId: data.cascadeId || '',
        },
      });
    }
    await prewarmNotificationAssets(data.cascadeId);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const payload = event.notification?.data || {};
  const targetUrl = new URL(payload.url || '/', self.location.origin).href;

  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const sameOriginClients = clientsList.filter((c) => {
      try {
        return new URL(c.url).origin === self.location.origin;
      } catch {
        return false;
      }
    });
    const isNonSpaPath = (c) => {
      try {
        const p = new URL(c.url).pathname;
        return p === '/push' || p === '/setup';
      } catch {
        return false;
      }
    };
    const client = sameOriginClients.find((c) => !isNonSpaPath(c)) || sameOriginClients[0] || null;
    if (client) {
      if (!isNonSpaPath(client) && payload.cascadeId) {
        try {
          client.postMessage({ type: 'AGY_OPEN_CASCADE', cascadeId: payload.cascadeId, url: targetUrl });
        } catch {}
        try { await client.focus(); } catch {}
        return;
      }
      try { await client.focus(); } catch {}
      if (isNonSpaPath(client)) {
        if (typeof client.navigate === 'function') {
          try { await client.navigate(targetUrl); } catch {}
        }
        return;
      }
      if (client.url !== targetUrl && typeof client.navigate === 'function') {
        try { await client.navigate(targetUrl); } catch {}
      }
      return;
    }
    if (typeof self.clients.openWindow === 'function') {
      if (payload.cascadeId) {
        await Promise.allSettled([self.clients.openWindow(targetUrl), prewarmNotificationAssets(payload.cascadeId)]);
      } else {
        await self.clients.openWindow(targetUrl);
      }
    }
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      let appServerKey = event.oldSubscription?.options?.applicationServerKey || null;
      if (!appServerKey) {
        const resp = await fetch('/relay-push/vapid-public-key', { credentials: 'same-origin', cache: 'no-store' });
        if (!resp.ok) return;
        const json = await resp.json();
        if (!json?.publicKey) return;
        appServerKey = urlBase64ToUint8Array(json.publicKey);
      }
      const nextSub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appServerKey,
      });
      await fetch('/relay-push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: nextSub.toJSON() }),
      });
    } catch {}
  })());
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

self.addEventListener('message', (event) => {
  if (event?.data?.type === 'AGY_INVALIDATE_SHELL') {
    event.waitUntil(
      caches.open(CACHE_NAME).then((cache) => cache.delete(APP_SHELL_KEY)).catch(() => {}),
    );
  }
});

async function revalidateAppShell(cache, prevResp) {
  const resp = await fetch('/', { credentials: 'same-origin', cache: 'no-store' });
  const ct = (resp?.headers?.get('content-type') || '').toLowerCase();
  const nextHash = resp?.headers?.get('x-agy-shell-hash') || '';
  if (resp && resp.status === 200 && ct.includes('text/html') && nextHash) {
    const prevHash = prevResp?.headers?.get('x-agy-shell-hash') || '';
    await cache.put(APP_SHELL_KEY, resp.clone());
    if (prevResp && prevHash && nextHash !== prevHash) {
      try {
        const html = await resp.clone().text();
        const m = /"csrfToken"\s*:\s*"([^"]+)"/.exec(html);
        if (m && m[1]) {
          const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
          for (const client of clients) {
            try {
              if (new URL(client.url).origin === self.location.origin) {
                client.postMessage({ type: 'AGY_CSRF_UPDATED', csrfToken: m[1] });
              }
            } catch {}
          }
        }
      } catch {}
    }
  }
  return resp;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate' && isSpaNavigatePath(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(APP_SHELL_KEY);
      if (cached) {
        event.waitUntil(revalidateAppShell(cache, cached).catch(() => {}));
        return cached;
      }
      try {
        const fresh = await revalidateAppShell(cache, null);
        if (fresh) return fresh;
      } catch {}
      try {
        return await fetch(req);
      } catch {
        return Response.error();
      }
    })());
    return;
  }

  if (!CACHE_PATHS.has(url.pathname)) return;

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
});
