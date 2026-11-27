  // Bypass same-origin no-cors priming fetch before WebSocket dial
  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      if (init && init.mode === 'no-cors') {
        try {
          const rawUrl = typeof input === 'string' ? input : input?.url;
          if (rawUrl) {
            const u = new URL(rawUrl, location.href);
            if (u.origin === location.origin && u.pathname === '/connect-websocket') {
              return Promise.resolve(new Response(null, { status: 200 }));
            }
          }
        } catch {}
      }
      return origFetch(input, init);
    };
  }

  // Overlap /connect-websocket (WebTransport over HTTP/3 QUIC + wss:// fallback) with /main.js download & parse
  let triggerSocketProbe = null;
  let triggerConvoPrefetch = null;
  let prewarmStandbyControlSocket = null;
  if (
    window === window.top &&
    typeof window.WebSocket === 'function' &&
    (location.protocol === 'https:' || location.protocol === 'http:')
  ) {
    const NativeWebSocket = window.WebSocket;
    const earlyWsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/connect-websocket';
    const wtUrl = 'https://' + location.host + '/wt-websocket';
    const canUseWT =
      location.protocol === 'https:' &&
      typeof window.WebTransport === 'function' &&
      typeof window.DecompressionStream === 'function' &&
      !/[?&]no-wt=1(?:&|$)/.test(location.search);

    const WT_FAIL_KEY = 'agy_relay_wt_fail_until';
    try {
      if (Number(localStorage.getItem(WT_FAIL_KEY) || 0) > Date.now()) {
        window.__agyWtDisabled = true;
      }
    } catch {}

    const CONVO_UUID_RE = /^\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:$|[/?#])/i;
    const bootMatch = CONVO_UUID_RE.exec(location.pathname || '');
    const bootCascadeId = bootMatch ? bootMatch[1] : '';
    agyIdbCache.preloadBootKeys(bootCascadeId);

    const CONVO_CACHE_MAX = 12;
    const CONVO_CACHE_TTL_MS = 10 * 60 * 1000;
    const convoSnapshotCache = new Map();
    const activeStateStreams = new Map();
    const prefetchStreams = new Map();
    let preSeq = 0;
    let bootUserStatus = null;
    let bootSumState = null;
    const streamAliases = new Map();
    const reverseAliases = new Map();

    const textDecoder = new TextDecoder();
    const textEncoder = new TextEncoder();

    const WebTransportWebSocket = createWebTransportWebSocketClass({ NativeWebSocket, WT_FAIL_KEY, textDecoder, textEncoder });



    let activeControlSocket = null;
    let standbySocket = null;
    let standbyTimer = 0;
    let lastInboundAt = 0;
    let probeTimer = 0;
    let probeSeq = 0;

    const clearStandby = (closeUnused = false) => {
      if (standbyTimer) {
        clearTimeout(standbyTimer);
        standbyTimer = 0;
      }
      if (closeUnused && standbySocket && !standbySocket._claimed) {
        const stale = standbySocket;
        standbySocket = null;
        try { stale.close(); } catch {}
      }
    };

    const cacheConvoSnapshot = (cascadeId, payload) => {
      if (!cascadeId || !payload) return;
      if (convoSnapshotCache.has(cascadeId)) convoSnapshotCache.delete(cascadeId);
      else if (convoSnapshotCache.size >= CONVO_CACHE_MAX) {
        const oldestKey = convoSnapshotCache.keys().next().value;
        if (oldestKey !== undefined) convoSnapshotCache.delete(oldestKey);
      }
      convoSnapshotCache.set(cascadeId, { payload, at: Date.now() });
      agyIdbCache.putDebounced('convo:' + cascadeId, payload, 250);
    };

    const cancelPrefetchEntry = (sock, preId) => {
      const info = prefetchStreams.get(preId);
      if (!info) return;
      if (info.timer) clearTimeout(info.timer);
      prefetchStreams.delete(preId);
      if (sock && sock.readyState === 1) {
        try { sock._rawSend(JSON.stringify({ streamId: preId, type: 'cancel' })); } catch {}
      }
    };

    const clearSocketTracking = (sock) => {
      for (const [sid, entry] of activeStateStreams.entries()) {
        if (entry.sock === sock) activeStateStreams.delete(sid);
      }
      for (const [pid, info] of prefetchStreams.entries()) {
        if (info.sock === sock) {
          if (info.timer) clearTimeout(info.timer);
          prefetchStreams.delete(pid);
        }
      }
      if (bootSumState && bootSumState.sock === sock) {
        if (bootSumState.timer) clearTimeout(bootSumState.timer);
        if (bootSumState.adoptedId) reverseAliases.delete(bootSumState.adoptedId);
        streamAliases.delete('__agy_pre_sum');
        bootSumState = null;
      }
    };

    const startBootPrefetches = (sock) => {
      if (!sock || sock.readyState !== 1) return;
      const csrf = window.__APP_CONFIG__?.csrfToken || '';
      if (!csrf) return;
      if (!bootUserStatus) {
        try {
          sock._rawSend(JSON.stringify({
            streamId: '__agy_pre_user',
            type: 'start',
            procedure: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
            stream: false,
            headers: {
              'x-codeium-csrf-token': [csrf],
              'content-type': ['application/json'],
            },
            payload: {},
          }));
        } catch {}
      }
      if (!bootSumState) {
        const preId = '__agy_pre_sum';
        const timer = setTimeout(() => {
          if (bootSumState && bootSumState.sock === sock && !bootSumState.adoptedId) {
            bootSumState = null;
            if (sock.readyState === 1) {
              try { sock._rawSend(JSON.stringify({ streamId: preId, type: 'cancel' })); } catch {}
            }
          }
        }, 15000);
        bootSumState = {
          preId,
          sock,
          adoptedId: null,
          mergedUpdates: Object.create(null),
          mergedDeletes: new Set(),
          extraPayloads: [],
          hasData: false,
          ended: false,
          timer,
          persistUpdates: Object.create(null),
          persistFrames: 0,
        };
        try {
          sock._rawSend(JSON.stringify({
            streamId: preId,
            type: 'start',
            procedure: '/exa.language_server_pb.LanguageServerService/JetboxSubscribeToSummaries',
            stream: true,
            headers: {
              'x-codeium-csrf-token': [csrf],
              'content-type': ['application/connect+json'],
              'connect-protocol-version': ['1'],
            },
            payload: {},
          }));
        } catch {
          clearTimeout(timer);
          bootSumState = null;
        }
      }
    };

    const startConvoPrefetch = (sock, cascadeId) => {
      if (!sock || sock.readyState !== 1 || !cascadeId) return;
      const csrf = window.__APP_CONFIG__?.csrfToken || '';
      if (!csrf) return;
      for (const info of prefetchStreams.values()) {
        if (info.cascadeId === cascadeId) return;
      }
      const existing = convoSnapshotCache.get(cascadeId);
      if (existing && Date.now() - existing.at < 3000) return;
      for (const [pid, info] of prefetchStreams.entries()) {
        if (info.sock === sock) cancelPrefetchEntry(sock, pid);
      }
      const preId = '__agy_pre_' + (++preSeq);
      const timer = setTimeout(() => cancelPrefetchEntry(sock, preId), 4000);
      prefetchStreams.set(preId, { cascadeId, sock, timer });
      try {
        sock._rawSend(JSON.stringify({
          streamId: preId,
          type: 'start',
          procedure: '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates',
          stream: true,
          headers: {
            'x-codeium-csrf-token': [csrf],
            'content-type': ['application/connect+json'],
            'connect-protocol-version': ['1'],
          },
          payload: {
            conversationId: cascadeId,
            subscriberId: preId,
            initialStepsPageBounds: { startIndex: -50 },
            initialGeneratorMetadatasPageBounds: { startIndex: -1 },
            initialExecutorMetadatasPageBounds: { startIndex: 0, endIndexExclusive: 0 },
            trajectoryVerbosity: 'CLIENT_TRAJECTORY_VERBOSITY_PROD_UI',
          },
        }));
      } catch {
        clearTimeout(timer);
        prefetchStreams.delete(preId);
      }
    };

    const mergeSummaryPayload = (targetMap, targetDeletes, payload) => {
      if (!payload || typeof payload !== 'object') return;
      if (payload.updates && typeof payload.updates === 'object') {
        for (const [k, v] of Object.entries(payload.updates)) {
          targetMap[k] = v;
          if (targetDeletes) targetDeletes.delete(k);
        }
      }
      if (Array.isArray(payload.deletes)) {
        for (const id of payload.deletes) {
          delete targetMap[id];
          if (targetDeletes) targetDeletes.add(id);
        }
      }
    };

    const attachControlHandlers = (sock) => {
      if (!sock || sock.__agyControlHandlers) return sock;
      sock.__agyControlHandlers = true;
      sock._onInboundMessage = (ev) => {
        if (activeControlSocket === sock) {
          lastInboundAt = Date.now();
          if (probeTimer) {
            clearTimeout(probeTimer);
            probeTimer = 0;
          }
          clearStandby(true);
        }
        const raw = ev?.data;
        if (typeof raw !== 'string') return true;
        if (raw.includes('"__agy_pre_user"')) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed?.streamId === '__agy_pre_user') {
              if (parsed.type === 'data' && parsed.payload) {
                bootUserStatus = { payload: parsed.payload, at: Date.now() };
                agyIdbCache.putDebounced('boot:userStatus', parsed.payload, 150);
              }
              return false;
            }
          } catch {}
        }
        if (bootSumState && bootSumState.sock === sock && raw.includes('"__agy_pre_sum"')) {
          if (bootSumState.adoptedId) {
            const targetId = bootSumState.adoptedId;
            if (bootSumState.persistFrames < 32) {
              bootSumState.persistFrames++;
              try {
                const parsed = JSON.parse(raw);
                if (parsed?.streamId === '__agy_pre_sum' && parsed.type === 'data' && parsed.payload) {
                  mergeSummaryPayload(bootSumState.persistUpdates, null, parsed.payload);
                  agyIdbCache.putDebounced(
                    'boot:summaries',
                    agyIdbCache.compactSummaries(bootSumState.persistUpdates),
                    1500,
                  );
                }
              } catch {}
            }
            if (raw.includes('"streamId":"__agy_pre_sum"')) {
              sock._dispatchDirectMessage(raw.replace('"streamId":"__agy_pre_sum"', '"streamId":' + JSON.stringify(targetId)));
            } else {
              try {
                const parsed = JSON.parse(raw);
                if (parsed?.streamId === '__agy_pre_sum') {
                  parsed.streamId = targetId;
                  sock._dispatchDirectMessage(JSON.stringify(parsed));
                } else {
                  return true;
                }
              } catch {}
            }
            return false;
          }
          try {
            const parsed = JSON.parse(raw);
            if (parsed?.streamId === '__agy_pre_sum') {
              if (parsed.type === 'data' && parsed.payload) {
                bootSumState.hasData = true;
                const p = parsed.payload;
                mergeSummaryPayload(bootSumState.mergedUpdates, bootSumState.mergedDeletes, p);
                for (const k of Object.keys(p)) {
                  if (k !== 'updates' && k !== 'deletes') {
                    bootSumState.extraPayloads.push(p);
                    break;
                  }
                }
              } else if (parsed.type === 'end') {
                bootSumState.ended = true;
                if (bootSumState.timer) {
                  clearTimeout(bootSumState.timer);
                  bootSumState.timer = 0;
                }
              }
              return false;
            }
          } catch {}
        }
        if (prefetchStreams.size > 0 && raw.includes('"__agy_pre_')) {
          try {
            const parsed = JSON.parse(raw);
            const info = parsed?.streamId ? prefetchStreams.get(parsed.streamId) : null;
            if (info) {
              if (parsed.type === 'data' && parsed.payload) {
                cacheConvoSnapshot(info.cascadeId, parsed.payload);
                cancelPrefetchEntry(info.sock, parsed.streamId);
              } else if (parsed.type === 'end') {
                if (info.timer) clearTimeout(info.timer);
                prefetchStreams.delete(parsed.streamId);
              }
              return false;
            }
          } catch {}
        }
        if (activeStateStreams.size > 0 && raw.includes('"type":"data"')) {
          try {
            const parsed = JSON.parse(raw);
            const entry = parsed?.streamId ? activeStateStreams.get(parsed.streamId) : null;
            if (entry && !entry.captured && parsed.payload) {
              entry.captured = true;
              cacheConvoSnapshot(entry.cascadeId, parsed.payload);
              activeStateStreams.delete(parsed.streamId);
            }
          } catch {}
        }
        return true;
      };
      sock.addEventListener('close', () => {
        clearSocketTracking(sock);
        if (standbySocket === sock) {
          standbySocket = null;
          clearStandby(false);
        }
        if (activeControlSocket === sock) {
          activeControlSocket = null;
          if (probeTimer) {
            clearTimeout(probeTimer);
            probeTimer = 0;
          }
        }
      }, { once: true });
      return sock;
    };

    const createControlSocket = (preferWT = canUseWT && !window.__agyWtDisabled) =>
      attachControlHandlers(new WebTransportWebSocket(wtUrl, earlyWsUrl, undefined, preferWT));

    const prewarmStandbySocket = () => {
      if (standbySocket || earlyWt) return;
      const fb = createControlSocket(canUseWT && !window.__agyWtDisabled);
      standbySocket = fb;
      standbyTimer = setTimeout(() => {
        standbyTimer = 0;
        if (standbySocket === fb && !fb._claimed) {
          standbySocket = null;
          try { fb.close(); } catch {}
        }
      }, 15000);
    };
    prewarmStandbyControlSocket = prewarmStandbySocket;

    const probeActiveSocket = (minIdleMs, opts = {}) => {
      const sock = activeControlSocket;
      if (!sock || sock.readyState !== 1 || probeTimer) return;
      if (Date.now() - lastInboundAt < minIdleMs) return;
      if (opts.prewarmStandby) prewarmStandbySocket();
      try {
        sock._rawSend(JSON.stringify({ streamId: '__agy_probe_' + (++probeSeq), type: 'ping' }));
      } catch {
        return;
      }
      const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 450;
      probeTimer = setTimeout(() => {
        probeTimer = 0;
        if (activeControlSocket !== sock || sock.readyState !== 1) return;
        try { sock.close(4000, 'stale-probe-timeout'); } catch {}
        if (typeof sock._finishClose === 'function') {
          try { sock._finishClose(1006, 'stale-probe-timeout', false); } catch {}
        }
      }, timeoutMs);
    };
    triggerSocketProbe = probeActiveSocket;

    triggerConvoPrefetch = (cascadeId) => {
      if (!cascadeId) return;
      const sock =
        (activeControlSocket && activeControlSocket.readyState === 1 ? activeControlSocket : null) ||
        (earlyWt && earlyWt.readyState === 1 ? earlyWt : null) ||
        (standbySocket && standbySocket.readyState === 1 ? standbySocket : null);
      if (sock) startConvoPrefetch(sock, cascadeId);
    };

    const trackControlSocket = (sock) => {
      if (!sock) return sock;
      attachControlHandlers(sock);
      if (activeControlSocket === sock) return sock;
      if (probeTimer) {
        clearTimeout(probeTimer);
        probeTimer = 0;
      }
      activeControlSocket = sock;
      lastInboundAt = Date.now();
      sock.addEventListener('open', () => {
        if (activeControlSocket === sock) lastInboundAt = Date.now();
      }, { once: true });
      if (!sock.__agySendWrapped) {
        sock.__agySendWrapped = true;
        sock.send = (data) => {
          if (typeof data === 'string') {
            if (data.includes('"type":"start"')) {
              if (data.includes('/GetUserStatus')) {
                try {
                  const parsed = JSON.parse(data);
                  const streamId = parsed?.streamId;
                  if (streamId && (!parsed.payload || Object.keys(parsed.payload).length === 0)) {
                    let cachedUser = null;
                    if (bootUserStatus && Date.now() - bootUserStatus.at < 15000) {
                      cachedUser = bootUserStatus.payload;
                      bootUserStatus = null;
                    } else {
                      cachedUser = agyIdbCache.getBoot('boot:userStatus');
                    }
                    if (cachedUser) {
                      queueMicrotask(() => {
                        if (sock.readyState === 1) {
                          sock._dispatchDirectMessage(JSON.stringify({ streamId, type: 'data', payload: cachedUser }));
                          sock._dispatchDirectMessage(JSON.stringify({ streamId, type: 'end', statusCode: 200 }));
                        }
                      });
                      return;
                    }
                  }
                } catch {}
              } else if (
                data.includes('/JetboxSubscribeToSummaries') &&
                bootSumState &&
                bootSumState.sock === sock &&
                !bootSumState.adoptedId &&
                !bootSumState.ended
              ) {
                try {
                  const parsed = JSON.parse(data);
                  const streamId = parsed?.streamId;
                  if (streamId && (!parsed.payload || Object.keys(parsed.payload).length === 0)) {
                    bootSumState.adoptedId = streamId;
                    if (bootSumState.timer) {
                      clearTimeout(bootSumState.timer);
                      bootSumState.timer = 0;
                    }
                    streamAliases.set('__agy_pre_sum', streamId);
                    reverseAliases.set(streamId, '__agy_pre_sum');
                    const bufferedUpdates = bootSumState.mergedUpdates;
                    const bufferedDeletes = [...bootSumState.mergedDeletes];
                    const bufferedExtras = bootSumState.extraPayloads;
                    const hadData = bootSumState.hasData;
                    bootSumState.persistUpdates = hadData ? { ...bufferedUpdates } : Object.create(null);
                    bootSumState.mergedUpdates = Object.create(null);
                    bootSumState.mergedDeletes = new Set();
                    bootSumState.extraPayloads = [];
                    if (hadData) {
                      agyIdbCache.putDebounced(
                        'boot:summaries',
                        agyIdbCache.compactSummaries(bufferedUpdates),
                        400,
                      );
                      queueMicrotask(() => {
                        if (sock.readyState !== 1) return;
                        const merged = { updates: bufferedUpdates };
                        if (bufferedDeletes.length > 0) merged.deletes = bufferedDeletes;
                        sock._dispatchDirectMessage(JSON.stringify({ streamId, type: 'data', payload: merged }));
                        for (const extra of bufferedExtras) {
                          sock._dispatchDirectMessage(JSON.stringify({ streamId, type: 'data', payload: extra }));
                        }
                      });
                    } else {
                      const idbSums = agyIdbCache.getBoot('boot:summaries');
                      if (idbSums && idbSums.updates) {
                        queueMicrotask(() => {
                          if (sock.readyState === 1) {
                            sock._dispatchDirectMessage(JSON.stringify({ streamId, type: 'data', payload: idbSums }));
                          }
                        });
                      }
                    }
                    return;
                  }
                } catch {}
              } else if (data.includes('StreamAgentStateUpdates')) {
                try {
                  const parsed = JSON.parse(data);
                  const streamId = parsed?.streamId;
                  const cascadeId = parsed?.payload?.conversationId;
                  if (streamId && cascadeId) {
                    activeStateStreams.set(streamId, { cascadeId, captured: false, sock });
                    const ramCached = convoSnapshotCache.get(cascadeId);
                    const bootCached = ramCached && Date.now() - ramCached.at < CONVO_CACHE_TTL_MS
                      ? ramCached.payload
                      : agyIdbCache.getBoot('convo:' + cascadeId);
                    if (bootCached) {
                      queueMicrotask(() => {
                        if (sock.readyState === 1 && activeStateStreams.has(streamId)) {
                          sock._dispatchDirectMessage(JSON.stringify({ streamId, type: 'data', payload: bootCached }));
                        }
                      });
                    } else {
                      agyIdbCache.getConvoAsync(cascadeId).then((idbCached) => {
                        if (!idbCached || sock.readyState !== 1) return;
                        const entry = activeStateStreams.get(streamId);
                        if (entry && !entry.captured) {
                          sock._dispatchDirectMessage(JSON.stringify({ streamId, type: 'data', payload: idbCached }));
                        }
                      });
                    }
                  }
                } catch {}
              }
              probeActiveSocket(4000, { timeoutMs: 450 });
            } else if (data.includes('"type":"cancel"')) {
              try {
                const parsed = JSON.parse(data);
                if (parsed?.streamId) {
                  activeStateStreams.delete(parsed.streamId);
                  if (reverseAliases.has(parsed.streamId)) {
                    const preId = reverseAliases.get(parsed.streamId);
                    reverseAliases.delete(parsed.streamId);
                    streamAliases.delete(preId);
                    if (bootSumState && bootSumState.adoptedId === parsed.streamId) {
                      if (bootSumState.timer) clearTimeout(bootSumState.timer);
                      bootSumState = null;
                    }
                    return sock._rawSend(JSON.stringify({ ...parsed, streamId: preId }));
                  }
                }
              } catch {}
            }
          }
          return sock._rawSend(data);
        };
      }
      return sock;
    };

    let earlyWt = null;
    let earlyCleanupTimer = 0;
    const clearEarlyTimer = () => {
      if (earlyCleanupTimer) {
        clearTimeout(earlyCleanupTimer);
        earlyCleanupTimer = 0;
      }
    };

    earlyWt = createControlSocket(canUseWT && !window.__agyWtDisabled);
    earlyWt.addEventListener('open', () => {
      startBootPrefetches(earlyWt);
      if (bootCascadeId) startConvoPrefetch(earlyWt, bootCascadeId);
    }, { once: true });
    earlyCleanupTimer = setTimeout(() => {
      earlyCleanupTimer = 0;
      if (earlyWt && !earlyWt._claimed) {
        const stale = earlyWt;
        earlyWt = null;
        try { stale.close(); } catch {}
      }
    }, 15000);

    const WrappedWebSocket = function(url, protocols) {
      if (protocols === undefined) {
        try {
          const targetUrl = new URL(String(url), location.href);
          if (targetUrl.href === earlyWsUrl) {
            if (earlyWt && (earlyWt.readyState === 0 || earlyWt.readyState === 1)) {
              const wt = earlyWt;
              earlyWt = null;
              wt._claimed = true;
              clearEarlyTimer();
              if (wt.readyState === 1) {
                queueMicrotask(() => {
                  if (wt.readyState === 1) wt._fireRaw('open', new Event('open'));
                });
              }
              return trackControlSocket(wt);
            }
            if (standbySocket && (standbySocket.readyState === 0 || standbySocket.readyState === 1)) {
              const sb = standbySocket;
              standbySocket = null;
              sb._claimed = true;
              clearStandby(false);
              if (sb.readyState === 1) {
                queueMicrotask(() => {
                  if (sb.readyState === 1) sb._fireRaw('open', new Event('open'));
                });
              }
              return trackControlSocket(sb);
            }
            const sock = createControlSocket(canUseWT && !window.__agyWtDisabled);
            sock._claimed = true;
            return trackControlSocket(sock);
          }
        } catch {}
      }
      return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    };
    WrappedWebSocket.prototype = NativeWebSocket.prototype;
    WrappedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
    WrappedWebSocket.OPEN = NativeWebSocket.OPEN;
    WrappedWebSocket.CLOSING = NativeWebSocket.CLOSING;
    WrappedWebSocket.CLOSED = NativeWebSocket.CLOSED;
    window.WebSocket = WrappedWebSocket;
  }
