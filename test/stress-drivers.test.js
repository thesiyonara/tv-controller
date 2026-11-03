// Disorderly connection sequences against fake TVs: sockets that never finish a handshake, a refused
// connection followed by a quick recovery, a TV that drops the socket during pairing and then answers,
// garbage JSON from a TV, and a Roku that stops answering. Each driver must settle its connect(), keep a
// healthy connection healthy when an older attempt's timer fires, and never throw out of a socket handler.
const assert = require('assert');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const protobuf = require('protobufjs');
const WebSocket = require('ws');
require('./helpers/electron-stub');
const { CertificateGenerator } = require('androidtv-remote/dist/certificate/CertificateGenerator.js');
const { AndroidTvDriver } = require('../dist/main/drivers/androidtv.js');
const { CastDriver } = require('../dist/main/drivers/cast.js');
const { RokuDriver } = require('../dist/main/drivers/roku.js');
const { SamsungDriver } = require('../dist/main/drivers/samsung.js');
const { WebosDriver } = require('../dist/main/drivers/webos.js');
const { getStore } = require('../dist/main/store.js');

const uncaught = [];
process.on('uncaughtException', (e) => { uncaught.push(e); console.error('[uncaught]', e.stack.split('\n').slice(0, 3).join(' | ')); });
process.on('unhandledRejection', (r) => { uncaught.push(r); console.error('[unhandled rejection]', (r && r.stack) || r); });

const serverCert = CertificateGenerator.generateFull('mock-tv', 'US', 'CA', 'L', 'O', 'OU');
const clientCert = CertificateGenerator.generateFull('client', 'US', 'CA', 'L', 'O', 'OU');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (srv, port, host = '127.0.0.1') => new Promise((res, rej) => srv.once('error', rej).listen(port, host, () => res(srv.address().port)));
async function waitFor(fn, ms, what) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return; await sleep(50); } throw new Error('timed out waiting for ' + what); }
const ctx = (kind, host, port) => ({ id: `${kind}:${host}`, kind, host, port, name: 'mock', appVersion: '0.0.0' });
const trail = (d) => { const t = []; d.on('state', (s) => { if (t[t.length - 1] !== s.state) t.push(s.state); }); return t; };
const results = {};

// ---- A. Android TV: a box that accepts TCP but never completes TLS (asleep, port filtered) ----
async function androidHang() {
  const held = [];
  const srv = net.createServer((s) => held.push(s));
  const port = await listen(srv, 0);
  getStore().setCredential('androidtv:127.0.0.1', { ...clientCert, fingerprint: undefined });
  const d = new AndroidTvDriver(ctx('androidtv', '127.0.0.1', port));
  const states = trail(d);
  const t = Date.now();
  const outcome = await Promise.race([d.connect().then(() => 'settled'), sleep(22000).then(() => 'hung')]);
  results.android = { outcome, ms: Date.now() - t, states };
  assert.strictEqual(outcome, 'settled', 'connect() settles when the handshake never completes');
  assert.ok(d.state.state !== 'connected');
  await d.disconnect();
  held.forEach((s) => s.destroy()); srv.close();
}

// ---- B. Cast: refused once, then up a second later; the first attempt's 8 s timer must not poison the recovery ----
const castProto = protobuf.loadSync(require.resolve('castv2/lib/cast_channel.proto'));
const CastMessage = castProto.lookupType('extensions.api.cast_channel.CastMessage');
function castServer() {
  return tls.createServer({ key: serverCert.key, cert: serverCert.cert }, (sock) => {
    let buf = Buffer.alloc(0);
    const send = (m, payload) => {
      const body = CastMessage.encode(CastMessage.create({ protocolVersion: 0, sourceId: m.destinationId, destinationId: m.sourceId, namespace: m.namespace, payloadType: 0, payloadUtf8: JSON.stringify(payload) })).finish();
      const head = Buffer.alloc(4); head.writeUInt32BE(body.length, 0); sock.write(Buffer.concat([head, body]));
    };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        const m = CastMessage.decode(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
        let data = {}; try { data = JSON.parse(m.payloadUtf8); } catch { /* ignore */ }
        if (data.type === 'PING') send(m, { type: 'PONG' });
        else if (data.type === 'GET_STATUS') send(m, { type: 'RECEIVER_STATUS', requestId: data.requestId, status: { applications: [], volume: { level: 0.4, muted: false } } });
      }
    });
    sock.on('error', () => undefined);
  });
}
async function castRecovery() {
  const d = new CastDriver(ctx('cast', '127.0.0.1', 8009));
  const states = trail(d);
  const t0 = Date.now();
  await d.connect(); // nothing listens yet: refused
  const afterRefused = d.state.state;
  const srv = castServer();
  await listen(srv, 8009);
  await waitFor(() => d.state.state === 'connected', 6000, 'the Cast reconnect to succeed').catch((e) => { results.cast = { states, error: e.message }; throw e; });
  const connectedAt = Date.now() - t0;
  await sleep(Math.max(0, 9500 - (Date.now() - t0))); // past the first attempt's 8 s connect timeout
  results.cast = { afterRefused, connectedAt, states, final: d.state.state, error: d.state.error, reconnectTimer: Boolean(d.reconnectTimer) };
  assert.strictEqual(d.state.state, 'connected', `a healthy Cast connection stays connected after the stale timer (got ${d.state.state}: ${d.state.error})`);
  assert.ok(!d.reconnectTimer, 'no reconnect loop runs behind a healthy connection');
  await d.disconnect();
  srv.close();
}

