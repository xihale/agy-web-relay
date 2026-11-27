import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { createFastUsageReader, injectMobileHead, shouldPatchSpaHtml } from './agy-web-relay.mjs';
import { createConvoSnapshotCache } from './lib/convo-snapshot.mjs';
import { MOBILE_CSS, MOBILE_JS, SW_JS } from './mobile-assets.mjs';
import { createWebPushManager } from './web-push.mjs';
import { deflateWsPayload, inflateWsPayload } from './ws-deflate-bridge.mjs';

test('SW_JS and MOBILE_JS parse cleanly', () => {
  assert.doesNotThrow(() => new vm.Script(SW_JS, { filename: 'sw.js' }));
  assert.doesNotThrow(() => new vm.Script(MOBILE_JS, { filename: 'relay-mobile.js' }));
});

test('shouldPatchSpaHtml and injectMobileHead patch / and /c/<uuid> SPA shells', () => {
  const spaHtml =
    '<!doctype html><html><head><script>window.__APP_CONFIG__ = {"csrfToken":"abc"};</script><script src="/main.js"></script></head><body></body></html>';
  assert.equal(shouldPatchSpaHtml('/', spaHtml, false), true);
  assert.equal(shouldPatchSpaHtml('/c/00000000-0000-4000-8000-000000000001', spaHtml, false), true);
  assert.equal(shouldPatchSpaHtml('/c/00000000-0000-4000-8000-000000000001', spaHtml, true), false);
  assert.equal(shouldPatchSpaHtml('/main.js', spaHtml, false), false);
  assert.equal(shouldPatchSpaHtml('/c/foo', '<html><body>Plain page</body></html>', false), false);

  const patched = injectMobileHead(
    spaHtml,
    { '/main.js': 'v123', '/jetbox.css': 'v456', '/compiled_tailwind.css': 'v789' },
    { css: 'body{margin:0}', js: MOBILE_JS },
  );
  assert.ok(patched.includes('data-agy-relay="mobile-js"'));
  assert.ok(patched.includes('/main.js?v=v123'));
  assert.ok(patched.includes('__agyRelayMobileInit'));
});

test('SW_JS notificationclick posts AGY_OPEN_CASCADE to SPA tab, navigates /push tab, and opens window when none', async () => {
  const listeners = new Map();
  const makeSelf = (clientsList) => {
    const opened = [];
    const selfObj = {
      location: { origin: 'https://relay.example:8421' },
      clients: {
        matchAll: async () => clientsList,
        openWindow: async (url) => {
          opened.push(url);
        },
      },
      addEventListener: (type, fn) => listeners.set(type, fn),
    };
    return { selfObj, opened };
  };

  // Case 1: SPA tab + /push tab exist -> prefers SPA tab, uses postMessage, no navigate
  {
    const spaMessages = [];
    let spaNavigated = 0;
    let spaFocused = 0;
    let pushNavigated = 0;
    const spaClient = {
      url: 'https://relay.example:8421/',
      focus: async () => {
        spaFocused++;
      },
      navigate: async () => {
        spaNavigated++;
      },
      postMessage: (msg) => spaMessages.push(msg),
    };
    const pushClient = {
      url: 'https://relay.example:8421/push',
      focus: async () => {},
      navigate: async () => {
        pushNavigated++;
      },
      postMessage: () => {},
    };
    const { selfObj } = makeSelf([pushClient, spaClient]);
    vm.runInNewContext(SW_JS, { self: selfObj, URL, caches: {}, Headers, Response, Request, fetch: async () => {} });
    const handler = listeners.get('notificationclick');
    assert.equal(typeof handler, 'function');

    let waitPromise = null;
    handler({
      notification: {
        close: () => {},
        data: { cascadeId: 'cid-123', url: '/c/cid-123' },
      },
      waitUntil: (p) => {
        waitPromise = p;
      },
    });
    await waitPromise;
    assert.equal(spaFocused, 1);
    assert.equal(spaNavigated, 0);
    assert.equal(pushNavigated, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(spaMessages)), [
      { type: 'AGY_OPEN_CASCADE', cascadeId: 'cid-123', url: 'https://relay.example:8421/c/cid-123' },
    ]);
  }

  // Case 2: Only /push tab exists -> navigates it to targetUrl
  {
    const navigated = [];
    const pushClient = {
      url: 'https://relay.example:8421/push',
      focus: async () => {},
      navigate: async (u) => {
        navigated.push(u);
      },
      postMessage: () => {},
    };
    listeners.clear();
    const { selfObj } = makeSelf([pushClient]);
    vm.runInNewContext(SW_JS, { self: selfObj, URL, caches: {}, Headers, Response, Request, fetch: async () => {} });
    let waitPromise = null;
    listeners.get('notificationclick')({
      notification: { close: () => {}, data: { cascadeId: 'cid-456', url: '/c/cid-456' } },
      waitUntil: (p) => {
        waitPromise = p;
      },
    });
    await waitPromise;
    assert.deepEqual(JSON.parse(JSON.stringify(navigated)), ['https://relay.example:8421/c/cid-456']);
  }

  // Case 3: No window client -> calls openWindow
  {
    listeners.clear();
    const { selfObj, opened } = makeSelf([]);
    vm.runInNewContext(SW_JS, { self: selfObj, URL, caches: {}, Headers, Response, Request, fetch: async () => {} });
    let waitPromise = null;
    listeners.get('notificationclick')({
      notification: { close: () => {}, data: { cascadeId: 'cid-789', url: '/c/cid-789' } },
      waitUntil: (p) => {
        waitPromise = p;
      },
    });
    await waitPromise;
    assert.deepEqual(JSON.parse(JSON.stringify(opened)), ['https://relay.example:8421/c/cid-789']);
  }
});

