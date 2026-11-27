import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import zlib from 'node:zlib';

const DEFAULT_SUBJECT = 'mailto:agy-relay@localhost';
const CONNECT_SUMMARY_PATH = '/exa.language_server_pb.LanguageServerService/JetboxSubscribeToSummaries';
const MONITOR_BACKOFF_MS = [2000, 4000, 8000, 15000, 30000];
const MAX_PAYLOAD_BYTES = 3600;
const MAX_SEEN_WAITING = 1000;

export function toBase64Url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function fromBase64Url(str) {
  if (typeof str !== 'string' || !str) return Buffer.alloc(0);
  return Buffer.from(str, 'base64url');
}

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
}

export function generateVapidKeys(subject = DEFAULT_SUBJECT) {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateKeyJwk = privateKey.export({ format: 'jwk' });
  const x = fromBase64Url(privateKeyJwk.x);
  const y = fromBase64Url(privateKeyJwk.y);
  if (x.length !== 32 || y.length !== 32) {
    throw new Error('Unexpected P-256 coordinate length');
  }
  const publicKeyRaw = Buffer.concat([Buffer.from([0x04]), x, y]);
  return {
    subject,
    publicKey: toBase64Url(publicKeyRaw),
    privateKeyJwk,
  };
}

function isValidVapid(vapid) {
  if (!vapid || typeof vapid !== 'object') return false;
  if (typeof vapid.publicKey !== 'string' || !vapid.privateKeyJwk) return false;
  try {
    const pub = fromBase64Url(vapid.publicKey);
    if (pub.length !== 65 || pub[0] !== 0x04) return false;
    crypto.createPrivateKey({ key: vapid.privateKeyJwk, format: 'jwk' });
    return true;
  } catch {
    return false;
  }
}

