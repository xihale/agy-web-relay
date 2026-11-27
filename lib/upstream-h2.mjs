import http2 from 'node:http2';
import { CACHEABLE_PATHS, LONG_LIVED_STATIC_PATHS } from './constants.mjs';
import { discoverTargetInfo } from './cli-tls.mjs';
import { attachH2SessionHeartbeat, cleanUpstreamHeaders } from './local-proxy.mjs';
import { computeContentEtag, ensureEntryEncoding, isCompressibleAsset } from './static-cache.mjs';

/**
 * Manages language_server target discovery, persistent HTTP/2 upstream sessions,
 * and coalesced upstream static asset caching.
 */
export function createUpstreamManager({ opts }) {
  let cachedTargetInfo = { port: 0, httpPort: 0, pid: 0, csrfToken: '' };
  let cachedAt = 0;
  let inFlightDiscovery = null;
  let h2Session = null;
  let h2SessionPort = 0;
  let detachH2Heartbeat = null;

  const staticCache = new Map();
  const inFlightStatic = new Map();

  async function getTargetInfo(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && cachedTargetInfo.port > 0 && now - cachedAt < 5000) {
      if (opts.targetPort === 0 || cachedTargetInfo.port === opts.targetPort) {
        return cachedTargetInfo;
      }
    }
    if (!inFlightDiscovery) {
      inFlightDiscovery = (async () => {
        try {
          const info = await discoverTargetInfo(opts.targetPort);
          if (info.port > 0 || forceRefresh) {
            cachedTargetInfo = info;
            cachedAt = Date.now();
          }
          return info;
        } finally {
          inFlightDiscovery = null;
        }
      })();
    }
    return inFlightDiscovery;
  }

  async function getTargetPort(forceRefresh = false) {
    if (opts.targetPort > 0) return opts.targetPort;
    const info = await getTargetInfo(forceRefresh);
    return info.port;
  }

  function invalidateTargetCache() {
    cachedAt = 0;
  }

  function getCachedTargetPort() {
    return opts.targetPort || cachedTargetInfo.port;
  }

  function detachH2Client(session) {
    if (h2Session === session) {
      h2Session = null;
      h2SessionPort = 0;
      if (detachH2Heartbeat) {
        detachH2Heartbeat();
        detachH2Heartbeat = null;
      }
    }
  }

  function dropH2Client(session) {
    detachH2Client(session);
    cachedAt = 0;
    for (const entry of staticCache.values()) {
      entry.checkedAt = 0;
    }
    if (session && !session.destroyed) {
      session.destroy();
    }
  }

  function getH2Client(port) {
    if (h2Session && !h2Session.closed && !h2Session.destroyed && h2SessionPort === port) {
      return h2Session;
    }
    if (h2Session) dropH2Client(h2Session);
    const session = http2.connect(`https://127.0.0.1:${port}`, {
      rejectUnauthorized: false,
      settings: {
        initialWindowSize: 4 * 1024 * 1024,
        maxFrameSize: 65536,
        maxConcurrentStreams: 256,
      },
    });
    h2Session = session;
    h2SessionPort = port;
    detachH2Heartbeat = attachH2SessionHeartbeat(session, dropH2Client);
    session.on('error', () => dropH2Client(session));
    session.on('frameError', () => dropH2Client(session));
    session.on('close', () => detachH2Client(session));
    session.on('goaway', () => {
      detachH2Client(session);
      if (!session.closed && !session.destroyed) {
        try {
          session.close();
        } catch {
          if (!session.destroyed) session.destroy();
        }
      }
    });
    return session;
  }

  async function buildStaticEntryFromUpstream(pathname, etag, lastModified, contentType, buf, prewarmAll = false) {
    const extraHeaders = LONG_LIVED_STATIC_PATHS.has(pathname)
      ? { 'cache-control': 'public, max-age=86400, stale-while-revalidate=604800' }
      : {};
    const entry = {
      etag: etag || computeContentEtag(buf),
      upstreamEtag: etag || '',
      lastModified: lastModified || '',
      contentType: contentType || 'application/octet-stream',
      raw: buf,
      br: null,
      gz: null,
      zstd: null,
      extraHeaders,
      checkedAt: Date.now(),
    };
    if (prewarmAll && isCompressibleAsset(entry.contentType, buf.length)) {
      const diskMeta = { pathname, key: entry.upstreamEtag || entry.etag };
      await Promise.all([
        ensureEntryEncoding(entry, 'br', diskMeta).catch(() => {}),
        ensureEntryEncoding(entry, 'gzip', diskMeta).catch(() => {}),
      ]);
    }
    return entry;
  }

  async function revalidateOrFetchStatic(pathname, cachedEntry, prewarmAll = false) {
    const initialPort = await getTargetPort(false);
    if (!initialPort) return { kind: 'no-target' };

    const attemptFetch = (portToUse, allowRetry) =>
      new Promise((resolve) => {
        let client;
        let upStream;
        try {
          client = getH2Client(portToUse);
          const upHeaders = {
            ':method': 'GET',
            ':path': pathname,
            ':authority': `127.0.0.1:${portToUse}`,
            ':scheme': 'https',
            'accept-encoding': 'identity',
          };
          if (cachedEntry?.upstreamEtag) upHeaders['if-none-match'] = cachedEntry.upstreamEtag;
          if (cachedEntry?.lastModified) upHeaders['if-modified-since'] = cachedEntry.lastModified;
          upStream = client.request(upHeaders);
          upStream.end();
        } catch (err) {
          if (allowRetry) {
            if (client) dropH2Client(client);
            getTargetPort(true)
              .then((refreshed) => {
                const nextPort = refreshed || (opts.targetPort > 0 ? opts.targetPort : 0);
                if (nextPort > 0) resolve(attemptFetch(nextPort, false));
                else resolve({ kind: 'error', err });
              })
              .catch((retryErr) => {
                resolve({ kind: 'error', err: retryErr });
              });
            return;
          }
          resolve({ kind: 'error', err });
          return;
        }

        let headersReceived = false;
        let settled = false;
        let streamEnded = false;

        const handleStaticFailure = async (err) => {
          if (settled) return;
          settled = true;
          try {
            if (!headersReceived && allowRetry) {
              dropH2Client(client);
              const refreshed = await getTargetPort(true);
              const nextPort = refreshed || (opts.targetPort > 0 ? opts.targetPort : 0);
              if (nextPort > 0) {
                resolve(attemptFetch(nextPort, false));
                return;
              }
            }
            resolve({ kind: 'error', err });
          } catch (retryErr) {
            resolve({ kind: 'error', err: retryErr });
          }
        };

        upStream.on('response', (headers) => {
          headersReceived = true;
          const status = Number(headers[':status'] || 502);
          if (status === 304 && cachedEntry) {
            settled = true;
            upStream.resume();
            cachedEntry.checkedAt = Date.now();
            if (headers.etag) {
              cachedEntry.upstreamEtag = headers.etag;
              cachedEntry.etag = headers.etag;
            }
            if (headers['last-modified']) {
              cachedEntry.lastModified = headers['last-modified'];
            }
            resolve({ kind: 'entry', entry: cachedEntry });
            return;
          }

          const chunks = [];
          upStream.on('data', (c) => chunks.push(c));
          upStream.on('end', async () => {
            streamEnded = true;
            settled = true;
            try {
              const buf = Buffer.concat(chunks);
              if (status === 200) {
                const entry = await buildStaticEntryFromUpstream(
                  pathname,
                  headers.etag || '',
                  headers['last-modified'] || '',
                  headers['content-type'] || 'application/octet-stream',
                  buf,
                  prewarmAll,
                );
                staticCache.set(pathname, entry);
                resolve({ kind: 'entry', entry });
              } else {
                resolve({ kind: 'passthrough', status, headers: cleanUpstreamHeaders(headers), body: buf });
              }
            } catch (err) {
              resolve({ kind: 'error', err });
            }
          });
        });

        upStream.on('error', (err) => {
          void handleStaticFailure(err);
        });

        upStream.on('close', () => {
          if (!settled && (!headersReceived || !streamEnded)) {
            void handleStaticFailure(new Error('Upstream static fetch closed prematurely'));
          }
        });
      });

    return attemptFetch(initialPort, true);
  }

  function fetchStaticCoalesced(pathname, cachedEntry = null, prewarmAll = false) {
    let pending = inFlightStatic.get(pathname);
    if (!pending) {
      pending = revalidateOrFetchStatic(pathname, cachedEntry, prewarmAll).finally(() => {
        inFlightStatic.delete(pathname);
      });
      inFlightStatic.set(pathname, pending);
    }
    return pending;
  }

  function prewarmStaticCache() {
    for (const pathname of CACHEABLE_PATHS) {
      if (staticCache.has(pathname)) continue;
      fetchStaticCoalesced(pathname, null, true).catch(() => {});
    }
  }

  function close() {
    if (h2Session) {
      const session = h2Session;
      detachH2Client(session);
      if (!session.destroyed) session.destroy();
    }
  }

  return {
    getTargetInfo,
    getTargetPort,
    invalidateTargetCache,
    getCachedTargetPort,
    getH2Client,
    dropH2Client,
    getCachedStatic: (pathname) => staticCache.get(pathname),
    fetchStaticCoalesced,
    prewarmStaticCache,
    close,
  };
}