test('MOBILE_JS nativeNotifications.onClicked handles AGY_OPEN_CASCADE and replays early clicks without reload', async () => {
  const swListeners = new Map();
  let assignedUrls = [];
  const timers = new Set();
  const trackTimeout = (fn, ms, ...args) => {
    const id = setTimeout(fn, ms, ...args);
    timers.add(id);
    return id;
  };
  const trackClearTimeout = (id) => {
    timers.delete(id);
    clearTimeout(id);
  };

  class FakeWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
    }
    send() {}
    close() {
      this.readyState = 3;
    }
  }

  const sandbox = {
    URL,
    Event,
    EventTarget,
    MessageEvent,
    CloseEvent: class CloseEvent extends Event {
      constructor(type, init = {}) {
        super(type);
        this.code = init.code ?? 1000;
        this.reason = init.reason ?? '';
        this.wasClean = init.wasClean ?? true;
      }
    },
    TextDecoder,
    TextEncoder,
    Response,
    setTimeout: trackTimeout,
    clearTimeout: trackClearTimeout,
    queueMicrotask,
    requestAnimationFrame: (fn) => trackTimeout(fn, 0),
    localStorage: {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    navigator: {
      serviceWorker: {
        register: async () => ({}),
        addEventListener: (type, fn) => swListeners.set(type, fn),
        ready: new Promise(() => {}),
      },
    },
    document: {
      readyState: 'complete',
      head: { appendChild: () => {} },
      documentElement: { style: { setProperty: () => {}, removeProperty: () => {} }, appendChild: () => {} },
      createElement: () => ({ setAttribute: () => {}, append: () => {} }),
      addEventListener: () => {},
      querySelector: () => null,
      getElementById: () => null,
      getElementsByTagName: () => [],
      visibilityState: 'visible',
    },
    location: {
      protocol: 'https:',
      host: 'relay.example:8421',
      origin: 'https://relay.example:8421',
      href: 'https://relay.example:8421/',
      pathname: '/',
      search: '',
      assign: (u) => assignedUrls.push(u),
    },
    WebSocket: FakeWebSocket,
    fetch: async () => new Response('{}', { status: 200 }),
    addEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;

  try {
    vm.runInNewContext(MOBILE_JS, sandbox);

    const swMessage = swListeners.get('message');
    assert.equal(typeof swMessage, 'function');

    // Early arrival before main.js registers onClicked
    swMessage({
      data: { type: 'AGY_OPEN_CASCADE', cascadeId: 'early-id', url: 'https://relay.example:8421/c/early-id' },
    });

    const received = [];
    const off = sandbox.nativeNotifications.onClicked((ev) => received.push(ev));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(JSON.parse(JSON.stringify(received)), [{ cascadeId: 'early-id' }]);

    // Live arrival after listener registered
    swMessage({
      data: { type: 'AGY_OPEN_CASCADE', url: 'https://relay.example:8421/c/live-id' },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(received)), [{ cascadeId: 'early-id' }, { cascadeId: 'live-id' }]);
    assert.equal(assignedUrls.length, 0);
    off();
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('MOBILE_JS WebTransportWebSocket transparently falls back to NativeWebSocket when WT rejects before open', async () => {
  const createdNativeSockets = [];
  const timers = new Set();
  const trackTimeout = (fn, ms, ...args) => {
    const id = setTimeout(fn, ms, ...args);
    timers.add(id);
    return id;
  };
  const trackClearTimeout = (id) => {
    timers.delete(id);
    clearTimeout(id);
  };

  class FakeNativeWS extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      createdNativeSockets.push(this);
      trackTimeout(() => {
        this.readyState = 1;
        this.onopen?.(new Event('open'));
        this.dispatchEvent(new Event('open'));
      }, 15);
    }
    send(d) {
      this.sent.push(d);
    }
    close(code = 1000, reason = '') {
      this.readyState = 3;
      this.onclose?.({ code, reason, wasClean: true });
    }
  }

  class FailingWebTransport {
    constructor() {
      this.ready = Promise.reject(new Error('QUIC blocked'));
      this.closed = new Promise(() => {});
    }
    close() {}
  }

  const sandbox = {
    URL,
    Event,
    EventTarget,
    MessageEvent,
    CloseEvent: class CloseEvent extends Event {
      constructor(type, init = {}) {
        super(type);
        this.code = init.code ?? 1000;
        this.reason = init.reason ?? '';
        this.wasClean = init.wasClean ?? true;
      }
    },
    TextDecoder,
    TextEncoder,
    DecompressionStream: class {},
    WebTransport: FailingWebTransport,
    WebSocket: FakeNativeWS,
    Response,
    setTimeout: trackTimeout,
    clearTimeout: trackClearTimeout,
    queueMicrotask,
    localStorage: { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: {},
    document: { readyState: 'loading', addEventListener: () => {} },
    location: {
      protocol: 'https:',
      host: 'relay.example:8421',
      origin: 'https://relay.example:8421',
      href: 'https://relay.example:8421/',
      pathname: '/',
      search: '',
    },
    fetch: async () => new Response(null, { status: 200 }),
    addEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;

  try {
    vm.runInNewContext(MOBILE_JS, sandbox);

    const ws = new sandbox.WebSocket('wss://relay.example:8421/connect-websocket');
    let opens = 0;
    let closes = 0;
    let errors = 0;
    ws.addEventListener('open', () => opens++);
    ws.addEventListener('close', () => closes++);
    ws.addEventListener('error', () => errors++);

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(opens, 1);
    assert.equal(closes, 0);
    assert.equal(errors, 0);
    assert.equal(ws.readyState, 1);
    assert.equal(sandbox.__agyActiveTransport, 'websocket-tcp');
    ws.send('hello');
    assert.equal(createdNativeSockets.at(-1).sent.includes('hello'), true);
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('createFastUsageReader aggregates JSON ledger records matching UsageLedger schema and invalidates modified files', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fast-usage-'));
  const scope = crypto.createHash('sha256').update('test@example.com').digest('hex');
  const scopeDir = path.join(tmpDir, scope);
  fs.mkdirSync(scopeDir, { recursive: true });

  const fileA = path.join(scopeDir, `${'a'.repeat(64)}.json`);
  const fileB = path.join(scopeDir, `${'b'.repeat(64)}.json`);
  const t1 = Date.parse('2026-11-27T01:00:00.000Z');
  const t2 = Date.parse('2026-11-26T01:00:00.000Z');

  fs.writeFileSync(
    fileA,
    JSON.stringify({
      schema: 1,
      account: scope,
      records: [
        { id: '1'.repeat(64), at: t1, model: 'Model A', uncached: 100, cacheRead: 200, cacheWrite: 50, output: 25, partial: false },
        { id: '2'.repeat(64), at: null, model: 'Model B', uncached: 10, cacheRead: 0, cacheWrite: 0, output: 5, partial: true },
      ],
    }),
  );
  fs.writeFileSync(
    fileB,
    JSON.stringify({
      schema: 1,
      account: scope,
      records: [
        { id: '1'.repeat(64), at: t1, model: 'Model A', uncached: 120, cacheRead: 200, cacheWrite: 50, output: 25, partial: false },
        { id: '3'.repeat(64), at: t2, model: 'Model A', uncached: 40, cacheRead: 10, cacheWrite: 0, output: 10, partial: false },
      ],
    }),
  );

  try {
    const reader = createFastUsageReader({ directory: tmpDir, timeZone: 'Asia/Shanghai' });
    const s1 = await reader.summary(scope, t1);
    assert.equal(s1.accountKey, scope);
    assert.equal(s1.today, '2026-11-27');
    assert.equal(s1.requests, 3);
    assert.equal(s1.todayTokens, 395); // deduplicated max for id 1...1
    assert.equal(s1.unknownTokens, 15);
    assert.equal(s1.unknownRequests, 1);
    assert.equal(s1.partialRequests, 1);
    assert.equal(s1.totalTokens, 395 + 60 + 15);
    assert.deepEqual(s1.models, ['Model A', 'Model B']);

    // Modify fileA and forceRefresh
    fs.writeFileSync(
      fileA,
      JSON.stringify({
        schema: 1,
        account: scope,
        records: [
          { id: '1'.repeat(64), at: t1, model: 'Model A', uncached: 100, cacheRead: 200, cacheWrite: 50, output: 25, partial: false },
          { id: '2'.repeat(64), at: null, model: 'Model B', uncached: 10, cacheRead: 0, cacheWrite: 0, output: 5, partial: true },
          { id: '4'.repeat(64), at: t1, model: 'Model B', uncached: 20, cacheRead: 0, cacheWrite: 0, output: 5, partial: false },
        ],
      }),
    );
    const s2 = await reader.summary(scope, t1, { forceRefresh: true });
    assert.equal(s2.requests, 4);
    assert.equal(s2.todayTokens, 420);

    // SQLite presence triggers null fallback
    fs.writeFileSync(path.join(scopeDir, `${'c'.repeat(64)}.sqlite`), '');
    const s3 = await reader.summary(scope, t1, { forceRefresh: true });
    assert.equal(s3, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SW_JS caches SPA App Shell on navigate, revalidates with AGY_CSRF_UPDATED, and caches context plugin', async () => {
  const listeners = new Map();
  const cacheStore = new Map();
  const clientMessages = [];
  let fetchCalls = 0;

  const makeCacheResp = (body, headersObj) => ({
    status: 200,
    headers: new Headers(headersObj),
    clone() {
      return makeCacheResp(body, headersObj);
    },
    text: async () => body,
  });

  const fakeCache = {
    match: async (k) => cacheStore.get(k) || null,
    put: async (k, v) => {
      cacheStore.set(k, v);
    },
    delete: async (k) => cacheStore.delete(k),
    keys: async () => [],
  };

  let shellVersion = 1;
  const selfObj = {
    location: { origin: 'https://relay.example:8421' },
    clients: {
      matchAll: async () => [
        {
          url: 'https://relay.example:8421/c/abc',
          postMessage: (m) => clientMessages.push(m),
        },
      ],
    },
    addEventListener: (type, fn) => listeners.set(type, fn),
  };

  vm.runInNewContext(SW_JS, {
    self: selfObj,
    URL,
    Headers,
    Response,
    Request,
    caches: { open: async () => fakeCache },
    fetch: async (input) => {
      fetchCalls++;
      const urlStr = typeof input === 'string' ? input : input.url;
      if (urlStr === '/') {
        const html = `<html><head><script>window.__APP_CONFIG__={"csrfToken":"tok-${shellVersion}"};</script></head></html>`;
        return makeCacheResp(html, {
          'content-type': 'text/html; charset=utf-8',
          'x-agy-shell-hash': `hash-v${shellVersion}`,
        });
      }
      return makeCacheResp('/* context */', { 'content-type': 'application/javascript', etag: '"ctx-1"' });
    },
  });

  const onFetch = listeners.get('fetch');
  assert.equal(typeof onFetch, 'function');

  // 1. Non-SPA routes (/push, /setup, .js not in CACHE_PATHS) are NOT intercepted
  for (const p of ['/push', '/setup', '/other-bundle.js']) {
    let called = false;
    onFetch({
      request: { method: 'GET', mode: 'navigate', url: `https://relay.example:8421${p}` },
      respondWith: () => {
        called = true;
      },
      waitUntil: () => {},
    });
    assert.equal(called, false, `Expected ${p} not to be intercepted`);
  }

  // 2. Context plugin is in CACHE_PATHS and intercepted
  {
    let respPromise = null;
    const waits = [];
    onFetch({
      request: { method: 'GET', mode: 'no-cors', url: 'https://relay.example:8421/relay-plugin/antigravity-context.js' },
      respondWith: (p) => {
        respPromise = p;
      },
      waitUntil: (p) => waits.push(p),
    });
    assert.ok(respPromise);
    const r = await respPromise;
    assert.equal(r.status, 200);
    await Promise.all(waits);
  }

  // 3. First navigate to /c/<uuid> fetches '/' and populates /__agy_app_shell
  {
    let respPromise = null;
    const waits = [];
    onFetch({
      request: { method: 'GET', mode: 'navigate', url: 'https://relay.example:8421/c/00000000-0000-4000-8000-000000000001' },
      respondWith: (p) => {
        respPromise = p;
      },
      waitUntil: (p) => waits.push(p),
    });
    const r1 = await respPromise;
    assert.equal(r1.headers.get('x-agy-shell-hash'), 'hash-v1');
    await Promise.all(waits);
    assert.ok(cacheStore.has('/__agy_app_shell'));
  }

  // 4. Second navigate returns cached v1 immediately and background revalidation sees v2 -> broadcasts AGY_CSRF_UPDATED
  {
    shellVersion = 2;
    const callsBefore = fetchCalls;
    let respPromise = null;
    const waits = [];
    onFetch({
      request: { method: 'GET', mode: 'navigate', url: 'https://relay.example:8421/c/11111111-1111-1111-1111-111111111111' },
      respondWith: (p) => {
        respPromise = p;
      },
      waitUntil: (p) => waits.push(p),
    });
    const r2 = await respPromise;
    assert.equal(r2.headers.get('x-agy-shell-hash'), 'hash-v1');
    await Promise.all(waits);
    assert.equal(fetchCalls, callsBefore + 1);
    assert.deepEqual(JSON.parse(JSON.stringify(clientMessages)), [{ type: 'AGY_CSRF_UPDATED', csrfToken: 'tok-2' }]);
  }
});

test('MOBILE_JS cold-boot prefetch, 0ms snapshot delivery, AGY_CSRF_UPDATED, and 450ms standby recovery', async () => {
  const swListeners = new Map();
  const docListeners = new Map();
  const timers = new Set();
  const intervals = new Set();
  const trackTimeout = (fn, ms, ...args) => {
    const id = setTimeout(fn, ms, ...args);
    timers.add(id);
    return id;
  };
  const trackClearTimeout = (id) => {
    timers.delete(id);
    clearTimeout(id);
  };
  const trackInterval = (fn, ms, ...args) => {
    const id = setInterval(fn, ms, ...args);
    intervals.add(id);
    return id;
  };
  const trackClearInterval = (id) => {
    intervals.delete(id);
    clearInterval(id);
  };

  const nativeSockets = [];
  class FakeNativeWS extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.autoRespond = true;
      nativeSockets.push(this);
      trackTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.(new Event('open'));
        this.dispatchEvent(new Event('open'));
      }, 5);
    }
    send(raw) {
      this.sent.push(raw);
      if (!this.autoRespond || typeof raw !== 'string') return;
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'start' && String(msg.procedure).includes('StreamAgentStateUpdates')) {
          trackTimeout(() => {
            if (this.readyState !== 1) return;
            const payload = { conversationId: msg.payload?.conversationId, status: 'IDLE', tag: msg.streamId };
            this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ streamId: msg.streamId, type: 'data', payload }) }));
          }, 5);
        }
      } catch {}
    }
    close(code = 1000, reason = '') {
      this.readyState = 3;
      this.onclose?.({ code, reason, wasClean: true });
    }
  }

  let nowOffset = 0;
  class FakeDate extends Date {
    static now() {
      return Date.now() + nowOffset;
    }
  }

  const cid = '00000000-0000-4000-8000-000000000001';
  const lsStore = new Map([['agy_session_csrf_token', 'old-csrf']]);
  const sandbox = {
    Date: FakeDate,
    URL,
    Event,
    EventTarget,
    MessageEvent,
    CloseEvent: class CloseEvent extends Event {
      constructor(type, init = {}) {
        super(type);
        this.code = init.code ?? 1000;
        this.reason = init.reason ?? '';
        this.wasClean = init.wasClean ?? true;
      }
    },
    TextDecoder,
    TextEncoder,
    Response,
    setTimeout: trackTimeout,
    clearTimeout: trackClearTimeout,
    setInterval: trackInterval,
    clearInterval: trackClearInterval,
    queueMicrotask,
    requestAnimationFrame: (fn) => trackTimeout(fn, 0),
    __APP_CONFIG__: { csrfToken: 'boot-csrf' },
    localStorage: {
      length: 0,
      key: () => null,
      getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
      setItem: (k, v) => lsStore.set(k, v),
      removeItem: (k) => lsStore.delete(k),
    },
    navigator: {
      serviceWorker: {
        register: async () => ({}),
        addEventListener: (type, fn) => swListeners.set(type, fn),
        ready: new Promise(() => {}),
      },
    },
    document: {
      readyState: 'complete',
      head: { appendChild: () => {} },
      documentElement: { style: { setProperty: () => {}, removeProperty: () => {} }, appendChild: () => {} },
      createElement: () => ({ setAttribute: () => {}, append: () => {} }),
      addEventListener: (type, fn) => docListeners.set(type, fn),
      querySelector: () => null,
      getElementById: () => null,
      getElementsByTagName: () => [],
      visibilityState: 'visible',
    },
    location: {
      protocol: 'https:',
      host: 'relay.example:8421',
      origin: 'https://relay.example:8421',
      href: `https://relay.example:8421/c/${cid}`,
      pathname: `/c/${cid}`,
      search: '',
      assign: () => {},
    },
    WebSocket: FakeNativeWS,
    fetch: async () => new Response('{}', { status: 200 }),
    addEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;

  try {
    vm.runInNewContext(MOBILE_JS, sandbox);

    // Wait for early socket to open + cold-boot prefetch to complete & cancel
    await new Promise((r) => setTimeout(r, 35));
    const earlyNative = nativeSockets[0];
    assert.ok(earlyNative.sent.some((s) => s.includes('__agy_pre_') && s.includes('StreamAgentStateUpdates')));
    assert.ok(earlyNative.sent.some((s) => s.includes('"type":"cancel"') && s.includes('__agy_pre_')));

    // Claim early socket as main.js would
    const sock = new sandbox.WebSocket('wss://relay.example:8421/connect-websocket');
    const received = [];
    sock.addEventListener('message', (ev) => received.push(JSON.parse(ev.data)));
    await new Promise((r) => setTimeout(r, 5));
    // Ensure prefetch frames were suppressed from main.js
    assert.equal(received.length, 0);

    // Now send real StreamAgentStateUpdates start -> cached snapshot arrives on microtask (0ms)
    earlyNative.autoRespond = false; // prevent server echo so only 0ms cache injection triggers first
    sock.send(
      JSON.stringify({
        streamId: 'real-1',
        type: 'start',
        procedure: '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates',
        stream: true,
        payload: { conversationId: cid },
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(received.length, 1);
    assert.equal(received[0].streamId, 'real-1');
    assert.equal(received[0].payload.conversationId, cid);

    // AGY_CSRF_UPDATED updates __APP_CONFIG__ and localStorage
    swListeners.get('message')({ data: { type: 'AGY_CSRF_UPDATED', csrfToken: 'fresh-csrf-99' } });
    assert.equal(sandbox.__APP_CONFIG__.csrfToken, 'fresh-csrf-99');
    assert.equal(lsStore.get('agy_session_csrf_token'), 'fresh-csrf-99');

    // Simulate background (>8s) -> visible resume with dead socket (no pong) -> hot-swap to open standby & replay streams without closing!
    const visHandler = docListeners.get('visibilitychange');
    assert.equal(typeof visHandler, 'function');
    let closedCount = 0;
    sock.addEventListener('close', () => closedCount++);
    sandbox.document.visibilityState = 'hidden';
    visHandler();
    nowOffset += 10_000;
    sandbox.document.visibilityState = 'visible';
    visHandler();
    assert.ok(earlyNative.sent.some((s) => s.includes('"type":"ping"') && s.includes('__agy_probe_')));
    assert.equal(nativeSockets.length, 2); // standby socket prewarmed in parallel
    await new Promise((r) => setTimeout(r, 260));
    assert.equal(closedCount, 0);
    assert.equal(sock.readyState, 1);
    const hotDonor = nativeSockets[1];
    assert.ok(hotDonor.sent.some((s) => s.includes('"streamId":"real-1"') && s.includes('StreamAgentStateUpdates')));

    // Reply arriving on the swapped donor transport delivers cleanly through sock!
    hotDonor.onmessage(new MessageEvent('message', {
      data: JSON.stringify({ streamId: 'real-1', type: 'data', payload: { conversationId: cid, replayed: true } }),
    }));
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(received.some((m) => m.streamId === 'real-1' && m.payload?.replayed === true));
  } finally {
    for (const id of timers) clearTimeout(id);
    for (const id of intervals) clearInterval(id);
  }
});

test('MOBILE_CSS includes #root:empty instant visual shell', () => {
  assert.ok(MOBILE_CSS.includes('#root:empty'));
  assert.ok(MOBILE_CSS.includes('#root:empty::before'));
  assert.ok(MOBILE_CSS.includes('agy-boot-spin'));
});

test('MOBILE_JS boot prefetch merges JetboxSubscribeToSummaries, adopts live stream, serves GetUserStatus in 0ms, and persists WT cooldown', async () => {
  const timers = new Set();
  const intervals = new Set();
  const trackTimeout = (fn, ms, ...args) => {
    const id = setTimeout(fn, ms, ...args);
    timers.add(id);
    return id;
  };
  const trackClearTimeout = (id) => {
    timers.delete(id);
    clearTimeout(id);
  };
  const trackInterval = (fn, ms, ...args) => {
    const id = setInterval(fn, ms, ...args);
    intervals.add(id);
    return id;
  };
  const trackClearInterval = (id) => {
    intervals.delete(id);
    clearInterval(id);
  };

  const nativeSockets = [];
  class FakeNativeWS extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      nativeSockets.push(this);
      trackTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.(new Event('open'));
        this.dispatchEvent(new Event('open'));
      }, 5);
    }
    send(raw) {
      this.sent.push(raw);
      if (typeof raw !== 'string') return;
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'start' && msg.streamId === '__agy_pre_user') {
          this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ streamId: '__agy_pre_user', type: 'data', payload: { userStatus: { name: 'Tester' } } }) }));
          this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ streamId: '__agy_pre_user', type: 'end', statusCode: 200 }) }));
        } else if (msg.type === 'start' && msg.streamId === '__agy_pre_sum') {
          // Emit 3 multi-frame chunks including an overwrite and a delete
          this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ streamId: '__agy_pre_sum', type: 'data', payload: { updates: { a: { v: 1 }, b: { v: 1 } } } }) }));
          this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ streamId: '__agy_pre_sum', type: 'data', payload: { updates: { a: { v: 2 }, c: { v: 3 } }, deletes: ['b'] } }) }));
        }
      } catch {}
    }
    close(code = 1000, reason = '') {
      this.readyState = 3;
      this.onclose?.({ code, reason, wasClean: true });
    }
  }

  let wtConstructed = 0;
  class FailingWebTransport {
    constructor() {
      wtConstructed++;
      this.ready = Promise.reject(new Error('QUIC blocked'));
      this.closed = new Promise(() => {});
    }
    close() {}
  }

  const lsMap = new Map();
  const makeSandbox = () => {
    const sb = {
      URL,
      Event,
      EventTarget,
      MessageEvent,
      CloseEvent: class CloseEvent extends Event {
        constructor(type, init = {}) {
          super(type);
          this.code = init.code ?? 1000;
          this.reason = init.reason ?? '';
          this.wasClean = init.wasClean ?? true;
        }
      },
      TextDecoder,
      TextEncoder,
      DecompressionStream: class {},
      WebTransport: FailingWebTransport,
      WebSocket: FakeNativeWS,
      Response,
      setTimeout: trackTimeout,
      clearTimeout: trackClearTimeout,
      setInterval: trackInterval,
      clearInterval: trackClearInterval,
      queueMicrotask,
      requestAnimationFrame: (fn) => trackTimeout(fn, 0),
      __APP_CONFIG__: { csrfToken: 'boot-csrf' },
      localStorage: {
        length: 0,
        key: () => null,
        getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
        setItem: (k, v) => lsMap.set(k, String(v)),
        removeItem: (k) => lsMap.delete(k),
      },
      navigator: {},
      document: {
        readyState: 'complete',
        head: { appendChild: () => {} },
        documentElement: { style: { setProperty: () => {}, removeProperty: () => {} }, appendChild: () => {} },
        createElement: () => ({ setAttribute: () => {}, append: () => {} }),
        addEventListener: () => {},
        querySelector: () => null,
        getElementById: () => null,
        getElementsByTagName: () => [],
        visibilityState: 'visible',
      },
      location: {
        protocol: 'https:',
        host: 'relay.example:8421',
        origin: 'https://relay.example:8421',
        href: 'https://relay.example:8421/',
        pathname: '/',
        search: '',
      },
      fetch: async () => new Response('{}', { status: 200 }),
      addEventListener: () => {},
    };
    sb.window = sb;
    sb.top = sb;
    return sb;
  };

  try {
    // Boot 1: WT fails -> persisted in localStorage, fallback WS opens and runs boot prefetches
    const sb1 = makeSandbox();
    vm.runInNewContext(MOBILE_JS, sb1);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(wtConstructed, 1);
    assert.ok(Number(lsMap.get('agy_relay_wt_fail_until')) > Date.now());

    const rawSock = nativeSockets[0];
    assert.ok(rawSock.sent.some((s) => s.includes('__agy_pre_user') && s.includes('GetUserStatus')));
    assert.ok(rawSock.sent.some((s) => s.includes('__agy_pre_sum') && s.includes('JetboxSubscribeToSummaries')));

    const sock = new sb1.WebSocket('wss://relay.example:8421/connect-websocket');
    const msgs = [];
    sock.addEventListener('message', (ev) => msgs.push(JSON.parse(ev.data)));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(msgs.length, 0); // Prefetch frames suppressed before adoption

    const sentBeforeAdopt = rawSock.sent.length;
    // 1. GetUserStatus -> 0ms cached hit, no network send
    sock.send(JSON.stringify({ streamId: 'real-u', type: 'start', procedure: '/exa.language_server_pb.LanguageServerService/GetUserStatus', stream: false, payload: {} }));
    // 2. JetboxSubscribeToSummaries({}) -> adopted, 1 merged frame delivered, no duplicate start
    sock.send(JSON.stringify({ streamId: 'real-sum', type: 'start', procedure: '/exa.language_server_pb.LanguageServerService/JetboxSubscribeToSummaries', stream: true, payload: {} }));
    // 3. JetboxSubscribeToSummaries({ backend: 2 }) -> NOT adopted, sent normally
    sock.send(JSON.stringify({ streamId: 'real-sum-b2', type: 'start', procedure: '/exa.language_server_pb.LanguageServerService/JetboxSubscribeToSummaries', stream: true, payload: { backend: 2 } }));

    await new Promise((r) => setTimeout(r, 10));
    assert.equal(rawSock.sent.length, sentBeforeAdopt + 1);
    assert.ok(rawSock.sent.at(-1).includes('real-sum-b2'));

    const userData = msgs.find((m) => m.streamId === 'real-u' && m.type === 'data');
    const userEnd = msgs.find((m) => m.streamId === 'real-u' && m.type === 'end');
    assert.deepEqual(JSON.parse(JSON.stringify(userData.payload)), { userStatus: { name: 'Tester' } });
    assert.equal(userEnd.statusCode, 200);

    const sumFrames = msgs.filter((m) => m.streamId === 'real-sum' && m.type === 'data');
    assert.equal(sumFrames.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(sumFrames[0].payload)), {
      updates: { a: { v: 2 }, c: { v: 3 } },
      deletes: ['b'],
    });

    // Live incremental update arrives on __agy_pre_sum -> rewritten to real-sum
    rawSock.onmessage(new MessageEvent('message', { data: JSON.stringify({ streamId: '__agy_pre_sum', type: 'data', payload: { updates: { d: { v: 4 } } } }) }));
    const liveRewritten = msgs.find((m) => m.streamId === 'real-sum' && m.payload?.updates?.d);
    assert.equal(liveRewritten.payload.updates.d.v, 4);

    // Cancel real-sum -> rewritten back to __agy_pre_sum on wire
    sock.send(JSON.stringify({ streamId: 'real-sum', type: 'cancel' }));
    assert.ok(rawSock.sent.at(-1).includes('"streamId":"__agy_pre_sum"') && rawSock.sent.at(-1).includes('"type":"cancel"'));

    // Boot 2: WT cooldown persisted -> skips WebTransport immediately (wtConstructed stays 1)
    const sb2 = makeSandbox();
    vm.runInNewContext(MOBILE_JS, sb2);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(wtConstructed, 1);
    assert.equal(sb2.__agyWtDisabled, true);
  } finally {
    for (const id of timers) clearTimeout(id);
    for (const id of intervals) clearInterval(id);
  }
});

