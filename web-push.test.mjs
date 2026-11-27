import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { MOBILE_JS, SW_JS, renderPushHtml, renderSetupHtml } from './mobile-assets.mjs';
import {
  buildVapidAuthHeader,
  createSummaryNotificationTracker,
  createWebPushManager,
  encryptWebPushPayload,
  fromBase64Url,
  generateVapidKeys,
  toBase64Url,
} from './web-push.mjs';

function decryptAes128GcmForTest(uaEcdh, authSecret, body) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  assert.equal(rs, 4096);
  assert.equal(idlen, 65);
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertextWithTag = body.subarray(21 + idlen);
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);
  const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);

  const uaPublic = uaEcdh.getPublicKey();
  const sharedSecret = uaEcdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'ascii'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'ascii'), 12));

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const plainWithPad = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  assert.equal(plainWithPad[plainWithPad.length - 1], 0x02);
  return plainWithPad.subarray(0, plainWithPad.length - 1);
}

test('VAPID JWT signature verifies with generated public key', () => {
  const vapid = generateVapidKeys('mailto:test@example.com');
  const auth = buildVapidAuthHeader('https://fcm.googleapis.com/fcm/send/abc', vapid, 1700000000);
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(auth);
  assert.ok(m);
  assert.equal(m[2], vapid.publicKey);

  const [hdrB64, payB64, sigB64] = m[1].split('.');
  const claims = JSON.parse(fromBase64Url(payB64).toString('utf8'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'mailto:test@example.com');
  assert.equal(claims.exp, 1700000000 + 12 * 3600);

  const rawPub = fromBase64Url(vapid.publicKey);
  const pubKeyObj = crypto.createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: toBase64Url(rawPub.subarray(1, 33)),
      y: toBase64Url(rawPub.subarray(33, 65)),
    },
    format: 'jwk',
  });
  const ok = crypto.verify(
    'sha256',
    Buffer.from(`${hdrB64}.${payB64}`, 'utf8'),
    { key: pubKeyObj, dsaEncoding: 'ieee-p1363' },
    fromBase64Url(sigB64),
  );
  assert.equal(ok, true);
});

test('RFC 8291 aes128gcm encryption roundtrips cleanly', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const sub = {
    endpoint: 'https://web.push.apple.com/QTestEndpoint',
    keys: {
      p256dh: toBase64Url(ua.getPublicKey()),
      auth: toBase64Url(authSecret),
    },
  };
  const payload = JSON.stringify({ title: 'Antigravity', body: '已完成: 测试任务', silent: true });
  const encrypted = encryptWebPushPayload(sub, payload);
  const decrypted = decryptAes128GcmForTest(ua, authSecret, encrypted);
  assert.equal(decrypted.toString('utf8'), payload);
});

test('multi-device subscription store broadcasts and prunes 410 Gone devices', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-push-test-'));
  const mkSub = (suffix) => {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    return {
      endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`,
      keys: {
        p256dh: toBase64Url(ecdh.getPublicKey()),
        auth: toBase64Url(crypto.randomBytes(16)),
      },
    };
  };

  const sentRequests = [];
  const fakeFetch = async (url, init) => {
    sentRequests.push({ url, headers: init.headers, len: init.body.length });
    if (url.endsWith('/gone')) {
      return { status: 410, text: async () => 'Gone' };
    }
    return { status: 201, text: async () => '' };
  };

  const mgr = createWebPushManager({
    configDir: tmpDir,
    fetchImpl: fakeFetch,
    log: () => {},
    warn: () => {},
  });

  try {
    const subA = mkSub('iphone');
    const subB = mkSub('gone');
    mgr.subscribe({ subscription: subA, deviceLabel: '主力 iPhone', userAgent: 'iPhone Safari' });
    mgr.subscribe({ subscription: subB, deviceLabel: '旧手机', userAgent: 'Android Chrome' });
    // Upsert same endpoint updates without duplicating
    mgr.subscribe({ subscription: subA, deviceLabel: '主力 iPhone 16', userAgent: 'iPhone Safari' });

    assert.equal(mgr.listDevices(subA.endpoint).length, 2);
    assert.equal(mgr.listDevices(subA.endpoint)[0].isCurrent, true);

    const res = await mgr.broadcast({ title: 'Test', body: 'Hello' });
    assert.equal(res.total, 2);
    assert.equal(res.sent, 1);
    assert.equal(res.failed, 1);
    assert.equal(res.pruned, 1);
    assert.equal(sentRequests.length, 2);
    assert.equal(mgr.listDevices().length, 1);
    assert.equal(mgr.listDevices()[0].deviceLabel, '主力 iPhone 16');

    // Reload from disk preserves VAPID key and remaining subscription
    const mgr2 = createWebPushManager({ configDir: tmpDir, fetchImpl: fakeFetch, log: () => {}, warn: () => {} });
    assert.equal(mgr2.getPublicKey(), mgr.getPublicKey());
    assert.equal(mgr2.listDevices().length, 1);
    mgr2.dispose();
  } finally {
    mgr.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('summary tracker suppresses initial snapshot and notifies on completion & waiting steps', () => {
  const events = [];
  const tracker = createSummaryNotificationTracker((ev) => events.push(ev));

  // Initial seed: should NOT emit even though one is running and one has waiting step
  tracker.processFrame({
    updates: {
      'conv-old': { summary: 'Old', status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false },
      'conv-seed': {
        summary: 'Seeded',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        notFullyIdle: true,
        waitingSteps: [{ stepIndex: 1, step: { runCommand: { commandLine: 'ls' } } }],
      },
    },
  });
  assert.equal(events.length, 0);

  // New waiting step on conv-seed + subagent finishes + main task finishes
  tracker.processFrame({
    updates: {
      'conv-seed': {
        summary: 'Seeded',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        notFullyIdle: true,
        waitingSteps: [
          { stepIndex: 1, step: { runCommand: { commandLine: 'ls' } } },
          { stepIndex: 2, step: { askQuestion: { questions: [{ question: '选哪个方案？' }] } } },
        ],
      },
      'conv-sub': {
        summary: 'Sub',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        notFullyIdle: true,
        trajectoryMetadata: { parentConversationId: 'conv-seed' },
      },
    },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'waiting');
  assert.equal(events[0].body, '选哪个方案？');

  // Now conv-seed and conv-sub finish; only conv-seed emits notification
  tracker.processFrame({
    updates: {
      'conv-seed': { summary: 'Seeded', status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false },
      'conv-sub': {
        summary: 'Sub',
        status: 'CASCADE_RUN_STATUS_IDLE',
        notFullyIdle: false,
        trajectoryMetadata: { parentConversationId: 'conv-seed' },
      },
    },
  });
  assert.equal(events.length, 2);
  assert.equal(events[1].type, 'finished');
  assert.equal(events[1].body, '已完成: Seeded');
  assert.equal(events[1].url, '/c/conv-seed');
});

test('generated client scripts and push HTML script parse cleanly', () => {
  assert.doesNotThrow(() => new vm.Script(SW_JS, { filename: 'sw.js' }));
  assert.doesNotThrow(() => new vm.Script(MOBILE_JS, { filename: 'relay-mobile.js' }));
  const pushHtml = renderPushHtml();
  const setupHtml = renderSetupHtml('100.64.0.2', 8421);
  assert.ok(setupHtml.includes('/push'));
  const m = /<script>([\s\S]*?)<\/script>/.exec(pushHtml);
  assert.ok(m);
  assert.doesNotThrow(() => new vm.Script(m[1], { filename: 'push-page.js' }));
});
