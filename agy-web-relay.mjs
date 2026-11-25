#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import {
  ICON_192,
  ICON_512,
  MANIFEST_JSON,
  MOBILE_CSS,
  MOBILE_JS,
  SW_JS,
  renderSetupHtml,
} from './mobile-assets.mjs';
import { attachWebSocketBridge } from './ws-deflate-bridge.mjs';

const brotliCompressAsync = promisify(zlib.brotliCompress);
const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);
const inflateAsync = promisify(zlib.inflate);
const HAS_ZSTD = typeof zlib.zstdCompress === 'function';
const zstdCompressAsync = HAS_ZSTD ? promisify(zlib.zstdCompress) : null;

const DAEMON_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'daemon');
const CONFIG_DIR = path.join(os.homedir(), '.config', 'agy-web-relay');
const CACHE_DIR = path.join(CONFIG_DIR, 'cache');
const ANTIGRAVITY_CONTEXT_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'antigravity-context');
const SESSION_COOKIE = 'agy_relay_sid';

const STATIC_CACHE_TTL_MS = 120_000;
const UNARY_RPC_COMPRESS_LIMIT = 256 * 1024;
const MAX_HTML_BUFFER_BYTES = 10 * 1024 * 1024;
const H2_PING_INTERVAL_MS = Math.max(100, Number(process.env.AGY_RELAY_H2_PING_MS) || 25_000);
const H2_PING_TIMEOUT_MS = Math.max(100, Number(process.env.AGY_RELAY_H2_PING_TIMEOUT_MS) || 10_000);
const TCP_KEEPALIVE_MS = 15_000;
const WS_CONNECT_TIMEOUT_MS = 5_000;
const LOCAL_PROXY_TIMEOUT_MS = 30_000;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'http2-settings',
]);
const CACHEABLE_PATHS = new Set([
  '/main.js',
  '/prism_bundle.js',
  '/jetbox.css',
  '/compiled_tailwind.css',
  '/antigravityCascadeDone.mp3',
]);

const localHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const localHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, rejectUnauthorized: false });

export function printHelp() {
  console.log(`Usage: agy-web-relay [options]

Expose local Antigravity language_server Web UI over EasyTier (HTTPS + HTTP/2 + Brotli + PWA).

Options:
  --bind <ip>          Bind IP (default: auto-detect tun0 / 100.64.x.x, else 127.0.0.1; env: AGY_RELAY_BIND)
  --wait-easytier      Wait until tun0 / 100.64.x.x is available (env: AGY_RELAY_WAIT_EASYTIER=1)
  --port <port>        Listen port (default: 8421, env: AGY_RELAY_PORT)
  --target-port <p>    Fixed local language_server HTTPS port (default: auto-discover; env: AGY_RELAY_TARGET_PORT)
  --cert <path>        TLS certificate path (default: ~/.config/agy-web-relay/cert.pem; env: AGY_RELAY_CERT)
  --key <path>         TLS private key path (default: ~/.config/agy-web-relay/key.pem; env: AGY_RELAY_KEY)
  --user <username>    Basic Auth username (default: agy, env: AGY_RELAY_USER)
  --pass <password>    Basic Auth password (default: random on startup, env: AGY_RELAY_PASS)
  --no-auth            Disable authentication (use only on trusted private EasyTier network; env: AGY_RELAY_NO_AUTH=1)
  --no-mobile-patch    Disable HTML PWA/mobile enhancements injection (env: AGY_RELAY_NO_MOBILE_PATCH=1)
  --http3              Enable Go HTTP/3 (QUIC) + WebTransport edge proxy (env: AGY_RELAY_HTTP3=1)
  --h3-bin <path>      Path to agy-h3-edge binary (env: AGY_RELAY_H3_BIN)
  -h, --help           Show this help
`);
}

function parsePortValue(raw, { allowZero = false, label = 'port' } = {}) {
  const str = String(raw ?? '').trim();
  if (!/^\d+$/.test(str)) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  const num = Number(str);
  const min = allowZero ? 0 : 1;
  if (!Number.isInteger(num) || num < min || num > 65535) {
    throw new Error(`Out-of-range ${label}: ${raw} (expected ${min}..65535)`);
  }
  return num;
}

export function parseArgs(argv = [], env = process.env) {
  const rawPort = env.AGY_RELAY_PORT;
  const rawTargetPort = env.AGY_RELAY_TARGET_PORT || env.AGY_TARGET_PORT;
  const opts = {
    bind: env.AGY_RELAY_BIND || '',
    waitEasyTier: env.AGY_RELAY_WAIT_EASYTIER === '1' || env.AGY_RELAY_WAIT_EASYTIE === '1',
    port: rawPort !== undefined && rawPort !== '' ? parsePortValue(rawPort, { allowZero: true, label: 'AGY_RELAY_PORT' }) : 8421,
    targetPort:
      rawTargetPort !== undefined && rawTargetPort !== ''
        ? parsePortValue(rawTargetPort, { allowZero: true, label: 'AGY_RELAY_TARGET_PORT' })
        : 0,
    cert: env.AGY_RELAY_CERT || path.join(CONFIG_DIR, 'cert.pem'),
    key: env.AGY_RELAY_KEY || path.join(CONFIG_DIR, 'key.pem'),
    user: env.AGY_RELAY_USER || 'agy',
    pass: env.AGY_RELAY_PASS || '',
    noAuth: env.AGY_RELAY_NO_AUTH === '1',
    noMobilePatch: env.AGY_RELAY_NO_MOBILE_PATCH === '1',
    http3: env.AGY_RELAY_HTTP3 === '1',
    h3Bin: env.AGY_RELAY_H3_BIN || path.join(import.meta.dirname, 'h3-edge', 'agy-h3-edge'),
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '--no-auth') {
      opts.noAuth = true;
    } else if (arg === '--no-mobile-patch') {
      opts.noMobilePatch = true;
    } else if (arg === '--http3') {
      opts.http3 = true;
    } else if (arg === '--no-http3') {
      opts.http3 = false;
    } else if (arg === '--h3-bin' && i + 1 < argv.length) {
      opts.h3Bin = argv[++i];
    } else if (arg === '--wait-easytier') {
      opts.waitEasyTier = true;
    } else if (arg === '--bind' && i + 1 < argv.length) {
      opts.bind = argv[++i];
    } else if (arg === '--port' && i + 1 < argv.length) {
      opts.port = parsePortValue(argv[++i], { allowZero: true, label: '--port' });
    } else if (arg === '--target-port' && i + 1 < argv.length) {
      opts.targetPort = parsePortValue(argv[++i], { allowZero: true, label: '--target-port' });
    } else if (arg === '--cert' && i + 1 < argv.length) {
      opts.cert = argv[++i];
    } else if (arg === '--key' && i + 1 < argv.length) {
      opts.key = argv[++i];
    } else if (arg === '--user' && i + 1 < argv.length) {
      opts.user = argv[++i];
    } else if (arg === '--pass' && i + 1 < argv.length) {
      opts.pass = argv[++i];
    } else {
      throw new Error(`Unknown or incomplete option: ${arg}`);
    }
  }
  return opts;
}

function detectEasyTierIp() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (name === 'tun0' || addr.address.startsWith('100.64.')) {
        candidates.push({ name, address: addr.address, priority: name === 'tun0' ? 0 : 1 });
      }
    }
  }
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates[0]?.address || null;
}

async function resolveBindIp(opts) {
  if (opts.bind) return opts.bind;
  let ip = detectEasyTierIp();
  if (ip) return ip;
  if (!opts.waitEasyTier) return '127.0.0.1';
  console.log('Waiting for EasyTier interface (tun0 / 100.64.x.x)...');
  while (!ip) {
    await new Promise((r) => setTimeout(r, 1000));
    ip = detectEasyTierIp();
  }
  return ip;
}