test('modular entrypoints re-export all public APIs', async () => {
  const relayMod = await import('./agy-web-relay.mjs');
  const expectedRelayExports = [
    'buildH2UpstreamHeaders',
    'createAuth',
    'createFastUsageReader',
    'createStaticAssetEntry',
    'etagVersionTag',
    'injectCsrfToken',
    'injectMobileHead',
    'matchesIfNoneMatch',
    'parseArgs',
    'parseLocalProxyTarget',
    'pickEncoding',
    'printHelp',
    'rewriteLocalHtml',
    'shouldPatchSpaHtml',
  ];
  for (const name of expectedRelayExports) {
    assert.equal(typeof relayMod[name], 'function', `Missing export ${name} on agy-web-relay.mjs`);
  }

  const assetsMod = await import('./mobile-assets.mjs');
  for (const name of ['MANIFEST_JSON', 'MOBILE_CSS', 'MOBILE_JS', 'SW_JS']) {
    assert.equal(typeof assetsMod[name], 'string', `Missing string export ${name} on mobile-assets.mjs`);
    assert.ok(assetsMod[name].length > 0, `Empty export ${name}`);
  }
  for (const name of ['ICON_192', 'ICON_512']) {
    assert.ok(Buffer.isBuffer(assetsMod[name]), `Missing Buffer export ${name}`);
  }
  for (const name of ['renderSetupHtml', 'renderPushHtml']) {
    assert.equal(typeof assetsMod[name], 'function', `Missing function export ${name}`);
  }
});

