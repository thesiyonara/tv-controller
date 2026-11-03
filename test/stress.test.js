// Stress / fuzz layer, no Electron needed: random and hostile input into every parser and state machine,
// volume into the activity log and discovery, a corrupted settings file, and a reconnect storm against
// closed ports. Anything here must be handled; nothing may throw out of a handler or grow without bound.
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const protobuf = require('protobufjs');
const { userData } = require('./helpers/electron-stub');
const { diffState, prettyPackage, ActivityLog } = require('../dist/main/activity.js');
const { parseMediaSessions, pickSession, toMedia } = require('../dist/main/live.js');
const { parseLink, launchTargets, searchLink, SERVICE_META } = require('../dist/main/deeplink.js');
const { RemoteSession, charToKey } = require('../dist/main/remote/session.js');
const { initials, colorFor } = require('../dist/main/drivers/driver.js');
const { guessName } = require('../dist/main/apps.js');
const { CertificateGenerator } = require('androidtv-remote/dist/certificate/CertificateGenerator.js');

const unhandled = [];
let finished = false;
process.on('unhandledRejection', (r) => { unhandled.push('rejection: ' + (r && r.stack || r)); console.error('[unhandled rejection]', r && r.stack || r); });
process.on('uncaughtException', (e) => { unhandled.push('exception: ' + (e && e.stack || e)); console.error('[uncaught exception]', e && e.stack || e); });
process.on('exit', (code) => { if (!finished && code === 0) { console.error('stress: FAILED (the suite stopped early)'); process.exitCode = 1; } });

// deterministic PRNG so a failure can be replayed
let seed = Number(process.env.STRESS_SEED || 20261102);
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const HOSTILE = ['', ' ', '\u0000', '<img src=x onerror=alert(1)>', '"><script>x</script>', "'; drop table x; --", '‮evil‬', '🎬📺'.repeat(20), 'x'.repeat(5000), '%00%ff%zz', '\n\r\t', '{{7*7}}', '${1+1}', 'null', 'undefined', '-1', '1e308', 'NaN', '../../../etc/passwd', 'ＡＢＣ', 'Zürich Ärger ßtraße'];
const str = () => (chance(0.3) ? pick(HOSTILE) : Array.from({ length: Math.floor(rnd() * 12) }, () => String.fromCharCode(32 + Math.floor(rnd() * 90))).join(''));
const any = (depth = 0) => {
  const r = rnd();
  if (r < 0.15) return undefined;
  if (r < 0.25) return null;
  if (r < 0.4) return str();
  if (r < 0.55) return Math.floor(rnd() * 2000) - 1000 + (chance(0.3) ? 0.5 : 0);
  if (r < 0.62) return chance(0.5);
  if (r < 0.7) return pick([NaN, Infinity, -Infinity, 0, -0, 2 ** 53]);
  if (depth > 2) return str();
  if (r < 0.85) return Array.from({ length: Math.floor(rnd() * 4) }, () => any(depth + 1));
  const o = {}; for (let i = 0; i < Math.floor(rnd() * 4); i++) o[str() || 'k'] = any(depth + 1); return o;
};
const t0 = Date.now();
const timing = {};
const failures = [];
// every step runs even when an earlier one fails, so one run reports everything
const timed = (name, fn) => { const s = Date.now(); try { fn(); } catch (e) { failures.push(name + ': ' + e.message); console.error(`[${name}] FAILED ${e.stack.split('\n').slice(0, 2).join(' ')}`); } timing[name] = Date.now() - s; };

