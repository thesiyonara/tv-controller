// Renderer flood and soak. Runs the real app headless (`xvfb-run -a npx electron test/stress-ui.js` on
// Linux, `npx electron test/stress-ui.js` elsewhere) with a throw-away data folder, feeds it the same IPC
// events the main process sends (device states, activity, screen frames, discovery lists) at volume, drives
// it through a resize storm, sheet and menu churn, hostile strings and a keyboard-mode burst, and watches
// DOM size, heap and process memory. Exit code 0 only when every check passes and the renderer logged no error.
const { app, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { IPC } = require('../dist/shared/ipc.js');

const SOAK_MS = Number(process.env.STRESS_SOAK_MS || 120000);
const out = process.env.SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tvc-stress-shots-'));
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'tvc-stress-data-')));
app.commandLine.appendSwitch('js-flags', '--expose-gc');
app.disableHardwareAcceleration(); // CI runners have no GPU; the software path is what xvfb can composite
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const failures = [];
const warnings = [];
const report = {};
const check = (ok, what) => { if (!ok) { failures.push(what); console.log('  FAIL', what); } };

const OVERFLOW = `(() => { const bad = []; const vw = window.innerWidth, vh = window.innerHeight;
  for (const el of document.querySelectorAll('body *')) { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('.hidden') || el.closest('.toasts') || el.closest('.ctx')) continue; const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const text = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) ? el.textContent.trim().slice(0, 28) : '';
    if (text && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis' && cs.overflowX !== 'auto' && cs.overflow !== 'auto' && cs.overflow !== 'hidden' && !el.closest('.apps-grid')) bad.push('overflow <' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '> ' + text);
    if (r.right > vw + 1 || r.left < -1) { if (!el.closest('.apps-grid, .continue-row')) bad.push('offscreen-x <' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '> ' + text); } }
  const c = document.getElementById('center'); if (c && c.scrollHeight > c.clientHeight + 1) bad.push('center scrolls ' + c.scrollHeight + '>' + c.clientHeight);
  const sb = document.querySelector('.sidebar'); if (vh >= 620 && sb && getComputedStyle(sb).display !== 'none' && sb.scrollHeight > sb.clientHeight + 1) bad.push('sidebar scrolls ' + sb.scrollHeight + '>' + sb.clientHeight);
  return [...new Set(bad)].slice(0, 8); })()`;

