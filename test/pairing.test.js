// Drives the in-house pairing implementation against a mock TV pairing service over real TLS.
// Covers: the full handshake, secret computation/checksum, a wrong code being refused locally,
// a bad secret from the TV, and cancellation.
const assert = require('assert');
const crypto = require('crypto');
const tls = require('tls');
const protobuf = require('protobufjs');
const { Pairing } = require('../dist/main/remote/pairing.js');
const { CertificateGenerator } = require('androidtv-remote/dist/certificate/CertificateGenerator.js');

const root = protobuf.loadSync(require.resolve('../dist/main/remote/pairingmessage.proto'));
const PM = root.lookupType('pairing.PairingMessage');
const Status = root.lookupEnum('pairing.PairingMessage.Status').values;
const serverCert = CertificateGenerator.generateFull('mock-tv', 'US', 'CA', 'L', 'O', 'OU');
const clientCert = CertificateGenerator.generateFull('client', 'US', 'CA', 'L', 'O', 'OU');

/** Mock TV. `behaviour` = 'ok' | 'badsecret' | 'hangup-after-config'. Records what it saw. */
function mockTv(behaviour, seen) {
  return tls.createServer({ key: serverCert.key, cert: serverCert.cert, requestCert: true, rejectUnauthorized: false }, (sock) => {
    const send = (p, status = Status.STATUS_OK) => sock.write(PM.encodeDelimited(PM.create({ protocolVersion: 2, status, ...p })).finish());
    let buf = Buffer.alloc(0);
    const nonce = 'B2C3';
    const expectedSecret = () => {
      const peer = sock.getPeerCertificate();
      const own = sock.getCertificate();
      const h = crypto.createHash('sha256');
      h.update(Buffer.from(peer.modulus, 'hex')); h.update(Buffer.from('0' + peer.exponent.slice(2), 'hex'));
      h.update(Buffer.from(own.modulus, 'hex')); h.update(Buffer.from('0' + own.exponent.slice(2), 'hex'));
      h.update(Buffer.from(nonce, 'hex'));
      return h.digest();
    };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const r = protobuf.Reader.create(buf);
        let len; try { len = r.uint32(); } catch { break; }
        if (buf.length < r.pos + len) break;
        const msg = PM.decode(buf.subarray(r.pos, r.pos + len)).toJSON(); buf = buf.subarray(r.pos + len);
        seen.push(Object.keys(msg).find((k) => k.startsWith('pairing')));
        if (msg.pairingRequest) { seen.clientName = msg.pairingRequest.clientName; send({ pairingRequestAck: {} }); }
        else if (msg.pairingOption) send({ pairingOption: { outputEncodings: [{ type: 'ENCODING_TYPE_HEXADECIMAL', symbolLength: 6 }], preferredRole: 'ROLE_TYPE_OUTPUT' } });
        else if (msg.pairingConfiguration) {
          send({ pairingConfigurationAck: {} });
          // "Display" the code: checksum byte + nonce
          seen.code = expectedSecret()[0].toString(16).padStart(2, '0').toUpperCase() + nonce;
          if (behaviour === 'hangup-after-config') sock.destroy();
        } else if (msg.pairingSecret) {
          const ok = Buffer.from(msg.pairingSecret.secret, 'base64').equals(expectedSecret());
          seen.secretOk = ok;
          if (behaviour === 'badsecret' || !ok) send({ pairingSecretAck: {} }, Status.STATUS_BAD_SECRET);
          else send({ pairingSecretAck: {} });
          sock.end();
        }
      }
    });
  });
}

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

(async () => {
  // 1. happy path
  {
    const seen = []; const server = mockTv('ok', seen); const port = await listen(server);
    const p = new Pairing('127.0.0.1', clientCert, { port, clientName: 'Test Client' });
    p.on('secret', () => { assert.ok(p.awaitingCode); assert.strictEqual(p.sendCode(seen.code.toLowerCase()), true, 'checksum accepted'); });
    assert.strictEqual(await p.start(), true);
    assert.deepStrictEqual(seen.slice(), ['pairingRequest', 'pairingOption', 'pairingConfiguration', 'pairingSecret']);
    assert.strictEqual(seen.clientName, 'Test Client');
    assert.strictEqual(seen.secretOk, true, 'TV accepted our secret');
    server.close();
  }
  // 2. wrong code is refused locally (checksum) and never sent
  {
    const seen = []; const server = mockTv('ok', seen); const port = await listen(server);
    const p = new Pairing('127.0.0.1', clientCert, { port });
    const done = p.start().catch((e) => e);
    await new Promise((r) => p.on('secret', r));
    const wrong = (seen.code[0] === 'A' ? 'B' : 'A') + seen.code.slice(1);
    assert.strictEqual(p.sendCode(wrong), false, 'checksum mismatch rejected');
    assert.strictEqual(p.sendCode('ZZZZZZ'), false, 'non-hex rejected');
    p.cancel();
    const err = await done;
    assert.ok(err instanceof Error && /cancelled/i.test(err.message), 'cancel rejects: ' + err.message);
    assert.ok(!seen.includes('pairingSecret'), 'nothing sent to the TV');
    server.close();
  }
  // 3. TV says bad secret
  {
    const seen = []; const server = mockTv('badsecret', seen); const port = await listen(server);
    const p = new Pairing('127.0.0.1', clientCert, { port });
    p.on('secret', () => p.sendCode(seen.code));
    const err = await p.start().catch((e) => e);
    assert.ok(err instanceof Error && /wrong code/i.test(err.message), 'bad secret -> wrong code error: ' + err.message);
    server.close();
  }
  // 4. TV hangs up before the ack: must NOT look like success
  {
    const seen = []; const server = mockTv('hangup-after-config', seen); const port = await listen(server);
    const p = new Pairing('127.0.0.1', clientCert, { port });
    const err = await p.start().catch((e) => e);
    assert.ok(err instanceof Error && /closed the pairing session/i.test(err.message), 'hangup rejects: ' + err.message);
    server.close();
  }
  console.log('pairing: ok');
  process.exit(0);
})().catch((e) => { console.error('pairing: FAILED', e); process.exit(1); });
setTimeout(() => { console.error('pairing: timeout'); process.exit(1); }, 20000);