test('IndexedDB cold-start cache hydrates boot & convo streams immediately and handles compaction/eviction', async () => {
  const timers = new Set();
  const intervals = new Set();
  const trackTimeout = (fn, ms = 0, ...args) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn(...args);
    }, ms);
    timers.add(id);
    return id;
  };
  const trackClearTimeout = (id) => {
    timers.delete(id);
    clearTimeout(id);
  };
  const trackInterval = (fn, ms = 0, ...args) => {
    const id = setInterval(fn, ms, ...args);
    intervals.add(id);
    return id;
  };
  const trackClearInterval = (id) => {
    intervals.delete(id);
    clearInterval(id);
  };

  function createMockIndexedDB(initialRecords = []) {
    const stores = new Map();
    const snapMap = new Map(initialRecords.map((r) => [r.key, r]));
    stores.set('snapshots', snapMap);
    const reqWrap = (run) => {
      const req = { result: undefined, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      queueMicrotask(() => run(req));
      return req;
    };
    const db = {
      objectStoreNames: { contains: (name) => stores.has(name) },
      createObjectStore: (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return {};
      },
      close: () => {},
      transaction: (name) => {
        const map = stores.get(name) || new Map();
        const tx = { oncomplete: null, onerror: null, onabort: null };
        const store = {
          get: (k) => reqWrap((req) => { req.result = map.get(k); req.onsuccess?.(); }),
          put: (v) => reqWrap((req) => { map.set(v.key, v); req.result = v.key; req.onsuccess?.(); }),
          delete: (k) => reqWrap((req) => { map.delete(k); req.onsuccess?.(); }),
          getAllKeys: () => reqWrap((req) => { req.result = Array.from(map.keys()); req.onsuccess?.(); }),
          getAll: () => reqWrap((req) => { req.result = Array.from(map.values()); req.onsuccess?.(); }),
        };
        tx.objectStore = () => store;
        trackTimeout(() => tx.oncomplete?.(), 5);
        return tx;
      },
    };
    return {
      stores,
      indexedDB: {
        open: () => reqWrap((req) => {
          req.result = db;
          req.onupgradeneeded?.();
          req.onsuccess?.();
        }),
      },
    };
  }

  class SilentFakeWS extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      trackTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.(new Event('open'));
        this.dispatchEvent(new Event('open'));
      }, 2);
    }
    send(raw) {
      this.sent.push(raw);
    }
    close() {
      this.readyState = 3;
    }
  }

  try {
    // 1. Unit check on client/idb-cache.js directly: compactSummaries & max-8 convo eviction & graceful fallback
    const idbSrc = fs.readFileSync(path.join(import.meta.dirname, 'client/idb-cache.js'), 'utf8');
    const mock1 = createMockIndexedDB();
    const idbSandbox = {
      indexedDB: mock1.indexedDB,
      setTimeout: trackTimeout,
      clearTimeout: trackClearTimeout,
      Date,
      Map,
      Set,
      Promise,
    };
    const cache = vm.runInNewContext(`${idbSrc}; agyIdbCache;`, idbSandbox);

    const manyUpdates = {};
    for (let i = 0; i < 180; i++) {
      manyUpdates[`s-${i}`] = {
        notFullyIdle: i === 5 || i === 12,
        waitingSteps: i === 25 ? [{ id: 'w1' }] : [],
        lastModifiedTime: `2026-11-${String(1 + (i % 28)).padStart(2, '0')}T${String(Math.floor(i / 28)).padStart(2, '0')}:00:00Z`,
      };
    }
    const compacted = cache.compactSummaries(manyUpdates, 150);
    assert.equal(Object.keys(compacted.updates).length, 150);
    assert.ok(compacted.updates['s-5'] && compacted.updates['s-12'] && compacted.updates['s-25']);

    for (let i = 1; i <= 10; i++) {
      cache.putDebounced(`convo:c-${i}`, { cascadeId: `c-${i}`, n: i }, 0);
      await new Promise((r) => setTimeout(r, 12));
    }
    const snapMap = mock1.stores.get('snapshots');
    const remainingConvos = Array.from(snapMap.keys()).filter((k) => k.startsWith('convo:'));
    assert.ok(remainingConvos.length <= 8, `Expected <=8 cached convos, got ${remainingConvos.length}`);
    assert.ok(snapMap.has('convo:c-10'));

    // 2. Full MOBILE_JS boot hydration test with pre-populated IDB and a silent server
    const bootCid = '00000000-0000-4000-8000-000000000001';
    const secondCid = '11111111-1111-1111-1111-111111111111';
    const now = Date.now();
    const mock2 = createMockIndexedDB([
      { key: 'boot:userStatus', data: { userStatus: { name: 'IDBUser' } }, updatedAt: now },
      { key: 'boot:summaries', data: { updates: { [bootCid]: { title: 'Cached Title' } } }, updatedAt: now },
      { key: `convo:${bootCid}`, data: { cascadeId: bootCid, steps: [{ id: 'step-cached' }] }, updatedAt: now },
      { key: `convo:${secondCid}`, data: { cascadeId: secondCid, steps: [{ id: 'step-async' }] }, updatedAt: now },
    ]);

    let sockRef = null;
    class CapturingSilentWS extends SilentFakeWS {
      constructor(url) {
        super(url);
        sockRef = this;
      }
    }

    const lsMap = new Map();
    const makeBootSandbox = (idbImpl) => {
      const sb = {
        URL,
        Event,
        EventTarget,
        MessageEvent,
        CloseEvent: class CloseEvent extends Event {
          constructor(type, init = {}) {
            super(type);
            this.code = init.code ?? 1000;
          }
        },
        TextDecoder,
        TextEncoder,
        DecompressionStream: class {},
        WebSocket: CapturingSilentWS,
        Response,
        indexedDB: idbImpl,
        setTimeout: trackTimeout,
        clearTimeout: trackClearTimeout,
        setInterval: trackInterval,
        clearInterval: trackClearInterval,
        queueMicrotask,
        requestAnimationFrame: (fn) => trackTimeout(fn, 0),
        __APP_CONFIG__: { csrfToken: 'boot-csrf' },
        localStorage: {
          length: 0,
          key: () => null,
          getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
          setItem: (k, v) => lsMap.set(k, String(v)),
          removeItem: (k) => lsMap.delete(k),
        },
        navigator: {},
        document: {
          readyState: 'complete',
          head: { appendChild: () => {} },
          documentElement: { style: { setProperty: () => {}, removeProperty: () => {} }, appendChild: () => {} },
          createElement: () => ({ setAttribute: () => {}, append: () => {} }),
          addEventListener: () => {},
          querySelector: () => null,
          getElementById: () => null,
          getElementsByTagName: () => [],
          visibilityState: 'visible',
        },
        location: {
          protocol: 'https:',
          host: 'relay.example:8421',
          origin: 'https://relay.example:8421',
          href: `https://relay.example:8421/c/${bootCid}`,
          pathname: `/c/${bootCid}`,
          search: '',
        },
        fetch: async () => new Response('{}', { status: 200 }),
        addEventListener: () => {},
      };
      sb.window = sb;
      sb.top = sb;
      return sb;
    };

    const sb = makeBootSandbox(mock2.indexedDB);
    vm.runInNewContext(MOBILE_JS, sb);
    await new Promise((r) => setTimeout(r, 25));

    const sock = new sb.WebSocket('wss://relay.example:8421/connect-websocket');
    const msgs = [];
    sock.addEventListener('message', (ev) => msgs.push(JSON.parse(ev.data)));

    sock.send(JSON.stringify({ streamId: 'u1', type: 'start', procedure: '/exa.language_server_pb.LanguageServerService/GetUserStatus', stream: false, payload: {} }));
    sock.send(JSON.stringify({ streamId: 's1', type: 'start', procedure: '/exa.language_server_pb.LanguageServerService/JetboxSubscribeToSummaries', stream: true, payload: {} }));
    sock.send(JSON.stringify({ streamId: 'c1', type: 'start', procedure: '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates', stream: true, payload: { conversationId: bootCid } }));
    sock.send(JSON.stringify({ streamId: 'c2', type: 'start', procedure: '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates', stream: true, payload: { conversationId: secondCid } }));

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(msgs.find((m) => m.streamId === 'u1' && m.type === 'data')?.payload?.userStatus?.name, 'IDBUser');
    assert.equal(msgs.find((m) => m.streamId === 's1' && m.type === 'data')?.payload?.updates?.[bootCid]?.title, 'Cached Title');
    assert.equal(msgs.find((m) => m.streamId === 'c1' && m.type === 'data')?.payload?.steps?.[0]?.id, 'step-cached');
    assert.equal(msgs.find((m) => m.streamId === 'c2' && m.type === 'data')?.payload?.steps?.[0]?.id, 'step-async');

    // Fresh server response updates IDB via putDebounced
    sockRef.onmessage(new MessageEvent('message', {
      data: JSON.stringify({
        streamId: 'c1',
        type: 'data',
        payload: { cascadeId: bootCid, steps: [{ id: 'step-fresh' }] },
      }),
    }));
    await new Promise((r) => setTimeout(r, 310));
    assert.equal(mock2.stores.get('snapshots').get(`convo:${bootCid}`)?.data?.steps?.[0]?.id, 'step-fresh');

    // 3. Missing / throwing indexedDB degrades gracefully without error
    assert.doesNotThrow(() => vm.runInNewContext(MOBILE_JS, makeBootSandbox(undefined)));
    assert.doesNotThrow(() => vm.runInNewContext(MOBILE_JS, makeBootSandbox({ open: () => { throw new Error('IDB blocked'); } })));
  } finally {
    for (const id of timers) clearTimeout(id);
    for (const id of intervals) clearInterval(id);
  }
});