// 60 devices on 40 hosts, 10 saved rooms, 400 apps, 30 history entries, 300 feed lines; hostile text everywhere it can come from
const SETUP = `
  window.__pwned = undefined;
  const X = ['<img src=x onerror="window.__pwned=1">', '"><svg onload="window.__pwned=2">', "'; window.__pwned=3; '", '\\u202Eevil\\u202C', '🎬📺'.repeat(12), 'x'.repeat(600), '&lt;b&gt;', '{{7*7}}', '\\u0000nul'];
  const hx = (i) => X[i % X.length];
  const devices = [], rooms = [], states = {};
  const t0 = Date.now();
  for (let h = 0; h < 40; h++) {
    const host = '192.168.' + (h >> 8) + '.' + (10 + (h & 255));
    const kinds = h < 20 ? ['androidtv', 'cast'] : h < 30 ? ['samsung'] : h < 35 ? ['webos'] : ['roku'];
    for (const kind of kinds) {
      const id = kind + ':' + host;
      devices.push({ id, kind, name: (h % 5 === 0 ? hx(h) + ' ' : '') + 'TV ' + h, host, port: 1, model: h % 3 ? 'Model ' + hx(h + 1) : undefined, meta: {}, paired: h % 7 !== 0, pairing: kind === 'cast' || kind === 'roku' ? 'none' : 'code', capabilities: kind === 'cast' ? ['volumeLevel','media','cast','launch'] : ['keys','text','power','volume','volumeLevel','apps','launch'], lastSeen: Date.now() - (h % 4) * 400000 });
      states[id] = { id, kind, host, state: h % 6 === 5 ? 'disconnected' : 'connected', powered: h % 9 !== 8, volume: { level: (h % 100) / 100, muted: h % 11 === 0, absolute: h % 100, max: 100 },
        currentApp: h % 2 ? { id: 'app.' + (h % 40), name: 'App ' + hx(h) } : undefined,
        media: kind === 'cast' && h % 3 === 0 ? { source: 'cast', appId: '233637DE', contentId: 'id' + h, title: 'Title ' + hx(h) + ' ' + 'long '.repeat(h % 50), subtitle: hx(h + 2), playerState: ['PLAYING','PAUSED','BUFFERING'][h % 3], currentTime: h * 7, duration: 7000, updatedAt: t0 } : undefined,
        channel: kind === 'roku' ? { number: String(h), name: hx(h), program: hx(h + 1) } : undefined };
    }
  }
  for (let r = 0; r < 10; r++) rooms.push({ id: 'r' + r, name: 'Room ' + r + ' ' + hx(r), primary: 'androidtv:192.168.0.' + (10 + r), audio: 'samsung:192.168.0.' + (30 + r), power: ['androidtv:192.168.0.' + (10 + r), 'samsung:192.168.0.' + (30 + r)], companions: ['cast:192.168.0.' + (10 + r)] });
  // devices, rooms and settings go through the real bridge so main's own updates don't wipe them out mid-run
  for (const d of devices) await controller.discovery.addManual(d.kind, d.host, d.name);
  for (const r of rooms) await controller.rooms.save(r);
  const target = 'room:r1';
  const pinnedApps = { [target]: ['app.0','app.1','app.2','app.3','app.4','app.5','app.6','app.7'] };
  const watchHistory = Array.from({ length: 30 }, (_, i) => ({ id: 'y:' + i, service: ['youtube','netflix','stremio','web'][i % 4], title: 'Watched ' + hx(i) + ' ' + 'long '.repeat(i % 20), subtitle: 'S' + i + ' E' + i, artwork: i % 3 ? 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==' : undefined, url: 'https://youtu.be/' + i, at: Date.now() - i * 3600e3, position: i * 10, duration: 1000 }));
  S.settings = await controller.settings.set({ pinnedApps, watchHistory, lastTarget: target });
  S.devices = await controller.discovery.list(); S.rooms = await controller.rooms.list(); S.states = states;
  if (S.scan) S.scan = { ...S.scan, blocked: false }; // a home network, not this sandbox
  S.target = target;
  S.apps[S.target] = Array.from({ length: 400 }, (_, i) => ({ id: 'app.' + i, name: 'App ' + i + ' ' + hx(i), initials: 'A' + (i % 10), color: '#' + ((i * 2654435) & 0xffffff).toString(16).padStart(6, '0'), source: i % 2 ? 'device' : 'catalog', link: 'https://x/' + i }));
  S.activity = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, at: t0 - (300 - i) * 2000, device: ['androidtv:192.168.0.11','cast:192.168.0.11','samsung:192.168.0.31'][i % 3], kind: ['play','volume','app','text','link','connect','mute','keyboard'][i % 8], dir: i % 4 ? 'in' : 'out', text: 'Line ' + i + ' ' + hx(i), detail: i % 2 ? 'Detail ' + hx(i + 3) : undefined, app: i % 5 ? 'app.' + (i % 40) : undefined }));
  $('#empty-state').classList.add('hidden'); for (const id of ['#now-card','#apps-section']) $(id).classList.remove('hidden');
  renderAll();
  return S.devices.length + '/' + S.rooms.length`;

