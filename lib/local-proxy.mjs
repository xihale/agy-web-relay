import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { stripRelayCookie } from './cli-tls.mjs';
import {
  H2_PING_INTERVAL_MS,
  H2_PING_TIMEOUT_MS,
  HOP_BY_HOP,
  LOCAL_PROXY_TIMEOUT_MS,
  MAX_HTML_BUFFER_BYTES,
} from './constants.mjs';
import {
  brotliDecompressAsync,
  compressBufferAsync,
  gunzipAsync,
  inflateAsync,
  pickEncoding,
} from './static-cache.mjs';

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

export function rewriteLocalRedirectLocation(loc, target) {
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

export function rewriteUpstreamLocation(loc, portToUse, clientHost) {
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

export function adaptLocalCspHeaders(respHeaders, allowScriptNonce) {
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

export function cleanUpstreamHeaders(headers) {
  const out = {};
  for (const [rawKey, val] of Object.entries(headers || {})) {
    const key = rawKey.toLowerCase();
    if (key.startsWith(':') || HOP_BY_HOP.has(key) || val === undefined) continue;
    out[key] = val;
  }
  return out;
}

export function applyCorsAndLocation(respHeaders, clientOrigin, clientHost, portToUse) {
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

export function appendSetCookie(respHeaders, setCookie) {
  if (!setCookie) return;
  const existing = respHeaders['set-cookie'];
  respHeaders['set-cookie'] = Array.isArray(existing)
    ? [...existing, setCookie]
    : existing
      ? [existing, setCookie]
      : [setCookie];
}

export function readJsonBody(req, maxBytes = 4096) {
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

export function attachH2SessionHeartbeat(session, onTimeoutOrError) {
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

export function createLocalTargetProxy({ localHttpAgent, localHttpsAgent }) {
  return function proxyLocalTarget(req, res, authResult, target) {
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
  };
}