function certMatchesBindIp(certPath, caCertPath, bindIp) {
  if (!fs.existsSync(certPath) || !fs.existsSync(caCertPath)) return false;
  try {
    execFileSync('openssl', ['verify', '-CAfile', caCertPath, certPath], { stdio: 'ignore' });
    const ext = execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-ext', 'subjectAltName'], {
      encoding: 'utf8',
    });
    return ext.includes(bindIp);
  } catch {
    return false;
  }
}

function ensureTlsCert(certPath, keyPath, bindIp) {
  const dir = path.dirname(certPath);
  const caCertPath = path.join(dir, 'ca-cert.pem');
  const caKeyPath = path.join(dir, 'ca-key.pem');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });

  if (!fs.existsSync(caCertPath) || !fs.existsSync(caKeyPath)) {
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '3650',
      '-subj',
      '/CN=Antigravity Local Relay CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
      '-addext',
      'subjectKeyIdentifier=hash',
      '-keyout',
      caKeyPath,
      '-out',
      caCertPath,
    ]);
    fs.chmodSync(caKeyPath, 0o600);
    fs.chmodSync(caCertPath, 0o644);
  }

  if (!fs.existsSync(keyPath) || !certMatchesBindIp(certPath, caCertPath, bindIp)) {
    const csrPath = path.join(dir, '.leaf.csr');
    const leafExt = path.join(dir, '.leaf.ext');
    const san = ['IP:127.0.0.1', 'DNS:localhost'];
    if (net.isIPv4(bindIp) && bindIp !== '127.0.0.1') {
      san.unshift(`IP:${bindIp}`);
    }
    fs.writeFileSync(
      leafExt,
      `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san.join(',')}\n`,
      { mode: 0o600 },
    );
    try {
      execFileSync('openssl', [
        'req',
        '-new',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-subj',
        `/CN=${bindIp}`,
        '-keyout',
        keyPath,
        '-out',
        csrPath,
      ]);
      execFileSync('openssl', [
        'x509',
        '-req',
        '-in',
        csrPath,
        '-CA',
        caCertPath,
        '-CAkey',
        caKeyPath,
        '-CAcreateserial',
        '-out',
        certPath,
        '-days',
        '825',
        '-extfile',
        leafExt,
      ]);
      fs.chmodSync(keyPath, 0o600);
      fs.chmodSync(certPath, 0o644);
    } finally {
      fs.rmSync(csrPath, { force: true });
      fs.rmSync(leafExt, { force: true });
    }
  }

  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
    caCert: fs.readFileSync(caCertPath),
  };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function canConnectLocalPort(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(500);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function discoverTargetInfo(fixedPort) {
  let files = [];
  try {
    const names = await fs.promises.readdir(DAEMON_DIR);
    const candidates = names.filter((f) => f.startsWith('hub_') && f.endsWith('.json'));
    const stated = await Promise.all(
      candidates.map(async (f) => {
        const full = path.join(DAEMON_DIR, f);
        try {
          const st = await fs.promises.stat(full);
          return { full, mtimeMs: st.mtimeMs };
        } catch {
          return null;
        }
      }),
    );
    files = stated.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    files = [];
  }

  for (const file of files) {
    try {
      const data = JSON.parse(await fs.promises.readFile(file.full, 'utf8'));
      const port = Number(data.httpsPort);
      const httpPort = Number(data.httpPort) || 0;
      const pid = Number(data.pid);
      const csrfToken = typeof data.csrfToken === 'string' ? data.csrfToken : '';
      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
      if (fixedPort > 0 && port !== fixedPort) continue;
      if (!isPidAlive(pid)) continue;
      if (await canConnectLocalPort(port)) {
        return { port, httpPort, csrfToken };
      }
    } catch {
      // Ignore malformed/stale discovery files
    }
  }

  if (fixedPort > 0) {
    return { port: fixedPort, httpPort: 0, csrfToken: '' };
  }
  return { port: 0, httpPort: 0, csrfToken: '' };
}

function sha256Equal(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createAuth(opts = {}) {
  if (opts.noAuth) {
    return {
      enabled: false,
      authenticate: () => ({ ok: true, setCookie: null }),
    };
  }
  const user = opts.user || 'agy';
  const password = opts.pass || crypto.randomBytes(12).toString('base64url');
  const hmacSecret = crypto.randomBytes(32);

  function signSession(username) {
    const exp = Date.now() + 24 * 60 * 60 * 1000;
    const payload = Buffer.from(JSON.stringify({ u: username, exp })).toString('base64url');
    const sig = crypto.createHmac('sha256', hmacSecret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  function verifySession(token) {
    const dot = token.indexOf('.');
    if (dot <= 0) return false;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expectedSig = crypto.createHmac('sha256', hmacSecret).update(payload).digest('base64url');
    if (!sha256Equal(sig, expectedSig)) return false;
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return parsed.u === user && typeof parsed.exp === 'number' && parsed.exp > Date.now();
    } catch {
      return false;
    }
  }

  function extractCookie(cookieHeader) {
    if (!cookieHeader) return '';
    for (const part of cookieHeader.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      if (part.slice(0, idx).trim() === SESSION_COOKIE) {
        return part.slice(idx + 1).trim();
      }
    }
    return '';
  }

  function authenticate(req) {
    const sid = extractCookie(req.headers.cookie);
    if (sid && verifySession(sid)) {
      return { ok: true, setCookie: null };
    }
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Basic ')) {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon > 0) {
        const u = decoded.slice(0, colon);
        const p = decoded.slice(colon + 1);
        if (sha256Equal(u, user) && sha256Equal(p, password)) {
          const token = signSession(user);
          return {
            ok: true,
            setCookie: `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Secure; Path=/`,
          };
        }
      }
    }
    return { ok: false, setCookie: null };
  }

  return { enabled: true, user, password, authenticate };
}

function stripRelayCookie(cookieHeader) {
  if (!cookieHeader) return undefined;
  const kept = cookieHeader
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith(`${SESSION_COOKIE}=`));
  return kept.length > 0 ? kept.join('; ') : undefined;
}

export function buildH2UpstreamHeaders(req, targetPort, forceIdentity = false, stripConditional = false) {
  const optsObj = typeof forceIdentity === 'object' && forceIdentity !== null ? forceIdentity : null;
  const useIdentity = optsObj ? Boolean(optsObj.forceIdentity) : Boolean(forceIdentity);
  const dropConditional = optsObj ? Boolean(optsObj.stripConditional) : Boolean(stripConditional);
  const targetOrigin = `https://127.0.0.1:${targetPort}`;
  const out = {
    ':method': req.method || 'GET',
    ':path': req.url || '/',
    ':authority': `127.0.0.1:${targetPort}`,
    ':scheme': 'https',
  };
  for (const [rawKey, val] of Object.entries(req.headers || {})) {
    const key = rawKey.toLowerCase();
    if (val === undefined || key.startsWith(':') || key === 'host' || HOP_BY_HOP.has(key)) {
      continue;
    }
    if (key === 'te' && String(val).toLowerCase() !== 'trailers') {
      continue;
    }
    if (useIdentity && key === 'accept-encoding') {
      continue;
    }
    if (dropConditional && (key === 'if-none-match' || key === 'if-modified-since')) {
      continue;
    }
    if (key === 'origin') {
      out.origin = targetOrigin;
    } else if (key === 'referer') {
      try {
        const refUrl = new URL(Array.isArray(val) ? val[0] : val);
        out.referer = `${targetOrigin}${refUrl.pathname}${refUrl.search}`;
      } catch {
        // Drop malformed referer
      }
    } else if (key === 'cookie') {
      const cleaned = stripRelayCookie(Array.isArray(val) ? val.join('; ') : val);
      if (cleaned) out.cookie = cleaned;
    } else {
      out[key] = val;
    }
  }
  if (useIdentity) {
    out['accept-encoding'] = 'identity';
  }
  return out;
}