function jpegFrame(w, h, seed) {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < buf.length; i += 4) { buf[i] = (i * seed) & 255; buf[i + 1] = (i >> 3) & 255; buf[i + 2] = (seed * 37) & 255; buf[i + 3] = 255; }
  return 'data:image/jpeg;base64,' + nativeImage.createFromBitmap(buf, { width: w, height: h }).toJPEG(70).toString('base64');
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (ev) => { if (ev.level >= 2) { errors.push(ev.message); console.log('[renderer error]', ev.message.slice(0, 200)); } });
  win.webContents.on('render-process-gone', (_ev, d) => { failures.push('renderer gone: ' + d.reason); console.log('[renderer gone]', d.reason); });
  // the sandbox has no reachable gateway; the app would say the network is blocked, which a home network never does
  const realSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (ch, ...a) => realSend(ch, ...(ch === IPC.discovery.statusEvent && a[0] ? [{ ...a[0], blocked: false }] : a));
  win.webContents.on('did-finish-load', async () => {
    const js = (c) => win.webContents.executeJavaScript(c);
    const send = (ch, ...a) => win.webContents.send(ch, ...a);
    // the layout check is the assertion; the picture is for people, and a runner without a compositor can't take one
    const shot = async (n) => { await sleep(300); try { fs.writeFileSync(path.join(out, n + '.png'), (await win.webContents.capturePage()).toPNG()); } catch (e) { warnings.push(`no screenshot for ${n}: ${e.message}`); } const ov = await js(OVERFLOW); console.log('[shot]', n, ov.length ? '\n    ' + ov.join('\n    ') : 'clean'); return ov; };
    const measure = async (name) => {
      await js('window.gc && window.gc()'); await sleep(150);
      const m = await js(`({ nodes: document.getElementsByTagName('*').length, heap: Math.round(performance.memory.usedJSHeapSize / 1048576), toasts: document.querySelectorAll('#toasts .toast').length, menus: document.querySelectorAll('.ctx').length, feed: document.querySelectorAll('#activity-list li').length, apps: document.querySelectorAll('#apps-grid .app').length, listeners: 0 })`);
      const tab = app.getAppMetrics().find((p) => p.type === 'Tab');
      m.rss = tab ? Math.round(tab.memory.workingSetSize / 1024) : -1;
      const t = Date.now(); await js('1'); m.roundtrip = Date.now() - t;
      report[name] = m;
      console.log(`[${name}]`, JSON.stringify(m));
      return m;
    };
    try {
      await sleep(1500);
      win.setSize(1200, 780); await sleep(300);
      const counts = await js(`(async () => { ${SETUP} })()`);
      console.log('[setup]', counts, 'devices/rooms through the bridge');
      const base = await measure('baseline');
      check(base.nodes < 6000, 'baseline DOM is bounded: ' + base.nodes + ' nodes');
      const pwned = await js('window.__pwned');
      check(pwned === undefined, 'hostile strings do not run: __pwned=' + pwned);
      check((await js('document.scripts.length')) === 1, 'no injected script elements');
      await shot('S1-baseline-hostile');

      // discovery churn: the full device list arriving over and over, as mDNS re-announcements do
      const devices = await js('S.devices');
      let t = Date.now();
      for (let i = 0; i < 200; i++) { send(IPC.discovery.update, devices); if (i % 20 === 0) await sleep(5); }
      await js('1');
      report.discoveryChurnMs = Date.now() - t;
      await measure('after discovery churn');

      // state flood: 3000 events, every kind of change
      const ids = await js('Object.keys(S.states)');
      const room = await js("S.rooms.find((r) => r.id === 'r1')");
      const hot = [room.primary, room.audio, ...(room.companions || [])].filter(Boolean);
      console.log('[flood targets]', ids.length, 'devices,', JSON.stringify(hot));
      check(ids.length >= 60 && hot.length === 3, 'flood targets resolved');
      t = Date.now();
      for (let i = 0; i < 3000; i++) {
        const id = i % 4 === 0 ? ids[i % ids.length] : hot[i % hot.length];
        const st = { id, kind: id.split(':')[0], host: id.split(':')[1], state: i % 500 === 499 ? 'disconnected' : 'connected', powered: true,
          volume: { level: (i % 100) / 100, muted: i % 13 === 0, absolute: i % 100, max: 100 },
          currentApp: { id: 'app.' + ((i / 50) | 0) % 40, name: 'App ' + ((i / 50) | 0) },
          media: id.startsWith('cast') ? { source: 'cast', appId: '233637DE', contentId: 'v' + ((i / 200) | 0), title: 'Flood title ' + ((i / 200) | 0), playerState: i % 7 ? 'PLAYING' : 'PAUSED', currentTime: i % 7000, duration: 7000, updatedAt: Date.now() } : undefined };
        send(IPC.device.state, st);
        if (i % 25 === 0) await sleep(1);
      }
      await js('1');
      report.stateFloodMs = Date.now() - t;
      const afterState = await measure('after state flood');
      check(afterState.roundtrip < 500, 'renderer answers quickly after the state flood: ' + afterState.roundtrip + ' ms');
      check(afterState.nodes < base.nodes * 1.5 + 200, 'DOM does not balloon with state events: ' + afterState.nodes + ' vs ' + base.nodes);

      // activity flood: 2000 feed lines
      t = Date.now();
      for (let i = 0; i < 2000; i++) { send(IPC.device.activityEvent, { id: 10000 + i, at: Date.now(), device: hot[i % hot.length], kind: ['play', 'volume', 'app', 'text', 'link', 'mute'][i % 6], dir: i % 3 ? 'in' : 'out', text: 'Flood line ' + i, detail: i % 2 ? 'detail ' + i : undefined }); if (i % 50 === 0) await sleep(1); }
      await js('1');
      report.activityFloodMs = Date.now() - t;
      const afterAct = await measure('after activity flood');
      check((await js('S.activity.length')) <= 300, 'renderer keeps at most 300 feed events');
      check(afterAct.feed <= 60, 'feed shows at most 60 rows: ' + afterAct.feed);

      // screen frames: 120 real JPEGs for the room's Android TV, then live view off
      const android = hot.find((x) => x.startsWith('androidtv'));
      send(IPC.device.state, { id: android, kind: 'androidtv', host: android.split(':')[1], state: 'connected', powered: true, liveView: { media: true, screen: true } });
      await sleep(50);
      t = Date.now();
      for (let i = 0; i < 120; i++) { send(IPC.device.screen, android, jpegFrame(800, 450, i + 1)); if (i % 10 === 0) await sleep(5); }
      await js('1');
      report.framesMs = Date.now() - t;
      await shot('S2-live-frames');
      send(IPC.device.screen, android, null);
      send(IPC.device.state, { id: android, kind: 'androidtv', host: android.split(':')[1], state: 'connected', powered: true });
      await sleep(100);
      const afterFrames = await measure('after frames');
      check(Object.keys(await js('S.frames')).length === 0, 'frames are dropped when the live view stops');

      // resize storm with compact toggles; overflow checked along the way
      const sizes = [];
      let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      let overflowHits = [];
      t = Date.now();
      for (let i = 0; i < 150; i++) {
        if (i % 25 === 0) { await js(`controller.app.setCompact(${(i / 25) % 2 === 1})`); await sleep(250); }
        const compactNow = (i / 25 | 0) % 2 === 1;
        const w = compactNow ? 220 + Math.floor(rnd() * 340) : 300 + Math.floor(rnd() * 1300), h = compactNow ? 320 + Math.floor(rnd() * 600) : 420 + Math.floor(rnd() * 600);
        win.setSize(w, h); sizes.push(w + 'x' + h);
        await sleep(i % 10 === 9 ? 350 : 60);
        if (i % 10 === 9) { const ov = await js(OVERFLOW); if (ov.length) overflowHits.push({ size: w + 'x' + h, compact: compactNow, ov }); }
      }
      await js('controller.app.setCompact(false)'); await sleep(300); win.setSize(1200, 780); await sleep(400);
      report.resizeStormMs = Date.now() - t;
      report.overflowHits = overflowHits;
      check(overflowHits.length === 0, 'no overflow during the resize storm: ' + JSON.stringify(overflowHits).slice(0, 600));
      await measure('after resize storm');
      await shot('S3-after-resize-storm');

      // sheet and menu churn
      t = Date.now();
      for (let i = 0; i < 30; i++) {
        await js(`openSettings(['general','shortcuts','behaviour','privacy','updates'][${i} % 5]); closeSheets(); openTypeSheet(undefined, ['tv','youtube','netflix','disney','prime'][${i} % 5]); closeSheets(); openHelp(); closeSheets(); renderDiag(); openSheet('#sheet-diag'); closeSheets(); openRoomEditor(S.rooms[0]); closeSheets(); openDevSheet(); closeSheets();`);
        await js(`$('#device-picker').click(); document.body.click(); $('#btn-devtools').click(); document.body.click(); $('#now-more').click(); document.body.click(); $('#vol-via').click(); document.body.click();`);
      }
      await sleep(200);
      report.sheetChurnMs = Date.now() - t;
      const afterSheets = await measure('after sheet churn');
      check(afterSheets.menus <= 1, 'at most one context menu in the DOM: ' + afterSheets.menus);
      check(!(await js("anySheetOpen()")), 'all sheets closed after churn');

      // keyboard-mode burst: 300 keystrokes while main refuses them (no real TV) → bounded toasts, no errors
      await js(`setKeyMode(true)`);
      for (let i = 0; i < 300; i++) { await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(String.fromCharCode(97 + (i % 26)))}, bubbles: true }))`); }
      await sleep(800);
      const afterKeys = await measure('after keyboard burst');
      check(afterKeys.toasts <= 4, 'error toasts are capped during a keystroke burst: ' + afterKeys.toasts);
      check(await js('S.keyMode'), 'keyboard mode survives refused keys');
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      check(!(await js('S.keyMode')), 'Esc leaves keyboard mode');

      // soak: mixed traffic for a while; memory sampled every 30 s
      const samples = [];
      const soakStart = Date.now();
      let n = 0;
      while (Date.now() - soakStart < SOAK_MS) {
        const id = hot[n % hot.length];
        send(IPC.device.state, { id, kind: id.split(':')[0], host: id.split(':')[1], state: 'connected', powered: true, volume: { level: (n % 100) / 100, muted: false, absolute: n % 100, max: 100 }, currentApp: { id: 'app.' + (n % 40), name: 'App ' + (n % 40) }, media: id.startsWith('cast') ? { source: 'cast', appId: '233637DE', contentId: 'soak' + ((n / 100) | 0), title: 'Soak ' + ((n / 100) | 0), playerState: 'PLAYING', currentTime: n % 7000, duration: 7000, updatedAt: Date.now() } : undefined });
        if (n % 4 === 0) send(IPC.device.activityEvent, { id: 20000 + n, at: Date.now(), device: id, kind: ['play', 'volume', 'app', 'text'][n % 4], dir: 'in', text: 'Soak line ' + n });
        if (n % 20 === 0) send(IPC.device.screen, android, jpegFrame(400, 225, n));
        if (n % 100 === 0) { win.setSize(900 + (n % 300), 650 + (n % 130)); }
        if (n % 600 === 0) samples.push(await measure('soak +' + Math.round((Date.now() - soakStart) / 1000) + 's'));
        n++;
        await sleep(50);
      }
      send(IPC.device.screen, android, null);
      win.setSize(1200, 780); await sleep(400);
      const last = await measure('soak end');
      samples.push(last);
      report.soakEvents = n;
      if (samples.length >= 2) {
        const first = samples[1] || samples[0];
        check(last.heap <= first.heap * 1.5 + 20, `heap stays flat through the soak: ${first.heap} → ${last.heap} MB`);
        check(last.nodes <= first.nodes * 1.2 + 100, `DOM stays flat through the soak: ${first.nodes} → ${last.nodes} nodes`);
        check(last.rss <= first.rss * 1.6 + 100000, `renderer memory stays flat through the soak: ${first.rss} → ${last.rss} KB`);
      }
      const finalOv = await shot('S4-final');
      check(finalOv.length === 0, 'final layout clean');
      await js('controller.app.setCompact(true)'); await sleep(300); win.setSize(380, 720); await sleep(400);
      const compactOv = await shot('S5-final-compact');
      check(compactOv.length === 0, 'final compact layout clean');
    } catch (e) {
      failures.push('probe error: ' + (e.stack || e));
      console.log('[probe error]', e.stack || e);
    }
    check(errors.length === 0, 'renderer logged no errors: ' + errors.slice(0, 3).join(' | '));
    try { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ report, failures, warnings, errors }, null, 1)); } catch (e) { console.log('[report not written]', e.message); }
    console.log('[report]', JSON.stringify(report));
    if (warnings.length) console.log('[warnings]', warnings.join(' | '));
    console.log(failures.length ? 'stress-ui: FAILED\n  ' + failures.join('\n  ') : 'stress-ui: ok', '· shots in', out);
    app.exit(failures.length ? 1 : 0);
  });
});
setTimeout(() => { console.log('stress-ui: timeout'); app.exit(3); }, SOAK_MS + 240000);
require(path.join(__dirname, '..', 'dist', 'main', 'index.js'));