// ---- C. Samsung: the TV drops the socket during the Allow wait, answers on the retry, sends garbage first ----
async function samsungFlap() {
  const info = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(req.url === '/api/v2/' ? JSON.stringify({ device: { modelName: 'QE65', PowerState: 'on', name: 'Mock' } }) : JSON.stringify({ visible: false })); });
  await listen(info, 8001);
  const httpsSrv = https.createServer({ key: serverCert.key, cert: serverCert.cert });
  const wss = new WebSocket.Server({ server: httpsSrv });
  let connections = 0;
  wss.on('connection', (ws) => {
    connections += 1;
    if (connections === 1) return ws.terminate(); // the TV drops us mid-handshake
    for (const junk of ['null', '"str"', '[1,2]', '{"event":"ms.remote.imeUpdate","data":12345}', '{"event":"ed.installedApp.get","data":null}', '{"event":{"x":1}}', 'not json']) ws.send(junk);
    ws.send(JSON.stringify({ event: 'ms.channel.connect', data: { token: 'tok123' } }));
  });
  await listen(httpsSrv, 8002);
  const d = new SamsungDriver(ctx('samsung', '127.0.0.1', 8002));
  const states = trail(d);
  const t0 = Date.now();
  const outcome = await Promise.race([d.connect().then(() => 'settled'), sleep(5000).then(() => 'still pending')]);
  await waitFor(() => d.state.state === 'connected', 8000, 'the Samsung retry to connect').catch((e) => { results.samsung = { states, outcome, error: e.message }; throw e; });
  const connectedAt = Date.now() - t0;
  assert.strictEqual(getStore().getCredential('samsung:127.0.0.1')?.token, 'tok123', 'token stored');
  await sleep(Math.max(0, 37500 - (Date.now() - t0))); // past the first attempt's 35 s Allow timer
  results.samsung = { outcome, connectedAt, connections, states, final: d.state.state, error: d.state.error, wantConnected: d.wantConnected };
  assert.strictEqual(d.state.state, 'connected', `a healthy Samsung connection survives the stale Allow timer (got ${d.state.state}: ${d.state.error})`);
  assert.strictEqual(d.wantConnected, true, 'the driver still wants the connection');
  assert.strictEqual(outcome, 'settled', 'connect() settles when the TV drops the socket (it must not hang on the Allow timer)');
  await d.disconnect();
  wss.close(); httpsSrv.close(); info.close();
}

