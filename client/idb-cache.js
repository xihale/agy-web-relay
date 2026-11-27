  function createIdbSnapshotCache() {
    const DB_NAME = 'agy-relay-cache-v1';
    const STORE_NAME = 'snapshots';
    const MAX_CONVO_ENTRIES = 8;
    const TTL_MS = 24 * 60 * 60 * 1000;
    const bootMemory = new Map();
    let dbPromise = null;
    let preloadStarted = false;
    const pendingWrites = new Map();

    function hasIdb() {
      return typeof indexedDB !== 'undefined' && indexedDB && typeof indexedDB.open === 'function';
    }

    function openDb() {
      if (!hasIdb()) return Promise.resolve(null);
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open(DB_NAME, 1);
          req.onupgradeneeded = () => {
            try {
              const db = req.result;
              if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'key' });
              }
            } catch {}
          };
          req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => {
              try { db.close(); } catch {}
              dbPromise = null;
            };
            resolve(db);
          };
          req.onerror = () => resolve(null);
          req.onblocked = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
      return dbPromise;
    }

    function readRecord(store, key) {
      return new Promise((resolve) => {
        try {
          const req = store.get(key);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }

    function isFresh(rec) {
      return Boolean(rec && rec.data !== undefined && Number.isFinite(rec.updatedAt) && Date.now() - rec.updatedAt <= TTL_MS);
    }

    function preloadBootKeys(bootCascadeId) {
      if (preloadStarted) return Promise.resolve();
      preloadStarted = true;
      const keys = ['boot:userStatus', 'boot:summaries'];
      if (bootCascadeId) keys.push('convo:' + bootCascadeId);
      return openDb()
        .then((db) => {
          if (!db) return;
          return new Promise((resolve) => {
            try {
              const tx = db.transaction(STORE_NAME, 'readonly');
              const store = tx.objectStore(STORE_NAME);
              Promise.all(keys.map((k) => readRecord(store, k))).then((recs) => {
                for (let i = 0; i < keys.length; i++) {
                  const rec = recs[i];
                  if (isFresh(rec) && !bootMemory.has(keys[i])) {
                    bootMemory.set(keys[i], { data: rec.data, updatedAt: rec.updatedAt });
                  }
                }
                resolve();
              });
              tx.onerror = () => resolve();
            } catch {
              resolve();
            }
          });
        })
        .catch(() => {});
    }

    function getBoot(key) {
      const hit = bootMemory.get(key);
      if (!hit) return null;
      if (Date.now() - hit.updatedAt > TTL_MS) {
        bootMemory.delete(key);
        return null;
      }
      return hit.data;
    }

    function getConvoAsync(cascadeId, opts = null) {
      if (!cascadeId) return Promise.resolve(null);
      const key = 'convo:' + cascadeId;
      const bypassMemory = Boolean(opts && opts.bypassMemory);
      const mem = getBoot(key);
      if (!bypassMemory && mem !== null) return Promise.resolve(mem);
      return openDb()
        .then((db) => {
          if (!db) return bypassMemory ? mem : null;
          return new Promise((resolve) => {
            try {
              const tx = db.transaction(STORE_NAME, 'readonly');
              const store = tx.objectStore(STORE_NAME);
              readRecord(store, key).then((rec) => {
                if (!isFresh(rec)) {
                  resolve(bypassMemory ? mem : null);
                  return;
                }
                const prev = bootMemory.get(key);
                if (!prev || rec.updatedAt >= prev.updatedAt) {
                  bootMemory.set(key, { data: rec.data, updatedAt: rec.updatedAt });
                }
                resolve(rec.data);
              });
              tx.onerror = () => resolve(bypassMemory ? mem : null);
            } catch {
              resolve(bypassMemory ? mem : null);
            }
          });
        })
        .catch(() => (bypassMemory ? mem : null));
    }

    function pruneOldConvoKeys(store) {
      return new Promise((resolve) => {
        try {
          const req = store.getAllKeys ? store.getAllKeys() : null;
          if (!req) {
            const reqAll = store.getAll();
            reqAll.onsuccess = () => {
              const convos = (reqAll.result || []).filter((r) => r && typeof r.key === 'string' && r.key.startsWith('convo:'));
              if (convos.length > MAX_CONVO_ENTRIES) {
                convos.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
                const drop = convos.length - MAX_CONVO_ENTRIES;
                for (let i = 0; i < drop; i++) {
                  try { store.delete(convos[i].key); } catch {}
                  bootMemory.delete(convos[i].key);
                }
              }
              resolve();
            };
            reqAll.onerror = () => resolve();
            return;
          }
          req.onsuccess = () => {
            const convoKeys = (req.result || []).filter((k) => typeof k === 'string' && k.startsWith('convo:'));
            if (convoKeys.length <= MAX_CONVO_ENTRIES) {
              resolve();
              return;
            }
            Promise.all(convoKeys.map((k) => readRecord(store, k))).then((recs) => {
              const valid = recs.filter(Boolean).sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
              const drop = valid.length - MAX_CONVO_ENTRIES;
              for (let i = 0; i < drop; i++) {
                try { store.delete(valid[i].key); } catch {}
                bootMemory.delete(valid[i].key);
              }
              resolve();
            });
          };
          req.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    }

    function writeNow(key, data, updatedAt) {
      return openDb()
        .then((db) => {
          if (!db) return;
          return new Promise((resolve) => {
            try {
              const tx = db.transaction(STORE_NAME, 'readwrite');
              const store = tx.objectStore(STORE_NAME);
              store.put({ key, data, updatedAt });
              const finish = () => resolve();
              tx.oncomplete = finish;
              tx.onerror = finish;
              tx.onabort = finish;
              if (key.startsWith('convo:')) {
                void pruneOldConvoKeys(store);
              }
            } catch {
              resolve();
            }
          });
        })
        .catch(() => {});
    }

    function putDebounced(key, data, delayMs = 300) {
      if (!key || data === undefined) return;
      const updatedAt = Date.now();
      bootMemory.set(key, { data, updatedAt });
      const prev = pendingWrites.get(key);
      if (prev) {
        if (prev.kind === 'idle' && typeof cancelIdleCallback === 'function') cancelIdleCallback(prev.id);
        else clearTimeout(prev.id);
        pendingWrites.delete(key);
      }
      if (!hasIdb()) return;
      const flush = () => {
        pendingWrites.delete(key);
        void writeNow(key, data, updatedAt);
      };
      if (delayMs <= 0) {
        flush();
        return;
      }
      const timerId = setTimeout(() => {
        if (typeof requestIdleCallback === 'function') {
          const idleId = requestIdleCallback(flush, { timeout: 600 });
          pendingWrites.set(key, { kind: 'idle', id: idleId });
        } else {
          flush();
        }
      }, delayMs);
      pendingWrites.set(key, { kind: 'timer', id: timerId });
    }

    function compactSummaries(updatesMap, maxEntries = 150) {
      if (!updatesMap || typeof updatesMap !== 'object') return { updates: {} };
      const entries = Object.entries(updatesMap);
      if (entries.length <= maxEntries) {
        return { updates: { ...updatesMap } };
      }
      const active = [];
      const rest = [];
      for (const entry of entries) {
        const sum = entry[1];
        if (!sum) continue;
        if (sum.notFullyIdle || (Array.isArray(sum.waitingSteps) && sum.waitingSteps.length > 0)) {
          active.push(entry);
        } else {
          rest.push(entry);
        }
      }
      rest.sort((a, b) => {
        const ta = a[1]?.lastModifiedTime || a[1]?.createdTime || '';
        const tb = b[1]?.lastModifiedTime || b[1]?.createdTime || '';
        return tb < ta ? -1 : tb > ta ? 1 : 0;
      });
      const out = Object.create(null);
      let count = 0;
      for (const [k, v] of active) {
        if (count >= maxEntries) break;
        out[k] = v;
        count++;
      }
      for (const [k, v] of rest) {
        if (count >= maxEntries) break;
        out[k] = v;
        count++;
      }
      return { updates: out };
    }

    return {
      preloadBootKeys,
      getBoot,
      getConvoAsync,
      putDebounced,
      compactSummaries,
    };
  }

  const agyIdbCache = createIdbSnapshotCache();