test('createConvoSnapshotCache extracts first Connect-JSON frame, aborts stream, and coalesces/caches hits', async () => {
  let reqCount = 0;
  let openStreams = 0;
  const server = http.createServer((req, res) => {
    reqCount++;
    openStreams++;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/connect+json' });
    const payload = Buffer.from(
      JSON.stringify({ cascadeId: '00000000-0000-4000-8000-000000000001', steps: [{ id: 'first-frame' }] }),
      'utf8',
    );
    const frame = Buffer.alloc(5 + payload.length);
    frame[0] = 0;
    frame.writeUInt32BE(payload.length, 1);
    payload.copy(frame, 5);
    res.write(frame);
    req.on('close', () => {
      openStreams--;
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const snapCache = createConvoSnapshotCache({
      getTargetInfo: async () => ({ port: port + 1, httpPort: port, csrfToken: 'snap-csrf' }),
    });
    const cid = '00000000-0000-4000-8000-000000000001';
    const [b1, b2] = await Promise.all([snapCache.getSnapshot(cid), snapCache.getSnapshot(cid)]);
    assert.equal(reqCount, 1);
    assert.equal(JSON.parse(b1.toString('utf8')).steps[0].id, 'first-frame');
    assert.equal(b1.toString('utf8'), b2.toString('utf8'));
    const b3 = await snapCache.getSnapshot(cid);
    assert.equal(reqCount, 1);
    assert.equal(b3.toString('utf8'), b1.toString('utf8'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(openStreams, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('SW_JS push pre-warms convo snapshot into IndexedDB and notificationclick posts AGY_OPEN_CASCADE before focus', async () => {
  const listeners = new Map();
  const storeMap = new Map();
  const idbData = new Map();
  const eventsOrder = [];
  const notifCalls = [];
  const postedMsgs = [];
  let fetchedConvoUrl = '';

  const reqWrap = (run) => {
    const req = { result: undefined, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
    queueMicrotask(() => run(req));
    return req;
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({}),
    close: () => {},
    transaction: () => {
      const tx = { oncomplete: null, onerror: null, onabort: null };
      const store = {
        get: (k) => reqWrap((req) => { req.result = idbData.get(k); req.onsuccess?.(); }),
        put: (v) => reqWrap((req) => { idbData.set(v.key, v); req.result = v.key; req.onsuccess?.(); }),
        delete: (k) => reqWrap((req) => { idbData.delete(k); req.onsuccess?.(); }),
        getAllKeys: () => reqWrap((req) => { req.result = Array.from(idbData.keys()); req.onsuccess?.(); }),
      };
      tx.objectStore = () => store;
      setTimeout(() => tx.oncomplete?.(), 2);
      return tx;
    },
  };

  const sandbox = {
    URL,
    Headers,
    Response,
    AbortController,
    setTimeout,
    clearTimeout,
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    indexedDB: { open: () => reqWrap((req) => { req.result = db; req.onsuccess?.(); }) },
    caches: {
      keys: async () => ['agy-relay-static-v12'],
      open: async () => ({
        match: async (k) => storeMap.get(String(k)) || null,
        put: async (k, resp) => { storeMap.set(String(k), resp); },
      }),
    },
    fetch: async (input) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.startsWith('/relay-cache/convo/')) {
        fetchedConvoUrl = u;
        return new Response(JSON.stringify({ cascadeId: '00000000-0000-4000-8000-000000000001', steps: [{ id: 'prewarmed' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('<html><script>window.__APP_CONFIG__={"csrfToken":"sw-csrf"};</script></html>', {
        status: 200,
        headers: { 'content-type': 'text/html', 'x-agy-shell-hash': 'h1' },
      });
    },
    self: null,
  };

  const cid = '00000000-0000-4000-8000-000000000001';
  const client = {
    url: 'https://relay.example:8421/',
    focused: false,
    postMessage: (msg) => {
      eventsOrder.push('postMessage');
      postedMsgs.push(msg);
    },
    focus: async () => {
      await new Promise((r) => setTimeout(r, 25));
      eventsOrder.push('focusResolved');
    },
  };
  sandbox.self = {
    location: { origin: 'https://relay.example:8421' },
    registration: {
      showNotification: async (title, opts) => {
        notifCalls.push({ title, opts });
      },
    },
    clients: {
      claim: async () => {},
      matchAll: async () => [client],
    },
    skipWaiting: async () => {},
    addEventListener: (type, fn) => listeners.set(type, fn),
  };

  vm.runInNewContext(SW_JS, sandbox);

  let waitPromise = Promise.resolve();
  listeners.get('push')({
    data: { json: () => ({ title: 'Antigravity', body: 'Done', cascadeId: cid, url: `/c/${cid}`, force: true }) },
    waitUntil: (p) => { waitPromise = p; },
  });
  await waitPromise;
  assert.equal(notifCalls.length, 1);
  assert.equal(fetchedConvoUrl, `/relay-cache/convo/${cid}`);
  assert.equal(idbData.get(`convo:${cid}`)?.data?.steps?.[0]?.id, 'prewarmed');
  assert.ok(storeMap.has('/__agy_app_shell'));

  let clickWait = Promise.resolve();
  listeners.get('notificationclick')({
    notification: { close: () => {}, data: { cascadeId: cid, url: `/c/${cid}` } },
    waitUntil: (p) => { clickWait = p; },
  });
  await clickWait;
  assert.deepEqual(eventsOrder, ['postMessage', 'focusResolved']);
  assert.equal(postedMsgs[0].type, 'AGY_OPEN_CASCADE');
  assert.equal(postedMsgs[0].cascadeId, cid);
});

test('MOBILE_JS /c/<uuid> prioritizes StreamAgentStateUpdates, adopts convo prefetch, and recovers via AGY_OPEN_CASCADE', async () => {
  const timers = new Set();
  const intervals = new Set();
  const trackTimeout = (fn, ms = 0, ...args) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn(...args);
    }, ms);
    timers.add(id);
    return id;
  };
  const trackClearTimeout = (id) => {
    timers.delete(id);
    clearTimeout(id);
  };
  const trackInterval = (fn, ms = 0, ...args) => {
    const id = setInterval(fn, ms, ...args);
    intervals.add(id);
    return id;
  };
  const trackClearInterval = (id) => {
    intervals.delete(id);
    clearInterval(id);
  };

  const cid = '00000000-0000-4000-8000-000000000001';
  const idbData = new Map([
    [`convo:${cid}`, { key: `convo:${cid}`, data: { cascadeId: cid, steps: [{ id: 'old-idb' }] }, updatedAt: Date.now() }],
  ]);
  const reqWrap = (run) => {
    const req = { result: undefined, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
    queueMicrotask(() => run(req));
    return req;
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({}),
    close: () => {},
    transaction: () => {
      const tx = { oncomplete: null, onerror: null, onabort: null };
      const store = {
        get: (k) => reqWrap((req) => { req.result = idbData.get(k); req.onsuccess?.(); }),
        put: (v) => reqWrap((req) => { idbData.set(v.key, v); req.result = v.key; req.onsuccess?.(); }),
        delete: (k) => reqWrap((req) => { idbData.delete(k); req.onsuccess?.(); }),
        getAllKeys: () => reqWrap((req) => { req.result = Array.from(idbData.keys()); req.onsuccess?.(); }),
      };
      tx.objectStore = () => store;
      trackTimeout(() => tx.oncomplete?.(), 2);
      return tx;
    },
  };

  const sockets = [];
  class OrderedWS extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
      trackTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.(new Event('open'));
        this.dispatchEvent(new Event('open'));
      }, 2);
    }
    send(raw) {
      this.sent.push(raw);
    }
    close(code = 1000, reason = '') {
      this.readyState = 3;
      this.onclose?.({ code, reason, wasClean: true });
    }
  }

  let swMsgListener = null;
  const lsMap = new Map();
  const sandbox = {
    URL,
    Event,
    EventTarget,
    MessageEvent,
    CloseEvent: class CloseEvent extends Event {
      constructor(type, init = {}) {
        super(type);
        this.code = init.code ?? 1000;
      }
    },
    TextDecoder,
    TextEncoder,
    DecompressionStream: class {},
    WebSocket: OrderedWS,
    Response,
    indexedDB: { open: () => reqWrap((req) => { req.result = db; req.onsuccess?.(); }) },
    setTimeout: trackTimeout,
    clearTimeout: trackClearTimeout,
    setInterval: trackInterval,
    clearInterval: trackClearInterval,
    queueMicrotask,
    requestAnimationFrame: (fn) => trackTimeout(fn, 0),
    __APP_CONFIG__: { csrfToken: 'boot-csrf' },
    localStorage: {
      length: 0,
      key: () => null,
      getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
      setItem: (k, v) => lsMap.set(k, String(v)),
      removeItem: (k) => lsMap.delete(k),
    },
    navigator: {
      serviceWorker: {
        register: async () => ({}),
        addEventListener: (type, fn) => { if (type === 'message') swMsgListener = fn; },
      },
    },
    document: {
      readyState: 'complete',
      head: { appendChild: () => {} },
      documentElement: { style: { setProperty: () => {}, removeProperty: () => {} }, appendChild: () => {} },
      createElement: () => ({ setAttribute: () => {}, append: () => {} }),
      addEventListener: () => {},
      querySelector: () => null,
      getElementById: () => null,
      getElementsByTagName: () => [],
      visibilityState: 'visible',
    },
    location: {
      protocol: 'https:',
      host: 'relay.example:8421',
      origin: 'https://relay.example:8421',
      href: `https://relay.example:8421/c/${cid}`,
      pathname: `/c/${cid}`,
      search: '',
    },
    fetch: async () => new Response('{}', { status: 200 }),
    addEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;

  try {
    vm.runInNewContext(MOBILE_JS, sandbox);
    await new Promise((r) => setTimeout(r, 15));

    const earlyRaw = sockets[0];
    const startTypes = earlyRaw.sent.map((s) => JSON.parse(s).procedure);
    const convoIdx = startTypes.indexOf('/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates');
    assert.ok(convoIdx >= 0, 'Expected boot convo prefetch');
    assert.equal(startTypes.indexOf('/exa.language_server_pb.LanguageServerService/JetboxSubscribeToSummaries'), -1);

    // Adopt in-flight convo prefetch without duplicate wire RPC
    const sock = new sandbox.WebSocket('wss://relay.example:8421/connect-websocket');
    const msgs = [];
    sock.addEventListener('message', (ev) => msgs.push(JSON.parse(ev.data)));
    const sentBefore = earlyRaw.sent.length;
    sock.send(JSON.stringify({
      streamId: 'real-c1',
      type: 'start',
      procedure: '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates',
      stream: true,
      payload: { conversationId: cid, initialStepsPageBounds: { startIndex: -50 } },
    }));
    assert.equal(earlyRaw.sent.length, sentBefore);

    // Prefetch frame arrives -> rewritten to real-c1 AND flushes deferred JetboxSubscribeToSummaries
    earlyRaw.onmessage(new MessageEvent('message', {
      data: JSON.stringify({ streamId: '__agy_pre_1', type: 'data', payload: { cascadeId: cid, steps: [{ id: 'live-1' }] } }),
    }));
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(msgs.some((m) => m.streamId === 'real-c1' && m.payload?.steps?.[0]?.id === 'old-idb'));
    assert.ok(msgs.some((m) => m.streamId === 'real-c1' && m.payload?.steps?.[0]?.id === 'live-1'));
    assert.ok(earlyRaw.sent.some((s) => s.includes('JetboxSubscribeToSummaries')));

    // Close active socket, simulate SW updating IDB while in background, then trigger AGY_OPEN_CASCADE
    sock.close();
    idbData.set(`convo:${cid}`, {
      key: `convo:${cid}`,
      data: { cascadeId: cid, steps: [{ id: 'fresh-from-sw' }] },
      updatedAt: Date.now() + 50,
    });
    const socketsBeforeNotif = sockets.length;
    swMsgListener?.({ data: { type: 'AGY_OPEN_CASCADE', cascadeId: cid, url: `/c/${cid}` } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sockets.length, socketsBeforeNotif + 1, 'Expected standby socket prewarmed even when active closed');

    const standbyWrap = new sandbox.WebSocket('wss://relay.example:8421/connect-websocket');
    const standbyMsgs = [];
    standbyWrap.addEventListener('message', (ev) => standbyMsgs.push(JSON.parse(ev.data)));
    standbyWrap.send(JSON.stringify({
      streamId: 'real-c2',
      type: 'start',
      procedure: '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates',
      stream: true,
      payload: { conversationId: cid },
    }));
    await new Promise((r) => setTimeout(r, 15));
    assert.ok(
      standbyMsgs.some((m) => m.streamId === 'real-c2' && m.payload?.steps?.[0]?.id === 'fresh-from-sw'),
      'Expected fresh SW IDB snapshot to override stale memory cache',
    );
  } finally {
    for (const id of timers) clearTimeout(id);
    for (const id of intervals) clearInterval(id);
  }
});

test('injectMobileHead places inline mobile script before blocking stylesheets', () => {
  const html =
    '<!doctype html><html><head><script>window.__APP_CONFIG__ = {"csrfToken":"abc"};</script>' +
    '<link rel="stylesheet" href="/jetbox.css" /><script src="/main.js"></script></head><body></body></html>';
  const patched = injectMobileHead(html, { '/jetbox.css': 'v1', '/main.js': 'v2' }, { css: 'body{}', js: 'console.log(1);' });
  const cfgIdx = patched.indexOf('window.__APP_CONFIG__');
  const mobileIdx = patched.indexOf('<script data-agy-relay="mobile-js">');
  const cssLinkIdx = patched.indexOf('<link rel="stylesheet" href="/jetbox.css?v=v1"');
  assert.ok(cfgIdx > 0 && mobileIdx > cfgIdx, 'mobile-js should appear after __APP_CONFIG__');
  assert.ok(cssLinkIdx > mobileIdx, 'mobile-js should appear before blocking jetbox.css stylesheet');
});

test('ws-deflate-bridge pooled deflateWsPayload and inflateWsPayload roundtrip concurrently across sizes', async () => {
  const smallA = Buffer.from(JSON.stringify({ msg: 'hello-small', seq: 1 }), 'utf8');
  const smallB = Buffer.from(JSON.stringify({ msg: 'hello-small-2', seq: 2 }), 'utf8');
  const largeA = Buffer.from(JSON.stringify({ big: 'x'.repeat(72 * 1024), list: Array.from({ length: 200 }, (_, i) => i) }), 'utf8');
  const largeB = Buffer.from(JSON.stringify({ big: 'y'.repeat(70 * 1024), tag: 'concurrent' }), 'utf8');

  const [c1, c2, c3, c4] = await Promise.all([
    deflateWsPayload(smallA, 3),
    deflateWsPayload(largeA, 4),
    deflateWsPayload(smallB, 3),
    deflateWsPayload(largeB, 4),
  ]);
  const [d1, d2, d3, d4] = await Promise.all([
    inflateWsPayload(c1),
    inflateWsPayload(c2),
    inflateWsPayload(c3),
    inflateWsPayload(c4),
  ]);
  assert.equal(d1.toString('utf8'), smallA.toString('utf8'));
  assert.equal(d2.toString('utf8'), largeA.toString('utf8'));
  assert.equal(d3.toString('utf8'), smallB.toString('utf8'));
  assert.equal(d4.toString('utf8'), largeB.toString('utf8'));
});

test('MOBILE_JS progressively chunks large summary snapshots without losing or clobbering updates', async () => {
  const timers = new Set();
  const intervals = new Set();
  const trackTimeout = (fn, ms = 0, ...args) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn(...args);
    }, ms);
    timers.add(id);
    return id;
  };
  const trackClearTimeout = (id) => {
    timers.delete(id);
    clearTimeout(id);
  };
  const trackInterval = (fn, ms = 0, ...args) => {
    const id = setInterval(fn, ms, ...args);
    intervals.add(id);
    return id;
  };
  const trackClearInterval = (id) => {
    intervals.delete(id);
    clearInterval(id);
  };

  const cid = '00000000-0000-4000-8000-000000000001';
  const bigUpdates = {};
  bigUpdates[cid] = { summary: 'boot-convo', lastModifiedTime: '2026-01-01T00:00:00Z' };
  bigUpdates['active-1'] = { summary: 'active-item', notFullyIdle: true, lastModifiedTime: '2026-01-02T00:00:00Z' };
  bigUpdates['sub-boot'] = { summary: 'child', trajectoryMetadata: { parentConversationId: cid }, lastModifiedTime: '2026-01-03T00:00:00Z' };
  for (let i = 0; i < 317; i++) {
    bigUpdates[`old-${i}`] = {
      summary: `sum-${i}`,
      lastModifiedTime: `2026-02-${String(1 + (i % 28)).padStart(2, '0')}T${String(Math.floor(i / 28)).padStart(2, '0')}:00:00Z`,
    };
  }

  let rawSockRef = null;
  class ChunkTestWS extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      rawSockRef = this;
      trackTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.(new Event('open'));
        this.dispatchEvent(new Event('open'));
      }, 2);
    }
    send(raw) {
      this.sent.push(raw);
      if (typeof raw === 'string' && raw.includes('"__agy_pre_sum"')) {
        this.onmessage?.(new MessageEvent('message', {
          data: JSON.stringify({ streamId: '__agy_pre_sum', type: 'data', payload: { updates: bigUpdates } }),
        }));
      }
    }
    close() {
      this.readyState = 3;
    }
  }

  const lsMap = new Map();
  const sandbox = {
    URL,
    Event,
    EventTarget,
    MessageEvent,
    CloseEvent: class CloseEvent extends Event {
      constructor(type, init = {}) {
        super(type);
        this.code = init.code ?? 1000;
      }
    },
    TextDecoder,
    TextEncoder,
    DecompressionStream: class {},
    WebSocket: ChunkTestWS,
    Response,
    setTimeout: trackTimeout,
    clearTimeout: trackClearTimeout,
    setInterval: trackInterval,
    clearInterval: trackClearInterval,
    queueMicrotask,
    requestAnimationFrame: (fn) => trackTimeout(fn, 0),
    __APP_CONFIG__: { csrfToken: 'boot-csrf' },
    localStorage: {
      length: 0,
      key: () => null,
      getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
      setItem: (k, v) => lsMap.set(k, String(v)),
      removeItem: (k) => lsMap.delete(k),
    },
    navigator: {},
    document: {
      readyState: 'complete',
      head: { appendChild: () => {} },
      documentElement: { style: { setProperty: () => {}, removeProperty: () => {} }, appendChild: () => {} },
      createElement: () => ({ setAttribute: () => {}, append: () => {} }),
      addEventListener: () => {},
      querySelector: () => null,
      getElementById: () => null,
      getElementsByTagName: () => [],
      visibilityState: 'visible',
    },
    location: {
      protocol: 'https:',
      host: 'relay.example:8421',
      origin: 'https://relay.example:8421',
      href: `https://relay.example:8421/c/${cid}`,
      pathname: `/c/${cid}`,
      search: '',
    },
    fetch: async () => new Response('{}', { status: 200 }),
    addEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;

  try {
    vm.runInNewContext(MOBILE_JS, sandbox);
    await new Promise((r) => setTimeout(r, 15));
    const sock = new sandbox.WebSocket('wss://relay.example:8421/connect-websocket');
    const sumFrames = [];
    sock.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.streamId === 'real-sum' && m.type === 'data') sumFrames.push(m.payload);
    });
    sock.send(JSON.stringify({ streamId: 'real-sum', type: 'start', procedure: '/exa.language_server_pb.LanguageServerService/JetboxSubscribeToSummaries', stream: true, payload: {} }));

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sumFrames.length, 1);
    const firstKeys = Object.keys(sumFrames[0].updates || {});
    assert.ok(firstKeys.length <= 60, `Expected <= 60 immediate summaries, got ${firstKeys.length}`);
    assert.ok(sumFrames[0].updates[cid] && sumFrames[0].updates['active-1'] && sumFrames[0].updates['sub-boot']);

    // Send live update for a deferred key before chunked timer fires -> must not be clobbered!
    rawSockRef.onmessage(new MessageEvent('message', {
      data: JSON.stringify({ streamId: '__agy_pre_sum', type: 'data', payload: { updates: { 'old-0': { summary: 'live-updated-0' } } } }),
    }));

    await new Promise((r) => setTimeout(r, 160));
    assert.ok(sumFrames.length >= 3, `Expected >= 3 chunked frames, got ${sumFrames.length}`);
    const merged = Object.create(null);
    for (const frame of sumFrames) {
      Object.assign(merged, frame.updates || {});
    }
    assert.equal(Object.keys(merged).length, 320);
    assert.equal(merged['old-0'].summary, 'live-updated-0');
  } finally {
    for (const id of timers) clearTimeout(id);
    for (const id of intervals) clearInterval(id);
  }
});

