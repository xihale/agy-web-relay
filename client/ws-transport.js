  /**
   * Builds the WebTransportWebSocket adapter with automatic Happy Eyeballs wss:// fallback.
   */
  function createWebTransportWebSocketClass({ NativeWebSocket, WT_FAIL_KEY, textDecoder, textEncoder }) {
    class WebTransportWebSocket extends EventTarget {
      constructor(targetWtUrl, logicalWsUrl, onPreClaimFail, preferWT = true) {
        super();
        this.url = logicalWsUrl;
        this.readyState = 0;
        this.binaryType = 'arraybuffer';
        this.bufferedAmount = 0;
        this.protocol = '';
        this.extensions = preferWT ? 'webtransport-quic' : '';
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        this._claimed = false;
        this._preferWT = Boolean(preferWT);
        this._wt = null;
        this._wtFailed = !this._preferWT;
        this._fallbackWs = null;
        this._usingFallbackWs = false;
        this._fallbackFailed = false;
        this._happyEyeballsTimer = 0;
        this._wtTimeoutTimer = 0;
        this._writer = null;
        this._reader = null;
        this._sendChain = Promise.resolve();
        this._onPreClaimFail = onPreClaimFail;
        this._onInboundMessage = null;
        this._connect(targetWtUrl);
      }

      _fireRaw(name, ev) {
        const handler = this['on' + name];
        if (typeof handler === 'function') {
          try { handler.call(this, ev); } catch {}
        }
        this.dispatchEvent(ev);
      }

      _fire(name, ev) {
        if (name === 'message' && typeof this._onInboundMessage === 'function') {
          try {
            if (this._onInboundMessage(ev) === false) return;
          } catch {}
        }
        this._fireRaw(name, ev);
      }

      _dispatchDirectMessage(raw) {
        if (this.readyState !== 1) return;
        this._fireRaw('message', new MessageEvent('message', { data: raw }));
      }

      _clearConnectTimers() {
        if (this._happyEyeballsTimer) {
          clearTimeout(this._happyEyeballsTimer);
          this._happyEyeballsTimer = 0;
        }
        if (this._wtTimeoutTimer) {
          clearTimeout(this._wtTimeoutTimer);
          this._wtTimeoutTimer = 0;
        }
      }

      _startFallbackWs() {
        if (this._fallbackWs || this._fallbackFailed || this.readyState !== 0 || this._usingFallbackWs) return;
        let ws;
        try {
          ws = new NativeWebSocket(this.url);
        } catch {
          this._fallbackFailed = true;
          if (this._wtFailed && this.readyState === 0) {
            this._fire('error', new Event('error'));
            this._finishClose(1006, '', false);
          }
          return;
        }
        ws.binaryType = this.binaryType || 'arraybuffer';
        this._fallbackWs = ws;
        ws.onopen = () => {
          if (this.readyState !== 0 || this._fallbackWs !== ws) {
            try { ws.close(); } catch {}
            return;
          }
          this._clearConnectTimers();
          this._usingFallbackWs = true;
          this.extensions = '';
          if (this._wt) {
            try { this._wt.close(); } catch {}
            this._wt = null;
          }
          window.__agyActiveTransport = 'websocket-tcp';
          this.readyState = 1;
          this._fire('open', new Event('open'));
        };
        ws.onmessage = (ev) => {
          if (this._usingFallbackWs && this.readyState === 1) {
            this._fire('message', new MessageEvent('message', {
              data: ev.data,
              origin: ev.origin,
              lastEventId: ev.lastEventId,
            }));
          }
        };
        ws.onerror = () => {
          if (this._usingFallbackWs) {
            this._fire('error', new Event('error'));
          }
        };
        ws.onclose = (ev) => {
          if (this._usingFallbackWs) {
            this._finishClose(ev.code || 1006, ev.reason || '', Boolean(ev.wasClean));
            return;
          }
          this._fallbackFailed = true;
          if (this._fallbackWs === ws) this._fallbackWs = null;
          if (this._wtFailed && this.readyState === 0) {
            this._fire('error', new Event('error'));
            this._finishClose(1006, '', false);
          }
        };
      }

      async _connect(targetWtUrl) {
        if (!this._preferWT) {
          this._startFallbackWs();
          return;
        }
        this._happyEyeballsTimer = setTimeout(() => {
          this._happyEyeballsTimer = 0;
          if (this.readyState === 0 && !this._usingFallbackWs) {
            this._startFallbackWs();
          }
        }, 180);
        try {
          const wt = new WebTransport(targetWtUrl);
          this._wt = wt;
          await Promise.race([
            wt.ready,
            new Promise((_, reject) => {
              this._wtTimeoutTimer = setTimeout(() => reject(new Error('WT timeout')), 1200);
            }),
          ]);
          if (this._wtTimeoutTimer) { clearTimeout(this._wtTimeoutTimer); this._wtTimeoutTimer = 0; }
          if (this.readyState !== 0 || this._usingFallbackWs) {
            try { wt.close(); } catch {}
            return;
          }
          const bidi = await wt.createBidirectionalStream();
          if (this.readyState !== 0 || this._usingFallbackWs) {
            try { wt.close(); } catch {}
            return;
          }
          if (this._happyEyeballsTimer) { clearTimeout(this._happyEyeballsTimer); this._happyEyeballsTimer = 0; }
          if (this._fallbackWs) {
            const fb = this._fallbackWs;
            this._fallbackWs = null;
            fb.onopen = fb.onmessage = fb.onerror = fb.onclose = null;
            try { fb.close(); } catch {}
          }
          this._writer = bidi.writable.getWriter();
          this._reader = bidi.readable.getReader();
          this.extensions = 'webtransport-quic';
          this.readyState = 1;
          window.__agyActiveTransport = 'webtransport-quic';
          try { localStorage.removeItem(WT_FAIL_KEY); } catch {}
          this._fire('open', new Event('open'));
          void this._readLoop();
          wt.closed.then(
            () => { if (!this._usingFallbackWs && this.readyState < 2) this._finishClose(1000, '', true); },
            () => { if (!this._usingFallbackWs && this.readyState < 2) this._finishClose(1006, '', false); },
          );
        } catch {
          this._clearConnectTimers();
          if (this._usingFallbackWs || this.readyState !== 0) return;
          this._wtFailed = true;
          window.__agyWtDisabled = true;
          try { localStorage.setItem(WT_FAIL_KEY, String(Date.now() + 10 * 60 * 1000)); } catch {}
          if (!this._claimed && typeof this._onPreClaimFail === 'function') {
            const cb = this._onPreClaimFail;
            this._onPreClaimFail = null;
            cb();
          }
          if (this._fallbackFailed) {
            this._fire('error', new Event('error'));
            this._finishClose(1006, '', false);
          } else {
            this._startFallbackWs();
          }
        }
      }

      async _readLoop() {
        const chunks = [];
        let totalLen = 0;
        let headOffset = 0;
        const readByteAt = (offset) => {
          let rem = offset + headOffset;
          for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            if (rem < c.byteLength) return c[rem];
            rem -= c.byteLength;
          }
          return 0;
        };
        const peekUint32 = (offset) => (
          ((readByteAt(offset) << 24) |
           (readByteAt(offset + 1) << 16) |
           (readByteAt(offset + 2) << 8) |
           readByteAt(offset + 3)) >>> 0
        );
        const skipBytes = (n) => {
          totalLen -= n;
          let rem = n;
          while (rem > 0 && chunks.length > 0) {
            const avail = chunks[0].byteLength - headOffset;
            if (rem < avail) {
              headOffset += rem;
              break;
            }
            rem -= avail;
            chunks.shift();
            headOffset = 0;
          }
        };
        const takeBytes = (n) => {
          if (n === 0) return new Uint8Array(0);
          const first = chunks[0];
          const firstAvail = first.byteLength - headOffset;
          if (n <= firstAvail) {
            const slice = first.subarray(headOffset, headOffset + n);
            totalLen -= n;
            if (n === firstAvail) {
              chunks.shift();
              headOffset = 0;
            } else {
              headOffset += n;
            }
            return slice;
          }
          const out = new Uint8Array(n);
          let written = 0;
          while (written < n) {
            const c = chunks[0];
            const avail = c.byteLength - headOffset;
            const take = Math.min(avail, n - written);
            out.set(c.subarray(headOffset, headOffset + take), written);
            written += take;
            if (take === avail) {
              chunks.shift();
              headOffset = 0;
            } else {
              headOffset += take;
            }
          }
          totalLen -= n;
          return out;
        };
        const reader = this._reader;
        try {
          while (this.readyState === 1) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
              chunks.push(value);
              totalLen += value.byteLength;
              while (totalLen >= 5) {
                const flags = readByteAt(0);
                const payloadLen = peekUint32(1);
                if (totalLen < 5 + payloadLen) break;
                skipBytes(5);
                let payload = takeBytes(payloadLen);
                if (flags & 0x02) {
                  const ds = new DecompressionStream('deflate-raw');
                  const writer = ds.writable.getWriter();
                  void writer.write(payload).then(() => writer.close());
                  payload = new Uint8Array(await new Response(ds.readable).arrayBuffer());
                }
                if (this.readyState !== 1) return;
                let msgData;
                if (flags & 0x01) {
                  if (this.binaryType === 'blob') {
                    msgData = new Blob([payload]);
                  } else {
                    const copy = new Uint8Array(payload.byteLength);
                    copy.set(payload);
                    msgData = copy.buffer;
                  }
                } else {
                  msgData = textDecoder.decode(payload);
                }
                this._fire('message', new MessageEvent('message', { data: msgData }));
              }
            }
          }
          if (this.readyState < 2) this._finishClose(1000, '', true);
        } catch {
          if (this.readyState < 2) this._finishClose(1006, '', false);
        }
      }

      _rawSend(data) {
        if (this.readyState !== 1) return;
        if (this._usingFallbackWs && this._fallbackWs) {
          this._fallbackWs.send(data);
          return;
        }
        if (!this._writer) return;
        let flags = 0;
        let bytes;
        if (typeof data === 'string') {
          bytes = textEncoder.encode(data);
        } else if (data instanceof ArrayBuffer) {
          flags = 0x01;
          bytes = new Uint8Array(data);
        } else if (ArrayBuffer.isView(data)) {
          flags = 0x01;
          bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        } else {
          bytes = textEncoder.encode(String(data));
        }
        const frame = new Uint8Array(5 + bytes.byteLength);
        frame[0] = flags;
        const n = bytes.byteLength;
        frame[1] = (n >>> 24) & 0xff;
        frame[2] = (n >>> 16) & 0xff;
        frame[3] = (n >>> 8) & 0xff;
        frame[4] = n & 0xff;
        frame.set(bytes, 5);
        this.bufferedAmount += frame.byteLength;
        const writer = this._writer;
        this._sendChain = this._sendChain.then(
          () => writer.write(frame).finally(() => { this.bufferedAmount = Math.max(0, this.bufferedAmount - frame.byteLength); }),
          () => { this.bufferedAmount = Math.max(0, this.bufferedAmount - frame.byteLength); },
        );
      }

      send(data) {
        this._rawSend(data);
      }

      close(code = 1000, reason = '') {
        if (this.readyState >= 2) return;
        this.readyState = 2;
        if (this._usingFallbackWs && this._fallbackWs) {
          try { this._fallbackWs.close(code, reason); } catch {}
        }
        this._finishClose(code, reason, true);
      }

      _finishClose(code, reason, wasClean) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this._clearConnectTimers();
        if (this._fallbackWs) {
          const fb = this._fallbackWs;
          this._fallbackWs = null;
          fb.onopen = fb.onmessage = fb.onerror = fb.onclose = null;
          try { fb.close(); } catch {}
        }
        try { this._writer?.close()?.catch?.(() => {}); } catch {}
        try { this._reader?.cancel()?.catch?.(() => {}); } catch {}
        try { this._wt?.close?.(); } catch {}
        this._fire('close', new CloseEvent('close', { code, reason, wasClean }));
      }
    }
    WebTransportWebSocket.CONNECTING = 0;
    WebTransportWebSocket.OPEN = 1;
    WebTransportWebSocket.CLOSING = 2;
    WebTransportWebSocket.CLOSED = 3;
    return WebTransportWebSocket;
  }