// ---- 1. diffState: random state pairs, including nonsense in every field ----
timed('diffState x20000', () => {
  const states = ['connected', 'disconnected', 'connecting', 'pairing', 'error', 'bogus', undefined, null, 5];
  const player = ['PLAYING', 'PAUSED', 'BUFFERING', 'IDLE', 'bogus', undefined, null];
  const mk = () => ({
    id: pick(['a', 'b']), kind: pick(['androidtv', 'cast', 'x']), host: str(), state: pick(states), error: chance(0.3) ? str() : undefined,
    powered: pick([true, false, undefined, null, 'yes']),
    volume: chance(0.6) ? { level: pick([0, 0.5, 1, NaN, -1, 'x', undefined]), muted: pick([true, false, undefined]), absolute: pick([undefined, 0, 12, NaN, 'x']), max: pick([undefined, 100, 0]) } : pick([undefined, null, 'x']),
    currentApp: chance(0.5) ? pick([{ id: str(), name: chance(0.5) ? str() : undefined }, { id: undefined }, 'x', null]) : undefined,
    media: chance(0.6) ? pick([{ title: chance(0.7) ? str() : undefined, subtitle: chance(0.5) ? str() : undefined, contentId: chance(0.7) ? str() : undefined, playerState: pick(player), appId: chance(0.5) ? str() : undefined, currentTime: any(), duration: any() }, null, 'x', 5]) : undefined,
    imeOpen: pick([true, false, undefined, 'x']), imeField: chance(0.4) ? pick([{ value: str(), start: 0, end: 0, label: chance(0.5) ? str() : undefined }, null, 'x', {}]) : undefined,
    channel: chance(0.4) ? pick([{ number: str(), name: str(), program: chance(0.5) ? str() : undefined }, {}, null, 'x']) : undefined,
    model: chance(0.3) ? str() : undefined, vendor: chance(0.3) ? str() : undefined,
  });
  let events = 0;
  for (let i = 0; i < 20000; i++) {
    const prev = chance(0.1) ? undefined : mk();
    const next = mk();
    let out;
    try { out = diffState(prev, next); } catch (e) { assert.fail(`diffState threw: ${e.message}\nprev=${JSON.stringify(prev)}\nnext=${JSON.stringify(next)}`); }
    assert.ok(Array.isArray(out));
    for (const e of out) { assert.strictEqual(typeof e.text, 'string'); assert.ok(e.text.length > 0, 'event text never empty'); assert.strictEqual(e.device, next.id); assert.ok(['in', 'out'].includes(e.dir)); events++; }
    if (next.state === 'connected' && prev?.state !== 'connected') assert.strictEqual(out[0]?.kind, 'connect', 'a connection is reported first');
    if (prev?.state === 'connected' && next.state !== 'connected') assert.deepStrictEqual(out.map((e) => e.kind), ['disconnect'], 'a disconnect is the only line');
  }
  assert.ok(events > 1000, 'the fuzz produced events: ' + events);
});

// ---- 2. ActivityLog: 200 000 adds stay bounded and ordered ----
timed('activity log x200000', () => {
  const log = new ActivityLog();
  let emitted = 0; log.on('event', () => emitted++);
  const kinds = ['connect', 'disconnect', 'app', 'play', 'pause', 'stop', 'volume', 'mute', 'power', 'keyboard', 'channel', 'launch', 'link', 'text', 'info', 'error'];
  let now = 1_700_000_000_000, lastId = 0;
  for (let i = 0; i < 200000; i++) {
    now += Math.floor(rnd() * 3000);
    const e = log.add({ device: pick(['a', 'b', 'c', 'd', 'e']), kind: pick(kinds), dir: pick(['in', 'out']), text: pick(['Volume 12', 'Volume 13', 'Muted', 'Opened Netflix', 'Playing', str()]), detail: chance(0.3) ? str() : undefined, at: now });
    // a coalesced volume step or a deduped line hands back the existing event; a new one always gets the next id
    assert.ok(e.id <= lastId + 1, 'ids are dense'); lastId = Math.max(lastId, e.id);
  }
  const list = log.list();
  assert.ok(list.length <= 300, 'capped at 300: ' + list.length);
  for (let i = 1; i < list.length; i++) assert.ok(list[i].id > list[i - 1].id, 'list is ordered by id');
  assert.ok(emitted > 0);
  assert.strictEqual(log.list(['zzz']).length, 0);
  const sizeMb = process.memoryUsage().heapUsed / 1048576;
  assert.ok(sizeMb < 400, 'heap stays sane: ' + sizeMb.toFixed(0) + ' MB');
});

