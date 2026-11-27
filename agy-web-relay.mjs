#!/usr/bin/env node
// Antigravity Web Relay — HTTP/2 + HTTP/3 TLS proxy + mobile PWA patcher for Antigravity
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import {
  CACHEABLE_PATHS,
  CONFIG_DIR,
  MAX_HTML_BUFFER_BYTES,
  STATIC_CACHE_TTL_MS,
  TCP_KEEPALIVE_MS,
  UNARY_RPC_COMPRESS_LIMIT,
} from './lib/constants.mjs';
import {
  buildH2UpstreamHeaders,
  createAuth,
  ensureTlsCert,
  parseArgs,
  printHelp,
  resolveBindIp,
} from './lib/cli-tls.mjs';
import { createContextBridgeLoader } from './lib/context-bridge.mjs';
import { createConvoSnapshotCache } from './lib/convo-snapshot.mjs';
import { injectCsrfToken, injectMobileHead, isHtmlCandidatePath, isSpaShellHtml, shouldPatchSpaHtml } from './lib/html-patch.mjs';
import {
  appendSetCookie,
  applyCorsAndLocation,
  attachH2SessionHeartbeat,
  cleanUpstreamHeaders,
  createLocalTargetProxy,
  parseLocalProxyTarget,
  rewriteLocalHtml,
} from './lib/local-proxy.mjs';
import { createLocalRouteHandler } from './lib/local-routes.mjs';
import {
  acceptsEncodingToken,
  brotliDecompressAsync,
  compressBufferAsync,
  createStaticAssetEntry,
  etagVersionTag,
  gunzipAsync,
  inflateAsync,
  matchesIfNoneMatch,
  pickEncoding,
  serveCachedStatic,
} from './lib/static-cache.mjs';
import { createUpstreamManager } from './lib/upstream-h2.mjs';
import { createFastUsageReader } from './lib/usage-reader.mjs';
import { attachUpgradeHandler } from './lib/ws-upgrade.mjs';
import {
  ICON_192,
  ICON_512,
  MANIFEST_JSON,
  MOBILE_CSS,
  MOBILE_JS,
  renderPushHtml,
  renderSetupHtml,
  SW_JS,
} from './mobile-assets.mjs';
import { createWebPushManager } from './web-push.mjs';

export {
  buildH2UpstreamHeaders,
  createAuth,
  createFastUsageReader,
  createStaticAssetEntry,
  etagVersionTag,
  injectCsrfToken,
  injectMobileHead,
  matchesIfNoneMatch,
  parseArgs,
  parseLocalProxyTarget,
  pickEncoding,
  printHelp,
  rewriteLocalHtml,
  shouldPatchSpaHtml,
};

const localHttpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: TCP_KEEPALIVE_MS, maxSockets: 64 });
const localHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: TCP_KEEPALIVE_MS,
  maxSockets: 64,
  rejectUnauthorized: false,
});

