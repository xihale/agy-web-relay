import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const MAX_WS_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_HANDSHAKE_BYTES = 16 * 1024;
const MAX_PENDING_MESSAGES = 64;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const DEFLATE_MIN_BYTES = 128;
const DEFLATE_HIGH_LEVEL_THRESHOLD = 16 * 1024;
const SYNC_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

export function clientOffersPerMessageDeflate(extHeader) {
  if (!extHeader) return false;
  const raw = Array.isArray(extHeader) ? extHeader.join(',') : String(extHeader);
  for (const part of raw.split(',')) {
    const token = part.split(';')[0].trim().toLowerCase();
    if (token === 'permessage-deflate') return true;
  }
  return false;
}

function applyMask(buf, maskKey) {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ maskKey[i & 3];
  }
  return out;
}

export function encodeWsFrame({
  opcode,
  rsv1 = false,
  rsv2 = false,
  rsv3 = false,
  masked = false,
  payload = Buffer.alloc(0),
}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = body.length;
  const firstByte =
    0x80 |
    (rsv1 ? 0x40 : 0) |
    (rsv2 ? 0x20 : 0) |
    (rsv3 ? 0x10 : 0) |
    (opcode & 0x0f);
  const maskBit = masked ? 0x80 : 0;

  let headerLen = 2;
  if (len >= 126 && len <= 0xffff) headerLen += 2;
  else if (len > 0xffff) headerLen += 8;
  if (masked) headerLen += 4;

  const out = Buffer.allocUnsafe(headerLen + len);
  out[0] = firstByte;
  let offset = 2;
  if (len < 126) {
    out[1] = maskBit | len;
  } else if (len <= 0xffff) {
    out[1] = maskBit | 126;
    out.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    out[1] = maskBit | 127;
    out.writeBigUInt64BE(BigInt(len), 2);
    offset = 10;
  }

  if (masked) {
    const maskKey = crypto.randomBytes(4);
    maskKey.copy(out, offset);
    offset += 4;
    for (let i = 0; i < len; i++) {
      out[offset + i] = body[i] ^ maskKey[i & 3];
    }
  } else if (len > 0) {
    body.copy(out, offset);
  }
  return out;
}

export class WsFrameParser {
  constructor(onMessage, maxMessageBytes = MAX_WS_MESSAGE_BYTES) {
    this.onMessage = onMessage;
    this.maxMessageBytes = maxMessageBytes;
    this.chunks = [];
    this.bufferedBytes = 0;
    this.fragOpcode = null;
    this.fragRsv1 = false;
    this.fragRsv2 = false;
    this.fragRsv3 = false;
    this.fragChunks = [];
    this.fragBytes = 0;
  }

  _compactIfNeeded() {
    if (this.chunks.length <= 1) return this.chunks[0] || Buffer.alloc(0);
    const merged = Buffer.concat(this.chunks, this.bufferedBytes);
    this.chunks = [merged];
    return merged;
  }

  _consume(n) {
    if (n <= 0) return;
    let remaining = n;
    while (remaining > 0 && this.chunks.length > 0) {
      const head = this.chunks[0];
      if (head.length <= remaining) {
        remaining -= head.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(remaining);
        remaining = 0;
      }
    }
    this.bufferedBytes -= n;
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    this.chunks.push(chunk);
    this.bufferedBytes += chunk.length;

    while (this.bufferedBytes >= 2) {
      const buf = this._compactIfNeeded();
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv1 = (b0 & 0x40) !== 0;
      const rsv2 = (b0 & 0x20) !== 0;
      const rsv3 = (b0 & 0x10) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let headerLen = 2;

      if (payloadLen === 126) {
        if (this.bufferedBytes < 4) return;
        payloadLen = buf.readUInt16BE(2);
        headerLen = 4;
      } else if (payloadLen === 127) {
        if (this.bufferedBytes < 10) return;
        const bigLen = buf.readBigUInt64BE(2);
        if (bigLen > BigInt(this.maxMessageBytes)) {
          throw new Error(`WebSocket frame exceeds max message size (${bigLen})`);
        }
        payloadLen = Number(bigLen);
        headerLen = 10;
      }

      if (payloadLen > this.maxMessageBytes) {
        throw new Error(`WebSocket frame exceeds max message size (${payloadLen})`);
      }

      const maskLen = masked ? 4 : 0;
      const totalFrameLen = headerLen + maskLen + payloadLen;
      if (this.bufferedBytes < totalFrameLen) return;

      let payload = buf.subarray(headerLen + maskLen, totalFrameLen);
      if (masked) {
        const maskKey = buf.subarray(headerLen, headerLen + 4);
        payload = applyMask(payload, maskKey);
      } else {
        // Copy out before _consume slices/replaces buffer views
        payload = Buffer.from(payload);
      }
      this._consume(totalFrameLen);

      const isControl = (opcode & 0x08) !== 0;
      if (isControl) {
        if (!fin) {
          throw new Error('Fragmented WebSocket control frame');
        }
        this.onMessage({ opcode, rsv1, rsv2, rsv3, masked, payload });
        continue;
      }

      if (opcode === 0) {
        if (this.fragOpcode === null) {
          throw new Error('Unexpected WebSocket continuation frame');
        }
        this.fragBytes += payload.length;
        if (this.fragBytes > this.maxMessageBytes) {
          throw new Error(`Fragmented WebSocket message exceeds max size (${this.fragBytes})`);
        }
        this.fragChunks.push(payload);
        if (fin) {
          const full = this.fragChunks.length === 1 ? this.fragChunks[0] : Buffer.concat(this.fragChunks, this.fragBytes);
          const msg = {
            opcode: this.fragOpcode,
            rsv1: this.fragRsv1,
            rsv2: this.fragRsv2,
            rsv3: this.fragRsv3,
            masked,
            payload: full,
          };
          this.fragOpcode = null;
          this.fragRsv1 = false;
          this.fragRsv2 = false;
          this.fragRsv3 = false;
          this.fragChunks = [];
          this.fragBytes = 0;
          this.onMessage(msg);
        }
      } else {
        if (this.fragOpcode !== null) {
          throw new Error('New WebSocket data frame received before previous fragmented message finished');
        }
        if (fin) {
          this.onMessage({ opcode, rsv1, rsv2, rsv3, masked, payload });
        } else {
          this.fragOpcode = opcode;
          this.fragRsv1 = rsv1;
          this.fragRsv2 = rsv2;
          this.fragRsv3 = rsv3;
          this.fragChunks = [payload];
          this.fragBytes = payload.length;
        }
      }
    }
  }
}