// ---- 3. dumpsys media_session: garbage, giant, and realistic layouts ----
timed('media_session parser', () => {
  const lines = ['package=com.plexapp.android', 'active=true', 'active=false', 'state=PlaybackState {state=PLAYING(3), position=123456, buffered position=0, speed=1.0, updated=1, actions=0, custom actions=[], active item id=-1, error=null}', 'state=PlaybackState {state=3, position=-5}', 'metadata: size=3, description=A title, A subtitle, null', 'metadata: size=0, description=null', '   ', 'random junk', 'package=', 'state=PlaybackState {', 'metadata: size=x, description=', 'package=' + 'p'.repeat(10000)];
  for (let i = 0; i < 3000; i++) {
    const dump = Array.from({ length: Math.floor(rnd() * 30) }, () => (chance(0.8) ? pick(lines) : str())).join(pick(['\n', '\r\n', '\n  ']));
    let sessions;
    try { sessions = parseMediaSessions(dump); } catch (e) { assert.fail('parseMediaSessions threw: ' + e.message + '\n' + dump); }
    for (const s of sessions) { assert.strictEqual(typeof s.pkg, 'string'); assert.strictEqual(typeof s.state, 'number'); }
    const s = pickSession(sessions);
    if (s) { const m = toMedia(s); assert.strictEqual(m.source, 'adb'); assert.ok(['IDLE', 'PAUSED', 'PLAYING', 'BUFFERING'].includes(m.playerState)); }
  }
  const giant = ('package=com.x\nactive=true\nstate=PlaybackState {state=3, position=10}\nmetadata: size=2, description=T, S\n').repeat(20000);
  const s = Date.now(); const sessions = parseMediaSessions(giant); const ms = Date.now() - s;
  assert.strictEqual(sessions.length, 20000);
  assert.ok(ms < 3000, 'a 2 MB dump parses quickly: ' + ms + ' ms');
  assert.deepStrictEqual(parseMediaSessions(''), []);
  assert.deepStrictEqual(parseMediaSessions('\u0000'.repeat(1000)), []);
});

