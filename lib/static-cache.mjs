import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { CACHE_DIR, HAS_ZSTD } from './constants.mjs';

const brotliCompressAsync = promisify(zlib.brotliCompress);
const gzipAsync = promisify(zlib.gzip);
export const gunzipAsync = promisify(zlib.gunzip);
export const brotliDecompressAsync = promisify(zlib.brotliDecompress);
export const inflateAsync = promisify(zlib.inflate);
const zstdCompressAsync = HAS_ZSTD ? promisify(zlib.zstdCompress) : null;

export function acceptsEncodingToken(enc, token) {
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

export async function compressBufferAsync(buf, encoding) {
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

export function computeContentEtag(buf) {
  const hash16 = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  return `"sha256-${hash16}"`;
}

export function isCompressibleAsset(contentType, byteLength) {
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

export async function sendCompressedAssetAsync(req, res, status, contentType, bodyBuf, extraHeaders = {}) {
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

const ENCODING_SPECS = {
  br: { field: 'br', promiseField: '_brPromise', ext: 'br', upgradeBrotli: true },
  gzip: { field: 'gz', promiseField: '_gzPromise', ext: 'gz', upgradeBrotli: false },
  zstd: { field: 'zstd', promiseField: '_zstdPromise', ext: 'zst', upgradeBrotli: false },
};

export async function ensureEntryEncoding(entry, encoding, diskMeta = null) {
  if (encoding === 'identity' || !isCompressibleAsset(entry.contentType, entry.raw.length)) {
    return entry.raw;
  }
  const spec = ENCODING_SPECS[encoding];
  if (!spec || (encoding === 'zstd' && !zstdCompressAsync)) {
    return entry.raw;
  }
  if (entry[spec.field]) return entry[spec.field];

  const diskKey = diskMeta ? diskMeta.key || entry.etag : '';
  if (!entry[spec.promiseField]) {
    entry[spec.promiseField] = (async () => {
      const diskPath = diskMeta && diskKey ? getDiskCachePath(diskMeta.pathname, diskKey, spec.ext) : null;
      if (diskPath) {
        try {
          const fromDisk = await fs.promises.readFile(diskPath);
          if (fromDisk.length > 0) {
            entry[spec.field] = fromDisk;
            return fromDisk;
          }
        } catch {}
      }
      const compressed = await compressBufferAsync(entry.raw, encoding);
      entry[spec.field] = compressed;
      if (diskPath) {
        if (spec.upgradeBrotli && entry.raw.length > 50 * 1024) {
          upgradeAndPersistDiskBrotli(entry, diskPath, entry.etag).catch(() => {});
        } else {
          writeDiskCacheFile(diskPath, compressed).catch(() => {});
        }
      }
      return compressed;
    })().finally(() => {
      entry[spec.promiseField] = null;
    });
  }
  return entry[spec.promiseField];
}

export async function serveCachedStatic(req, res, entry, setCookie, diskMeta = null) {
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
