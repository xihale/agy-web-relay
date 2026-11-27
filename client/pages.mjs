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
    <strong>2. 多设备后台推送（Web Push，静默通知）</strong>
    <p>添加主屏幕后，可在任意多台手机/电脑设备上分别订阅后台推送，锁屏或切后台时也能收到任务完成与待确认提醒：</p>
    <a class="btn sec" href="/push">管理推送设备与测试</a>
  </div>
  <div class="card">
    <strong>3. 直接进入工作台</strong>
    <p>如果已经在当前设备信任过根证书，可以直接进入：</p>
    <a class="btn sec" href="/">打开 Antigravity</a>
  </div>
</body>
</html>`;
}

export function renderPushHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Antigravity 后台推送管理</title>
  <link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />
  <link rel="icon" type="image/png" sizes="192x192" href="/relay-icon-192.png" />
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
      max-width: 600px; margin-inline: auto;
      box-sizing: border-box;
    }
    h1 { font-size: 20px; margin: 0 0 12px; color: #fff; }
    .card {
      background: #14141c; border: 1px solid #27273a;
      border-radius: 14px; padding: 16px; margin-bottom: 14px;
    }
    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
    button, a.btn {
      display: inline-block; padding: 9px 14px; border-radius: 10px;
      border: 0; cursor: pointer; font: 600 14px/1.2 system-ui, -apple-system, sans-serif;
      background: #7aa2f7; color: #0b0b0f; text-decoration: none;
    }
    button.sec, a.btn.sec { background: #27273a; color: #e4e4e7; }
    button.danger { background: #5a222b; color: #fecdd3; padding: 6px 10px; font-size: 12px; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    input[type="text"] {
      width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 10px;
      border: 1px solid #303048; background: #0f0f16; color: #fff; font-size: 16px;
      margin-top: 8px;
    }
    .muted { color: #a1a1aa; font-size: 13px; }
    .pill {
      display: inline-block; padding: 2px 8px; border-radius: 999px;
      font-size: 12px; background: #27273a; color: #e4e4e7; margin-right: 6px;
    }
    .pill.ok { background: rgba(34, 197, 94, 0.2); color: #86efac; }
    .pill.warn { background: rgba(245, 158, 11, 0.2); color: #fcd34d; }
    .pill.err { background: rgba(239, 68, 68, 0.2); color: #fca5a5; }
    .dev {
      display: flex; justify-content: space-between; align-items: center; gap: 10px;
      padding: 10px 0; border-top: 1px solid #232334;
    }
    .dev:first-child { border-top: 0; padding-top: 0; }
    .dev-title { font-weight: 600; font-size: 14px; }
    .msg { margin-top: 10px; font-size: 13px; white-space: pre-wrap; }
    @media (prefers-color-scheme: light) {
      body { background: #f8fafc; color: #18181b; }
      h1 { color: #09090b; }
      .card { background: #ffffff; border-color: #e4e4e7; }
      button.sec, a.btn.sec { background: #e4e4e7; color: #18181b; }
      input[type="text"] { background: #fff; color: #18181b; border-color: #d4d4d8; }
      .muted { color: #52525b; }
      .pill { background: #e4e4e7; color: #18181b; }
      .pill.ok { background: #dcfce7; color: #166534; }
      .pill.warn { background: #fef3c7; color: #92400e; }
      .pill.err { background: #fee2e2; color: #991b1b; }
      .dev { border-top-color: #e4e4e7; }
    }
  </style>
</head>
<body>
  <h1>Antigravity 多设备后台推送</h1>
  <div class="card">
    <strong>当前设备</strong>
    <div id="env-status" class="row"></div>
    <p id="ios-hint" class="muted" style="display:none">
      检测到 iOS 浏览器标签页模式：请先点底部分享按钮 → <strong>添加到主屏幕</strong>，然后从主屏幕图标打开再开启推送。
    </p>
    <label for="device-label" class="muted" style="display:block;margin-top:10px">设备名称（方便区分多台设备）</label>
    <input id="device-label" type="text" maxlength="64" placeholder="例如：主力 iPhone / 备用 Android" />
    <div class="row">
      <button id="btn-enable" type="button">开启 / 更新当前设备推送</button>
      <button id="btn-test" type="button" class="sec">发送测试推送（全部设备）</button>
      <button id="btn-disable" type="button" class="sec" style="display:none">取消当前设备</button>
    </div>
    <div id="action-msg" class="msg muted"></div>
  </div>
  <div class="card">
    <strong>已订阅设备（<span id="dev-count">0</span>）</strong>
    <div id="dev-list" style="margin-top:10px" class="muted">加载中…</div>
  </div>
  <div class="row">
    <a class="btn sec" href="/">返回 Antigravity</a>
    <a class="btn sec" href="/setup">证书与安装指引</a>
  </div>
  <script>
    const envEl = document.getElementById('env-status');
    const iosHintEl = document.getElementById('ios-hint');
    const labelInput = document.getElementById('device-label');
    const btnEnable = document.getElementById('btn-enable');
    const btnTest = document.getElementById('btn-test');
    const btnDisable = document.getElementById('btn-disable');
    const msgEl = document.getElementById('action-msg');
    const countEl = document.getElementById('dev-count');
    const listEl = document.getElementById('dev-list');

    function detectDefaultLabel() {
      const ua = navigator.userAgent || '';
      const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : 'Linux';
      const br = /Edg/.test(ua) ? 'Edge' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : '';
      const isPwa = window.matchMedia?.('(display-mode: standalone)')?.matches || navigator.standalone === true;
      return [os, br, isPwa ? 'PWA' : ''].filter(Boolean).join(' · ');
    }
    labelInput.value = detectDefaultLabel();

    function urlBase64ToUint8Array(base64String) {
      const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(base64);
      const out = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      return out;
    }

    function pill(text, cls) {
      const s = document.createElement('span');
      s.className = 'pill ' + (cls || '');
      s.textContent = text;
      return s;
    }

    function fmtTime(ts) {
      if (!ts) return '未推送过';
      return new Date(ts).toLocaleString();
    }

    function withTimeout(promise, ms, msg) {
      return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
      ]);
    }

    async function ensureSwReg() {
      const reg = await withTimeout(
        navigator.serviceWorker.register('/sw.js'),
        6000,
        'Service Worker 注册超时（请确认已安装并完全信任 CA 根证书）',
      );
      if (reg && reg.active) return reg;
      return withTimeout(
        navigator.serviceWorker.ready,
        6000,
        'Service Worker 未激活（请刷新页面后重试）',
      );
    }

    async function getCurrentSub() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
      const reg = await ensureSwReg();
      return withTimeout(reg.pushManager.getSubscription(), 4000, '读取订阅超时');
    }

    async function refreshStatus() {
      envEl.innerHTML = '';
      const isSecure = window.isSecureContext;
      const hasSw = 'serviceWorker' in navigator;
      const hasPush = 'PushManager' in window;
      const hasNotif = typeof Notification !== 'undefined';
      const perm = hasNotif ? Notification.permission : 'unsupported';
      const isStandalone = window.matchMedia?.('(display-mode: standalone)')?.matches || navigator.standalone === true;
      const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent || '');

      envEl.append(
        pill(isSecure ? 'HTTPS 安全上下文' : '非安全上下文', isSecure ? 'ok' : 'err'),
        pill(hasSw && hasPush ? '支持 Web Push' : '不支持 Web Push', hasSw && hasPush ? 'ok' : 'warn'),
        pill('通知权限: ' + perm, perm === 'granted' ? 'ok' : perm === 'denied' ? 'err' : 'warn'),
      );
      if (isIos && !isStandalone) iosHintEl.style.display = 'block';

      let currentEndpoint = '';
      try {
        const sub = await getCurrentSub();
        currentEndpoint = sub?.endpoint || '';
        btnDisable.style.display = sub ? 'inline-block' : 'none';
      } catch {}

      const r = await fetch('/relay-push/status', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: currentEndpoint }),
      });
      const data = await r.json();
      countEl.textContent = String(data.count || 0);
      listEl.innerHTML = '';
      if (!Array.isArray(data.devices) || data.devices.length === 0) {
        listEl.textContent = '暂无已订阅设备。';
        return;
      }
      for (const dev of data.devices) {
        const row = document.createElement('div');
        row.className = 'dev';
        const info = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'dev-title';
        title.textContent = dev.deviceLabel + (dev.isCurrent ? '（当前设备）' : '');
        const meta = document.createElement('div');
        meta.className = 'muted';
        meta.textContent = 'ID: ' + dev.id + ' · 最近成功: ' + fmtTime(dev.lastSuccessAt) + (dev.lastError ? ' · 错误: ' + dev.lastError : '');
        info.append(title, meta);

        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'danger';
        rm.textContent = '移除';
        rm.addEventListener('click', async () => {
          rm.disabled = true;
          await fetch('/relay-push/unsubscribe', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: dev.id }),
          });
          await refreshStatus();
        });
        row.append(info, rm);
        listEl.appendChild(row);
      }
    }

    btnEnable.addEventListener('click', async () => {
      msgEl.textContent = '1/5 正在请求通知权限…';
      btnEnable.disabled = true;
      try {
        if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
          throw new Error('当前浏览器/标签页不支持 Web Push');
        }
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') throw new Error('通知权限状态: ' + perm);
        msgEl.textContent = '2/5 正在注册 Service Worker…';
        const reg = await ensureSwReg();
        let sub = await withTimeout(reg.pushManager.getSubscription(), 4000, '读取现有订阅超时');
        if (!sub) {
          msgEl.textContent = '3/5 正在获取 VAPID 公钥…';
          const kr = await withTimeout(
            fetch('/relay-push/vapid-public-key', { credentials: 'same-origin', cache: 'no-store' }),
            5000,
            '获取 VAPID 公钥超时',
          );
          const { publicKey } = await kr.json();
          msgEl.textContent = '4/5 正在向浏览器推送服务注册（FCM / APNs）…';
          sub = await withTimeout(
            reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(publicKey),
            }),
            12000,
            '向浏览器推送服务注册超时：Android/Chrome 需能连通 Google FCM，iOS 需用主屏幕 PWA 连通 Apple APNs',
          );
        }
        msgEl.textContent = '5/5 正在保存设备订阅…';
        const sr = await withTimeout(
          fetch('/relay-push/subscribe', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ subscription: sub.toJSON(), deviceLabel: labelInput.value }),
          }),
          5000,
          '保存订阅到中继超时',
        );
        const res = await sr.json();
        if (!sr.ok) throw new Error(res.error || '订阅保存失败');
        msgEl.textContent = '已订阅当前设备（' + res.deviceLabel + '），当前共 ' + res.count + ' 台设备。';
        await refreshStatus();
      } catch (err) {
        msgEl.textContent = '开启失败: ' + (err?.message || err);
      } finally {
        btnEnable.disabled = false;
      }
    });

    btnDisable.addEventListener('click', async () => {
      msgEl.textContent = '';
      btnDisable.disabled = true;
      try {
        const sub = await getCurrentSub();
        if (sub) {
          const endpoint = sub.endpoint;
          await sub.unsubscribe().catch(() => {});
          await fetch('/relay-push/unsubscribe', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint }),
          });
        }
        msgEl.textContent = '已取消当前设备订阅。';
        await refreshStatus();
      } catch (err) {
        msgEl.textContent = '取消失败: ' + (err?.message || err);
      } finally {
        btnDisable.disabled = false;
      }
    });

    btnTest.addEventListener('click', async () => {
      msgEl.textContent = '正在向所有已订阅设备发送测试推送…';
      btnTest.disabled = true;
      try {
        const r = await fetch('/relay-push/test', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'Antigravity 测试通知', body: '后台静默 Web Push 通道正常' }),
        });
        const data = await r.json();
        const details = (data.results || []).map((x) => x.deviceLabel + ': ' + (x.ok ? '成功 (' + x.status + ')' : x.error)).join('\\n');
        msgEl.textContent = data.total === 0
          ? '没有已订阅设备，请先点击“开启当前设备推送”。'
          : '发送完成：成功 ' + data.sent + ' / ' + data.total + (data.pruned ? '（已自动清理 ' + data.pruned + ' 个失效订阅）' : '') + (details ? '\\n' + details : '');
        await refreshStatus();
      } catch (err) {
        msgEl.textContent = '测试发送失败: ' + (err?.message || err);
      } finally {
        btnTest.disabled = false;
      }
    });

    refreshStatus().catch((err) => {
      msgEl.textContent = '加载失败: ' + (err?.message || err);
    });
  </script>
</body>
</html>`;
}
