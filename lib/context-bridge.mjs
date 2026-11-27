import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canConnectLocalPort } from './cli-tls.mjs';
import { ANTIGRAVITY_CONTEXT_DIR, CONTEXT_GUID_RE } from './constants.mjs';
import { createStaticAssetEntry } from './static-cache.mjs';
import { createFastUsageReader } from './usage-reader.mjs';

function extractCjsExport(source, fileLabel) {
  const marker = 'module.exports = ';
  const idx = source.indexOf(marker);
  if (idx < 0) throw new Error(`Unexpected CJS export format in ${fileLabel}`);
  return source.slice(idx + marker.length).trim().replace(/;$/, '');
}

export function createContextBridgeLoader({ getTargetInfo } = {}) {
  let contextBridgePromise = null;

  return function getContextBridge() {
    if (contextBridgePromise) return contextBridgePromise;
    contextBridgePromise = (async () => {
      const widgetPath = path.join(ANTIGRAVITY_CONTEXT_DIR, 'compat', 'inline-widget.cjs');
      try {
        await fs.promises.access(widgetPath);
      } catch {
        return null;
      }

      const importPlugin = (rel) => import(pathToFileURL(path.join(ANTIGRAVITY_CONTEXT_DIR, rel)).href);
      const [
        { MetricsStore },
        { AntigravityClient },
        { UsageLedger },
        { SessionHistory },
        { PreferencesStore },
        { readHostTheme },
        { platformPaths },
      ] = await Promise.all([
        importPlugin('sidecars/panel/store.mjs'),
        importPlugin('sidecars/panel/client.mjs'),
        importPlugin('sidecars/panel/usage.mjs'),
        importPlugin('sidecars/panel/history.mjs'),
        importPlugin('compat/preferences.mjs'),
        importPlugin('compat/host-theme.mjs'),
        importPlugin('compat/platform.mjs'),
      ]);

      const paths = platformPaths();
      const realHistory = new SessionHistory();
      // Read-only history wrapper: host sidecar owns all writes to history and usage ledger.
      const readOnlyHistory = {
        directory: null,
        load: (scope, id) => realHistory.load(scope, id),
        save: async () => null,
      };
      const client = new AntigravityClient();
      const fallbackDiscoverNow = client.discoverNow.bind(client);
      // Antigravity 2.35+ omits --csrf_token from language_server CLI args and stores it in daemon/hub_*.json.
      client.discoverNow = async () => {
        if (typeof getTargetInfo === 'function') {
          const info = await getTargetInfo(true).catch(() => null);
          if (
            info &&
            Number.isInteger(info.httpPort) &&
            info.httpPort > 0 &&
            info.httpPort <= 65535 &&
            info.csrfToken &&
            (await canConnectLocalPort(info.httpPort))
          ) {
            client.server = {
              port: info.httpPort,
              csrf: info.csrfToken,
              pid: Number.isInteger(info.pid) && info.pid > 0 ? info.pid : `hub:${info.httpPort}`,
            };
            client.discoveredAt = client.now();
            return client.server;
          }
        }
        return fallbackDiscoverNow();
      };
      const store = new MetricsStore(client, {
        history: readOnlyHistory,
        onTrajectory: null,
        onBackgroundResult: null,
        background: null,
        owns: () => true,
      });
      const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
      const ledger = new UsageLedger(undefined, { timeZone: localTimeZone });
      const fastUsageReader = createFastUsageReader({
        directory: ledger.directory,
        timeZone: localTimeZone,
        source: ledger.source,
      });
      const preferences = new PreferencesStore();

      let settingsCache = {};
      let settingsAt = -Infinity;
      let settingsInFlight = null;
      let lastUsageSummaryAt = 0;

      const isEnabled = async () => {
        const now = Date.now();
        if (now - settingsAt >= 1000) {
          if (!settingsInFlight) {
            settingsInFlight = (async () => {
              let settings = {};
              try {
                const rawSettings = await fs.promises.readFile(paths.settings, 'utf8');
                settings = JSON.parse(rawSettings.replace(/^\uFEFF/, ''));
              } catch {}
              try {
                const rawPluginCfg = await fs.promises.readFile(paths.pluginConfig, 'utf8');
                const pluginCfg = JSON.parse(rawPluginCfg.replace(/^\uFEFF/, ''));
                if (pluginCfg.plugins?.['antigravity-context']?.enabled === false) settings.enabled = false;
              } catch {}
              const budgetMb = Number(settings.collectionBudgetMb ?? process.env.ANTIGRAVITY_CONTEXT_BUDGET_MB);
              client.setBudgetBytes?.(
                Number.isFinite(budgetMb) && budgetMb > 0 ? budgetMb * 1024 * 1024 : 8 * 1024 * 1024,
              );
              settingsCache = settings;
              settingsAt = Date.now();
            })().finally(() => {
              settingsInFlight = null;
            });
          }
          await settingsInFlight;
        }
        return settingsCache.enabled !== false && settingsCache.inline !== false && settingsCache.mode !== 'legacy';
      };

      let cachedVersion = null;
      let cachedVersionMtime = -1;
      const pluginJsonPath = path.join(ANTIGRAVITY_CONTEXT_DIR, 'plugin.json');
      const readVersion = async () => {
        try {
          const st = await fs.promises.stat(pluginJsonPath);
          if (st.mtimeMs === cachedVersionMtime) return cachedVersion;
          const meta = JSON.parse(await fs.promises.readFile(pluginJsonPath, 'utf8'));
          cachedVersion = typeof meta.version === 'string' ? meta.version : null;
          cachedVersionMtime = st.mtimeMs;
          return cachedVersion;
        } catch {
          return null;
        }
      };

      const validatedInput = (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Invalid metrics request');
        }
        if (value.conversationId != null && !CONTEXT_GUID_RE.test(value.conversationId)) {
          throw new Error('Invalid conversation ID');
        }
        const out = { conversationId: value.conversationId || null, force: value.force === true };
        if (value.usageSync === true) out.usageSync = true;
        if (value.usageCheck === true) out.usageCheck = true;
        if (value.usageRefresh === true) out.usageRefresh = true;
        return out;
      };

      const compatDir = path.join(ANTIGRAVITY_CONTEXT_DIR, 'compat');
      const compatFiles = [
        path.join(compatDir, 'usage-ui.cjs'),
        path.join(compatDir, 'i18n.cjs'),
        path.join(compatDir, 'theme.cjs'),
        path.join(compatDir, 'inline-widget.cjs'),
      ];
      let cachedScriptKey = '';
      let cachedScriptEntry = null;
      let scriptBuildPromise = null;
      let disabledEntry = null;

      const getClientScriptEntry = async () => {
        const enabled = await isEnabled();
        if (!enabled) {
          if (!disabledEntry) {
            disabledEntry = await createStaticAssetEntry(
              '/* antigravity-context disabled */\n',
              'application/javascript; charset=utf-8',
              {},
            );
          }
          return disabledEntry;
        }

        const stats = await Promise.all(compatFiles.map((f) => fs.promises.stat(f)));
        const key = stats.map((s) => `${s.mtimeMs}:${s.size}`).join('|');
        if (cachedScriptEntry && cachedScriptKey === key) {
          return cachedScriptEntry;
        }
        if (!scriptBuildPromise) {
          scriptBuildPromise = (async () => {
            const [usageRaw, i18nRaw, themeRaw, widgetRaw] = await Promise.all(
              compatFiles.map((f) => fs.promises.readFile(f, 'utf8')),
            );
            const usageJs = extractCjsExport(usageRaw, 'usage-ui.cjs');
            const i18nJs = extractCjsExport(i18nRaw, 'i18n.cjs');
            const themeJs = extractCjsExport(themeRaw, 'theme.cjs');
            const widgetJs = extractCjsExport(widgetRaw, 'inline-widget.cjs');
            const script = `(() => {
  if (window !== window.top || window.__agPulseInlineInstalled) return;
  const offline = (error) => ({ connection: 'offline', error, speed: null, groups: [], enabled: false });
  const postJson = async (url, body) => {
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };
  window.agPulseHost = {
    getMetrics: (input) => postJson('/relay-plugin/antigravity-context/metrics', input || {}).catch(() => offline('等待 Antigravity Context 重新连接')),
    getPreferences: () => fetch('/relay-plugin/antigravity-context/preferences', { credentials: 'same-origin', cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})),
    setPreferences: (input) => postJson('/relay-plugin/antigravity-context/preferences', input || {}),
    report: () => {},
  };
  window.__agPulseUsageFactory = (${usageJs});
  window.__agPulseI18nFactory = (${i18nJs});
  window.__agPulseThemeFactory = (${themeJs});
  (${widgetJs})();
})();\n`;
            const entry = await createStaticAssetEntry(script, 'application/javascript; charset=utf-8', {});
            cachedScriptKey = key;
            cachedScriptEntry = entry;
            return entry;
          })().finally(() => {
            scriptBuildPromise = null;
          });
        }
        return scriptBuildPromise;
      };

      const metricsCache = new Map();
      const metricsInFlight = new Map();
      const getMetrics = async (rawInput) => {
        if (!(await isEnabled())) {
          return { connection: 'offline', error: 'Antigravity Context 已停用', speed: null, groups: [], enabled: false };
        }
        const input = validatedInput(rawInput || {});
        const bypassCache = Boolean(input.force || input.usageRefresh || input.usageSync || input.usageCheck);
        const cacheKey = input.conversationId || '';
        const now = Date.now();
        if (!bypassCache) {
          const hit = metricsCache.get(cacheKey);
          if (hit && now < hit.expiresAt) {
            return hit.data;
          }
        }
        const existingFlight = metricsInFlight.get(cacheKey);
        if (existingFlight) {
          return existingFlight;
        }
        const flight = (async () => {
          const base = await store.snapshot({ ...input, selectLatest: false });
          let usageData = null;
          if (store.identity) {
            const summaryNow = Date.now();
            usageData = await fastUsageReader.summary(store.identity, summaryNow, { forceRefresh: bypassCache });
            if (usageData === null) {
              if (bypassCache || summaryNow - lastUsageSummaryAt > 60_000) {
                ledger.cache = null;
                lastUsageSummaryAt = summaryNow;
              }
              usageData = await ledger.summary(store.identity, summaryNow);
            }
          }
          const ver = await readVersion();
          const result = {
            ...base,
            usage: usageData,
            preferences: await preferences.snapshot(),
            theme: await readHostTheme(),
            integration: { state: 'mounted', mode: 'relay', windows: 1 },
            ...(ver ? { update: { state: 'current', host: 'app', currentVersion: ver, latestVersion: ver } } : {}),
          };
          const ttl = result.connection === 'offline' ? 8000 : 2000;
          if (metricsCache.size >= 64 && !metricsCache.has(cacheKey)) {
            metricsCache.delete(metricsCache.keys().next().value);
          }
          metricsCache.set(cacheKey, { data: result, expiresAt: Date.now() + ttl });
          return result;
        })().finally(() => {
          if (metricsInFlight.get(cacheKey) === flight) metricsInFlight.delete(cacheKey);
        });
        metricsInFlight.set(cacheKey, flight);
        return flight;
      };

      return {
        getClientScriptEntry,
        buildClientScript: async () => (await getClientScriptEntry()).raw.toString('utf8'),
        getMetrics,
        getPreferences: () => preferences.get(),
        setPreferences: (input) => preferences.set(input),
        dispose: () => store.dispose(),
      };
    })().catch((err) => {
      contextBridgePromise = null;
      console.warn(`[agy-web-relay] failed to initialize antigravity-context bridge: ${err?.message || err}`);
      return null;
    });
    return contextBridgePromise;
  };
}
