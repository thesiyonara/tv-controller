// Drives the in-house Android TV Remote v2 session against a mock TV over real TLS.
// Verifies framing (incl. multi-byte varint lengths), the configure/set-active
// handshake, feature negotiation, ping replies, key/long-press/app-link sends and
// IME text replacement with the counters the TV handed us.
const assert = require('assert');
const tls = require('tls');
const protobuf = require('protobufjs');
const { RemoteSession } = require('../dist/main/remote/session.js');
const { CertificateGenerator } = require('androidtv-remote/dist/certificate/CertificateGenerator.js');

const root = protobuf.loadSync(require.resolve('../dist/main/remote/remotemessage.proto'));
const RM = root.lookupType('remote.RemoteMessage');
const serverCert = CertificateGenerator.generateFull('mock-tv', 'US', 'CA', 'L', 'O', 'OU');
const clientCert = CertificateGenerator.generateFull('client', 'US', 'CA', 'L', 'O', 'OU');

const received = [];
const server = tls.createServer({ key: serverCert.key, cert: serverCert.cert, requestCert: true, rejectUnauthorized: false }, (sock) => {
  const send = (p) => sock.write(RM.encodeDelimited(RM.create(p)).finish());
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const r = protobuf.Reader.create(buf);
      let len;
      try { len = r.uint32(); } catch { break; }
      if (buf.length < r.pos + len) break;
      const msg = RM.decode(buf.subarray(r.pos, r.pos + len)).toJSON();
      buf = buf.subarray(r.pos + len);
      received.push(msg);
      if (msg.remoteConfigure) send({ remoteSetActive: { active: 622 } });
      else if (msg.remoteSetActive) {
        send({ remoteStart: { started: true } });
        send({ remoteSetVolumeLevel: { volumeLevel: 12, volumeMax: 100, volumeMuted: false, playerModel: 'mock' } });
        send({ remoteImeKeyInject: { appInfo: { appPackage: 'com.google.android.youtube.tv' } } });
        send({ remotePingRequest: { val1: 42 } });
        setTimeout(() => {
          send({ remoteImeBatchEdit: { imeCounter: 7, fieldCounter: 3, editInfo: [] } });
          send({ remoteImeShowRequest: { remoteTextFieldStatus: { counterField: 3, value: 'sev', start: 3, end: 3, label: 'Search' } } });
          send({ remoteVoiceBegin: { sessionId: 1, packageName: 'com.google.android.katniss' } });
        }, 50);
      }
    }
  });
  send({ remoteConfigure: { code1: 639, deviceInfo: { model: 'Mock TV ' + 'x'.repeat(150), vendor: 'Mockers', unknown1: 1, unknown2: '1', packageName: 'mock', appVersion: '1.0' } } });
});

server.listen(0, '127.0.0.1', async () => {
  const s = new RemoteSession('127.0.0.1', clientCert, server.address().port, '0.0.0');
  const events = [];
  for (const ev of ['ready', 'powered', 'volume', 'currentApp', 'imeShow', 'deviceInfo', 'voiceBegin', 'error', 'close']) s.on(ev, (...a) => events.push([ev, ...a]));
  await s.connect();
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(s.ready, 'session ready');
  assert.strictEqual(s.imeAvailable, true, 'ime counters received');
  s.sendKey('KEYCODE_DPAD_UP');
  s.sendKey('KEYCODE_HOME', 'START_LONG');
  s.sendAppLink('https://www.youtube.com');
  s.sendText('severance season 2');
  await new Promise((r) => setTimeout(r, 200));
  s.close();
  await new Promise((r) => setTimeout(r, 100));

  const names = (e) => events.map((x) => x[0]);
  assert.deepStrictEqual(names().filter((n) => n !== 'close'), ['deviceInfo', 'ready', 'powered', 'volume', 'currentApp', 'imeShow', 'voiceBegin']);
  assert.strictEqual(events.find((e) => e[0] === 'deviceInfo')[1].model.length, 158, 'multi-byte varint frame decoded');
  assert.deepStrictEqual(events.find((e) => e[0] === 'volume')[1], { level: 12, maximum: 100, muted: false });
  assert.strictEqual(events.find((e) => e[0] === 'imeShow')[1].label, 'Search');
  assert.ok(!events.some((e) => e[0] === 'error'), 'no errors');

  const kinds = received.map((m) => Object.keys(m)[0]);
  assert.deepStrictEqual(kinds, ['remoteConfigure', 'remoteSetActive', 'remotePingResponse', 'remoteKeyInject', 'remoteKeyInject', 'remoteAppLinkLaunchRequest', 'remoteImeBatchEdit']);
  assert.strictEqual(received[0].remoteConfigure.code1, 615, 'wanted features masked by TV-supported ones');
  assert.strictEqual(received[2].remotePingResponse.val1, 42);
  assert.deepStrictEqual(received[3].remoteKeyInject, { keyCode: 'KEYCODE_DPAD_UP', direction: 'SHORT' });
  assert.deepStrictEqual(received[4].remoteKeyInject, { keyCode: 'KEYCODE_HOME', direction: 'START_LONG' });
  const batch = received[6].remoteImeBatchEdit;
  assert.strictEqual(batch.imeCounter, 7);
  assert.strictEqual(batch.fieldCounter, 3);
  assert.deepStrictEqual(batch.editInfo[0], { insert: 1, textFieldStatus: { start: 17, end: 17, value: 'severance season 2' } });
  console.log('remote-session: ok');
  server.close();
  process.exit(0);
});
setTimeout(() => { console.error('remote-session: timeout'); process.exit(1); }, 15000);