test('web-push subscribe skips redundant disk writes for unchanged active subscription', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-push-noop-'));
  const manager = createWebPushManager({ configDir: tmpDir, getTargetInfo: async () => null });
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const sub = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/noop-test',
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
  try {
    manager.subscribe({ subscription: sub, userAgent: 'Mozilla/5.0 Android Chrome' });
    const statePath = path.join(tmpDir, 'web-push.json');
    const t0 = new Date(Date.now() - 5000);
    fs.utimesSync(statePath, t0, t0);
    const beforeMtime = fs.statSync(statePath).mtimeMs;
    manager.subscribe({ subscription: sub, userAgent: 'Mozilla/5.0 Android Chrome' });
    const afterMtime = fs.statSync(statePath).mtimeMs;
    assert.equal(afterMtime, beforeMtime);
  } finally {
    manager.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SW_JS preserves versioned /main.js in persistent asset cache across SW upgrades', async () => {
  const listeners = new Map();
  const cachesBacking = new Map([
    ['agy-relay-static-v12', new Map([
      ['https://relay.example:8421/__agy_app_shell', new Response('<html>old-shell</html>', { status: 200 })],
      ['https://relay.example:8421/main.js?v=keep123', new Response('console.log("cached-main");', { status: 200 })],
    ])],
  ]);
  const deletedCaches = [];
  let fetchCalls = 0;

  const makeCacheApi = (map) => ({
    keys: async () => Array.from(map.keys()).map((u) => ({ url: u })),
    match: async (k) => {
      const key = typeof k === 'string' ? k : k?.url;
      if (map.has(key)) return map.get(key).clone();
      for (const [entryUrl, resp] of map.entries()) {
        try {
          const u = new URL(entryUrl);
          if (u.pathname + u.search === key) return resp.clone();
        } catch {}
      }
      return undefined;
    },
    put: async (k, resp) => {
      const key = typeof k === 'string' ? k : k?.url;
      map.set(key, resp);
    },
  });

  const sandbox = {
    URL,
    Headers,
    Response,
    AbortController,
    setTimeout,
    clearTimeout,
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    caches: {
      keys: async () => Array.from(cachesBacking.keys()),
      delete: async (k) => {
        deletedCaches.push(k);
        return cachesBacking.delete(k);
      },
      open: async (name) => {
        if (!cachesBacking.has(name)) cachesBacking.set(name, new Map());
        return makeCacheApi(cachesBacking.get(name));
      },
    },
    fetch: async (req) => {
      fetchCalls++;
      const url = typeof req === 'string' ? req : req.url;
      if (url.endsWith('/')) {
        return new Response('<html><script>window.__APP_CONFIG__={"csrfToken":"c1"};</script></html>', {
          status: 200,
          headers: { 'content-type': 'text/html', 'x-agy-shell-hash': 'shell-v13' },
        });
      }
      return new Response('network-main', { status: 200 });
    },
    self: null,
  };

  sandbox.self = {
    location: { origin: 'https://relay.example:8421' },
    clients: { claim: async () => {}, matchAll: async () => [] },
    skipWaiting: async () => {},
    addEventListener: (type, fn) => listeners.set(type, fn),
  };

  vm.runInNewContext(SW_JS, sandbox);

  let waitP = Promise.resolve();
  listeners.get('activate')({ waitUntil: (p) => { waitP = p; } });
  await waitP;
  assert.ok(deletedCaches.includes('agy-relay-static-v12'));
  assert.ok(cachesBacking.get('agy-relay-assets-v1')?.has('https://relay.example:8421/main.js?v=keep123'));

  let fetchRespPromise = null;
  fetchCalls = 0;
  listeners.get('fetch')({
    request: { method: 'GET', mode: 'no-cors', url: 'https://relay.example:8421/main.js?v=keep123' },
    waitUntil: () => {},
    respondWith: (p) => { fetchRespPromise = p; },
  });
  const served = await fetchRespPromise;
  assert.equal(await served.text(), 'console.log("cached-main");');
  assert.equal(fetchCalls, 0);
});