export function deflateWsPayload(buf, level = 4) {
  return new Promise((resolve, reject) => {
    const input = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    const comp = zlib.createDeflateRaw({ level, windowBits: 15 });
    const chunks = [];
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      comp.destroy();
      reject(err);
    };
    comp.on('error', fail);
    comp.on('data', (c) => chunks.push(c));
    comp.write(input);
    comp.flush(zlib.constants.Z_SYNC_FLUSH, () => {
      if (settled) return;
      settled = true;
      comp.destroy();
      let out = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
      if (
        out.length >= 4 &&
        out[out.length - 4] === 0x00 &&
        out[out.length - 3] === 0x00 &&
        out[out.length - 2] === 0xff &&
        out[out.length - 1] === 0xff
      ) {
        out = out.subarray(0, out.length - 4);
      }
      resolve(out);
    });
  });
}

export function inflateWsPayload(buf, maxBytes = MAX_WS_MESSAGE_BYTES) {
  return new Promise((resolve, reject) => {
    const input = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    const inf = zlib.createInflateRaw({ windowBits: 15 });
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      inf.destroy();
      reject(err);
    };
    inf.on('error', fail);
    inf.on('data', (c) => {
      if (settled) return;
      totalBytes += c.length;
      if (totalBytes > maxBytes) {
        fail(new Error(`Inflated WebSocket message exceeds max size (${totalBytes})`));
        return;
      }
      chunks.push(c);
    });
    inf.write(input);
    inf.write(SYNC_TAIL);
    inf.flush(zlib.constants.Z_SYNC_FLUSH, () => {
      if (settled) return;
      settled = true;
      inf.destroy();
      resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalBytes));
    });
  });
}

function writeSocketAsync(socket, buf) {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    if (socket.write(buf)) {
      resolve();
      return;
    }
    const done = () => {
      socket.removeListener('drain', done);
      socket.removeListener('close', done);
      socket.removeListener('error', done);
      resolve();
    };
    socket.once('drain', done);
    socket.once('close', done);
    socket.once('error', done);
  });
}

function createPipelinedDirectionPump({ srcSocket, destSocket, transformMessage, onFatal }) {
  const queue = [];
  let queuedBytes = 0;
  let running = false;
  let paused = false;

  const maybeResume = () => {
    if (paused && queue.length <= MAX_PENDING_MESSAGES / 2 && queuedBytes <= MAX_PENDING_BYTES / 2) {
      paused = false;
      if (!srcSocket.destroyed) srcSocket.resume();
    }
  };

  const drainQueue = async () => {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0 && !destSocket.destroyed) {
        const item = queue.shift();
        const frame = await item.promise;
        queuedBytes -= item.size;
        maybeResume();
        if (destSocket.destroyed) break;
        await writeSocketAsync(destSocket, frame);
      }
    } catch (err) {
      onFatal(err);
    } finally {
      running = false;
      maybeResume();
    }
  };

  const parser = new WsFrameParser((msg) => {
    const size = msg.payload.length;
    const promise = Promise.resolve().then(() => transformMessage(msg));
    promise.catch(() => {});
    queue.push({ promise, size });
    queuedBytes += size;
    if (!paused && (queue.length >= MAX_PENDING_MESSAGES || queuedBytes >= MAX_PENDING_BYTES)) {
      paused = true;
      if (!srcSocket.destroyed) srcSocket.pause();
    }
    void drainQueue();
  });

  return (chunk) => {
    try {
      parser.push(chunk);
    } catch (err) {
      onFatal(err);
    }
  };
}

