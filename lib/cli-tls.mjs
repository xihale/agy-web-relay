import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR, DAEMON_DIR, HOP_BY_HOP, SESSION_COOKIE } from './constants.mjs';

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

export function parsePortValue(raw, { allowZero = false, label = 'port' } = {}) {
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
    h3Bin: env.AGY_RELAY_H3_BIN || path.join(import.meta.dirname, '..', 'h3-edge', 'agy-h3-edge'),
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

export function detectEasyTierIp() {
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

export async function resolveBindIp(opts) {
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

export function certMatchesBindIp(certPath, caCertPath, bindIp) {
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

export function ensureTlsCert(certPath, keyPath, bindIp) {
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

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function canConnectLocalPort(port) {
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

export async function discoverTargetInfo(fixedPort) {
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
        return { port, httpPort, pid, csrfToken };
      }
    } catch {
      // Ignore malformed/stale discovery files
    }
  }

  if (fixedPort > 0) {
    return { port: fixedPort, httpPort: 0, pid: 0, csrfToken: '' };
  }
  return { port: 0, httpPort: 0, pid: 0, csrfToken: '' };
}

export function sha256Equal(a, b) {
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

export function stripRelayCookie(cookieHeader) {
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

export function buildHttp1UpgradeHeaders(rawHeaders, targetPort, targetProto = 'https', prefix = '') {
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
