import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

const STREAM_AGENT_STATE_PATH = '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates';

/**
 * Fetches and caches initial Connect-JSON snapshots for single conversations
 * so mobile Service Workers can pre-warm IndexedDB immediately on push arrival.
 */
export function createConvoSnapshotCache({
  getTargetInfo,
  maxEntries = 16,
  ttlMs = 120_000,
  timeoutMs = 4000,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();

  function setCached(cascadeId, buf) {
    if (cache.has(cascadeId)) cache.delete(cascadeId);
    else if (cache.size >= maxEntries) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    cache.set(cascadeId, { buf, at: Date.now() });
  }

  async function fetchSnapshot(cascadeId) {
    let info = null;
    try {
      info = typeof getTargetInfo === 'function' ? await getTargetInfo(false) : null;
      if (!info?.port && typeof getTargetInfo === 'function') {
        info = await getTargetInfo(true);
      }
    } catch {
      info = null;
    }

    const useHttp = Number.isInteger(info?.httpPort) && info.httpPort > 0 && info.httpPort <= 65535;
    const port = useHttp ? info.httpPort : Number(info?.port || 0);
    if (!port || !info?.csrfToken) return null;

    const reqPayload = Buffer.from(
      JSON.stringify({
        conversationId: cascadeId,
        subscriberId: `agy-relay-snap-${Date.now()}`,
        initialStepsPageBounds: { startIndex: -50 },
        initialGeneratorMetadatasPageBounds: { startIndex: -1 },
        initialExecutorMetadatasPageBounds: { startIndex: 0, endIndexExclusive: 0 },
        trajectoryVerbosity: 'CLIENT_TRAJECTORY_VERBOSITY_PROD_UI',
      }),
      'utf8',
    );
    const frame = Buffer.alloc(5 + reqPayload.length);
    frame[0] = 0;
    frame.writeUInt32BE(reqPayload.length, 1);
    reqPayload.copy(frame, 5);

    const transport = useHttp ? http : https;
    const reqOpts = {
      hostname: '127.0.0.1',
      port,
      method: 'POST',
      path: STREAM_AGENT_STATE_PATH,
      headers: {
        'Content-Type': 'application/connect+json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': info.csrfToken,
      },
      ...(useHttp ? {} : { rejectUnauthorized: false }),
    };

    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const req = transport.request(reqOpts, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          done(null);
          return;
        }
        let buf = Buffer.alloc(0);
        res.on('data', (chunk) => {
          if (settled) return;
          buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
          while (buf.length >= 5) {
            const flags = buf[0];
            const len = buf.readUInt32BE(1);
            if (buf.length < 5 + len) break;
            let body = buf.subarray(5, 5 + len);
            buf = buf.subarray(5 + len);
            if (flags & 0x02) continue;
            try {
              if (flags & 0x01) body = zlib.gunzipSync(body);
              const normalized = Buffer.from(JSON.stringify(JSON.parse(body.toString('utf8'))), 'utf8');
              setCached(cascadeId, normalized);
              done(normalized);
              req.destroy();
              return;
            } catch {
              done(null);
              req.destroy();
              return;
            }
          }
        });
        res.on('end', () => done(null));
        res.on('error', () => done(null));
      });

      const timer = setTimeout(() => {
        req.destroy();
        done(null);
      }, timeoutMs);
      timer.unref?.();

      req.on('error', () => done(null));
      req.end(frame);
    });
  }

  async function getSnapshot(cascadeId, { force = false } = {}) {
    if (!cascadeId || typeof cascadeId !== 'string') return null;
    if (!force) {
      const hit = cache.get(cascadeId);
      if (hit && Date.now() - hit.at < ttlMs) {
        cache.delete(cascadeId);
        cache.set(cascadeId, hit);
        return hit.buf;
      }
      if (hit) cache.delete(cascadeId);
    }
    let pending = inFlight.get(cascadeId);
    if (!pending) {
      pending = fetchSnapshot(cascadeId).finally(() => {
        inFlight.delete(cascadeId);
      });
      inFlight.set(cascadeId, pending);
    }
    return pending;
  }

  function warm(cascadeId) {
    if (!cascadeId) return Promise.resolve(null);
    return getSnapshot(cascadeId, { force: true }).catch(() => null);
  }

  return { getSnapshot, warm };
}