function sendPlainError(res, status, message) {
  if (!res.headersSent && !res.destroyed) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(message);
  } else if (!res.destroyed) {
    res.destroy();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2), process.env);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const auth = createAuth(opts);
  const bindIp = await resolveBindIp(opts);
  const tlsCreds = ensureTlsCert(opts.cert, opts.key, bindIp);
  let activePort = opts.port;
  const setupHtml = renderSetupHtml(bindIp, opts.port);
  const pushHtml = renderPushHtml();
  const startupLastModified = new Date().toUTCString();

  const [setupEntry, pushEntry, manifestEntry, icon192Entry, icon512Entry, mobileCssEntry, mobileJsEntry, swJsEntry, caCertEntry] =
    await Promise.all([
      createStaticAssetEntry(setupHtml, 'text/html; charset=utf-8', {}, { lastModified: startupLastModified }),
      createStaticAssetEntry(pushHtml, 'text/html; charset=utf-8', {}, { lastModified: startupLastModified }),
      createStaticAssetEntry(
        MANIFEST_JSON,
        'application/manifest+json; charset=utf-8',
        { 'cache-control': 'public, max-age=86400, stale-while-revalidate=604800' },
        { lastModified: startupLastModified },
      ),
      createStaticAssetEntry(
        ICON_192,
        'image/png',
        { 'cache-control': 'public, max-age=86400, stale-while-revalidate=604800' },
        { compress: false, lastModified: startupLastModified },
      ),
      createStaticAssetEntry(
        ICON_512,
        'image/png',
        { 'cache-control': 'public, max-age=86400, stale-while-revalidate=604800' },
        { compress: false, lastModified: startupLastModified },
      ),
      createStaticAssetEntry(MOBILE_CSS, 'text/css; charset=utf-8', {}, { lastModified: startupLastModified }),
      createStaticAssetEntry(MOBILE_JS, 'application/javascript; charset=utf-8', {}, { lastModified: startupLastModified }),
      createStaticAssetEntry(
        SW_JS,
        'application/javascript; charset=utf-8',
        { 'service-worker-allowed': '/' },
        { lastModified: startupLastModified },
      ),
      createStaticAssetEntry(
        tlsCreds.caCert,
        'application/x-x509-ca-cert',
        { 'content-disposition': 'attachment; filename="agy-relay-ca.crt"' },
        { compress: false, lastModified: startupLastModified },
      ),
    ]);

  const localStaticRoutes = new Map([
    ['/ca.crt', caCertEntry],
    ['/setup', setupEntry],
    ['/push', pushEntry],
    ['/manifest.webmanifest', manifestEntry],
    ['/relay-icon-192.png', icon192Entry],
    ['/relay-icon-512.png', icon512Entry],
    ['/relay-mobile.css', mobileCssEntry],
    ['/relay-mobile.js', mobileJsEntry],
    ['/sw.js', swJsEntry],
  ]);

  const upstream = createUpstreamManager({ opts });
  const convoSnapshotCache = createConvoSnapshotCache({ getTargetInfo: upstream.getTargetInfo });
  const getContextBridge = createContextBridgeLoader({ getTargetInfo: upstream.getTargetInfo });
  const webPushManager = createWebPushManager({
    configDir: CONFIG_DIR,
    getTargetInfo: upstream.getTargetInfo,
    onNotifyPrewarm: (id) => convoSnapshotCache.warm(id),
  });
  const proxyLocalTarget = createLocalTargetProxy({ localHttpAgent, localHttpsAgent });
  const handleLocalRoute = createLocalRouteHandler({
    localStaticRoutes,
    getTargetPort: upstream.getTargetPort,
    getContextBridge,
    webPushManager,
    convoSnapshotCache,
  });

  const rootHtmlMemo = new Map();

  const server = http2.createSecureServer(
    {
      key: tlsCreds.key,
      cert: tlsCreds.cert,
      allowHTTP1: true,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.3',
      sessionTimeout: 86400,
      settings: {
        initialWindowSize: 4 * 1024 * 1024,
        maxFrameSize: 65536,
        maxConcurrentStreams: 256,
        enablePush: false,
      },
    },
    async (req, res) => {
      req.on('error', () => {});
      res.on('error', () => {});

      try {
        const authResult = auth.authenticate(req);
        if (!authResult.ok) {
          res.writeHead(401, {
            'WWW-Authenticate': 'Basic realm="Antigravity Local Relay", charset="UTF-8"',
            'Content-Type': 'text/plain; charset=utf-8',
          });
          res.end('Authentication required');
          return;
        }

        const pathname = (req.url || '/').split('?')[0];
        if (await handleLocalRoute(pathname, req, res, authResult)) {
          return;
        }

        const localTarget = parseLocalProxyTarget(req.url, req.headers.referer, activePort);
        if (localTarget) {
          proxyLocalTarget(req, res, authResult, localTarget);
          return;
        }

        if ((req.method === 'GET' || req.method === 'HEAD') && CACHEABLE_PATHS.has(pathname)) {
          const cached = upstream.getCachedStatic(pathname);
          if (cached) {
            if (Date.now() - cached.checkedAt >= STATIC_CACHE_TTL_MS) {
              upstream.fetchStaticCoalesced(pathname, cached, false).catch(() => {});
            }
            await serveCachedStatic(req, res, cached, authResult.setCookie, {
              pathname,
              key: cached.upstreamEtag || cached.etag,
            });
            return;
          }
          const result = await upstream.fetchStaticCoalesced(pathname, null, false);
          if (res.destroyed || res.writableEnded) return;
          if (result.kind === 'no-target') {
            sendPlainError(res, 503, 'No active Antigravity language_server found. Start Antigravity first.');
            return;
          }
          if (result.kind === 'error') {
            sendPlainError(res, 502, `Upstream error: ${result.err?.message || 'Upstream unavailable'}`);
            return;
          }
          if (result.kind === 'entry') {
            await serveCachedStatic(req, res, result.entry, authResult.setCookie, {
              pathname,
              key: result.entry.upstreamEtag || result.entry.etag,
            });
            return;
          }
          const ptHeaders = { ...result.headers };
          applyCorsAndLocation(
            ptHeaders,
            req.headers.origin,
            req.headers[':authority'] || req.headers.host,
            upstream.getCachedTargetPort(),
          );
          appendSetCookie(ptHeaders, authResult.setCookie);
          ptHeaders['content-length'] = String(result.body.length);
          res.writeHead(result.status, ptHeaders);
          res.end(req.method === 'HEAD' ? undefined : result.body);
          return;
        }

        const isHtmlCandidate = req.method === 'GET' && isHtmlCandidatePath(pathname);
        const isSpaMobilePatch = isHtmlCandidate && !opts.noMobilePatch;
        const clientCacheControl = String(req.headers['cache-control'] || '').toLowerCase();
        const forceTargetRefresh =
          isHtmlCandidate &&
          (clientCacheControl.includes('no-store') ||
            clientCacheControl.includes('no-cache') ||
            String(req.headers.pragma || '').toLowerCase().includes('no-cache'));

        const resolveForwardTarget = (info, fallbackPort = 0) => ({
          port: opts.targetPort > 0 ? opts.targetPort : info.port || fallbackPort,
          csrfToken: info.csrfToken || '',
        });
        const initialTargetInfo = await upstream.getTargetInfo(forceTargetRefresh);
        const initialTarget = resolveForwardTarget(initialTargetInfo);
        if (!initialTarget.port) {
          sendPlainError(res, 503, 'No active Antigravity language_server found. Start Antigravity first.');
          return;
        }

        const assetVersions = {};
        if (isSpaMobilePatch) {
          for (const p of ['/main.js', '/prism_bundle.js', '/jetbox.css', '/compiled_tailwind.css']) {
            const tag = etagVersionTag(upstream.getCachedStatic(p)?.etag);
            if (tag) assetVersions[p] = tag;
          }
        }
        const assetVersionsKey = Object.entries(assetVersions)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join('&');

        const clientOrigin = req.headers.origin;
        const clientHost = req.headers[':authority'] || req.headers.host;
        const method = (req.method || 'GET').toUpperCase();
        const canRetryMethod = method === 'GET' || method === 'HEAD';

        let reqEnded = Boolean(req.readableEnded);
        req.once('end', () => {
          reqEnded = true;
        });

        if (isSpaMobilePatch && typeof res.writeEarlyHints === 'function') {
          try {
            const hintUrl = (p) => (assetVersions[p] ? `${p}?v=${assetVersions[p]}` : p);
            res.writeEarlyHints({
              link: [
                `<${hintUrl('/compiled_tailwind.css')}>; rel=preload; as=style`,
                `<${hintUrl('/jetbox.css')}>; rel=preload; as=style`,
                `<${hintUrl('/main.js')}>; rel=preload; as=script`,
              ],
            });
          } catch {
            // Ignore if client doesn't support 103 Early Hints
          }
        }

        const forward = (target, allowRetry) => {
          if (res.destroyed || res.writableEnded) return;
          const portToUse = target.port;
          let client;
          let upStream;
          try {
            client = upstream.getH2Client(portToUse);
            upStream = client.request(buildH2UpstreamHeaders(req, portToUse, isHtmlCandidate, isHtmlCandidate));
          } catch (err) {
            if (allowRetry && canRetryMethod) {
              if (client) upstream.dropH2Client(client);
              upstream.getTargetInfo(true)
                .then((refreshedInfo) => {
                  const nextTarget = resolveForwardTarget(refreshedInfo, portToUse);
                  if (nextTarget.port) forward(nextTarget, false);
                  else sendPlainError(res, 502, `Upstream error: ${err.message}`);
                })
                .catch(() => {
                  if (!res.destroyed) res.destroy();
                });
              return;
            }
            sendPlainError(res, 502, `Upstream error: ${err.message}`);
            return;
          }

          let headersReceived = false;
          let streamEnded = false;
          let failureHandled = false;

          const onResClose = () => {
            if (!res.writableEnded && !upStream.closed && !upStream.destroyed) {
              upStream.close(http2.constants.NGHTTP2_CANCEL);
            }
          };
          res.on('close', onResClose);

          const handleUpstreamFailure = async (err) => {
            if (failureHandled) return;
            failureHandled = true;
            try {
              res.removeListener('close', onResClose);
              req.unpipe(upStream);
              if (!headersReceived && allowRetry && canRetryMethod) {
                upstream.dropH2Client(client);
                const refreshedInfo = await upstream.getTargetInfo(true);
                const nextTarget = resolveForwardTarget(refreshedInfo, 0);
                if (nextTarget.port) {
                  forward(nextTarget, false);
                  return;
                }
              }
              sendPlainError(res, 502, `Upstream error: ${err.message}`);
            } catch {
              if (!res.destroyed) res.destroy();
            }
          };

          upStream.on('end', () => {
            streamEnded = true;
          });

          upStream.on('response', (headers) => {
            headersReceived = true;
            const status = Number(headers[':status'] || 502);
            const respHeaders = cleanUpstreamHeaders(headers);
            applyCorsAndLocation(respHeaders, clientOrigin, clientHost, portToUse);
            appendSetCookie(respHeaders, authResult.setCookie);

            const contentType = String(respHeaders['content-type'] || '').toLowerCase();
            const wantMobilePatch = isSpaMobilePatch && status === 200 && contentType.includes('text/html');
            const wantCsrfPatch =
              isHtmlCandidate && Boolean(target.csrfToken) && status === 200 && contentType.includes('text/html');
            const wantHtmlPatch = wantMobilePatch || wantCsrfPatch;
            const streamEncoding = pickEncoding(req.headers['accept-encoding'], { preferZstd: true });
            const rawLen = respHeaders['content-length'];
            const parsedLen = rawLen !== undefined ? Number(rawLen) : NaN;
            const isSmallUnaryRpc =
              Number.isFinite(parsedLen) && parsedLen > 512 && parsedLen <= UNARY_RPC_COMPRESS_LIMIT;
            const isCompressibleRpcType =
              contentType.includes('grpc-web') ||
              contentType.includes('connect+json') ||
              contentType.includes('application/json');
            const wantUnaryRpcCompress =
              !wantHtmlPatch &&
              req.method !== 'HEAD' &&
              status !== 204 &&
              status !== 304 &&
              !respHeaders['content-encoding'] &&
              isCompressibleRpcType &&
              streamEncoding !== 'identity' &&
              isSmallUnaryRpc;

            if (wantHtmlPatch && Number.isFinite(parsedLen) && parsedLen > MAX_HTML_BUFFER_BYTES) {
              res.writeHead(status, respHeaders);
              upStream.pipe(res);
              return;
            }

            const wantStreamRpcGzip =
              !wantHtmlPatch &&
              !wantUnaryRpcCompress &&
              isCompressibleRpcType &&
              req.method !== 'HEAD' &&
              status === 200 &&
              !respHeaders['content-encoding'] &&
              !respHeaders['connect-content-encoding'] &&
              acceptsEncodingToken(String(req.headers['accept-encoding'] || '').toLowerCase(), 'gzip');

            if (wantStreamRpcGzip) {
              delete respHeaders['content-length'];
              delete respHeaders.etag;
              respHeaders['content-encoding'] = 'gzip';
              respHeaders.vary = respHeaders.vary ? `${respHeaders.vary}, Accept-Encoding` : 'Accept-Encoding';
              res.writeHead(status, respHeaders);
              const gzip = zlib.createGzip({ level: 4, flush: zlib.constants.Z_SYNC_FLUSH });
              const destroyGzip = () => {
                if (!gzip.destroyed) gzip.destroy();
              };
              res.once('close', destroyGzip);
              upStream.once('error', destroyGzip);
              gzip.once('error', () => {
                if (!res.destroyed) res.destroy();
              });
              upStream.pipe(gzip).pipe(res);
              return;
            }

            if (!wantHtmlPatch && !wantUnaryRpcCompress) {
              res.writeHead(status, respHeaders);
              upStream.pipe(res);
              return;
            }

            const maxBuffer = wantHtmlPatch ? MAX_HTML_BUFFER_BYTES : UNARY_RPC_COMPRESS_LIMIT;
            const chunks = [];
            let totalBytes = 0;
            let overflowed = false;

            const onData = (c) => {
              if (overflowed) return;
              totalBytes += c.length;
              if (totalBytes > maxBuffer) {
                overflowed = true;
                upStream.removeListener('data', onData);
                upStream.removeListener('end', onEnd);
                if (!res.destroyed && !res.writableEnded) {
                  res.writeHead(status, respHeaders);
                  for (const prev of chunks) res.write(prev);
                  res.write(c);
                  chunks.length = 0;
                  upStream.pipe(res);
                }
                return;
              }
              chunks.push(c);
            };

            const onEnd = async () => {
              if (overflowed || res.destroyed || res.writableEnded) return;
              try {
                let buf = Buffer.concat(chunks);
                const encoding = pickEncoding(req.headers['accept-encoding'], { preferZstd: true });
                if (wantHtmlPatch) {
                  const enc = String(respHeaders['content-encoding'] || '').toLowerCase();
                  try {
                    if (enc === 'gzip') buf = await gunzipAsync(buf);
                    else if (enc === 'br') buf = await brotliDecompressAsync(buf);
                    else if (enc === 'deflate') buf = await inflateAsync(buf);
                  } catch {
                    // Leave buf as-is if decompression fails
                  }
                  if (res.destroyed || res.writableEnded) return;
                  delete respHeaders['content-encoding'];
                  delete respHeaders.etag;

                  const rawHash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
                  const memoKey = `${rawHash}|${wantCsrfPatch ? target.csrfToken : ''}|${wantMobilePatch ? '1' : '0'}|${wantMobilePatch ? assetVersionsKey : ''}|${encoding}`;
                  const memoHit = rootHtmlMemo.get(memoKey);
                  if (memoHit) {
                    if (encoding !== 'identity') {
                      respHeaders['content-encoding'] = encoding;
                      respHeaders.vary = respHeaders.vary ? `${respHeaders.vary}, Accept-Encoding` : 'Accept-Encoding';
                    }
                    if (memoHit.shellHash) {
                      respHeaders['x-agy-shell-hash'] = memoHit.shellHash;
                    }
                    respHeaders['content-length'] = String(memoHit.out.length);
                    res.writeHead(status, respHeaders);
                    res.end(memoHit.out);
                    return;
                  }

                  let html = buf.toString('utf8');
                  if (wantCsrfPatch) html = injectCsrfToken(html, target.csrfToken);
                  const patchedSpaShell = wantMobilePatch && isSpaShellHtml(html);
                  if (patchedSpaShell) {
                    html = injectMobileHead(html, assetVersions, { css: MOBILE_CSS, js: MOBILE_JS });
                  }
                  const shellHash = patchedSpaShell
                    ? crypto
                        .createHash('sha256')
                        .update(
                          `${rawHash}|${wantCsrfPatch ? target.csrfToken : ''}|${assetVersionsKey}|${mobileCssEntry.etag}|${mobileJsEntry.etag}`,
                        )
                        .digest('hex')
                        .slice(0, 16)
                    : '';
                  buf = Buffer.from(html, 'utf8');
                  const out = buf.length > 512 && encoding !== 'identity' ? await compressBufferAsync(buf, encoding) : buf;
                  if (res.destroyed || res.writableEnded) return;
                  if (rootHtmlMemo.size >= 8) rootHtmlMemo.clear();
                  rootHtmlMemo.set(memoKey, { out, shellHash });
                  if (out !== buf && encoding !== 'identity') {
                    respHeaders['content-encoding'] = encoding;
                    respHeaders.vary = respHeaders.vary ? `${respHeaders.vary}, Accept-Encoding` : 'Accept-Encoding';
                  }
                  if (shellHash) {
                    respHeaders['x-agy-shell-hash'] = shellHash;
                  }
                  respHeaders['content-length'] = String(out.length);
                  res.writeHead(status, respHeaders);
                  res.end(out);
                  return;
                }

                if (buf.length > 512 && encoding !== 'identity') {
                  const compressed = await compressBufferAsync(buf, encoding);
                  if (res.destroyed || res.writableEnded) return;
                  respHeaders['content-encoding'] = encoding;
                  respHeaders['content-length'] = String(compressed.length);
                  respHeaders.vary = respHeaders.vary ? `${respHeaders.vary}, Accept-Encoding` : 'Accept-Encoding';
                  delete respHeaders.etag;
                  res.writeHead(status, respHeaders);
                  res.end(compressed);
                } else {
                  respHeaders['content-length'] = String(buf.length);
                  res.writeHead(status, respHeaders);
                  res.end(buf);
                }
              } catch {
                if (!res.destroyed) res.destroy();
              }
            };

            upStream.on('data', onData);
            upStream.on('end', onEnd);
          });

          upStream.on('error', (err) => {
            void handleUpstreamFailure(err);
          });

          upStream.on('aborted', () => {
            void handleUpstreamFailure(new Error('Upstream stream aborted'));
          });

          upStream.on('close', () => {
            res.removeListener('close', onResClose);
            if (!headersReceived && !failureHandled) {
              void handleUpstreamFailure(new Error('Upstream closed before response headers'));
              return;
            }
            if (headersReceived && !streamEnded && !failureHandled && !res.writableEnded && !res.destroyed) {
              res.destroy();
            }
          });

          if (reqEnded || (canRetryMethod && !req.headers['content-length'] && !req.headers['transfer-encoding'])) {
            upStream.end();
          } else {
            req.pipe(upStream);
          }
        };

        forward(initialTarget, true);
      } catch (err) {
        sendPlainError(res, 500, `Relay internal error: ${err?.message || 'Unknown error'}`);
      }
    },
  );

  server.on('connection', (socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, TCP_KEEPALIVE_MS);
    socket.on('error', () => {});
  });

  server.on('sessionError', () => {});

  server.on('session', (session) => {
    session.on('error', () => {});
    try {
      session.setLocalWindowSize(8 * 1024 * 1024);
    } catch {}
    attachH2SessionHeartbeat(session, (s) => {
      if (!s.destroyed) s.destroy();
    });
  });

  attachUpgradeHandler(server, {
    auth,
    opts,
    getActivePort: () => activePort,
    getTargetPort: upstream.getTargetPort,
    invalidateTargetCache: upstream.invalidateTargetCache,
  });

  server.on('error', (err) => {
    console.error(`Relay server error: ${err.message}`);
    process.exit(1);
  });

  const useH3Edge = Boolean(opts.http3 && fs.existsSync(opts.h3Bin));
  if (opts.http3 && !useH3Edge) {
    console.warn(`Warning: --http3 requested but edge binary not found at ${opts.h3Bin}; falling back to HTTP/2.`);
  }

  let h3Proc = null;
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down relay...`);
    const forceTimer = setTimeout(() => process.exit(0), 2000);
    forceTimer.unref?.();

    if (h3Proc && !h3Proc.killed) {
      try {
        h3Proc.kill('SIGTERM');
        const h3KillTimer = setTimeout(() => {
          if (h3Proc && !h3Proc.killed) {
            try {
              h3Proc.kill('SIGKILL');
            } catch {}
          }
        }, 1500);
        h3KillTimer.unref?.();
      } catch {}
    }

    upstream.close();
    localHttpAgent.destroy();
    localHttpsAgent.destroy();

    try {
      webPushManager.dispose();
    } catch {}

    try {
      const bridge = await Promise.race([
        getContextBridge(),
        new Promise((resolve) => setTimeout(() => resolve(null), 200)),
      ]);
      if (bridge && typeof bridge.dispose === 'function') {
        bridge.dispose();
      }
    } catch {}

    server.close(() => {
      clearTimeout(forceTimer);
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const listenHost = useH3Edge ? '127.0.0.1' : bindIp;
  const listenPort = useH3Edge ? 0 : opts.port;

  server.listen(listenPort, listenHost, async () => {
    try {
      const addr = server.address();
      const internalPort = typeof addr === 'object' && addr ? addr.port : opts.port;
      const publicPort = useH3Edge ? opts.port : internalPort;
      activePort = publicPort;
      if (!useH3Edge && publicPort !== opts.port) {
        const updatedSetupHtml = renderSetupHtml(bindIp, publicPort);
        const updatedSetupEntry = await createStaticAssetEntry(
          updatedSetupHtml,
          'text/html; charset=utf-8',
          {},
          { lastModified: startupLastModified },
        );
        localStaticRoutes.set('/setup', updatedSetupEntry);
      }

      if (useH3Edge) {
        h3Proc = spawn(
          opts.h3Bin,
          [
            '--listen',
            `${bindIp}:${publicPort}`,
            '--backend',
            `127.0.0.1:${internalPort}`,
            '--cert',
            opts.cert,
            '--key',
            opts.key,
          ],
          { stdio: 'inherit' },
        );
        h3Proc.on('exit', (code, sig) => {
          if (!shuttingDown) {
            console.error(`agy-h3-edge exited unexpectedly (code=${code}, signal=${sig})`);
            process.exit(1);
          }
        });
        h3Proc.on('error', (err) => {
          if (!shuttingDown) {
            console.error(`agy-h3-edge process error: ${err?.message || err}`);
            process.exit(1);
          }
        });
      }

      const detected = await upstream.getTargetPort(true);
      console.log(
        useH3Edge
          ? `Antigravity Local Relay listening on https://${bindIp}:${publicPort}/ (HTTP/3 QUIC + WebTransport + HTTP/2 + zstd/Brotli + PWA)`
          : `Antigravity Local Relay listening on https://${bindIp}:${publicPort}/ (HTTP/2 + zstd/Brotli + PWA)`,
      );
      console.log(`CA Setup Page: https://${bindIp}:${publicPort}/setup`);
      console.log(
        detected
          ? `Forwarding to local language_server on https://127.0.0.1:${detected}`
          : 'Warning: no running language_server detected yet (will auto-discover on first request).',
      );
      if (auth.enabled) {
        console.log(`Basic Auth User: ${auth.user}`);
        console.log(opts.pass ? 'Basic Auth Pass: <configured via env/flag>' : `Basic Auth Pass: ${auth.password}`);
      } else {
        console.log('WARNING: Authentication is DISABLED (--no-auth, EasyTier bind only).');
      }
      setTimeout(upstream.prewarmStaticCache, 300).unref();
      setTimeout(() => {
        getContextBridge()
          .then((b) => b?.getMetrics?.({}))
          .catch(() => {});
      }, 600).unref();
      webPushManager.ensureMonitorStarted();
    } catch (err) {
      console.error(`Relay startup hook error: ${err?.message || err}`);
    }
  });
}

const isMain =
  Boolean(process.argv[1]) &&
  (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href ||
    (() => {
      try {
        return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
      } catch {
        return false;
      }
    })());

if (isMain) {
  main().catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  });
}