export function buildVapidAuthHeader(endpoint, vapid, nowSec = Math.floor(Date.now() / 1000)) {
  const u = new URL(endpoint);
  const headerB64 = toBase64Url(Buffer.from('{"typ":"JWT","alg":"ES256"}', 'utf8'));
  const payloadB64 = toBase64Url(
    Buffer.from(
      JSON.stringify({
        aud: u.origin,
        exp: nowSec + 12 * 3600,
        sub: vapid.subject || DEFAULT_SUBJECT,
      }),
      'utf8',
    ),
  );
  const signingInput = `${headerB64}.${payloadB64}`;
  const keyObj = crypto.createPrivateKey({ key: vapid.privateKeyJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: keyObj,
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${signingInput}.${toBase64Url(sig)}, k=${vapid.publicKey}`;
}

export function validateSubscriptionInput(sub) {
  if (!sub || typeof sub !== 'object') {
    throw new Error('Missing subscription object');
  }
  const rawEndpoint = typeof sub.endpoint === 'string' ? sub.endpoint.trim() : '';
  if (!rawEndpoint) throw new Error('Missing subscription endpoint');
  let parsedUrl;
  try {
    parsedUrl = new URL(rawEndpoint);
  } catch {
    throw new Error('Invalid subscription endpoint URL');
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('Subscription endpoint must use HTTPS');
  }
  const p256dh = typeof sub.keys?.p256dh === 'string' ? sub.keys.p256dh.trim() : '';
  const auth = typeof sub.keys?.auth === 'string' ? sub.keys.auth.trim() : '';
  const uaPub = fromBase64Url(p256dh);
  const authBuf = fromBase64Url(auth);
  if (uaPub.length !== 65 || uaPub[0] !== 0x04) {
    throw new Error('Invalid p256dh public key');
  }
  if (authBuf.length < 16) {
    throw new Error('Invalid auth secret');
  }
  return {
    endpoint: parsedUrl.href,
    keys: { p256dh, auth },
  };
}

/**
 * Encrypt a Web Push payload per RFC 8291 (aes128gcm content coding).
 */
export function encryptWebPushPayload(subscription, payload) {
  const valid = validateSubscriptionInput(subscription);
  const uaPublic = fromBase64Url(valid.keys.p256dh);
  const authSecret = fromBase64Url(valid.keys.auth);
  const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'ascii'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));

  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), 16),
  );
  const nonce = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'ascii'), 12),
  );

  // RFC 8188 final record delimiter byte 0x02
  const record = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(record), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = Buffer.alloc(21 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  asPublic.copy(header, 21);

  return Buffer.concat([header, encrypted, tag]);
}

function encodeBoundedPayload(payloadObj) {
  const clone = { ...payloadObj };
  let buf = Buffer.from(JSON.stringify(clone), 'utf8');
  if (buf.length <= MAX_PAYLOAD_BYTES) return buf;
  if (typeof clone.body === 'string') {
    let text = clone.body;
    while (buf.length > MAX_PAYLOAD_BYTES && text.length > 16) {
      text = `${text.slice(0, Math.floor(text.length * 0.7))}…`;
      clone.body = text;
      buf = Buffer.from(JSON.stringify(clone), 'utf8');
    }
  }
  return buf;
}

export async function sendWebPushToSubscription(
  subscription,
  payloadObj,
  vapid,
  { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {},
) {
  const encoded = encodeBoundedPayload(payloadObj);
  const encryptedBody = encryptWebPushPayload(subscription, encoded);
  const authHeader = buildVapidAuthHeader(subscription.endpoint, vapid);

  const resp = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(encryptedBody.length),
      TTL: '86400',
      Urgency: 'high',
    },
    body: encryptedBody,
    signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
  });

  if (resp.status >= 200 && resp.status < 300) {
    return { ok: true, status: resp.status, gone: false, error: '' };
  }
  const detail = await resp.text().catch(() => '');
  const trimmed = detail.replace(/\s+/g, ' ').trim().slice(0, 180);
  const gone = resp.status === 404 || resp.status === 410;
  return {
    ok: false,
    status: resp.status,
    gone,
    error: trimmed ? `HTTP ${resp.status}: ${trimmed}` : `HTTP ${resp.status}`,
  };
}

export function inferDeviceLabel(userAgent = '', explicitLabel = '') {
  const custom = typeof explicitLabel === 'string' ? explicitLabel.trim().slice(0, 64) : '';
  if (custom) return custom;
  const ua = String(userAgent || '');
  let osLabel = '未知设备';
  if (/iPhone/i.test(ua)) osLabel = 'iPhone';
  else if (/iPad/i.test(ua)) osLabel = 'iPad';
  else if (/Android/i.test(ua)) osLabel = 'Android';
  else if (/Mac OS X|Macintosh/i.test(ua)) osLabel = 'macOS';
  else if (/Windows/i.test(ua)) osLabel = 'Windows';
  else if (/Linux/i.test(ua)) osLabel = 'Linux';

  let browserLabel = '';
  if (/Edg/i.test(ua)) browserLabel = 'Edge';
  else if (/Chrome|CriOS/i.test(ua)) browserLabel = 'Chrome';
  else if (/Firefox|FxiOS/i.test(ua)) browserLabel = 'Firefox';
  else if (/Safari/i.test(ua)) browserLabel = 'Safari';

  return browserLabel ? `${osLabel} · ${browserLabel}` : osLabel;
}

function summarizeStepWaiting(trajectoryId, summary, waitingStep) {
  const stepObj = waitingStep?.step || {};
  const cascadeId = stepObj.metadata?.sourceTrajectoryStepInfo?.cascadeId || trajectoryId;
  let title = '需要你的操作';
  let body = 'Agent 正在等待你的确认或输入';

  if (stepObj.runCommand) {
    title = '需要终端执行权限';
    body = stepObj.runCommand.commandLine ? `命令: ${stepObj.runCommand.commandLine}` : '请确认是否允许运行终端命令';
  } else if (stepObj.openBrowserUrl) {
    title = '需要打开网页权限';
    body = stepObj.openBrowserUrl.url ? `URL: ${stepObj.openBrowserUrl.url}` : '请确认是否允许打开网页';
  } else if (stepObj.askQuestion) {
    const qs = Array.isArray(stepObj.askQuestion.questions) ? stepObj.askQuestion.questions : [];
    title = qs.length > 1 ? 'Agent 有多个问题需要回答' : 'Agent 有问题需要回答';
    body = qs[0]?.question || '点击回到会话查看并回复';
  } else {
    const inter = stepObj.requestedInteraction;
    const permTarget =
      inter?.permission?.resource?.target ||
      inter?.filePermission?.absolutePathUri ||
      inter?.interaction?.value?.resource?.target ||
      inter?.interaction?.value?.absolutePathUri;
    if (permTarget) {
      title = '需要权限确认';
      body = String(permTarget);
    } else if (summary?.summary) {
      body = `等待处理: ${summary.summary}`;
    }
  }

  return {
    type: 'waiting',
    title,
    body,
    tag: `agy-waiting-${cascadeId}-${waitingStep.stepIndex}`,
    cascadeId,
    url: `/c/${encodeURIComponent(cascadeId)}`,
  };
}

function isHiddenSummary(sum) {
  return Boolean(sum?.trajectoryMetadata?.sourceMetadata?.hideFromConversationList);
}

function isActiveWaitingStatus(sum) {
  return (
    sum?.status === 'CASCADE_RUN_STATUS_RUNNING' ||
    sum?.status === 'CASCADE_RUN_STATUS_BUSY' ||
    Boolean(sum?.hasActiveChildren)
  );
}

export function createSummaryNotificationTracker(onNotify) {
  let hasSeeded = false;
  const activeTrajectories = new Set();
  const seenWaitingSteps = new Set();

  const rememberWaiting = (key) => {
    if (seenWaitingSteps.has(key)) return false;
    seenWaitingSteps.add(key);
    if (seenWaitingSteps.size > MAX_SEEN_WAITING) {
      const oldest = seenWaitingSteps.values().next().value;
      if (oldest !== undefined) seenWaitingSteps.delete(oldest);
    }
    return true;
  };

  return {
    resetSeed() {
      // Keep activeTrajectories/seenWaitingSteps across brief LS reconnects once seeded
    },
    processFrame(msg) {
      if (!msg || typeof msg !== 'object') return;
      const updates = msg.updates && typeof msg.updates === 'object' ? Object.entries(msg.updates) : [];
      const deletes = Array.isArray(msg.deletes) ? msg.deletes : [];

      if (!hasSeeded) {
        hasSeeded = true;
        for (const [id, sum] of updates) {
          if (!sum || isHiddenSummary(sum)) continue;
          if (sum.notFullyIdle) activeTrajectories.add(id);
          if (isActiveWaitingStatus(sum) && Array.isArray(sum.waitingSteps)) {
            for (const ws of sum.waitingSteps) {
              if (ws && ws.stepIndex !== undefined && ws.stepIndex !== null) {
                rememberWaiting(`${id}-${ws.stepIndex}`);
              }
            }
          }
        }
        return;
      }

      for (const [id, sum] of updates) {
        if (!sum || isHiddenSummary(sum)) continue;

        if (sum.notFullyIdle) {
          activeTrajectories.add(id);
        } else if (activeTrajectories.has(id)) {
          activeTrajectories.delete(id);
          const isSubagent = Boolean(sum.trajectoryMetadata?.parentConversationId);
          const isCanceled = sum.latestExecutorTerminationReason === 'EXECUTOR_TERMINATION_REASON_USER_CANCELED';
          if (!isSubagent && !isCanceled) {
            const label = sum.annotations?.title || sum.summary || '';
            onNotify?.({
              type: 'finished',
              title: 'Antigravity',
              body: label ? `已完成: ${label}` : 'Agent 任务已完成',
              tag: `agy-finished-${id}`,
              cascadeId: id,
              url: `/c/${encodeURIComponent(id)}`,
            });
          }
        }

        if (isActiveWaitingStatus(sum) && Array.isArray(sum.waitingSteps)) {
          for (const ws of sum.waitingSteps) {
            if (!ws || ws.stepIndex === undefined || ws.stepIndex === null) continue;
            const key = `${id}-${ws.stepIndex}`;
            if (rememberWaiting(key)) {
              onNotify?.(summarizeStepWaiting(id, sum, ws));
            }
          }
        }
      }

      for (const id of deletes) {
        activeTrajectories.delete(id);
      }
    },
    getStats() {
      return {
        hasSeeded,
        activeCount: activeTrajectories.size,
        seenWaitingCount: seenWaitingSteps.size,
      };
    },
  };
}

export function createWebPushManager({
  configDir,
  getTargetInfo,
  onNotifyPrewarm,
  fetchImpl = globalThis.fetch,
  log = console.log,
  warn = console.warn,
} = {}) {
  const statePath = path.join(configDir, 'web-push.json');
  let state = { vapid: null, subscriptions: [] };

  const loadState = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (isValidVapid(raw.vapid)) state.vapid = raw.vapid;
        if (Array.isArray(raw.subscriptions)) {
          state.subscriptions = raw.subscriptions.filter((item) => {
            try {
              validateSubscriptionInput(item);
              return true;
            } catch {
              return false;
            }
          });
        }
      }
    } catch {}
    if (!state.vapid) {
      state.vapid = generateVapidKeys(DEFAULT_SUBJECT);
      saveState();
    }
  };

  const saveState = () => {
    writeFileAtomic(statePath, JSON.stringify(state, null, 2));
  };

  loadState();

  let disposed = false;
  let monitorRunning = false;
  let monitorReq = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;

  const tracker = createSummaryNotificationTracker((eventPayload) => {
    if (disposed) return;
    if (eventPayload?.cascadeId && typeof onNotifyPrewarm === 'function') {
      Promise.resolve(onNotifyPrewarm(eventPayload.cascadeId)).catch(() => {});
    }
    if (state.subscriptions.length === 0) return;
    void broadcast(eventPayload).catch((err) => {
      warn?.(`[web-push] broadcast error: ${err?.message || err}`);
    });
  });

  const clearReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const stopMonitor = () => {
    monitorRunning = false;
    clearReconnectTimer();
    if (monitorReq) {
      try {
        monitorReq.destroy();
      } catch {}
      monitorReq = null;
    }
  };

  const scheduleReconnect = () => {
    if (disposed || !monitorRunning || state.subscriptions.length === 0) return;
    if (reconnectTimer) return;
    const idx = Math.min(reconnectAttempt++, MONITOR_BACKOFF_MS.length - 1);
    const delay = MONITOR_BACKOFF_MS[idx];
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectMonitor();
    }, delay);
    reconnectTimer.unref?.();
  };

  const connectMonitor = async () => {
    if (disposed || !monitorRunning || monitorReq || state.subscriptions.length === 0) return;
    let info = null;
    try {
      info = typeof getTargetInfo === 'function' ? await getTargetInfo(true) : null;
    } catch {
      info = null;
    }
    if (disposed || !monitorRunning || state.subscriptions.length === 0) return;

    const useHttp = Number.isInteger(info?.httpPort) && info.httpPort > 0 && info.httpPort <= 65535;
    const port = useHttp ? info.httpPort : Number(info?.port || 0);
    if (!port || !info?.csrfToken) {
      scheduleReconnect();
      return;
    }

    const reqPayload = Buffer.from('{}', 'utf8');
    const frame = Buffer.alloc(5 + reqPayload.length);
    frame[0] = 0;
    frame.writeUInt32BE(reqPayload.length, 1);
    reqPayload.copy(frame, 5);

    const transport = useHttp ? http : https;
    const reqOpts = {
      hostname: '127.0.0.1',
      port,
      method: 'POST',
      path: CONNECT_SUMMARY_PATH,
      headers: {
        'Content-Type': 'application/connect+json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': info.csrfToken,
      },
      ...(useHttp ? {} : { rejectUnauthorized: false }),
    };

    const req = transport.request(reqOpts, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        if (monitorReq === req) monitorReq = null;
        scheduleReconnect();
        return;
      }

      reconnectAttempt = 0;
      let buf = Buffer.alloc(0);

      res.on('data', (chunk) => {
        buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
        while (buf.length >= 5) {
          const flags = buf[0];
          const len = buf.readUInt32BE(1);
          if (buf.length < 5 + len) break;
          let body = buf.subarray(5, 5 + len);
          buf = buf.subarray(5 + len);
          try {
            if (flags & 0x01) {
              body = zlib.gunzipSync(body);
            }
            if (flags & 0x02) {
              continue;
            }
            const parsed = JSON.parse(body.toString('utf8'));
            tracker.processFrame(parsed);
          } catch {}
        }
      });

      res.on('end', () => {
        if (monitorReq === req) monitorReq = null;
        scheduleReconnect();
      });
      res.on('error', () => {
        if (monitorReq === req) monitorReq = null;
        scheduleReconnect();
      });
    });

    monitorReq = req;
    req.on('error', () => {
      if (monitorReq === req) monitorReq = null;
      scheduleReconnect();
    });
    req.end(frame);
  };

  const ensureMonitorStarted = () => {
    if (disposed || state.subscriptions.length === 0) return false;
    if (!monitorRunning) {
      monitorRunning = true;
      reconnectAttempt = 0;
      void connectMonitor();
    } else if (!monitorReq && !reconnectTimer) {
      void connectMonitor();
    }
    return true;
  };

  const subscribe = ({ subscription, deviceLabel = '', userAgent = '' } = {}) => {
    const valid = validateSubscriptionInput(subscription);
    const id = crypto.createHash('sha256').update(valid.endpoint).digest('hex').slice(0, 12);
    const now = Date.now();
    const label = inferDeviceLabel(userAgent, deviceLabel);
    const idx = state.subscriptions.findIndex((s) => s.endpoint === valid.endpoint);
    if (idx >= 0) {
      const prev = state.subscriptions[idx];
      state.subscriptions[idx] = {
        ...prev,
        id,
        endpoint: valid.endpoint,
        keys: valid.keys,
        deviceLabel: deviceLabel?.trim() ? label : prev.deviceLabel || label,
        userAgent: String(userAgent || prev.userAgent || '').slice(0, 240),
        updatedAt: now,
      };
    } else {
      state.subscriptions.push({
        id,
        endpoint: valid.endpoint,
        keys: valid.keys,
        deviceLabel: label,
        userAgent: String(userAgent || '').slice(0, 240),
        createdAt: now,
        updatedAt: now,
        lastSuccessAt: 0,
        lastError: '',
      });
    }
    saveState();
    ensureMonitorStarted();
    const record = state.subscriptions.find((s) => s.endpoint === valid.endpoint);
    log?.(`[web-push] subscribed device "${record.deviceLabel}" (${id}), total=${state.subscriptions.length}`);
    return { id: record.id, deviceLabel: record.deviceLabel, count: state.subscriptions.length };
  };

  const unsubscribe = ({ endpoint = '', id = '' } = {}) => {
    const before = state.subscriptions.length;
    state.subscriptions = state.subscriptions.filter((s) => {
      if (endpoint && s.endpoint === endpoint) return false;
      if (id && s.id === id) return false;
      return true;
    });
    const removed = before - state.subscriptions.length;
    if (removed > 0) {
      saveState();
      if (state.subscriptions.length === 0) stopMonitor();
    }
    return { removed, count: state.subscriptions.length };
  };

  const listDevices = (currentEndpoint = '') =>
    state.subscriptions.map((s) => ({
      id: s.id,
      deviceLabel: s.deviceLabel || '未命名设备',
      createdAt: s.createdAt || 0,
      updatedAt: s.updatedAt || 0,
      lastSuccessAt: s.lastSuccessAt || 0,
      lastError: s.lastError || '',
      isCurrent: Boolean(currentEndpoint && s.endpoint === currentEndpoint),
    }));

  const broadcast = async (payloadObj, { targetId = '' } = {}) => {
    const targets = targetId
      ? state.subscriptions.filter((s) => s.id === targetId)
      : [...state.subscriptions];
    if (targets.length === 0) {
      return { total: 0, sent: 0, failed: 0, pruned: 0, results: [] };
    }

    const settled = await Promise.all(
      targets.map(async (sub) => {
        try {
          const res = await sendWebPushToSubscription(sub, payloadObj, state.vapid, { fetchImpl });
          return { sub, res };
        } catch (err) {
          return {
            sub,
            res: { ok: false, status: 0, gone: false, error: err?.message || String(err) },
          };
        }
      }),
    );

    const now = Date.now();
    const goneEndpoints = new Set();
    let sent = 0;
    let failed = 0;
    const results = [];

    for (const { sub, res } of settled) {
      if (res.ok) {
        sent++;
        sub.lastSuccessAt = now;
        sub.lastError = '';
      } else {
        failed++;
        sub.lastError = res.error || `HTTP ${res.status}`;
        if (res.gone) goneEndpoints.add(sub.endpoint);
      }
      results.push({
        id: sub.id,
        deviceLabel: sub.deviceLabel,
        ok: res.ok,
        status: res.status,
        gone: res.gone,
        error: res.error,
      });
    }

    let pruned = 0;
    if (goneEndpoints.size > 0) {
      const before = state.subscriptions.length;
      state.subscriptions = state.subscriptions.filter((s) => !goneEndpoints.has(s.endpoint));
      pruned = before - state.subscriptions.length;
      if (state.subscriptions.length === 0) stopMonitor();
    }
    saveState();

    return { total: targets.length, sent, failed, pruned, results };
  };

  return {
    getPublicKey: () => state.vapid.publicKey,
    subscribe,
    unsubscribe,
    listDevices,
    broadcast,
    ensureMonitorStarted,
    isMonitorActive: () => monitorRunning && Boolean(monitorReq),
    dispose: () => {
      disposed = true;
      stopMonitor();
    },
  };
}