function parseUpstreamHeadersBlock(headerText) {
  const lines = headerText.split('\r\n');
  const statusLine = lines[0] || '';
  const statusMatch = /^HTTP\/\d+\.\d+\s+(\d{3})\b/.exec(statusLine);
  const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
  const headers = Object.create(null);
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':');
    if (colon <= 0) continue;
    const name = lines[i].slice(0, colon).trim().toLowerCase();
    const val = lines[i].slice(colon + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${val}` : val;
  }
  return { statusCode, headers };
}

export function attachWebSocketBridge({ req, clientSocket, upstreamSocket, head, rawRequestHeaders, onCleanup }) {
  clientSocket.setNoDelay?.(true);
  upstreamSocket.setNoDelay?.(true);

  if (!clientOffersPerMessageDeflate(req?.headers?.['sec-websocket-extensions'])) {
    upstreamSocket.write(rawRequestHeaders);
    if (head && head.length > 0) upstreamSocket.write(head);
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
    return;
  }

  let closed = false;
  const abortBridge = () => {
    if (closed) return;
    closed = true;
    onCleanup?.();
  };

  clientSocket.pause();

  const hsChunks = [];
  let hsBytes = 0;

  const activateDeflateBridge = (initialUpstreamBytes) => {
    const pumpUpstreamToClient = createPipelinedDirectionPump({
      srcSocket: upstreamSocket,
      destSocket: clientSocket,
      onFatal: abortBridge,
      transformMessage: async (msg) => {
        const isControl = (msg.opcode & 0x08) !== 0;
        if (isControl || msg.rsv1 || msg.payload.length < DEFLATE_MIN_BYTES || (msg.opcode !== 1 && msg.opcode !== 2)) {
          return encodeWsFrame({
            opcode: msg.opcode,
            rsv1: msg.rsv1,
            rsv2: msg.rsv2,
            rsv3: msg.rsv3,
            masked: false,
            payload: msg.payload,
          });
        }
        const level = msg.payload.length >= DEFLATE_HIGH_LEVEL_THRESHOLD ? 6 : 4;
        const compressed = await deflateWsPayload(msg.payload, level);
        if (compressed.length < msg.payload.length) {
          return encodeWsFrame({
            opcode: msg.opcode,
            rsv1: true,
            rsv2: msg.rsv2,
            rsv3: msg.rsv3,
            masked: false,
            payload: compressed,
          });
        }
        return encodeWsFrame({
          opcode: msg.opcode,
          rsv1: false,
          rsv2: msg.rsv2,
          rsv3: msg.rsv3,
          masked: false,
          payload: msg.payload,
        });
      },
    });

    const pumpClientToUpstream = createPipelinedDirectionPump({
      srcSocket: clientSocket,
      destSocket: upstreamSocket,
      onFatal: abortBridge,
      transformMessage: async (msg) => {
        const isControl = (msg.opcode & 0x08) !== 0;
        let payload = msg.payload;
        if (!isControl && msg.rsv1) {
          payload = await inflateWsPayload(payload);
        }
        return encodeWsFrame({
          opcode: msg.opcode,
          rsv1: false,
          rsv2: msg.rsv2,
          rsv3: msg.rsv3,
          masked: true,
          payload,
        });
      },
    });

    upstreamSocket.on('data', pumpUpstreamToClient);
    clientSocket.on('data', pumpClientToUpstream);

    if (initialUpstreamBytes && initialUpstreamBytes.length > 0) {
      pumpUpstreamToClient(initialUpstreamBytes);
    }
    if (head && head.length > 0) {
      pumpClientToUpstream(head);
    }
    if (!clientSocket.destroyed) clientSocket.resume();
  };

  const onUpstreamHandshakeData = (chunk) => {
    if (closed) return;
    hsChunks.push(chunk);
    hsBytes += chunk.length;
    if (hsBytes > MAX_HANDSHAKE_BYTES) {
      upstreamSocket.removeListener('data', onUpstreamHandshakeData);
      abortBridge();
      return;
    }

    const combined = hsChunks.length === 1 ? hsChunks[0] : Buffer.concat(hsChunks, hsBytes);
    const headerEnd = combined.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    upstreamSocket.removeListener('data', onUpstreamHandshakeData);

    const headerBuf = combined.subarray(0, headerEnd);
    const trailing = combined.subarray(headerEnd + 4);
    const headerText = headerBuf.toString('latin1');
    const { statusCode, headers } = parseUpstreamHeadersBlock(headerText);

    if (statusCode !== 101 || headers['sec-websocket-extensions']) {
      if (!clientSocket.destroyed) {
        clientSocket.write(combined);
      }
      if (head && head.length > 0 && !upstreamSocket.destroyed) {
        upstreamSocket.write(head);
      }
      if (!clientSocket.destroyed) clientSocket.resume();
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
      return;
    }

    const modifiedHeaders = `${headerText}\r\nSec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover; client_no_context_takeover\r\n\r\n`;
    if (!clientSocket.destroyed) {
      clientSocket.write(modifiedHeaders, 'latin1');
    }
    activateDeflateBridge(trailing);
  };

  upstreamSocket.on('data', onUpstreamHandshakeData);
  upstreamSocket.write(rawRequestHeaders);
}
