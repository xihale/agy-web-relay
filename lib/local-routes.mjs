import { readJsonBody } from './local-proxy.mjs';
import { sendCompressedAssetAsync, serveCachedStatic } from './static-cache.mjs';

function sendJsonError(res, status, payload, cookieOpt) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cookieOpt });
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function sendJson(req, res, payload, cookieOpt) {
  return sendCompressedAssetAsync(
    req,
    res,
    200,
    'application/json; charset=utf-8',
    Buffer.from(JSON.stringify(payload)),
    { 'cache-control': 'no-store', ...cookieOpt },
  );
}

/**
 * Creates the relay-local HTTP route handler for PWA assets, health checks,
 * context plugin endpoints, and Web Push APIs.
 */
export function createLocalRouteHandler({ localStaticRoutes, getTargetPort, getContextBridge, webPushManager }) {
  return async function handleLocalRoute(pathname, req, res, authResult) {
    const cookieOpt = authResult.setCookie ? { 'set-cookie': authResult.setCookie } : {};
    const staticEntry = localStaticRoutes.get(pathname);
    if (staticEntry && (req.method === 'GET' || req.method === 'HEAD')) {
      await serveCachedStatic(req, res, staticEntry, authResult.setCookie);
      return true;
    }
    if (pathname === '/connect-websocket' && (req.method === 'GET' || req.method === 'HEAD') && !req.headers.upgrade) {
      res.writeHead(204, { 'cache-control': 'no-store', 'content-length': '0', ...cookieOpt });
      res.end();
      return true;
    }
    if (pathname === '/relay-health') {
      const port = await getTargetPort(false);
      const ok = port > 0;
      const body = Buffer.from(JSON.stringify({ ok, targetPort: port || null }));
      res.writeHead(ok ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'content-length': String(body.length),
        ...cookieOpt,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    }
    if (pathname === '/relay-plugin/antigravity-context.js') {
      const bridge = await getContextBridge();
      if (!bridge) {
        const fallback = Buffer.from('/* antigravity-context not installed */\n', 'utf8');
        await sendCompressedAssetAsync(req, res, 200, 'application/javascript; charset=utf-8', fallback, {
          'cache-control': 'no-store',
          ...cookieOpt,
        });
        return true;
      }
      const entry = await bridge.getClientScriptEntry();
      await serveCachedStatic(req, res, entry, authResult.setCookie);
      return true;
    }
    if (pathname === '/relay-plugin/antigravity-context/metrics') {
      if (req.method !== 'POST') {
        sendJsonError(res, 405, '{"error":"Method not allowed"}', cookieOpt);
        return true;
      }
      const bridge = await getContextBridge();
      if (!bridge) {
        sendJsonError(res, 404, '{"error":"antigravity-context not installed"}', cookieOpt);
        return true;
      }
      try {
        const input = await readJsonBody(req, 4096);
        await sendJson(req, res, await bridge.getMetrics(input), cookieOpt);
      } catch (err) {
        sendJsonError(
          res,
          400,
          { connection: 'offline', error: err?.message || 'Metrics unavailable', speed: null, groups: [] },
          cookieOpt,
        );
      }
      return true;
    }
    if (pathname === '/relay-plugin/antigravity-context/preferences') {
      const bridge = await getContextBridge();
      if (!bridge) {
        sendJsonError(res, 404, '{"error":"antigravity-context not installed"}', cookieOpt);
        return true;
      }
      try {
        if (req.method === 'GET' || req.method === 'POST') {
          const data =
            req.method === 'GET' ? await bridge.getPreferences() : await bridge.setPreferences(await readJsonBody(req, 1024));
          await sendJson(req, res, data, cookieOpt);
          return true;
        }
        sendJsonError(res, 405, '{"error":"Method not allowed"}', cookieOpt);
      } catch (err) {
        sendJsonError(res, 400, { error: err?.message || 'Preferences error' }, cookieOpt);
      }
      return true;
    }
    if (pathname === '/relay-push/vapid-public-key') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJsonError(res, 405, '{"error":"Method not allowed"}', cookieOpt);
        return true;
      }
      const body = Buffer.from(JSON.stringify({ supported: true, publicKey: webPushManager.getPublicKey() }));
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': String(body.length),
        ...cookieOpt,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    }
    if (pathname === '/relay-push/status') {
      try {
        const input = req.method === 'POST' ? await readJsonBody(req, 4096) : {};
        const currentEndpoint = typeof input?.endpoint === 'string' ? input.endpoint : '';
        const devices = webPushManager.listDevices(currentEndpoint);
        await sendJson(
          req,
          res,
          {
            publicKey: webPushManager.getPublicKey(),
            count: devices.length,
            devices,
            currentSubscribed: devices.some((d) => d.isCurrent),
            monitorActive: webPushManager.isMonitorActive(),
          },
          cookieOpt,
        );
      } catch (err) {
        sendJsonError(res, 400, { error: err?.message || 'Invalid status request' }, cookieOpt);
      }
      return true;
    }
    if (pathname === '/relay-push/subscribe') {
      if (req.method !== 'POST') {
        sendJsonError(res, 405, '{"error":"Method not allowed"}', cookieOpt);
        return true;
      }
      try {
        const input = await readJsonBody(req, 16384);
        const result = webPushManager.subscribe({
          subscription: input?.subscription,
          deviceLabel: typeof input?.deviceLabel === 'string' ? input.deviceLabel : '',
          userAgent: String(req.headers['user-agent'] || ''),
        });
        await sendJson(
          req,
          res,
          {
            ok: true,
            ...result,
            devices: webPushManager.listDevices(input?.subscription?.endpoint || ''),
          },
          cookieOpt,
        );
      } catch (err) {
        sendJsonError(res, 400, { error: err?.message || 'Subscribe failed' }, cookieOpt);
      }
      return true;
    }
    if (pathname === '/relay-push/unsubscribe') {
      if (req.method !== 'POST') {
        sendJsonError(res, 405, '{"error":"Method not allowed"}', cookieOpt);
        return true;
      }
      try {
        const input = await readJsonBody(req, 4096);
        const result = webPushManager.unsubscribe({
          endpoint: typeof input?.endpoint === 'string' ? input.endpoint : '',
          id: typeof input?.id === 'string' ? input.id : '',
        });
        await sendJson(req, res, { ok: true, ...result, devices: webPushManager.listDevices() }, cookieOpt);
      } catch (err) {
        sendJsonError(res, 400, { error: err?.message || 'Unsubscribe failed' }, cookieOpt);
      }
      return true;
    }
    if (pathname === '/relay-push/test') {
      if (req.method !== 'POST') {
        sendJsonError(res, 405, '{"error":"Method not allowed"}', cookieOpt);
        return true;
      }
      try {
        const input = await readJsonBody(req, 4096);
        const summary = await webPushManager.broadcast(
          {
            type: 'test',
            force: true,
            title: typeof input?.title === 'string' && input.title.trim() ? input.title.trim() : 'Antigravity 测试通知',
            body:
              typeof input?.body === 'string' && input.body.trim()
                ? input.body.trim()
                : '后台静默 Web Push 推送正常',
            tag: `agy-test-${Date.now()}`,
            url: '/',
          },
          { targetId: typeof input?.id === 'string' ? input.id : '' },
        );
        await sendJson(req, res, { ok: true, ...summary }, cookieOpt);
      } catch (err) {
        sendJsonError(res, 400, { error: err?.message || 'Test push failed' }, cookieOpt);
      }
      return true;
    }
    return false;
  };
}