// ---- 4. names and colours from arbitrary strings ----
timed('names x30000', () => {
  for (let i = 0; i < 30000; i++) {
    const s = str();
    for (const fn of [prettyPackage, guessName, initials, colorFor]) { const r = fn(s); assert.strictEqual(typeof r, 'string', fn.name); }
    assert.ok(initials(s).length >= 1 && initials(s).length <= 2, 'initials are one or two characters: ' + JSON.stringify(initials(s)));
    assert.match(colorFor(s), /^#[0-9A-F]{6}$/);
  }
  assert.strictEqual(prettyPackage('com.plexapp.android'), 'Plexapp');
  assert.strictEqual(prettyPackage('x'.repeat(100000)).length, 100000);
});

// ---- 5. deep links: every scheme and shape a clipboard can hold ----
timed('deeplink x20000', () => {
  const hosts = ['www.youtube.com', 'youtu.be', 'm.youtube.com', 'netflix.com', 'www.netflix.com', 'disneyplus.com', 'primevideo.com', 'amazon.com', 'open.spotify.com', 'twitch.tv', 'app.plex.tv', 'play.max.com', 'hulu.com', 'tv.apple.com', 'web.strem.io', 'app.strem.io', 'evil.youtube.com.attacker.io', 'xn--mnchen-3ya.de', '127.0.0.1', '[::1]', 'localhost', ''];
  const paths = ['/watch', '/watch?v=aqz-KE-bpKQ', '/shorts/abcdefgh', '/results?search_query=a%20b', '/title/81', '/watch/81', '/search?q=x', '/video/abc/def', '/detail/B0ABC', '/dp/XYZ', '/#/search?search=q', '/#/detail/movie/tt1', '/' + 'a'.repeat(50000), '/%zz', '/\u0000', ''];
  const schemes = ['https://', 'http://', 'javascript:', 'data:text/html,', 'file:///', 'spotify:', 'plex://', 'stremio:///', 'ftp://', 'mailto:', ''];
  const known = new Set(Object.keys(SERVICE_META));
  for (let i = 0; i < 20000; i++) {
    const url = chance(0.1) ? str() : pick(schemes) + pick(hosts) + pick(paths) + (chance(0.3) ? '?x=' + str() : '');
    let link;
    try { link = parseLink(url); } catch (e) { assert.fail('parseLink threw on ' + JSON.stringify(url) + ': ' + e.message); }
    assert.ok(known.has(link.service), 'known service: ' + link.service);
    assert.strictEqual(typeof link.url, 'string');
    let t;
    try { t = launchTargets(link); } catch (e) { assert.fail('launchTargets threw on ' + JSON.stringify(url) + ': ' + e.message); }
    assert.strictEqual(typeof t, 'object');
    if (link.id !== undefined) assert.strictEqual(typeof link.id, 'string');
  }
  assert.strictEqual(parseLink('https://evil.youtube.com.attacker.io/watch?v=x').service, 'web', 'suffix lookalikes are not YouTube');
  assert.strictEqual(parseLink('javascript:alert(1)').service, 'web');
  for (const svc of known) { const l = searchLink(svc, '<>&"\' ' + 'q'.repeat(3000)); if (l) assert.ok(!/[<>" ]/.test(l.url), 'search text is encoded for ' + svc); }
});

// ---- 6. key injection: every BMP code point and some astral ones ----
timed('charToKey', () => {
  for (let c = 0; c < 0x10000; c += 7) { const r = charToKey(String.fromCharCode(c)); assert.ok(r === undefined || /^KEYCODE_[A-Z0-9_]+$/.test(r), 'code point ' + c); }
  for (const s of ['😀', '👨‍👩‍👧', 'é', 'ß', '', 'ab']) { const r = charToKey(s); assert.ok(r === undefined || /^KEYCODE_/.test(r)); }
  assert.strictEqual(charToKey('A'), 'KEYCODE_A');
});

// ---- 7. the remote protocol frame reader: random bytes, frames split at every byte, a giant length prefix ----
const root = protobuf.loadSync(require.resolve('../dist/main/remote/remotemessage.proto'));
const RM = root.lookupType('remote.RemoteMessage');
const cert = CertificateGenerator.generateFull('client', 'US', 'CA', 'L', 'O', 'OU');
function fakeSession() {
  const s = new RemoteSession('127.0.0.1', cert, 6466, '0.0.0');
  const out = [], errors = [];
  s.socket = { destroyed: false, write: (b) => out.push(Buffer.from(b)), destroy() { this.destroyed = true; } };
  s.on('error', (e) => errors.push(e.message));
  return { s, out, errors };
}
timed('frame reader', () => {
  // valid frames, delivered one byte at a time and in random chunks
  const pings = Buffer.concat([1, 2, 3].map((v) => Buffer.from(RM.encodeDelimited(RM.create({ remotePingRequest: { val1: v } })).finish())));
  for (const chunkSize of [1, 2, 3, 7, 1000]) {
    const { s, out, errors } = fakeSession();
    for (let i = 0; i < pings.length; i += chunkSize) s.onData(pings.subarray(i, i + chunkSize));
    assert.strictEqual(out.length, 3, `3 ping replies with ${chunkSize}-byte chunks`);
    assert.deepStrictEqual(out.map((b) => RM.decodeDelimited(b).toJSON().remotePingResponse.val1), [1, 2, 3]);
    assert.deepStrictEqual(errors, []);
  }
  // random bytes: errors are events, never throws, and the buffer never keeps growing past a frame's worth
  for (let i = 0; i < 2000; i++) {
    const { s } = fakeSession();
    const n = Math.floor(rnd() * 64);
    const b = Buffer.alloc(n); for (let j = 0; j < n; j++) b[j] = Math.floor(rnd() * 256);
    try { s.onData(b); } catch (e) { assert.fail('onData threw on ' + b.toString('hex') + ': ' + e.message); }
  }
  // a frame that claims to be 4 GB long: the session must give up, not accumulate until the app dies
  const { s, errors } = fakeSession();
  const huge = Buffer.from([0xf0, 0xff, 0xff, 0xff, 0x0f]); // varint 4294967280
  s.onData(huge);
  const chunk = Buffer.alloc(65536, 0x41);
  for (let i = 0; i < 64; i++) s.onData(chunk); // 4 MB
  assert.ok(s.buf.length < 2 * 1024 * 1024, 'buffer is bounded after a giant length prefix: ' + s.buf.length);
  assert.ok(errors.length > 0 && s.socket.destroyed, 'a giant frame is reported and the socket dropped');
});

// ---- 8. a settings file with the wrong shape must not take the app down ----
timed('store corruption', () => {
  const file = path.join(userData, 'android-tv-controller.json');
  const fresh = () => { for (const k of Object.keys(require.cache)) if (/dist[\\/]main[\\/](store|discovery)\.js$/.test(k)) delete require.cache[k]; return require('../dist/main/store.js').getStore(); };
  const variants = [
    'null', '[]', '5', '"x"', '{', '',
    '{"settings": null}', '{"settings": "garbage"}', '{"settings": {"watchHistory": null, "textHistory": "abc", "pinnedApps": null, "hiddenApps": [], "adbHosts": 5, "corners": "x", "deviceNames": 3, "dismissedLinkHints": {}}}',
    '{"knownDevices": [1, 2], "rooms": null, "credentials": null}', '{"knownDevices": {"x": null, "y": {"id": "y"}, "z": {"id": "androidtv:1", "kind": "bogus", "host": "1"}}, "rooms": {"r": null, "q": {"id": "q"}}}',
    '{"settings": {"watchHistory": [null, 1, {"id": 5}], "theme": 7, "lastTarget": {}}}',
  ];
  for (const v of variants) {
    fs.writeFileSync(file, v);
    let store;
    try { store = fresh(); } catch (e) { assert.fail('store failed to load ' + JSON.stringify(v) + ': ' + e.message); }
    try {
      const s = store.settings();
      assert.ok(Array.isArray(s.watchHistory) && Array.isArray(s.textHistory) && Array.isArray(s.adbHosts) && Array.isArray(s.dismissedLinkHints), 'arrays are arrays for ' + v);
      assert.ok(s.pinnedApps && typeof s.pinnedApps === 'object' && !Array.isArray(s.pinnedApps), 'pinnedApps is a map for ' + v);
      assert.ok(s.corners && typeof s.corners === 'object' && s.deviceNames && typeof s.deviceNames === 'object', 'maps are maps for ' + v);
      assert.ok(Array.isArray(store.rooms()) && Array.isArray(store.knownDevices()), 'rooms/devices list for ' + v);
      for (const d of store.knownDevices()) assert.ok(d && typeof d.id === 'string' && typeof d.host === 'string' && ['androidtv', 'cast', 'roku', 'samsung', 'webos'].includes(d.kind), 'known device is well formed: ' + JSON.stringify(d));
      for (const r of store.rooms()) assert.ok(r && typeof r.id === 'string' && typeof r.primary === 'string', 'room is well formed: ' + JSON.stringify(r));
      store.recordWatch({ id: 'y:1', service: 'youtube', title: 't', url: 'u', at: 1 });
      store.migrateDevice('androidtv:1', 'androidtv:2');
      store.updateSettings({ theme: 'light' });
      store.setCredential('androidtv:2', { token: 'x' });
      assert.strictEqual(store.getCredential('androidtv:2').token, 'x');
      store.flush();
      JSON.parse(fs.readFileSync(file, 'utf8'));
      // discovery boots from whatever the store holds
      const { Discovery } = require('../dist/main/discovery.js');
      const disc = new Discovery();
      assert.ok(Array.isArray(disc.list()));
    } catch (e) { assert.fail('store operations failed for ' + JSON.stringify(v) + ': ' + e.stack); }
  }
  fs.writeFileSync(file, '{}');
  fresh();
});

// ---- 9. discovery: hostile announcements and five hundred devices ----
timed('discovery flood', () => {
  const { Discovery } = require('../dist/main/discovery.js');
  const disc = new Discovery();
  let updates = 0; disc.on('update', () => updates++);
  // garbage SSDP and mDNS never throw
  for (let i = 0; i < 3000; i++) {
    try {
      disc.onSsdpResponse(chance(0.5) ? str() : `HTTP/1.1 200 OK\r\nST: ${pick(['roku:ecp', 'urn:lge-com:service:webos-second-screen:1', str()])}\r\nSERVER: ${pick(['Roku/12', 'Samsung', 'WebOS/5', str()])}\r\nUSN: ${pick(['uuid:abc::x', str(), ''])}\r\nLOCATION: ${pick(['http://x/d.xml', str()])}\r\n\r\n`, pick(['10.0.0.' + Math.floor(rnd() * 255), str()]));
      disc.onMdnsUp(pick(['androidtv', 'cast']), pick([{}, { addresses: [] }, { addresses: null }, { addresses: ['10.0.1.' + Math.floor(rnd() * 255)], txt: pick([null, undefined, {}, { fn: str(), md: str(), id: str(), bt: str() }]), name: chance(0.7) ? str() : undefined, port: any() }, any()]));
    } catch (e) { assert.fail('discovery handler threw: ' + e.stack); }
  }
  // two unnamed Android TVs at different addresses are two TVs, not one that moved
  const before = disc.list().length;
  disc.onMdnsUp('androidtv', { addresses: ['10.9.9.1'], txt: {}, port: 6466 });
  disc.onMdnsUp('androidtv', { addresses: ['10.9.9.2'], txt: {}, port: 6466 });
  assert.ok(disc.get('androidtv:10.9.9.1') && disc.get('androidtv:10.9.9.2'), 'both unnamed TVs stay listed');
  // five hundred Cast devices announcing twice
  const s = Date.now();
  for (let round = 0; round < 2; round++) for (let i = 0; i < 500; i++) disc.onMdnsUp('cast', { addresses: ['10.20.' + (i >> 8) + '.' + (i & 255)], txt: { fn: 'Speaker ' + i, md: 'Nest', id: 'id' + i }, name: 'Speaker ' + i, port: 8009 });
  const ms = Date.now() - s;
  assert.ok(disc.list().filter((d) => d.kind === 'cast' && /^10\.20\./.test(d.host)).length === 500, '500 devices listed');
  assert.ok(ms < 5000, '1000 announcements handled quickly: ' + ms + ' ms');
  const { getStore } = require('../dist/main/store.js');
  getStore().flush();
  const size = fs.statSync(path.join(userData, 'android-tv-controller.json')).size;
  assert.ok(size < 2 * 1024 * 1024, 'store file stays small with 500 devices: ' + (size / 1024).toFixed(0) + ' KB');
  timing['discovery updates emitted'] = updates;
});

// ---- 10. a reconnect storm against closed ports: every driver backs off and lets go on disconnect ----
(async () => {
  const { AndroidTvDriver } = require('../dist/main/drivers/androidtv.js');
  const { CastDriver } = require('../dist/main/drivers/cast.js');
  const { RokuDriver } = require('../dist/main/drivers/roku.js');
  const { SamsungDriver } = require('../dist/main/drivers/samsung.js');
  const { WebosDriver } = require('../dist/main/drivers/webos.js');
  const { getStore } = require('../dist/main/store.js');
  // a port nothing listens on, for the drivers that take one
  const closed = await new Promise((r) => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => r(p)); }); });
  const ctx = (kind, i) => ({ id: `${kind}:127.0.0.${i}`, kind, host: `127.0.0.${i}`, port: closed, name: 'x', appVersion: '0.0.0' });
  const drivers = [];
  for (let i = 1; i <= 4; i++) {
    getStore().setCredential(`androidtv:127.0.0.${i}`, { ...cert, fingerprint: undefined });
    drivers.push(new AndroidTvDriver(ctx('androidtv', i)), new CastDriver(ctx('cast', i)), new RokuDriver(ctx('roku', i)), new SamsungDriver(ctx('samsung', i)), new WebosDriver(ctx('webos', i)));
  }
  const states = new Map();
  for (const d of drivers) d.on('state', (s) => states.set(s.id, (states.get(s.id) || 0) + 1));
  const s = Date.now();
  await Promise.all(drivers.map((d) => d.connect().catch((e) => unhandled.push('connect rejected: ' + e.message))));
  timing['storm connect settle ms'] = Date.now() - s;
  await new Promise((r) => setTimeout(r, 3500));
  for (const d of drivers) {
    assert.ok(['error', 'disconnected', 'connecting', 'pairing'].includes(d.state.state), `${d.state.id} not connected to a closed port: ${d.state.state}`);
    if (d.wantConnected) assert.ok(d.reconnectTimer || d.state.state === 'connecting', `${d.state.id} keeps trying while wanted`);
  }
  await Promise.all(drivers.map((d) => d.disconnect()));
  for (const d of drivers) { assert.strictEqual(d.reconnectTimer, undefined, `${d.state.id} has no reconnect timer after disconnect`); assert.strictEqual(d.state.state, 'disconnected'); }
  // a stale connect timeout from before the disconnect must not resurface as an error later
  await new Promise((r) => setTimeout(r, 9000));
  for (const d of drivers) assert.strictEqual(d.state.state, 'disconnected', `${d.state.id} stays disconnected after old timers fire (got ${d.state.state}${d.state.error ? ': ' + d.state.error : ''})`);
  timing['state events in storm'] = [...states.values()].reduce((a, b) => a + b, 0);
  assert.deepStrictEqual(unhandled, [], 'no unhandled errors');
  finished = true;
  console.log(JSON.stringify(timing));
  if (failures.length) { console.error('stress: FAILED\n  ' + failures.join('\n  ')); process.exit(1); }
  console.log(`stress: ok in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(0);
})().catch((e) => { finished = true; console.error('stress: FAILED', e); console.error('unhandled:', unhandled); process.exit(1); });
setTimeout(() => { console.error('stress: timeout'); process.exit(1); }, 60000);