// ---- D. LG: garbage in every subscription, then the TV restarts ----
async function webosGarbage() {
  const httpsSrv = https.createServer({ key: serverCert.key, cert: serverCert.cert });
  const wss = new WebSocket.Server({ server: httpsSrv });
  let connections = 0;
  wss.on('connection', (ws) => {
    connections += 1;
    const me = connections;
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'register') {
        for (const junk of ['null', '[]', '{"type":"response","id":5}', '{"id":"register_0"}', '{"type":"response","id":"sub_volume","payload":"str"}']) ws.send(junk);
        ws.send(JSON.stringify({ type: 'registered', id: 'register_0', payload: { 'client-key': 'key' + me } }));
        return;
      }
      if (m.type === 'subscribe') {
        const payloads = {
          sub_volume: [{ subscribed: true, volumeStatus: { volume: 'loud', muteStatus: null } }, { subscribed: true, volume: 2e9, muted: 'x' }, null, 7],
          sub_app: [{ subscribed: true, appId: { x: 1 } }, { subscribed: true, appId: 'com.webos.app.livetv' }, { subscribed: true, appId: 'youtube.leanback.v4' }],
          sub_channel: [{ subscribed: true, channelNumber: 12, channelName: ['a'], programName: {} }],
          sub_power: [{ subscribed: true, state: 12 }, { subscribed: true, state: 'Active' }],
          sub_keyboard: [{ subscribed: true, currentWidget: 'x' }, { subscribed: true, currentWidget: { focus: 'yes', contentType: 1 } }, { subscribed: true, currentWidget: { focus: false } }],
        }[m.id] || [{ subscribed: true }];
        for (const p of payloads) ws.send(p === null ? JSON.stringify({ type: 'response', id: m.id }) : JSON.stringify({ type: 'response', id: m.id, payload: p }));
        if (m.id === 'sub_channel') ws.send(JSON.stringify({ type: 'error', id: m.id, error: '500 no tuner' }));
        return;
      }
      if (m.type === 'request') ws.send(JSON.stringify({ type: 'response', id: m.id, payload: m.uri.endsWith('getSystemInfo') ? { modelName: 'OLED', returnValue: true } : { returnValue: true } }));
    });
    if (me === 1) setTimeout(() => ws.terminate(), 1500); // the TV reboots
  });
  await listen(httpsSrv, 3001);
  const d = new WebosDriver(ctx('webos', '127.0.0.1', 3001));
  const states = trail(d);
  await d.connect();
  assert.strictEqual(d.state.state, 'connected', 'LG connected despite garbage before registered');
  await sleep(1000);
  assert.strictEqual(d.state.model, 'OLED');
  await waitFor(() => states.filter((s) => s === 'connected').length >= 2, 8000, 'LG to reconnect after the reboot');
  results.webos = { states, connections, volume: d.state.volume, app: d.state.currentApp, powered: d.state.powered, key: getStore().getCredential('webos:127.0.0.1')?.clientKey };
  assert.strictEqual(d.state.state, 'connected');
  await d.disconnect();
  wss.close(); httpsSrv.close();
}

// ---- E. Roku: garbage answers, then silence, then back ----
async function rokuSilence() {
  let mode = 'ok';
  const srv = http.createServer((req, res) => {
    if (mode === 'silent') return; // never answer
    if (req.url === '/query/device-info') return res.end('<device-info><model-name>Mock</model-name><power-mode>PowerOn</power-mode></device-info>');
    if (mode === 'garbage') return res.end(['<<<', '<app id="x">', 'x'.repeat(200000), '<player state="bogus"><position>abc</position><duration>-1</duration></player>', ''][Math.floor(Math.random() * 5)]);
    res.end('<app id="12">Netflix</app>');
  });
  const port = await listen(srv, 0);
  const d = new RokuDriver(ctx('roku', '127.0.0.1', port));
  const states = trail(d);
  await d.connect();
  assert.strictEqual(d.state.state, 'connected');
  mode = 'garbage';
  await sleep(6000);
  assert.strictEqual(d.state.state, 'connected', 'garbage answers do not drop the connection');
  mode = 'silent';
  await waitFor(() => d.state.state !== 'connected', 30000, 'Roku to be declared gone after three silent polls');
  const droppedWith = d.state.error;
  mode = 'ok';
  await waitFor(() => d.state.state === 'connected', 20000, 'Roku to come back');
  results.roku = { states, droppedWith, media: d.state.media };
  await d.disconnect();
  srv.close();
}

(async () => {
  const t0 = Date.now();
  const outcomes = await Promise.allSettled([androidHang(), castRecovery(), samsungFlap(), webosGarbage(), rokuSilence()]);
  const failed = outcomes.map((o, i) => [['android', 'cast', 'samsung', 'webos', 'roku'][i], o]).filter(([, o]) => o.status === 'rejected');
  console.log(JSON.stringify(results, null, 1));
  for (const [name, o] of failed) console.error(`${name}: FAILED ${o.reason && o.reason.stack || o.reason}`);
  if (uncaught.length) console.error(`${uncaught.length} exception(s) escaped a socket handler:\n` + uncaught.map((e) => '  ' + String(e && e.stack || e).split('\n').slice(0, 2).join(' ')).join('\n'));
  const ok = !failed.length && !uncaught.length;
  console.log(`stress-drivers: ${ok ? 'ok' : 'FAILED'} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(ok ? 0 : 1);
})();
setTimeout(() => { console.error('stress-drivers: timeout'); console.log(JSON.stringify(results, null, 1)); process.exit(1); }, 90000);
