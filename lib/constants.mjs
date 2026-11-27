import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export const DAEMON_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'daemon');
export const CONFIG_DIR = path.join(os.homedir(), '.config', 'agy-web-relay');
export const CACHE_DIR = path.join(CONFIG_DIR, 'cache');
export const ANTIGRAVITY_CONTEXT_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'antigravity-context');
export const SESSION_COOKIE = 'agy_relay_sid';
export const CONTEXT_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const STATIC_CACHE_TTL_MS = 120_000;
export const UNARY_RPC_COMPRESS_LIMIT = 4 * 1024 * 1024;
export const MAX_HTML_BUFFER_BYTES = 10 * 1024 * 1024;
export const H2_PING_INTERVAL_MS = Math.max(100, Number(process.env.AGY_RELAY_H2_PING_MS) || 25_000);
export const H2_PING_TIMEOUT_MS = Math.max(100, Number(process.env.AGY_RELAY_H2_PING_TIMEOUT_MS) || 10_000);
export const TCP_KEEPALIVE_MS = 15_000;
export const WS_CONNECT_TIMEOUT_MS = 5_000;
export const LOCAL_PROXY_TIMEOUT_MS = 30_000;

export const HAS_ZSTD = typeof zlib.zstdCompress === 'function';

export const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'http2-settings',
]);

export const CACHEABLE_PATHS = new Set([
  '/main.js',
  '/prism_bundle.js',
  '/jetbox.css',
  '/compiled_tailwind.css',
  '/antigravityCascadeDone.mp3',
]);