function buildHttp1UpgradeHeaders(rawHeaders, targetPort, targetProto = 'https', prefix = '') {
  const targetOrigin = `${targetProto}://127.0.0.1:${targetPort}`;
  const headers = { ...rawHeaders };
  headers.host = `127.0.0.1:${targetPort}`;
  if (headers.origin) headers.origin = targetOrigin;
  if (headers.referer) {
    try {
      const refUrl = new URL(headers.referer);
      let refPath = refUrl.pathname;
      if (prefix && refPath.startsWith(prefix)) {
        refPath = refPath.slice(prefix.length) || '/';
      }
      headers.referer = `${targetOrigin}${refPath}${refUrl.search}`;
    } catch {
      delete headers.referer;
    }
  }
  const cleanedCookie = stripRelayCookie(headers.cookie);
  if (cleanedCookie) headers.cookie = cleanedCookie;
  else delete headers.cookie;
  return headers;
}

function acceptsEncodingToken(enc, token) {
  return (
    enc.includes(token) &&
    !new RegExp(`(?:^|[,\\s])${token}\\s*;\\s*q\\s*=\\s*0(?:\\.0+)?(?:\\s*,|\\s*$)`).test(enc)
  );
}

export function pickEncoding(acceptEncoding, opts = {}) {
  const enc = String(acceptEncoding || '').toLowerCase();
  const preferZstd = Boolean(opts && opts.preferZstd);
  if (preferZstd && HAS_ZSTD && acceptsEncodingToken(enc, 'zstd')) {
    return 'zstd';
  }
  if (acceptsEncodingToken(enc, 'br')) {
    return 'br';
  }
  if (HAS_ZSTD && acceptsEncodingToken(enc, 'zstd')) {
    return 'zstd';
  }
  if (acceptsEncodingToken(enc, 'gzip')) {
    return 'gzip';
  }
  return 'identity';
}

function stripWeakTagPrefix(tag) {
  const t = String(tag || '').trim();
  return t.startsWith('W/') ? t.slice(2).trim() : t;
}

export function matchesIfNoneMatch(header, etag) {
  if (!header || !etag) return false;
  const raw = Array.isArray(header) ? header.join(',') : String(header);
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (trimmed === '*') return true;
  const target = stripWeakTagPrefix(etag);
  const tokens = trimmed.match(/(?:W\/)?"(?:\\.|[^"])*"|\*/g);
  if (tokens) {
    for (const tok of tokens) {
      if (tok === '*') return true;
      if (stripWeakTagPrefix(tok) === target) return true;
    }
    return false;
  }
  for (const part of trimmed.split(',')) {
    const p = part.trim();
    if (p === '*' || stripWeakTagPrefix(p) === target) return true;
  }
  return false;
}

async function compressBufferAsync(buf, encoding) {
  if (encoding === 'zstd' && zstdCompressAsync) {
    return zstdCompressAsync(buf, {
      params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
    });
  }
  if (encoding === 'br') {
    return brotliCompressAsync(buf, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
    });
  }
  if (encoding === 'gzip') {
    return gzipAsync(buf, { level: 6 });
  }
  return buf;
}

export function etagVersionTag(etag) {
  if (!etag || typeof etag !== 'string') return '';
  return crypto.createHash('sha256').update(etag).digest('hex').slice(0, 8);
}

function computeContentEtag(buf) {
  const hash16 = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  return `"sha256-${hash16}"`;
}

function isCompressibleAsset(contentType, byteLength) {
  if (byteLength <= 512) return false;
  const ct = String(contentType || '').toLowerCase();
  if (ct.startsWith('image/') || ct.startsWith('audio/') || ct.startsWith('video/')) {
    return false;
  }
  return true;
}

export async function createStaticAssetEntry(body, contentType, extraHeaders = {}, options = {}) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  const ct = contentType || 'application/octet-stream';
  const etag = options.etag || computeContentEtag(raw);
  const compress = options.compress ?? isCompressibleAsset(ct, raw.length);
  let br = null;
  let gz = null;
  if (compress) {
    [br, gz] = await Promise.all([compressBufferAsync(raw, 'br'), compressBufferAsync(raw, 'gzip')]);
  }
  return {
    raw,
    br,
    gz,
    zstd: null,
    etag,
    upstreamEtag: options.upstreamEtag || '',
    lastModified: options.lastModified || '',
    contentType: ct,
    extraHeaders: { ...extraHeaders },
    checkedAt: options.checkedAt ?? Date.now(),
  };
}

const VIEWPORT_META_TAG =
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />';
const VIEWPORT_META_RE =
  /<meta\b(?=[^>]*\bname\s*=\s*(?:"viewport"|'viewport'|viewport(?=[\s>/])))[^>]*>\s*/gi;

export function injectMobileHead(html, assetVersions = {}, inlineAssets = null) {
  const verUrl = (p) => (assetVersions[p] ? `${p}?v=${assetVersions[p]}` : p);
  const useInline = Boolean(inlineAssets && typeof inlineAssets === 'object' && inlineAssets.css && inlineAssets.js);
  const mobilePreload = useInline
    ? ''
    : `\n<link rel="preload" as="style" href="${verUrl('/relay-mobile.css')}" />\n<link rel="preload" as="script" href="${verUrl('/relay-mobile.js')}" />`;
  const preload = `${VIEWPORT_META_TAG}
<link rel="preload" as="style" href="${verUrl('/compiled_tailwind.css')}" />
<link rel="preload" as="style" href="${verUrl('/jetbox.css')}" />${mobilePreload}
<link rel="preload" as="script" href="${verUrl('/main.js')}" />`;

  let out = String(html);
  for (const p of ['/jetbox.css', '/compiled_tailwind.css', '/prism_bundle.js', '/main.js']) {
    if (!assetVersions[p]) continue;
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`((?:href|src)=["'])${escaped}(["'])`, 'g'), `$1${verUrl(p)}$2`);
  }

  const openHead = /<head\b[^>]*>/i.exec(out);
  const closeHead = /<\/head>/i.exec(out);
  if (openHead && closeHead && closeHead.index > openHead.index) {
    const headStart = openHead.index + openHead[0].length;
    const headInner = out.slice(headStart, closeHead.index).replace(VIEWPORT_META_RE, '');
    const sep = headInner.startsWith('\n') || headInner.startsWith('\r') ? '' : '\n';
    out = `${out.slice(0, headStart)}\n${preload}${sep}${headInner}${out.slice(closeHead.index)}`;
  } else if (openHead) {
    const headStart = openHead.index + openHead[0].length;
    const tail = out.slice(headStart).replace(VIEWPORT_META_RE, '');
    const sep = tail.startsWith('\n') || tail.startsWith('\r') ? '' : '\n';
    out = `${out.slice(0, headStart)}\n${preload}${sep}${tail}`;
  }

  const mobileTags = useInline
    ? `<style data-agy-relay="mobile-css">${inlineAssets.css.replace(/<\/style/gi, '<\\/style')}</style>\n<script data-agy-relay="mobile-js">${inlineAssets.js.replace(/<\/script/gi, '<\\/script')}</script>`
    : `<link rel="stylesheet" href="${verUrl('/relay-mobile.css')}" />\n<script src="${verUrl('/relay-mobile.js')}"></script>`;

  const snippet = `<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />
<link rel="icon" type="image/png" sizes="192x192" href="/relay-icon-192.png" />
<link rel="apple-touch-icon" sizes="192x192" href="/relay-icon-192.png" />
<meta name="theme-color" content="#0b0b0f" media="(prefers-color-scheme: dark)" />
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
${mobileTags}`;

  const idxMatch = /<\/head>/i.exec(out);
  if (!idxMatch) return out;
  return `${out.slice(0, idxMatch.index)}${snippet}\n${out.slice(idxMatch.index)}`;
}