test('MOBILE_JS AGY_OPEN_CASCADE pushes fresh IDB snapshot into same-convo open stream and wakes sleeping backoff timers', async () => {
  const timers = new Set();
  const intervals = new Set();
  const trackTimeout = (fn, ms = 0, ...args) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn(...args);
    }, ms);
    timers.add(id);
    return id;
  };
  const trackClearTimeout = (id) => {
    timers.delete(id);
    clearTimeout(id);
  };
  const trackInterval = (fn, ms = 0, ...args) => {
    const id = setInterval(fn, ms, ...args);
    intervals.add(id);
    return id;
  };
  const trackClearInterval = (id) => {
    intervals.delete(id);
    clearInterval(id);
  };

  const cid = '00000000-0000-4000-8000-000000000001';
  const idbData = new Map([
    [`convo:${cid}`, { key: `convo:${cid}`, data: { cascadeId: cid, steps: [{ id: 'initial-idb' }] }, updatedAt: Date.now() }],
  ]);
  const reqWrap = (run) => {
    const req = { result: undefined, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
    queueMicrotask(() => run(req));
    return req;
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({}),
    close: () => {},
    transaction: () => {
      const tx = { oncomplete: null, onerror: null, onabort: null };
      const store = {
        get: (k) => reqWrap((req) => { req.result = idbData.get(k); req.onsuccess?.(); }),
        put: (v) => reqWrap((req) => { idbData.set(v.key, v); req.result = v.key; req.onsuccess?.(); }),
        delete: (k) => reqWrap((req) => { idbData.delete(k); req.onsuccess?.(); }),
        getAllKeys: () => reqWrap((req) => { req.result = Array.from(idbData.keys()); req.onsuccess?.(); }),
      };
      tx.objectStore = () => store;
      trackTimeout(() => tx.oncomplete?.(), 2);
      return tx;
    },
  };

  const sockets = [];
  class MockWS extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
      trackTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.(new Event('open'));
        this.dispatchEvent(new Event('open'));
      }, 2);
    }
    send(raw) {
      this.sent.push(raw);
    }
    close(code = 1000, reason = '') {
      this.readyState = 3;
      this.onclose?.({ code, reason, wasClean: true });
    }
  }

  let swMsgListener = null;
  const lsMap = new Map();
  const sandbox = {
    URL,
    Event,
    EventTarget,
    MessageEvent,
    CloseEvent: class CloseEvent extends Event {
      constructor(type, init = {}) {
        super(type);
        this.code = init.code ?? 1000;
      }
    },
    TextDecoder,
    TextEncoder,
    DecompressionStream: class {},
    WebSocket: MockWS,
    Response,
    indexedDB: { open: () => reqWrap((req) => { req.result = db; req.onsuccess?.(); }) },
    setTimeout: trackTimeout,
    clearTimeout: trackClearTimeout,
    setInterval: trackInterval,
    clearInterval: trackClearInterval,
    queueMicrotask,
    requestAnimationFrame: (fn) => trackTimeout(fn, 0),
    __APP_CONFIG__: { csrfToken: 'boot-csrf' },
    localStorage: {
      length: 0,
      key: () => null,
      getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
      setItem: (k, v) => lsMap.set(k, String(v)),
      removeItem: (k) => lsMap.delete(k),
    },
    navigator: {
      serviceWorker: {
        register: async () => ({}),
        addEventListener: (type, fn) => { if (type === 'message') swMsgListener = fn; },
      },
    },
    document: {
      readyState: 'complete',
      head: { appendChild: () => {} },
      documentElement: { style: { setProperty: () => {}, removeProperty: () => {} }, appendChild: () => {} },
      createElement: () => ({ setAttribute: () => {}, append: () => {} }),
      addEventListener: () => {},
      querySelector: () => null,
      getElementById: () => null,
      getElementsByTagName: () => [],
      visibilityState: 'visible',
    },
    location: {
      protocol: 'https:',
      host: 'relay.example:8421',
      origin: 'https://relay.example:8421',
      href: `https://relay.example:8421/c/${cid}`,
      pathname: `/c/${cid}`,
      search: '',
    },
    fetch: async () => new Response('{}', { status: 200 }),
    addEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;

  try {
    vm.runInNewContext(MOBILE_JS, sandbox);
    await new Promise((r) => setTimeout(r, 15));

    const sock = new sandbox.WebSocket('wss://relay.example:8421/connect-websocket');
    const msgs = [];
    sock.addEventListener('message', (ev) => msgs.push(JSON.parse(ev.data)));
    sock.send(JSON.stringify({
      streamId: 'real-same',
      type: 'start',
      procedure: '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates',
      stream: true,
      payload: { conversationId: cid },
    }));

    // Complete frame 1 so activeStateStreams removes 'real-same', while openStateStreams retains it!
    sockets[0].onmessage(new MessageEvent('message', {
      data: JSON.stringify({ streamId: '__agy_pre_1', type: 'data', payload: { cascadeId: cid, steps: [{ id: 'step-before' }] } }),
    }));
    await new Promise((r) => setTimeout(r, 10));

    // SW writes updated snapshot while user is looking elsewhere, then user taps notification for SAME conversation
    idbData.set(`convo:${cid}`, {
      key: `convo:${cid}`,
      data: { cascadeId: cid, steps: [{ id: 'finished-reply' }] },
      updatedAt: Date.now() + 100,
    });
    swMsgListener?.({ data: { type: 'AGY_OPEN_CASCADE', cascadeId: cid, url: `/c/${cid}` } });
    await new Promise((r) => setTimeout(r, 15));
    assert.ok(
      msgs.some((m) => m.streamId === 'real-same' && m.payload?.steps?.[0]?.id === 'finished-reply'),
      'Expected fresh IDB snapshot pushed immediately into already-open same-convo stream',
    );

    // Close active socket -> external 8000ms backoff timer is tracked and woken immediately by AGY_OPEN_CASCADE
    sock.close();
    let backoffWoke = false;
    sandbox.setTimeout(() => { backoffWoke = true; }, 8000);
    swMsgListener?.({ data: { type: 'AGY_OPEN_CASCADE', cascadeId: cid, url: `/c/${cid}` } });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(backoffWoke, true);
  } finally {
    for (const id of timers) clearTimeout(id);
    for (const id of intervals) clearInterval(id);
  }
});

