import net from 'node:net';
import tls from 'node:tls';
import { TCP_KEEPALIVE_MS, WS_CONNECT_TIMEOUT_MS } from './constants.mjs';
import { buildHttp1UpgradeHeaders } from './cli-tls.mjs';
import { parseLocalProxyTarget } from './local-proxy.mjs';
import { attachWebSocketBridge } from '../ws-deflate-bridge.mjs';

/**
 * Attaches the HTTP/1.1 WebSocket upgrade handler with local-target routing,
 * RFC 7692 permessage-deflate bridging, and upstream port retry on ECONNREFUSED.
 */
export function attachUpgradeHandler(server, { auth, opts, getActivePort, getTargetPort, invalidateTargetCache }) {
  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => {});
    try {
      socket.setNoDelay(true);
      socket.setKeepAlive(true, TCP_KEEPALIVE_MS);

      const authResult = auth.authenticate(req);
      if (!authResult.ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const bridgeUpgrade = (proto, port, reqPath, prefix = '', onPreConnectRefused = null) => {
        if (socket.destroyed) return;
        let connected = false;
        let handedOff = false;

        const upstream =
          proto === 'https'
            ? tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false })
            : net.connect({ host: '127.0.0.1', port });

        const connectTimer = setTimeout(() => {
          if (!connected && !upstream.destroyed) {
            const err = new Error('WebSocket upstream connect timeout');
            err.code = 'ETIMEDOUT';
            upstream.destroy(err);
          }
        }, WS_CONNECT_TIMEOUT_MS);
        connectTimer.unref?.();

        const cleanupBoth = () => {
          clearTimeout(connectTimer);
          if (!socket.destroyed) socket.destroy();
          if (!upstream.destroyed) upstream.destroy();
        };

        const onClientClose = () => {
          clearTimeout(connectTimer);
          if (!upstream.destroyed) upstream.destroy();
        };

        socket.once('error', cleanupBoth);
        socket.once('close', onClientClose);

        upstream.once(proto === 'https' ? 'secureConnect' : 'connect', () => {
          connected = true;
          clearTimeout(connectTimer);
          if (socket.destroyed) {
            upstream.destroy();
            return;
          }
          upstream.setNoDelay(true);
          upstream.setKeepAlive(true, TCP_KEEPALIVE_MS);
          const headers = buildHttp1UpgradeHeaders(req.headers, port, proto, prefix);
          let raw = `${req.method} ${reqPath} HTTP/${req.httpVersion}\r\n`;
          for (const [k, v] of Object.entries(headers)) {
            if (v === undefined) continue;
            if (Array.isArray(v)) {
              for (const item of v) raw += `${k}: ${item}\r\n`;
            } else {
              raw += `${k}: ${v}\r\n`;
            }
          }
          raw += '\r\n';
          attachWebSocketBridge({
            req,
            clientSocket: socket,
            upstreamSocket: upstream,
            head,
            rawRequestHeaders: raw,
            onCleanup: cleanupBoth,
          });
        });

        upstream.on('error', async (err) => {
          clearTimeout(connectTimer);
          try {
            if (!connected && err?.code === 'ECONNREFUSED' && onPreConnectRefused && !socket.destroyed) {
              handedOff = true;
              socket.removeListener('error', cleanupBoth);
              socket.removeListener('close', onClientClose);
              upstream.destroy();
              await onPreConnectRefused();
              return;
            }
          } catch {
            // Fall through to socket/upstream cleanup
          }
          cleanupBoth();
        });

        upstream.once('close', () => {
          clearTimeout(connectTimer);
          if (!handedOff && !socket.destroyed) socket.destroy();
        });
      };

      const localTarget = parseLocalProxyTarget(req.url, req.headers.referer, getActivePort());
      if (localTarget) {
        bridgeUpgrade(localTarget.proto, localTarget.port, localTarget.upstreamPath, localTarget.prefix);
        return;
      }

      const targetPort = await getTargetPort(false);
      if (!targetPort) {
        if (!socket.destroyed) {
          socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
          socket.destroy();
        }
        return;
      }

      bridgeUpgrade('https', targetPort, req.url, '', async () => {
        try {
          if (opts.targetPort > 0) {
            if (!socket.destroyed) socket.destroy();
            return;
          }
          invalidateTargetCache();
          const refreshed = await getTargetPort(true);
          if (refreshed > 0 && !socket.destroyed) {
            bridgeUpgrade('https', refreshed, req.url, '', null);
          } else if (!socket.destroyed) {
            socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
            socket.destroy();
          }
        } catch {
          if (!socket.destroyed) socket.destroy();
        }
      });
    } catch {
      if (!socket.destroyed) socket.destroy();
    }
  });
}
