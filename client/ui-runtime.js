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
      'pointerdown',
      (e) => {
        if (!triggerConvoPrefetch) return;
        const a = e.target?.closest?.('a[href]');
        if (a) {
          const rawHref = a.getAttribute('href');
          if (rawHref) {
            try {
              const u = new URL(rawHref, location.href);
              if (u.origin === location.origin && u.pathname !== location.pathname) {
                const m = /^\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:$|[/?#])/i.exec(u.pathname);
                if (m) triggerConvoPrefetch(m[1]);
              }
            } catch {}
          }
        }
      },
      { capture: true, passive: true },
    );

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

    let hiddenAt = 0;
    window.addEventListener?.('offline', () => {
      clearRetryTimer();
      setOfflineBanner(true, '网络已断开');
    });
    window.addEventListener?.('online', () => {
      retryCount = 0;
      checkRelayHealth();
      triggerSocketProbe?.(1500, { timeoutMs: 450, prewarmStandby: true });
    });
    window.addEventListener?.('pageshow', () => {
      triggerSocketProbe?.(1500, { timeoutMs: 450, prewarmStandby: true });
    });
    document.addEventListener?.('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        const hiddenMs = hiddenAt ? Date.now() - hiddenAt : 0;
        hiddenAt = 0;
        retryCount = 0;
        checkRelayHealth();
        triggerSocketProbe?.(1500, { timeoutMs: hiddenMs >= 8000 ? 250 : 450, prewarmStandby: hiddenMs >= 8000 });
      } else {
        hiddenAt = Date.now();
        clearRetryTimer();
      }
    });
    if (typeof setInterval === 'function' && triggerSocketProbe) {
      setInterval(() => {
        if (document.visibilityState === 'visible') {
          triggerSocketProbe(12000, { timeoutMs: 600, prewarmStandby: false });
        }
      }, 15000);
    }

    const PUSH_DISMISS_KEY = 'agy_relay_push_dismissed';
    function urlBase64ToUint8Array(base64String) {
      const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const rawData = atob(base64);
      const output = new Uint8Array(rawData.length);
      for (let i = 0; i < rawData.length; i++) output[i] = rawData.charCodeAt(i);
      return output;
    }

    function withTimeout(promise, ms, errMsg) {
      return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(errMsg)), ms)),
      ]);
    }

    async function ensureSwReg(timeoutMs = 6000) {
      const reg = await withTimeout(
        navigator.serviceWorker.register('/sw.js'),
        timeoutMs,
        'Service Worker 注册超时（请确认已信任根证书）',
      );
      if (reg?.active) return reg;
      return withTimeout(
        navigator.serviceWorker.ready,
        timeoutMs,
        'Service Worker 未就绪（请刷新页面或检查证书信任）',
      );
    }

    const PUSH_SYNC_KEY = 'agy_relay_push_sync_v1';
    function pushSubSignature(sub) {
      try {
        const json = sub?.toJSON ? sub.toJSON() : sub;
        return `${json?.endpoint || ''}|${json?.keys?.p256dh || ''}|${json?.keys?.auth || ''}`;
      } catch {
        return '';
      }
    }

    async function postPushSubscribe(subscription) {
      const r = await fetchWithTimeout(
        '/relay-push/subscribe',
        {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subscription: subscription.toJSON ? subscription.toJSON() : subscription }),
        },
        5000,
      );
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      const sig = pushSubSignature(subscription);
      if (sig) {
        try {
          localStorage.setItem(PUSH_SYNC_KEY, JSON.stringify({ sig, at: Date.now() }));
        } catch {}
      }
      return data;
    }

    function showPushBanner() {
      if (!document.body || document.getElementById('agy-relay-push-banner')) return;
      const el = document.createElement('div');
      el.id = 'agy-relay-push-banner';
      el.setAttribute('role', 'status');
      const text = document.createElement('span');
      text.textContent = '后台通知未开启';
      const enableBtn = document.createElement('button');
      enableBtn.type = 'button';
      enableBtn.textContent = '开启推送';
      const manageLink = document.createElement('a');
      manageLink.href = '/push';
      manageLink.textContent = '多设备';
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'sec';
      closeBtn.textContent = '×';
      closeBtn.setAttribute('aria-label', '关闭');

      const hideBanner = () => {
        el.dataset.visible = '0';
        setTimeout(() => el.remove(), 220);
      };

      closeBtn.addEventListener('click', () => {
        try { localStorage.setItem(PUSH_DISMISS_KEY, '1'); } catch {}
        hideBanner();
      });

      enableBtn.addEventListener('click', async () => {
        enableBtn.disabled = true;
        enableBtn.textContent = '开启中…';
        try {
          text.textContent = '请允许通知权限…';
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') {
            text.textContent = perm === 'denied' ? '通知权限被拒绝' : '未授予通知权限';
            enableBtn.disabled = false;
            enableBtn.textContent = '重试';
            return;
          }
          text.textContent = '正在准备 Service Worker…';
          const reg = await ensureSwReg(6000);
          if (!reg?.pushManager) throw new Error('当前环境不支持 PushManager');
          let sub = await withTimeout(reg.pushManager.getSubscription(), 4000, '读取现有订阅超时');
          if (!sub) {
            text.textContent = '获取推送公钥…';
            const keyResp = await fetchWithTimeout(
              '/relay-push/vapid-public-key',
              { credentials: 'same-origin', cache: 'no-store' },
              5000,
            );
            if (!keyResp.ok) throw new Error('HTTP ' + keyResp.status);
            const { publicKey } = await keyResp.json();
            text.textContent = '连接浏览器推送服务…';
            sub = await withTimeout(
              reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey),
              }),
              12000,
              '连接推送服务超时（需设备能访问 FCM/APNs）',
            );
          }
          text.textContent = '保存订阅到中继…';
          await postPushSubscribe(sub);
          text.textContent = '已开启后台推送';
          enableBtn.remove();
          setTimeout(hideBanner, 1800);
        } catch (err) {
          text.textContent = '开启失败: ' + (err?.message || '请检查网络/证书');
          enableBtn.disabled = false;
          enableBtn.textContent = '重试';
        }
      });

      el.append(text, enableBtn, manageLink, closeBtn);
      document.body.appendChild(el);
      requestAnimationFrame(() => {
        el.dataset.visible = '1';
      });
    }

    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && navigator.serviceWorker) {
      navigator.serviceWorker.register?.('/sw.js')?.catch?.(() => {});
      navigator.serviceWorker.addEventListener?.('message', (event) => {
        const data = event?.data;
        if (data && data.type === 'AGY_ASSET_UPDATED') {
          updateAvailable = true;
          setOfflineBanner(true, '发现新版本资源，建议刷新页面', '立即刷新', () => location.reload());
        } else if (data && data.type === 'AGY_CSRF_UPDATED' && typeof data.csrfToken === 'string' && data.csrfToken) {
          try {
            window.__APP_CONFIG__ = { ...(window.__APP_CONFIG__ || {}), csrfToken: data.csrfToken };
            if (window.localStorage?.getItem('agy_session_csrf_token') !== null) {
              window.localStorage.setItem('agy_session_csrf_token', data.csrfToken);
            }
          } catch {}
        } else if (data && data.type === 'AGY_OPEN_CASCADE') {
          let cascadeId = typeof data.cascadeId === 'string' ? data.cascadeId : '';
          if (!cascadeId && data.url) {
            try {
              const target = new URL(data.url, location.origin);
              const m = target.pathname.match(/^\/c\/([^/?#]+)/);
              if (m) {
                try { cascadeId = decodeURIComponent(m[1]); } catch { cascadeId = m[1]; }
              }
            } catch {}
          }
          prepareNotificationCascade?.(cascadeId);
          dispatchCascadeOpen(cascadeId, data.url);
        }
      });

      if (window === window.top && 'PushManager' in window && typeof Notification !== 'undefined') {
        navigator.serviceWorker.ready
          .then(async (reg) => {
            if (!reg?.pushManager) return;
            const existing = await reg.pushManager.getSubscription();
            if (existing) {
              let syncedFresh = false;
              try {
                const rawSync = localStorage.getItem(PUSH_SYNC_KEY);
                if (rawSync) {
                  const parsed = JSON.parse(rawSync);
                  const sig = pushSubSignature(existing);
                  if (sig && parsed?.sig === sig && Date.now() - Number(parsed.at || 0) < 12 * 60 * 60 * 1000) {
                    syncedFresh = true;
                  }
                }
              } catch {}
              if (!syncedFresh) {
                const syncFn = () => { void postPushSubscribe(existing).catch(() => {}); };
                if (typeof requestIdleCallback === 'function') {
                  requestIdleCallback(syncFn, { timeout: 3000 });
                } else {
                  setTimeout(syncFn, 2500);
                }
              }
              return;
            }
            let dismissed = false;
            try { dismissed = localStorage.getItem(PUSH_DISMISS_KEY) === '1'; } catch {}
            if (!dismissed && Notification.permission !== 'denied') {
              setTimeout(showPushBanner, 1800);
            }
          })
          .catch(() => {});
      }
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
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(injectContextPlugin, { timeout: 250 });
      } else {
        setTimeout(injectContextPlugin, 80);
      }
    }

    initMobileFileSheet();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDeferred, { once: true });
  } else {
    initDeferred();
  }