const APP_CONFIG_EMPTY_CSRF_RE =
  /(window\.__APP_CONFIG__\s*=\s*\{[^<]*?"csrfToken"\s*:\s*)""/;

export function injectCsrfToken(html, csrfToken) {
  const out = String(html);
  if (!csrfToken || typeof csrfToken !== 'string') return out;
  return out.replace(APP_CONFIG_EMPTY_CSRF_RE, (_, prefix) => `${prefix}${JSON.stringify(csrfToken)}`);
}

function getDiskCachePath(pathname, etag, ext) {
  if (!etag) return null;
  const key = crypto.createHash('sha256').update(`${pathname}|${etag}`).digest('hex').slice(0, 24);
  return path.join(CACHE_DIR, `${key}.${ext}`);
}

async function writeDiskCacheFile(filePath, data) {
  await fs.promises.mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fs.promises.writeFile(tmp, data, { mode: 0o600 });
  await fs.promises.rename(tmp, filePath);
}

async function upgradeAndPersistDiskBrotli(entry, diskPath, expectedEtag) {
  const maxBr = await brotliCompressAsync(entry.raw, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  if (maxBr && entry.etag === expectedEtag) {
    entry.br = maxBr;
    await writeDiskCacheFile(diskPath, maxBr);
  }
}

export function parseLocalProxyTarget(reqUrl, refererHeader, relayPort = 0) {
  const raw = reqUrl || '/';
  const exact = /^\/_relay_local\/(http|https)\/(\d{1,5})(\/.*|\?.*)?$/.exec(raw);
  if (exact) {
    const proto = exact[1];
    const port = Number(exact[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || (relayPort > 0 && port === relayPort)) return null;
    let upstreamPath = exact[3] || '/';
    if (upstreamPath.startsWith('?')) upstreamPath = `/${upstreamPath}`;
    return {
      proto,
      port,
      prefix: `/_relay_local/${proto}/${port}`,
      upstreamPath,
      needsSlashRedirect: !exact[3] || exact[3].startsWith('?'),
    };
  }
  if (refererHeader) {
    try {
      const refUrl = new URL(refererHeader);
      const refMatch = /^\/_relay_local\/(http|https)\/(\d{1,5})(?:\/|$)/.exec(refUrl.pathname);
      if (refMatch) {
        const proto = refMatch[1];
        const port = Number(refMatch[2]);
        if (Number.isInteger(port) && port >= 1 && port <= 65535 && (relayPort <= 0 || port !== relayPort)) {
          return {
            proto,
            port,
            prefix: `/_relay_local/${proto}/${port}`,
            upstreamPath: raw,
            needsSlashRedirect: false,
          };
        }
      }
    } catch {
      // Ignore malformed referer
    }
  }
  return null;
}

function rewriteLocalRedirectLocation(loc, target) {
  if (typeof loc !== 'string' || !loc) return loc;
  if (loc.startsWith('/') && !loc.startsWith('//') && !loc.startsWith('/_relay_local/')) {
    return `${target.prefix}${loc}`;
  }
  try {
    const u = new URL(loc);
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1') {
      const proto = u.protocol === 'https:' ? 'https' : 'http';
      const port = u.port || (proto === 'https' ? '443' : '80');
      return `/_relay_local/${proto}/${port}${u.pathname || '/'}${u.search}${u.hash}`;
    }
  } catch {
    // Ignore non-URL locations
  }
  return loc;
}

function rewriteUpstreamLocation(loc, portToUse, clientHost) {
  if (typeof loc !== 'string' || !loc || !clientHost) return loc;
  try {
    const u = new URL(loc);
    const h = u.hostname.toLowerCase();
    if (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      (h === '127.0.0.1' || h === 'localhost') &&
      (!u.port || Number(u.port) === portToUse)
    ) {
      return `https://${clientHost}${u.pathname}${u.search}${u.hash}`;
    }
  } catch {
    // Keep relative or non-URL Location intact
  }
  return loc;
}

function buildLocalIframeShim(prefix, nonce = '') {
  const nonceAttr = nonce ? ` nonce="${String(nonce).replace(/"/g, '&quot;')}"` : '';
  return `<script data-agy-relay-local${nonceAttr}>(function(){
var P=${JSON.stringify(prefix)};
function rw(u){
  if(typeof u!=='string')return u;
  if(u.indexOf('/_relay_local/')===0||u.indexOf(window.location.origin+'/_relay_local/')===0)return u;
  if(u.charAt(0)==='/'&&u.charAt(1)!=='/')return P+u;
  try{
    var p=new URL(u,window.location.href);
    var h=p.hostname.toLowerCase();
    if(h==='localhost'||h==='127.0.0.1'||h==='[::1]'||h==='::1'){
      var pr=p.protocol==='https:'||p.protocol==='wss:'?'https':'http';
      var pt=p.port||(pr==='https'?'443':'80');
      var base=(p.protocol==='ws:'||p.protocol==='wss:')?((window.location.protocol==='https:'?'wss://':'ws://')+window.location.host):window.location.origin;
      return base+'/_relay_local/'+pr+'/'+pt+p.pathname+p.search+p.hash;
    }
    if(p.origin===window.location.origin&&p.pathname.indexOf('/_relay_local/')!==0){
      var outBase=(p.protocol==='ws:'||p.protocol==='wss:')?((window.location.protocol==='https:'?'wss://':'ws://')+window.location.host):window.location.origin;
      return outBase+P+p.pathname+p.search+p.hash;
    }
  }catch(e){}
  return u;
}
var origFetch=window.fetch;
if(origFetch){
  window.fetch=function(input,init){
    if(typeof input==='string')input=rw(input);
    else if(input&&typeof input==='object'&&typeof input.url==='string'){
      var nu=rw(input.url);
      if(nu!==input.url)input=new Request(nu,input);
    }
    return origFetch.call(this,input,init);
  };
}
var origOpen=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method,url){
  var args=Array.prototype.slice.call(arguments);
  args[1]=rw(url);
  return origOpen.apply(this,args);
};
if(window.EventSource){
  var OrigES=window.EventSource;
  window.EventSource=function(url,cfg){return new OrigES(rw(url),cfg);};
  window.EventSource.prototype=OrigES.prototype;
}
if(window.WebSocket){
  var OrigWS=window.WebSocket;
  window.WebSocket=function(url,protos){
    var target=rw(url);
    if(typeof target==='string'&&target.charAt(0)==='/'){
      target=(window.location.protocol==='https:'?'wss://':'ws://')+window.location.host+target;
    }
    return protos!==undefined?new OrigWS(target,protos):new OrigWS(target);
  };
  window.WebSocket.prototype=OrigWS.prototype;
  window.WebSocket.CONNECTING=OrigWS.CONNECTING;
  window.WebSocket.OPEN=OrigWS.OPEN;
  window.WebSocket.CLOSING=OrigWS.CLOSING;
  window.WebSocket.CLOSED=OrigWS.CLOSED;
}
})();</script>`;
}

const LOCAL_ATTR_RE = /((?:^|[\s"'/])(?:src|href|action)\s*=\s*["'])\/(?!\/|_relay_local\/)/gi;
const LOCAL_HTML_SCAN_RE =
  /(<!--[\s\S]*?-->)|(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)|(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)|(<[^>]+>)/gi;

function rewriteOpeningTagUrls(tag, prefix) {
  return tag.replace(LOCAL_ATTR_RE, (_, lead) => `${lead}${prefix}/`);
}

export function rewriteLocalHtml(html, prefix, nonce = '') {
  const rewritten = String(html).replace(
    LOCAL_HTML_SCAN_RE,
    (full, comment, sOpen, sBody, sClose, stOpen, stBody, stClose, tag) => {
      if (comment) return comment;
      if (sOpen) return `${rewriteOpeningTagUrls(sOpen, prefix)}${sBody}${sClose}`;
      if (stOpen) return `${rewriteOpeningTagUrls(stOpen, prefix)}${stBody}${stClose}`;
      if (tag) return rewriteOpeningTagUrls(tag, prefix);
      return full;
    },
  );
  const shim = buildLocalIframeShim(prefix, nonce);
  const headMatch = /<head\b[^>]*>/i.exec(rewritten);
  if (headMatch) {
    const pos = headMatch.index + headMatch[0].length;
    return `${rewritten.slice(0, pos)}\n${shim}${rewritten.slice(pos)}`;
  }
  return `${shim}\n${rewritten}`;
}

function directiveRestrictsInlineScript(sources) {
  const lower = sources.map((s) => s.toLowerCase());
  const hasUnsafeInline = lower.includes("'unsafe-inline'");
  const hasNonceOrHashOrStrict = lower.some((s) => /^'(?:nonce-|sha(?:256|384|512)-|strict-dynamic)/.test(s));
  return !hasUnsafeInline || hasNonceOrHashOrStrict;
}

function stripFrameAncestorsFromCsp(rawHeader) {
  const policies = Array.isArray(rawHeader) ? rawHeader.flatMap((v) => String(v).split(',')) : String(rawHeader).split(',');
  const cleaned = policies
    .map((policy) =>
      policy
        .split(';')
        .map((d) => d.trim())
        .filter((d) => d && !/^frame-ancestors(?:\s|$)/i.test(d))
        .join('; '),
    )
    .filter(Boolean);
  return cleaned.join(', ');
}

function adaptLocalCspHeaders(respHeaders, allowScriptNonce) {
  delete respHeaders['x-frame-options'];
  if (respHeaders['content-security-policy-report-only']) {
    const cleanedRo = stripFrameAncestorsFromCsp(respHeaders['content-security-policy-report-only']);
    if (cleanedRo) respHeaders['content-security-policy-report-only'] = cleanedRo;
    else delete respHeaders['content-security-policy-report-only'];
  }

  let nonce = '';
  const rawCsp = respHeaders['content-security-policy'];
  if (!rawCsp) return nonce;

  const rawPolicies = Array.isArray(rawCsp)
    ? rawCsp.flatMap((v) => String(v).split(','))
    : String(rawCsp).split(',');

  const outPolicies = [];
  for (const policy of rawPolicies) {
    const directives = [];
    let scriptSrcIdx = -1;
    let scriptSrcElemIdx = -1;
    let defaultSrcTokens = null;

    for (const part of policy.split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const tokens = trimmed.split(/\s+/);
      const name = tokens[0].toLowerCase();
      if (name === 'frame-ancestors') continue;
      const idx = directives.length;
      directives.push({ name, tokens });
      if (name === 'script-src') scriptSrcIdx = idx;
      else if (name === 'script-src-elem') scriptSrcElemIdx = idx;
      else if (name === 'default-src') defaultSrcTokens = tokens.slice(1);
    }

    if (allowScriptNonce) {
      const ensureNonce = () => {
        if (!nonce) nonce = crypto.randomBytes(16).toString('hex');
        return `'nonce-${nonce}'`;
      };
      if (scriptSrcIdx >= 0 && directiveRestrictsInlineScript(directives[scriptSrcIdx].tokens.slice(1))) {
        directives[scriptSrcIdx].tokens.push(ensureNonce());
      }
      if (scriptSrcElemIdx >= 0 && directiveRestrictsInlineScript(directives[scriptSrcElemIdx].tokens.slice(1))) {
        directives[scriptSrcElemIdx].tokens.push(ensureNonce());
      }
      if (scriptSrcIdx < 0 && scriptSrcElemIdx < 0 && defaultSrcTokens && directiveRestrictsInlineScript(defaultSrcTokens)) {
        const inherited = defaultSrcTokens.filter((t) => t.toLowerCase() !== "'none'");
        directives.push({ name: 'script-src', tokens: ['script-src', ...inherited, ensureNonce()] });
      }
    }

    const joined = directives.map((d) => d.tokens.join(' ')).join('; ');
    if (joined) outPolicies.push(joined);
  }

  if (outPolicies.length > 0) {
    respHeaders['content-security-policy'] = outPolicies.join(', ');
  } else {
    delete respHeaders['content-security-policy'];
  }
  return nonce;
}

function readJsonBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', fail);
  });
}

function attachH2SessionHeartbeat(session, onTimeoutOrError) {
  let ackTimer = null;
  let pingTimer = null;
  let closed = false;

  const cleanup = () => {
    closed = true;
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (ackTimer) {
      clearTimeout(ackTimer);
      ackTimer = null;
    }
  };

  pingTimer = setInterval(() => {
    if (closed || session.closed || session.destroyed) {
      cleanup();
      return;
    }
    if (ackTimer) return;
    ackTimer = setTimeout(() => {
      ackTimer = null;
      if (!closed && !session.destroyed) {
        cleanup();
        onTimeoutOrError(session);
      }
    }, H2_PING_TIMEOUT_MS);
    ackTimer.unref?.();

    try {
      const sent = session.ping((err) => {
        if (ackTimer) {
          clearTimeout(ackTimer);
          ackTimer = null;
        }
        if (err && !closed && !session.destroyed) {
          cleanup();
          onTimeoutOrError(session);
        }
      });
      if (!sent) {
        cleanup();
        onTimeoutOrError(session);
      }
    } catch {
      cleanup();
      onTimeoutOrError(session);
    }
  }, H2_PING_INTERVAL_MS);
  pingTimer.unref?.();

  session.on('close', cleanup);
  session.on('error', cleanup);
  return cleanup;
}

const CONTEXT_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractCjsExport(source, fileLabel) {
  const marker = 'module.exports = ';
  const idx = source.indexOf(marker);
  if (idx < 0) throw new Error(`Unexpected CJS export format in ${fileLabel}`);
  return source.slice(idx + marker.length).trim().replace(/;$/, '');
}

function createContextBridgeLoader() {
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
        { UsageLedger },
        { SessionHistory },
        { PreferencesStore },
        { readHostTheme },
        { platformPaths },
      ] = await Promise.all([
        importPlugin('sidecars/panel/store.mjs'),
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
      const store = new MetricsStore(undefined, {
        history: readOnlyHistory,
        onTrajectory: null,
        onBackgroundResult: null,
        background: null,
        owns: () => true,
      });
      const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
      const ledger = new UsageLedger(undefined, { timeZone: localTimeZone });
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
        const base = await store.snapshot({ ...input, selectLatest: false });
        let usageData = null;
        if (store.identity) {
          const summaryNow = Date.now();
          if (bypassCache || summaryNow - lastUsageSummaryAt > 5000) {
            // Force cache re-aggregation over lstat-cached JSON ledger files since writes happen in the desktop sidecar.
            ledger.cache = null;
            lastUsageSummaryAt = summaryNow;
          }
          usageData = await ledger.summary(store.identity, summaryNow);
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
        metricsCache.set(cacheKey, { data: result, expiresAt: Date.now() + ttl });
        return result;
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

async function sendCompressedAssetAsync(req, res, status, contentType, bodyBuf, extraHeaders = {}) {
  const encoding = pickEncoding(req.headers['accept-encoding'], { preferZstd: true });
  const out = bodyBuf.length > 512 && encoding !== 'identity' ? await compressBufferAsync(bodyBuf, encoding) : bodyBuf;
  if (res.destroyed || res.writableEnded) return;
  const headers = {
    'content-type': contentType,
    'content-length': String(out.length),
    vary: 'Accept-Encoding',
    ...extraHeaders,
  };
  if (out !== bodyBuf && encoding !== 'identity') {
    headers['content-encoding'] = encoding;
  }
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : out);
}

function sendPrecompressedEntry(req, res, entry, setCookie) {
  if (res.destroyed || res.writableEnded) return;
  const headers = {
    vary: 'Accept-Encoding',
    ...(entry.extraHeaders || {}),
  };
  if (setCookie) headers['set-cookie'] = setCookie;

  const encoding = pickEncoding(req.headers['accept-encoding']);
  let payload = entry.raw;
  if (encoding === 'br' && entry.br) {
    payload = entry.br;
    headers['content-encoding'] = 'br';
  } else if (encoding === 'gzip' && entry.gz) {
    payload = entry.gz;
    headers['content-encoding'] = 'gzip';
  }
  headers['content-type'] = entry.contentType;
  headers['content-length'] = String(payload.length);
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : payload);
}

async function ensureEntryEncoding(entry, encoding, diskMeta = null) {
  if (encoding === 'identity' || !isCompressibleAsset(entry.contentType, entry.raw.length)) {
    return entry.raw;
  }
  const diskKey = diskMeta ? diskMeta.key || entry.etag : '';
  if (encoding === 'br') {
    if (entry.br) return entry.br;
    if (!entry._brPromise) {
      entry._brPromise = (async () => {
        const diskPath = diskMeta && diskKey ? getDiskCachePath(diskMeta.pathname, diskKey, 'br') : null;
        if (diskPath) {
          try {
            const fromDisk = await fs.promises.readFile(diskPath);
            if (fromDisk.length > 0) {
              entry.br = fromDisk;
              return fromDisk;
            }
          } catch {}
        }
        const compressed = await compressBufferAsync(entry.raw, 'br');
        entry.br = compressed;
        if (diskPath) {
          if (entry.raw.length > 50 * 1024) {
            upgradeAndPersistDiskBrotli(entry, diskPath, entry.etag).catch(() => {});
          } else {
            writeDiskCacheFile(diskPath, compressed).catch(() => {});
          }
        }
        return compressed;
      })().finally(() => {
        entry._brPromise = null;
      });
    }
    return entry._brPromise;
  }
  if (encoding === 'gzip') {
    if (entry.gz) return entry.gz;
    if (!entry._gzPromise) {
      entry._gzPromise = (async () => {
        const diskPath = diskMeta && diskKey ? getDiskCachePath(diskMeta.pathname, diskKey, 'gz') : null;
        if (diskPath) {
          try {
            const fromDisk = await fs.promises.readFile(diskPath);
            if (fromDisk.length > 0) {
              entry.gz = fromDisk;
              return fromDisk;
            }
          } catch {}
        }
        const compressed = await compressBufferAsync(entry.raw, 'gzip');
        entry.gz = compressed;
        if (diskPath) {
          writeDiskCacheFile(diskPath, compressed).catch(() => {});
        }
        return compressed;
      })().finally(() => {
        entry._gzPromise = null;
      });
    }
    return entry._gzPromise;
  }
  if (encoding === 'zstd' && zstdCompressAsync) {
    if (entry.zstd) return entry.zstd;
    if (!entry._zstdPromise) {
      entry._zstdPromise = (async () => {
        const diskPath = diskMeta && diskKey ? getDiskCachePath(diskMeta.pathname, diskKey, 'zst') : null;
        if (diskPath) {
          try {
            const fromDisk = await fs.promises.readFile(diskPath);
            if (fromDisk.length > 0) {
              entry.zstd = fromDisk;
              return fromDisk;
            }
          } catch {}
        }
        const compressed = await compressBufferAsync(entry.raw, 'zstd');
        entry.zstd = compressed;
        if (diskPath) {
          writeDiskCacheFile(diskPath, compressed).catch(() => {});
        }
        return compressed;
      })().finally(() => {
        entry._zstdPromise = null;
      });
    }
    return entry._zstdPromise;
  }
  return entry.raw;
}

async function serveCachedStatic(req, res, entry, setCookie, diskMeta = null) {
  if (res.destroyed || res.writableEnded) return;
  const inm = req.headers['if-none-match'];
  const ims = req.headers['if-modified-since'];
  let queryV = '';
  if (req.url && req.url.includes('?')) {
    try {
      queryV = new URL(req.url, 'https://localhost').searchParams.get('v') || '';
    } catch {}
  }
  const isVersionedImmutable = Boolean(entry.etag && queryV && queryV === etagVersionTag(entry.etag));
  const defaultCacheControl = entry.extraHeaders?.['cache-control'] || 'no-cache';
  const baseHeaders = {
    vary: 'Accept-Encoding',
    ...(entry.extraHeaders || {}),
    'cache-control': isVersionedImmutable ? 'public, max-age=31536000, immutable' : defaultCacheControl,
  };
  if (entry.etag) baseHeaders.etag = entry.etag;
  if (entry.lastModified) baseHeaders['last-modified'] = entry.lastModified;
  if (setCookie) baseHeaders['set-cookie'] = setCookie;

  let notModified = false;
  if (inm) {
    notModified = Boolean(entry.etag && matchesIfNoneMatch(inm, entry.etag));
  } else if (ims && entry.lastModified) {
    const imsMs = Date.parse(Array.isArray(ims) ? ims[0] : ims);
    const lmMs = Date.parse(entry.lastModified);
    if (Number.isFinite(imsMs) && Number.isFinite(lmMs) && lmMs <= imsMs) {
      notModified = true;
    }
  }

  if (notModified) {
    res.writeHead(304, baseHeaders);
    res.end();
    return;
  }

  const encoding = pickEncoding(req.headers['accept-encoding']);
  let payload = entry.raw;
  if (encoding !== 'identity') {
    payload = await ensureEntryEncoding(entry, encoding, diskMeta);
    if (res.destroyed || res.writableEnded) return;
    if (payload !== entry.raw) {
      baseHeaders['content-encoding'] = encoding;
    }
  }
  baseHeaders['content-type'] = entry.contentType;
  baseHeaders['content-length'] = String(payload.length);
  res.writeHead(200, baseHeaders);
  res.end(req.method === 'HEAD' ? undefined : payload);
}

function cleanUpstreamHeaders(headers) {
  const out = {};
  for (const [rawKey, val] of Object.entries(headers || {})) {
    const key = rawKey.toLowerCase();
    if (key.startsWith(':') || HOP_BY_HOP.has(key) || val === undefined) continue;
    out[key] = val;
  }
  return out;
}

function applyCorsAndLocation(respHeaders, clientOrigin, clientHost, portToUse) {
  if (respHeaders['access-control-allow-origin']) {
    let hostOrigin = null;
    if (clientHost) {
      try {
        hostOrigin = new URL(`https://${clientHost}`).origin;
      } catch {}
    }
    if (clientOrigin && hostOrigin) {
      let isSameOrigin = false;
      try {
        isSameOrigin = new URL(clientOrigin).origin === hostOrigin;
      } catch {}
      if (isSameOrigin) {
        respHeaders['access-control-allow-origin'] = hostOrigin;
        respHeaders.vary = respHeaders.vary ? `${respHeaders.vary}, Origin` : 'Origin';
      } else {
        delete respHeaders['access-control-allow-origin'];
      }
    } else if (respHeaders['access-control-allow-origin'] !== '*' && hostOrigin) {
      respHeaders['access-control-allow-origin'] = hostOrigin;
    }
  }
  if (typeof respHeaders.location === 'string' && clientHost) {
    respHeaders.location = rewriteUpstreamLocation(respHeaders.location, portToUse, clientHost);
  }
}

function appendSetCookie(respHeaders, setCookie) {
  if (!setCookie) return;
  const existing = respHeaders['set-cookie'];
  respHeaders['set-cookie'] = Array.isArray(existing)
    ? [...existing, setCookie]
    : existing
      ? [existing, setCookie]
      : [setCookie];
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err?.message || String(err));
    process.exit(1);
  }
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const auth = createAuth(opts);
  const bindIp = await resolveBindIp(opts);
  const tlsCreds = ensureTlsCert(opts.cert, opts.key, bindIp);
  let activePort = opts.port;
  const setupHtml = renderSetupHtml(bindIp, opts.port);
  const startupLastModified = new Date().toUTCString();

  const [setupEntry, manifestEntry, icon192Entry, icon512Entry, mobileCssEntry, mobileJsEntry, swJsEntry, caCertEntry] =
    await Promise.all([
      createStaticAssetEntry(setupHtml, 'text/html; charset=utf-8', {}, { lastModified: startupLastModified }),
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
      createStaticAssetEntry(
        MOBILE_JS,
        'application/javascript; charset=utf-8',
        {},
        { lastModified: startupLastModified },
      ),
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
    ['/manifest.webmanifest', manifestEntry],
    ['/relay-icon-192.png', icon192Entry],
    ['/relay-icon-512.png', icon512Entry],
    ['/relay-mobile.css', mobileCssEntry],
    ['/relay-mobile.js', mobileJsEntry],
    ['/sw.js', swJsEntry],
  ]);

  let cachedTargetInfo = { port: 0, httpPort: 0, csrfToken: '' };
  let cachedAt = 0;
  let inFlightDiscovery = null;
  let h2Session = null;
  let h2SessionPort = 0;
  let detachH2Heartbeat = null;

  // Memory cache for upstream static bundles keyed by URL pathname
  const staticCache = new Map();
  const inFlightStatic = new Map();
  const getContextBridge = createContextBridgeLoader();

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
          if (info.port > 0) {
            cachedTargetInfo = info;
            cachedAt = Date.now();
          } else if (forceRefresh) {
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

  const rootHtmlMemo = new Map();

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
    const extraHeaders =
      pathname === '/antigravityCascadeDone.mp3'
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

  async function handleLocalRoute(pathname, req, res, authResult) {
    const cookieOpt = authResult.setCookie ? { 'set-cookie': authResult.setCookie } : {};
    const staticEntry = localStaticRoutes.get(pathname);
    if (staticEntry && (req.method === 'GET' || req.method === 'HEAD')) {
      await serveCachedStatic(req, res, staticEntry, authResult.setCookie);
      return true;
    }
    if (pathname === '/connect-websocket' && (req.method === 'GET' || req.method === 'HEAD') && !req.headers.upgrade) {
      res.writeHead(204, {
        'cache-control': 'no-store',
        'content-length': '0',
        ...cookieOpt,
      });
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
        res.writeHead(405, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cookieOpt });
        res.end('{"error":"Method not allowed"}');
        return true;
      }
      const bridge = await getContextBridge();
      if (!bridge) {
        res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cookieOpt });
        res.end('{"error":"antigravity-context not installed"}');
        return true;
      }
      try {
        const input = await readJsonBody(req, 4096);
        const data = await bridge.getMetrics(input);
        await sendCompressedAssetAsync(req, res, 200, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(data)), {
          'cache-control': 'no-store',
          ...cookieOpt,
        });
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cookieOpt });
          res.end(
            JSON.stringify({ connection: 'offline', error: err?.message || 'Metrics unavailable', speed: null, groups: [] }),
          );
        }
      }
      return true;
    }
    if (pathname === '/relay-plugin/antigravity-context/preferences') {
      const bridge = await getContextBridge();
      if (!bridge) {
        res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cookieOpt });
        res.end('{"error":"antigravity-context not installed"}');
        return true;
      }
      try {
        if (req.method === 'GET') {
          const data = await bridge.getPreferences();
          await sendCompressedAssetAsync(
            req,
            res,
            200,
            'application/json; charset=utf-8',
            Buffer.from(JSON.stringify(data)),
            {
              'cache-control': 'no-store',
              ...cookieOpt,
            },
          );
          return true;
        }
        if (req.method === 'POST') {
          const input = await readJsonBody(req, 1024);
          const data = await bridge.setPreferences(input);
          await sendCompressedAssetAsync(
            req,
            res,
            200,
            'application/json; charset=utf-8',
            Buffer.from(JSON.stringify(data)),
            {
              'cache-control': 'no-store',
              ...cookieOpt,
            },
          );
          return true;
        }
        res.writeHead(405, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cookieOpt });
        res.end('{"error":"Method not allowed"}');
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cookieOpt });
          res.end(JSON.stringify({ error: err?.message || 'Preferences error' }));
        }
      }
      return true;
    }
    return false;
  }

  function proxyLocalTarget(req, res, authResult, target) {
    if (target.needsSlashRedirect && (req.method === 'GET' || req.method === 'HEAD')) {
      const location = `${target.prefix}${target.upstreamPath}`;
      const headers = { location, 'cache-control': 'no-store' };
      if (authResult.setCookie) headers['set-cookie'] = authResult.setCookie;
      res.writeHead(307, headers);
      res.end();
      return;
    }

    const upstreamHeaders = {};
    for (const [rawKey, val] of Object.entries(req.headers)) {
      const key = rawKey.toLowerCase();
      if (key.startsWith(':') || HOP_BY_HOP.has(key) || val === undefined) continue;
      if (key === 'host') continue;
      if (key === 'origin') {
        upstreamHeaders.origin = `${target.proto}://127.0.0.1:${target.port}`;
      } else if (key === 'referer') {
        try {
          const refUrl = new URL(Array.isArray(val) ? val[0] : val);
          const refPath = refUrl.pathname.startsWith(target.prefix)
            ? refUrl.pathname.slice(target.prefix.length) || '/'
            : refUrl.pathname;
          upstreamHeaders.referer = `${target.proto}://127.0.0.1:${target.port}${refPath}${refUrl.search}`;
        } catch {
          // Ignore malformed referer
        }
      } else if (key === 'cookie') {
        const cleaned = stripRelayCookie(Array.isArray(val) ? val.join('; ') : val);
        if (cleaned) upstreamHeaders.cookie = cleaned;
      } else {
        upstreamHeaders[key] = val;
      }
    }
    upstreamHeaders.host = `127.0.0.1:${target.port}`;
    if (req.method === 'GET' || req.method === 'HEAD') {
      upstreamHeaders['accept-encoding'] = 'identity';
    }

    const client = target.proto === 'https' ? https : http;
    const upReq = client.request(
      {
        hostname: '127.0.0.1',
        port: target.port,
        path: target.upstreamPath,
        method: req.method,
        headers: upstreamHeaders,
        agent: target.proto === 'https' ? localHttpsAgent : localHttpAgent,
      },
      (upRes) => {
        const status = upRes.statusCode || 502;
        const respHeaders = cleanUpstreamHeaders(upRes.headers);
        if (typeof respHeaders.location === 'string') {
          respHeaders.location = rewriteLocalRedirectLocation(respHeaders.location, target);
        }
        appendSetCookie(respHeaders, authResult.setCookie);

        const contentType = String(respHeaders['content-type'] || '').toLowerCase();
        const shouldRewriteHtml =
          contentType.includes('text/html') &&
          req.method === 'GET' &&
          status >= 200 &&
          status < 400 &&
          status !== 204 &&
          status !== 304;

        const cspNonce = adaptLocalCspHeaders(respHeaders, shouldRewriteHtml);
        const declaredLen = Number(respHeaders['content-length']);

        upRes.on('error', () => {
          if (!res.destroyed) res.destroy();
        });

        if (shouldRewriteHtml && !(Number.isFinite(declaredLen) && declaredLen > MAX_HTML_BUFFER_BYTES)) {
          const chunks = [];
          let totalBytes = 0;
          let overflowed = false;

          const onData = (c) => {
            if (overflowed) return;
            totalBytes += c.length;
            if (totalBytes > MAX_HTML_BUFFER_BYTES) {
              overflowed = true;
              upRes.removeListener('data', onData);
              upRes.removeListener('end', onEnd);
              if (!res.destroyed && !res.writableEnded) {
                res.writeHead(status, respHeaders);
                for (const prev of chunks) res.write(prev);
                res.write(c);
                chunks.length = 0;
                upRes.pipe(res);
              }
              return;
            }
            chunks.push(c);
          };

          const onEnd = async () => {
            if (overflowed || res.destroyed || res.writableEnded) return;
            try {
              let rawBuf = Buffer.concat(chunks);
              const enc = String(respHeaders['content-encoding'] || '').toLowerCase();
              try {
                if (enc === 'gzip') rawBuf = await gunzipAsync(rawBuf);
                else if (enc === 'br') rawBuf = await brotliDecompressAsync(rawBuf);
                else if (enc === 'deflate') rawBuf = await inflateAsync(rawBuf);
              } catch {
                // Leave rawBuf as-is if decompression fails
              }
              if (res.destroyed || res.writableEnded) return;
              delete respHeaders['content-encoding'];
              delete respHeaders['content-length'];
              delete respHeaders.etag;

              const outBuf =
                rawBuf.length > MAX_HTML_BUFFER_BYTES
                  ? rawBuf
                  : Buffer.from(rewriteLocalHtml(rawBuf.toString('utf8'), target.prefix, cspNonce), 'utf8');

              const outEnc = pickEncoding(req.headers['accept-encoding'], { preferZstd: true });
              if (outBuf.length > 512 && outEnc !== 'identity') {
                const compressed = await compressBufferAsync(outBuf, outEnc);
                if (res.destroyed || res.writableEnded) return;
                respHeaders['content-encoding'] = outEnc;
                respHeaders['content-length'] = String(compressed.length);
                respHeaders.vary = 'Accept-Encoding';
                res.writeHead(status, respHeaders);
                res.end(compressed);
              } else {
                respHeaders['content-length'] = String(outBuf.length);
                res.writeHead(status, respHeaders);
                res.end(outBuf);
              }
            } catch {
              if (!res.destroyed) res.destroy();
            }
          };

          upRes.on('data', onData);
          upRes.on('end', onEnd);
          return;
        }

        res.writeHead(status, respHeaders);
        upRes.pipe(res);
      },
    );

    upReq.setTimeout(LOCAL_PROXY_TIMEOUT_MS, () => {
      upReq.destroy(new Error('Local service request timeout'));
    });

    upReq.on('error', (err) => {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Local service (${target.proto}://127.0.0.1:${target.port}) error: ${err.message}`);
      } else if (!res.destroyed) {
        res.destroy();
      }
    });
    res.on('close', () => {
      if (!res.writableEnded && !upReq.destroyed) upReq.destroy();
    });
    req.pipe(upReq);
  }

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
        const cached = staticCache.get(pathname);
        if (cached) {
          if (Date.now() - cached.checkedAt >= STATIC_CACHE_TTL_MS) {
            fetchStaticCoalesced(pathname, cached, false).catch(() => {});
          }
          await serveCachedStatic(req, res, cached, authResult.setCookie, {
            pathname,
            key: cached.upstreamEtag || cached.etag,
          });
          return;
        }
        const result = await fetchStaticCoalesced(pathname, null, false);
        if (res.destroyed || res.writableEnded) return;
        if (result.kind === 'no-target') {
          res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('No active Antigravity language_server found. Start Antigravity first.');
          return;
        }
        if (result.kind === 'error') {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Upstream error: ${result.err?.message || 'Upstream unavailable'}`);
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
          opts.targetPort || cachedTargetInfo.port,
        );
        appendSetCookie(ptHeaders, authResult.setCookie);
        ptHeaders['content-length'] = String(result.body.length);
        res.writeHead(result.status, ptHeaders);
        res.end(req.method === 'HEAD' ? undefined : result.body);
        return;
      }

      const isRootMobilePatch = req.method === 'GET' && pathname === '/' && !opts.noMobilePatch;
      const isHtmlCandidate =
        req.method === 'GET' && (pathname === '/' || pathname.endsWith('.html') || !path.extname(pathname));
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
      const initialTargetInfo = await getTargetInfo(forceTargetRefresh);
      const initialTarget = resolveForwardTarget(initialTargetInfo);
      if (!initialTarget.port) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('No active Antigravity language_server found. Start Antigravity first.');
        return;
      }

      const assetVersions = {};
      if (isRootMobilePatch) {
        for (const p of ['/main.js', '/prism_bundle.js', '/jetbox.css', '/compiled_tailwind.css']) {
          const tag = etagVersionTag(staticCache.get(p)?.etag);
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

      if (isRootMobilePatch && typeof res.writeEarlyHints === 'function') {
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
          client = getH2Client(portToUse);
          upStream = client.request(buildH2UpstreamHeaders(req, portToUse, isHtmlCandidate, isHtmlCandidate));
        } catch (err) {
          if (allowRetry && canRetryMethod) {
            if (client) dropH2Client(client);
            getTargetInfo(true)
              .then((refreshedInfo) => {
                const nextTarget = resolveForwardTarget(refreshedInfo, portToUse);
                if (nextTarget.port) forward(nextTarget, false);
                else if (!res.headersSent && !res.destroyed) {
                  res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
                  res.end(`Upstream error: ${err.message}`);
                }
              })
              .catch(() => {
                if (!res.destroyed) res.destroy();
              });
            return;
          }
          if (!res.headersSent && !res.destroyed) {
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`Upstream error: ${err.message}`);
          }
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
              dropH2Client(client);
              const refreshedInfo = await getTargetInfo(true);
              const nextTarget = resolveForwardTarget(refreshedInfo, 0);
              if (nextTarget.port) {
                forward(nextTarget, false);
                return;
              }
            }
            if (!res.headersSent && !res.destroyed) {
              res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end(`Upstream error: ${err.message}`);
            } else if (!res.destroyed) {
              res.destroy();
            }
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
          const wantMobilePatch = isRootMobilePatch && status === 200 && contentType.includes('text/html');
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
                const memoKey = `${rawHash}|${wantCsrfPatch ? target.csrfToken : ''}|${wantMobilePatch ? assetVersionsKey : ''}|${encoding}`;
                const memoHit = rootHtmlMemo.get(memoKey);
                if (memoHit) {
                  if (encoding !== 'identity') {
                    respHeaders['content-encoding'] = encoding;
                    respHeaders.vary = respHeaders.vary ? `${respHeaders.vary}, Accept-Encoding` : 'Accept-Encoding';
                  }
                  respHeaders['content-length'] = String(memoHit.length);
                  res.writeHead(status, respHeaders);
                  res.end(memoHit);
                  return;
                }

                let html = buf.toString('utf8');
                if (wantCsrfPatch) html = injectCsrfToken(html, target.csrfToken);
                if (wantMobilePatch) {
                  html = injectMobileHead(html, assetVersions, { css: MOBILE_CSS, js: MOBILE_JS });
                }
                buf = Buffer.from(html, 'utf8');
                const out = buf.length > 512 && encoding !== 'identity' ? await compressBufferAsync(buf, encoding) : buf;
                if (res.destroyed || res.writableEnded) return;
                if (rootHtmlMemo.size >= 4) rootHtmlMemo.clear();
                rootHtmlMemo.set(memoKey, out);
                if (out !== buf && encoding !== 'identity') {
                  respHeaders['content-encoding'] = encoding;
                  respHeaders.vary = respHeaders.vary ? `${respHeaders.vary}, Accept-Encoding` : 'Accept-Encoding';
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
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Relay internal error: ${err?.message || 'Unknown error'}`);
        } else if (!res.destroyed) {
          res.destroy();
        }
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

      const localTarget = parseLocalProxyTarget(req.url, req.headers.referer, activePort);
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
          cachedAt = 0;
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

    if (h2Session) {
      const s = h2Session;
      detachH2Client(s);
      if (!s.destroyed) s.destroy();
    }
    localHttpAgent.destroy();
    localHttpsAgent.destroy();

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

      const detected = await getTargetPort(true);
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
        if (opts.pass) {
          console.log('Basic Auth Pass: <configured via env/flag>');
        } else {
          console.log(`Basic Auth Pass: ${auth.password}`);
        }
      } else {
        console.log('WARNING: Authentication is DISABLED (--no-auth, EasyTier bind only).');
      }
      setTimeout(prewarmStaticCache, 300).unref();
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
