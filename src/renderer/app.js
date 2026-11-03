/* global controller */
// Renderer. Plain JS, no bundler. All device I/O goes through window.controller (preload).
// Targets are a device id ("androidtv:1.2.3.4") or a room id ("room:xyz"); main routes keys per role.

// Apply the last theme before the first paint so there is no flash; settings confirm it right after.
try {
  const t = localStorage.getItem('theme'), a = localStorage.getItem('accent');
  if (t) document.documentElement.dataset.theme = t;
  if (a) document.documentElement.dataset.accent = a;
  document.documentElement.dataset.palette = localStorage.getItem('palette') || 'charcoal';
} catch { /* storage unavailable */ }

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const KIND_LABEL = { androidtv: 'Google TV', cast: 'Cast', roku: 'Roku', samsung: 'Samsung', webos: 'LG' };
const KEYS_KINDS = ['androidtv', 'samsung', 'webos', 'roku']; // kinds that can drive a UI
/** Keys a brand has no equivalent for; the buttons are hidden rather than shown dead. */
const UNSUPPORTED = { androidtv: [], samsung: ['ASSIST'], webos: ['ASSIST'], roku: ['ASSIST', 'CAPTIONS', 'GUIDE', 'SETTINGS'], cast: [] };
const CAST_ONLY_KEYS = ['VOLUME_UP', 'VOLUME_DOWN', 'MUTE', 'PLAY_PAUSE', 'STOP', 'HOME'];
const SERVICE = {
  youtube: { name: 'YouTube', color: '#C4302B' }, netflix: { name: 'Netflix', color: '#B20710' }, disney: { name: 'Disney+', color: '#0F3E8C' },
  prime: { name: 'Prime Video', color: '#0F6E8C' }, spotify: { name: 'Spotify', color: '#1A7F43' }, twitch: { name: 'Twitch', color: '#5A3E9C' },
  plex: { name: 'Plex', color: '#8A6508' }, max: { name: 'Max', color: '#2F3FA8' }, hulu: { name: 'Hulu', color: '#1F7A3E' },
  appletv: { name: 'Apple TV', color: '#3A3F4B' }, stremio: { name: 'Stremio', color: '#7B2CBF' }, web: { name: 'Link', color: '#3A3F4B' },
};
const KEYBOARD_MAP = {
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', Enter: 'SELECT', Backspace: 'BACK', Escape: 'BACK',
  h: 'HOME', H: 'HOME', ' ': 'PLAY_PAUSE', '+': 'VOLUME_UP', '=': 'VOLUME_UP', '-': 'VOLUME_DOWN', m: 'MUTE', M: 'MUTE', i: 'INFO', I: 'INFO',
  0: 'DIGIT_0', 1: 'DIGIT_1', 2: 'DIGIT_2', 3: 'DIGIT_3', 4: 'DIGIT_4', 5: 'DIGIT_5', 6: 'DIGIT_6', 7: 'DIGIT_7', 8: 'DIGIT_8', 9: 'DIGIT_9',
};
const KIND_ICON = {
  tv: '<svg class="kind" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8"/></svg>',
  box: '<svg class="kind" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="2" y="8" width="20" height="9" rx="2"/><path d="M6 12.5h.01M10 12.5h4"/></svg>',
  cast: '<svg class="kind" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M2 16a6 6 0 016 6M2 12a10 10 0 0110 10M2 8a14 14 0 0114 14"/><path d="M6 4h14a2 2 0 012 2v12a2 2 0 01-2 2h-4"/></svg>',
  room: '<svg class="kind" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M3 11l9-8 9 8M5 10v10h14V10"/></svg>',
};
const ICON_PLAY = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg>';
const ICON_SKIP_BACK = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
const ICON_SKIP_FWD = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>';
/** What the four buttons around the ring do unless the user changed them (right-click). */
const CORNER_DEFAULT = { tl: { type: 'skip', seconds: -10 }, tr: { type: 'skip', seconds: 10 }, bl: { type: 'skip', seconds: -60 }, br: { type: 'skip', seconds: 60 } };
/** [key, menu label, short label that fits a corner] */
const CORNER_KEYS = [['PLAY_PAUSE', 'Play / pause', 'Play'], ['STOP', 'Stop', 'Stop'], ['MUTE', 'Mute', 'Mute'], ['CAPTIONS', 'Subtitles', 'CC'], ['INFO', 'Info', 'Info'], ['GUIDE', 'Guide', 'Guide'], ['INPUT', 'Input', 'Input'], ['SETTINGS', 'TV settings', 'Setup'], ['SEARCH', 'Search', 'Search']];
const ICON_PAUSE = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

const S = {
  devices: [], rooms: [], states: {}, apps: {}, settings: null,
  target: null, compact: false, pairing: null, platform: 'darwin', mod: '⌘',
  appScope: 'all', searchTab: 'tv', results: [], selectedResult: 0, searchTimer: null, defaultShortcuts: { compact: '', type: '' },
  scan: null, update: null, updateDismissed: false, sleep: null, osd: null, numpad: false, adb: null, dragDepth: 0,
  activity: [], frames: {}, lastVolumeAction: 0, lastClipOffer: '', keyMode: false, settingsTab: 'general',
};
const TYPE_BAR_TEXT = 'Type on the TV or search YouTube, Netflix…';
/** Cast receiver ids / Android packages → service, to rebuild a link for what's playing. */
const MEDIA_SERVICE = { '233637DE': 'youtube', CA5E8412: 'netflix', 'com.google.android.youtube.tv': 'youtube', 'com.netflix.ninja': 'netflix', 'com.stremio.one': 'stremio', 'com.netflix.mediaclient': 'netflix' };
const LINK_HOSTS = [
  [/(^|\.)youtube\.com$|^youtu\.be$/, 'YouTube'], [/(^|\.)netflix\.com$/, 'Netflix'], [/(^|\.)disneyplus\.com$/, 'Disney+'], [/(^|\.)primevideo\.com$|(^|\.)amazon\.com$/, 'Prime Video'],
  [/(^|\.)twitch\.tv$/, 'Twitch'], [/(^|\.)spotify\.com$/, 'Spotify'], [/(^|\.)plex\.tv$/, 'Plex'], [/(^|\.)max\.com$/, 'Max'], [/(^|\.)hulu\.com$/, 'Hulu'], [/^tv\.apple\.com$/, 'Apple TV'],
];

/* ---------------- helpers ---------------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(s) {
  if (!Number.isFinite(s)) return '0:00';
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
}
function timeAgo(t) {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + ' min ago';
  if (d < 86400) return Math.floor(d / 3600) + ' h ago';
  if (d < 7 * 86400) return Math.floor(d / 86400) + ' d ago';
  return new Date(t).toLocaleDateString();
}
function basename(p) { return String(p).split(/[\\/]/).pop(); }
/** Compact relative time for the feed: "now", "12s", "3m", "2h", then a clock time. */
function relTime(t) {
  const d = (Date.now() - t) / 1000;
  if (d < 5) return 'now';
  if (d < 60) return Math.floor(d) + 's';
  if (d < 3600) return Math.floor(d / 60) + 'm';
  if (d < 86400) return Math.floor(d / 3600) + 'h';
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function clockTime(t) { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
/** Which streaming service a URL belongs to, by host, or null. */
function linkService(url) {
  try { const h = new URL(url).hostname.replace(/^www\.|^m\.|^open\./, ''); const hit = LINK_HOSTS.find(([re]) => re.test(h)); return hit ? hit[1] : null; } catch { return null; }
}
/** A link that reopens what's playing, when the service is one we can rebuild it for. */
function mediaLink(m) {
  if (!m?.contentId) return null;
  if (/^https?:/.test(m.contentId)) return m.contentId;
  const svc = MEDIA_SERVICE[m.appId];
  if (svc === 'youtube') return `https://www.youtube.com/watch?v=${encodeURIComponent(m.contentId)}`;
  if (svc === 'netflix' && /^\d+$/.test(m.contentId)) return `https://www.netflix.com/watch/${m.contentId}`;
  return null;
}
/** The richest report of what's playing wins (title + duration + artwork), like main's roomState. */

function toast(msg, kind) {
  // The same message again while it is still up just keeps it up (a burst of errors is one toast, not ten).
  const dup = $$('#toasts .toast:not(.leaving):not(.osd):not(.action)').find((t) => t.textContent === msg);
  if (dup) { clearTimeout(dup._timer); dup._timer = setTimeout(() => { dup.classList.add('leaving'); setTimeout(() => dup.remove(), 250); }, kind === 'error' ? 4500 : 2200); return; }
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  el._timer = setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 250); }, kind === 'error' ? 4500 : 2200);
  // never more than three stacked
  const live = $$('#toasts .toast:not(.leaving):not(.osd):not(.action)');
  if (live.length > 3) live.slice(0, live.length - 3).forEach((t) => { clearTimeout(t._timer); t.remove(); });
}
/** Electron wraps errors thrown in main as "Error invoking remote method 'x': Error: …"; show only the message. */
function errText(err) { return String(err?.message || err || '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
function showErr(err) { if (err) toast(errText(err), 'error'); }
/** A toast with one action button; stays until clicked, dismissed, or `ms` elapse. */
function toastAction(msg, label, fn, ms = 9000) {
  const el = document.createElement('div');
  el.className = 'toast action';
  el.innerHTML = '<span class="grow"></span><button class="small primary"></button><button class="icon-btn" aria-label="Dismiss">✕</button>';
  el.querySelector('.grow').textContent = msg;
  const b = el.querySelector('button.small');
  b.textContent = label;
  const close = () => { if (!el.isConnected) return; el.classList.add('leaving'); setTimeout(() => el.remove(), 250); };
  b.onclick = () => { close(); fn(); };
  el.querySelector('.icon-btn').onclick = close;
  $('#toasts').appendChild(el);
  setTimeout(close, ms);
  return el;
}
function openSheet(id) {
  const overlay = $(id);
  if (overlay.classList.contains('hidden')) overlay.returnFocus = document.activeElement;
  overlay.classList.remove('hidden');
  const dialog = overlay.querySelector('[role="dialog"]');
  if (dialog) {
    dialog.setAttribute('aria-modal', 'true');
    dialog.querySelector('button:not(:disabled), input:not(:disabled), select:not(:disabled)')?.focus();
  }
}
function closeSheets() {
  let focus;
  $$('.overlay').forEach((o) => { if (!o.classList.contains('hidden')) focus = o.returnFocus; o.classList.add('hidden'); });
  if (focus?.isConnected && focus.getClientRects().length) focus.focus();
}
function anySheetOpen() { return $$('.overlay').some((o) => !o.classList.contains('hidden')); }
function isUrl(s) { return /^https?:\/\/\S+$/i.test((s || '').trim()); }
const MEDIA_EXT = /\.(mp4|m4v|webm|mkv|mov|mp3|m4a|aac|flac|wav|ogg|m3u8|mpd|jpg|jpeg|png|gif|webp)$/i;
/** A direct media file / stream URL: Cast devices can play these without any app. */
function isMediaUrl(s) { try { return isUrl(s) && MEDIA_EXT.test(new URL(s.trim()).pathname); } catch { return false; } }
function mediaKind(s) { try { const p = new URL(s).pathname; return /\.(mp3|m4a|aac|flac|wav|ogg)$/i.test(p) ? 'audio' : /\.(jpg|jpeg|png|gif|webp)$/i.test(p) ? 'picture' : 'video'; } catch { return 'video'; } }
function castCapable() { const r = resolve(S.target); return !!r && r.all.some((id) => device(id)?.kind === 'cast' && S.states[id]?.state === 'connected'); }
/** Images that fail to load are removed so the tile initials or placeholder behind them show. */
function imgFallback(root) {
  root.querySelectorAll('img').forEach((img) => img.addEventListener('error', () => {
    const tile = img.closest('.tile, .art-mini');
    img.remove();
    if (tile && tile.dataset.initials) tile.textContent = tile.dataset.initials;
    const card = root.closest?.('.cw') || (root.classList?.contains('cw') ? root : null);
    if (card) {
      const thumb = card.querySelector('.thumb'), info = card.querySelector('.info');
      if (thumb && info) {
        const badge = thumb.querySelector('.svc'), bar = thumb.querySelector('.bar');
        if (badge) info.prepend(badge);
        if (bar) info.append(bar);
        thumb.remove(); card.classList.add('text');
      }
    }
  }, { once: true }));
}
function flash(key) {
  const b = $(`.remote button[data-key="${key}"]`);
  if (!b) return;
  b.classList.add('pressed');
  setTimeout(() => b.classList.remove('pressed'), 140);
}
function resolve(target) {
  if (!target) return null;
  if (target.startsWith('room:')) {
    const room = S.rooms.find((r) => 'room:' + r.id === target);
    if (!room) return null;
    const audio = room.audio || room.primary;
    return { room, primary: room.primary, audio, all: [...new Set([room.primary, audio, ...(room.power || []), ...(room.companions || [])])] };
  }
  return { primary: target, audio: target, all: [target] };
}
function device(id) { return S.devices.find((d) => d.id === id); }
function displayName(d) { return (S.settings?.deviceNames && S.settings.deviceNames[d.id]) || d.name; }
/** Short name for a device's physical box: the sidebar group name without Samsung's "[TV] " prefix. */
function shortName(d) { return displayName(d).replace(/^\[TV\]\s*/i, ''); }
/** Name of the physical box a device belongs to (several protocols share one host). */
function hostName(id) {
  const d = device(id);
  if (!d) return id;
  const g = groupsByHost().find((x) => x.host === d.host);
  return (g ? g.name : displayName(d)).replace(/^\[TV\]\s*/i, '');
}
function targetName(target) {
  const r = resolve(target);
  if (!r) return '';
  if (r.room) return r.room.name;
  const d = device(target);
  return d ? displayName(d) : target;
}
function primaryKind() { const r = resolve(S.target); return r ? device(r.primary)?.kind : undefined; }
function hasAndroid() { const r = resolve(S.target); return !!r && r.all.some((id) => device(id)?.kind === 'androidtv'); }
/** Merged state for the active target. */
function activeState() {
  const r = resolve(S.target);
  if (!r) return null;
  const p = S.states[r.primary] || { state: 'disconnected' };
  const a = S.states[r.audio] || {};
  const media = TVMedia.selectMedia(r.all.map((id) => S.states[id]));
  const anyConnected = r.all.some((id) => S.states[id]?.state === 'connected');
  const anyPairing = r.all.some((id) => S.states[id]?.state === 'pairing');
  const anyConnecting = r.all.some((id) => S.states[id]?.state === 'connecting');
  const android = r.all.map((id) => S.states[id]).find((s) => s?.kind === 'androidtv');
  const channel = r.all.map((id) => S.states[id]?.channel).find(Boolean);
  return { ...p, state: anyPairing ? 'pairing' : anyConnected ? 'connected' : anyConnecting ? 'connecting' : p.state, volume: a.volume || p.volume, media, playbackError: android?.playbackError, screenError: android?.screenError, liveView: android?.liveView, liveId: android?.id, channel };
}
const SYSTEM_LIGHT = window.matchMedia('(prefers-color-scheme: light)');
function applyTheme() {
  const theme = S.settings?.theme || 'dark';
  const resolved = theme === 'system' ? (SYSTEM_LIGHT.matches ? 'light' : 'dark') : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.palette = S.settings?.palette || 'charcoal';
  try { localStorage.setItem('palette', S.settings?.palette || 'charcoal'); } catch { /* ignore */ }
  document.documentElement.dataset.accent = S.settings?.accent || 'neutral';
  for (const key of ['theme', 'accent']) {
    $$('#set-' + key + ' button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[key] === (S.settings?.[key] || (key === 'theme' ? 'dark' : 'neutral')))));
  }
  try { localStorage.setItem('theme', resolved); localStorage.setItem('accent', S.settings?.accent || 'neutral'); } catch { /* ignore */ }
}
SYSTEM_LIGHT.addEventListener('change', applyTheme);
/** Small modal text prompt. Resolves with the value, or null when cancelled. */
function promptSheet(title, value, placeholder) {
  return new Promise((resolve) => {
    $('#prompt-title').textContent = title;
    const input = $('#prompt-input');
    input.value = value || '';
    input.placeholder = placeholder || '';
    let done = false;
    const finish = (v) => { if (done) return; done = true; closeSheets(); resolve(v); };
    $('#prompt-ok').onclick = () => finish(input.value.trim() || null);
    input.onkeydown = (e) => { if (e.key === 'Enter') finish(input.value.trim() || null); if (e.key === 'Escape') finish(null); };
    $('#sheet-prompt').querySelector('[data-close]').onclick = () => finish(null);
    openSheet('#sheet-prompt');
    input.focus(); input.select();
  });
}
/** Popup menu at the pointer, or hanging under `anchor` (a button) when given. */
function contextMenu(e, items, anchor) {
  $$('.ctx').forEach((c) => c.remove());
  const menu = document.createElement('div');
  menu.className = 'ctx';
  for (const it of items) {
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.danger) b.classList.add('danger');
    b.onclick = () => { menu.remove(); it.run(); };
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  let x = e.clientX, y = e.clientY;
  if (anchor) { const r = anchor.getBoundingClientRect(); x = r.left; y = r.bottom + 6; }
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }));
}

/* ---------------- devices ---------------- */

function groupsByHost() {
  const byHost = new Map();
  for (const d of S.devices) {
    if (!byHost.has(d.host)) byHost.set(d.host, { host: d.host, name: displayName(d), model: d.model, entries: [] });
    const g = byHost.get(d.host);
    g.entries.push(d);
    if (KEYS_KINDS.includes(d.kind) && d.name) g.name = displayName(d);
    if (S.settings?.deviceNames?.[d.id]) g.name = S.settings.deviceNames[d.id];
    if (d.model && !g.model) g.model = d.model;
  }
  return [...byHost.values()];
}
function groupIcon(g) {
  const kinds = g.entries.map((e) => e.kind);
  if (kinds.includes('samsung') || kinds.includes('webos') || /\btv\b/i.test(g.model || '')) return KIND_ICON.tv;
  if (kinds.includes('androidtv') || kinds.includes('roku')) return KIND_ICON.box;
  return KIND_ICON.cast;
}
function isStale(g) {
  const seen = Math.max(...g.entries.map((e) => e.lastSeen || 0));
  return seen > 0 ? Date.now() - seen > 10 * 60 * 1000 : true;
}
/** Target id for a host group: a saved room containing it, else an auto room when it has several protocols, else the device. */
function targetForGroup(g) {
  const ids = g.entries.map((e) => e.id);
  const saved = S.rooms.find((r) => ids.includes(r.primary) && !r.id.startsWith('auto-'));
  if (saved) return 'room:' + saved.id;
  if (g.entries.length === 1) return g.entries[0].id;
  const primary = g.entries.find((e) => KEYS_KINDS.includes(e.kind)) || g.entries[0];
  const auto = { id: 'auto-' + g.host.replace(/[^0-9a-zA-Z]/g, '-'), name: g.name, primary: primary.id, companions: ids.filter((i) => i !== primary.id) };
  const existing = S.rooms.find((r) => r.id === auto.id);
  if (!existing || existing.companions?.length !== auto.companions.length) {
    S.rooms = [...S.rooms.filter((r) => r.id !== auto.id), auto];
    controller.rooms.save(auto).catch(() => undefined);
  }
  return 'room:' + auto.id;
}
function inSavedRoom(e, rooms) { return rooms.some((r) => [r.primary, r.audio, ...(r.companions || [])].includes(e.id)); }
const TV_KINDS = ['samsung', 'webos'];
/** A streaming box and a TV that aren't in a saved room yet: the pair worth suggesting. */
function linkSuggestion() {
  const rooms = S.rooms.filter((r) => !r.id.startsWith('auto-'));
  const boxes = S.devices.filter((d) => d.kind === 'androidtv' && !inSavedRoom(d, rooms));
  const tvs = S.devices.filter((d) => TV_KINDS.includes(d.kind) && !inSavedRoom(d, rooms));
  if (!boxes.length || !tvs.length) return null;
  const box = boxes[0], tv = tvs[0];
  const key = box.id + '+' + tv.id;
  if ((S.settings?.dismissedLinkHints || []).includes(key)) return null;
  return { box, tv, key };
}
/** Create (or update) the room that makes `audioId` the volume/power device for `primaryId`. */
async function linkDevices(primaryId, audioId, name) {
  const primary = device(primaryId), audio = device(audioId);
  const existing = S.rooms.find((r) => !r.id.startsWith('auto-') && r.primary === primaryId);
  const id = existing ? existing.id : 'r' + Date.now().toString(36);
  const companions = S.devices.filter((d) => d.host === primary?.host && d.id !== primaryId && d.id !== audioId).map((d) => d.id);
  const roomName = name || existing?.name || (audio ? displayName(audio).replace(/^\[TV\]\s*/i, '') : displayName(primary)) || 'Living room';
  const saved = await controller.rooms.save({ id, name: roomName, primary: primaryId, audio: audioId || undefined, power: [primaryId, audioId].filter(Boolean), companions });
  S.rooms = await controller.rooms.list();
  await open('room:' + saved.id);
  toast(audio ? `Volume and power now go to ${displayName(audio)}` : 'Room saved');
}
function renderLinkHint() {
  const el = $('#link-hint');
  const s = linkSuggestion();
  if (!s) return el.classList.add('hidden');
  el.classList.remove('hidden');
  el.innerHTML = `<div>Is <strong>${esc(displayName(s.box))}</strong> plugged into <strong>${esc(displayName(s.tv))}</strong>? Link them: volume and power go to the TV, everything else to the box.</div>
    <div class="row"><button class="small primary" id="link-yes">Link</button><button class="small ghost" id="link-no">Not now</button></div>`;
  $('#link-yes').onclick = () => linkDevices(s.box.id, s.tv.id);
  $('#link-no').onclick = () => saveSettings({ dismissedLinkHints: [...(S.settings.dismissedLinkHints || []), s.key] }).then(renderLinkHint);
}

/** One line of what a set of devices is doing right now, for the sidebar: "Netflix · playing", "Standby", "Live TV · BBC One". */
function liveLine(ids) {
  const states = ids.map((id) => S.states[id]).filter(Boolean);
  if (!states.some((s) => s.state === 'connected')) return '';
  if (states.some((s) => s.powered === false) && !states.some((s) => s.media?.playerState === 'PLAYING')) return 'Standby';
  const media = TVMedia.selectMedia(states);
  const app = (media?.appId && (appById(media.appId) || SERVICE[MEDIA_SERVICE[media.appId]])) || states.map((s) => s.currentApp).find((a) => a && (a.name || a.id));
  const ch = states.map((s) => s.channel).find(Boolean);
  const parts = [];
  if (app) parts.push(app.name || app.id);
  if (ch && (ch.name || ch.number)) parts.push([ch.number, ch.name].filter(Boolean).join(' '));
  if (media?.playerState === 'PLAYING') parts.push(media.title ? 'playing ' + media.title : 'playing');
  else if (media?.playerState === 'PAUSED') parts.push('paused');
  return parts.join(' · ');
}

function renderDevices() {
  const list = $('#device-list');
  list.innerHTML = '';
  const rooms = S.rooms.filter((r) => !r.id.startsWith('auto-'));
  for (const room of rooms) {
    const li = document.createElement('li');
    li.className = 'device' + ('room:' + room.id === S.target ? ' active' : '');
    const members = [room.primary, room.audio, ...(room.companions || [])].filter(Boolean).map((id) => device(id)).filter(Boolean);
    const connected = members.some((m) => S.states[m.id]?.state === 'connected');
    const main = [room.primary, room.audio].filter(Boolean).map((id) => device(id)).filter(Boolean);
    const live = liveLine(members.map((m) => m.id));
    li.innerHTML = `<span class="dot ${connected ? 'ok' : ''}"></span>${KIND_ICON.room}<div class="meta"><strong>${esc(room.name)}</strong><small>${esc(live || [...new Set(main.map((m) => KIND_LABEL[m.kind]))].join(' + ') || 'Room')}</small></div>`;
    li.onclick = () => open('room:' + room.id);
    li.oncontextmenu = (e) => { e.preventDefault(); contextMenu(e, [
      { label: 'Edit room…', run: () => openRoomEditor(room) },
      ...(members.some((m) => m.kind === 'androidtv') ? [{ label: 'Install apps (ADB)…', run: () => { S.target = 'room:' + room.id; openDevSheet(); } }] : []),
      { label: 'Disconnect', run: () => controller.device.disconnect('room:' + room.id) },
    ]); };
    list.appendChild(li);
  }
  for (const g of groupsByHost()) {
    if (g.entries.some((e) => inSavedRoom(e, rooms))) continue;
    const target = targetForGroup(g);
    const li = document.createElement('li');
    const st = g.entries.map((e) => S.states[e.id]?.state);
    const cls = st.includes('connected') ? 'ok' : st.includes('connecting') || st.includes('pairing') ? 'busy' : st.includes('error') ? 'err' : '';
    const stale = !st.includes('connected') && isStale(g);
    li.className = 'device' + (target === S.target ? ' active' : '') + (stale ? ' stale' : '');
    li.title = `${g.host}${g.model ? ' · ' + g.model : ''}${stale ? ' · not seen recently' : ''}`;
    const kinds = [...new Set(g.entries.map((e) => KIND_LABEL[e.kind]))].join(' + ');
    const unpaired = g.entries.some((e) => e.pairing !== 'none' && !e.paired);
    const live = !unpaired && !stale && liveLine(g.entries.map((e) => e.id));
    li.innerHTML = `<span class="dot ${cls}"></span>${groupIcon(g)}<div class="meta"><strong>${esc(g.name)}</strong><small>${esc(live || kinds)}${unpaired ? ' · not paired' : ''}${stale ? ' · not seen' : ''}</small></div>`;
    li.onclick = () => open(target);
    li.oncontextmenu = (e) => { e.preventDefault(); contextMenu(e, [
      { label: 'Link into a room…', run: () => openRoomEditor({ primary: g.entries.find((x) => KEYS_KINDS.includes(x.kind))?.id || g.entries[0].id }) },
      { label: 'Rename…', run: async () => {
        const name = await promptSheet('Rename device', g.name, 'Living room TV');
        if (name === null) return;
        const names = { ...(S.settings.deviceNames || {}) };
        for (const e of g.entries) names[e.id] = name;
        await saveSettings({ deviceNames: names });
        renderDevices(); renderHeader();
      } },
      ...(g.entries.some((x) => x.kind === 'androidtv') ? [{ label: 'Install apps (ADB)…', run: () => { S.target = target; openDevSheet(); } }] : []),
      { label: 'Disconnect', run: () => controller.device.disconnect(target) },
      ...g.entries.filter((x) => x.pairing !== 'none').map((x) => ({ label: `Forget ${KIND_LABEL[x.kind]} pairing`, run: () => controller.device.forget(x.id).then(() => toast('Pairing forgotten')) })),
      { label: 'Remove from list', danger: true, run: () => Promise.all(g.entries.map((x) => controller.discovery.forget(x.id))) },
    ]); };
    list.appendChild(li);
  }
  if (!list.children.length && !S.scan) list.innerHTML = '<li class="empty-list">Looking for TVs…</li>';
  list.querySelectorAll('.device').forEach((item) => {
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', [...item.querySelectorAll('strong, small')].map((part) => part.textContent.trim()).join(', '));
    if (item.classList.contains('active')) item.setAttribute('aria-current', 'true');
    item.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); } };
  });
  list.classList.toggle('many', list.children.length > 3);
  renderLinkHint();
  // Once TVs are on the list the discovery controls fold into the ⋯ menu; the activity feed gets the room.
  const found = S.devices.length > 0 && !S.scan?.blocked;
  $('#discovery-tools').classList.toggle('folded', found && !S.toolsOpen);
  $('#btn-devtools').classList.toggle('hidden', !found);
}

/* ---------------- open / connect ---------------- */

async function open(target) {
  S.target = target;
  renderDevices();
  renderHeader();
  $('#empty-state').classList.add('hidden');
  for (const id of ['#now-card', '#apps-section']) $(id).classList.remove('hidden');
  renderContinue();
  renderActivity();
  controller.settings.set({ lastTarget: target }).then((s) => (S.settings = s));
  try {
    await controller.device.connect(target);
  } catch (err) {
    showErr(err);
  }
  renderAll();
  loadApps(false);
}

/* ---------------- rendering ---------------- */

function renderHeader() {
  document.body.classList.toggle('has-target', !!S.target);
  const st = activeState();
  const r = resolve(S.target);
  $('#picker-name').textContent = S.target ? targetName(S.target) : 'Choose a device';
  const parts = [];
  if (r) {
    if (st?.powered === false) parts.push('Standby');
    if (st?.currentApp?.name || st?.currentApp?.id) parts.push(st.currentApp.name || st.currentApp.id);
    else if (st?.state === 'connected' && st?.powered !== false) parts.push('Connected');
    else if (st?.state === 'connecting') parts.push('Connecting…');
    else if (st?.state === 'pairing') parts.push('Pairing…');
    if (st?.media?.playerState === 'PLAYING') parts.push('playing');
    else if (st?.media?.playerState === 'PAUSED') parts.push('paused');
  }
  $('#picker-sub').textContent = parts.join(' · ');
  const playingTitle = st?.media?.playerState === 'PLAYING' && st.media.title;
  document.title = playingTitle ? `${playingTitle} · ${targetName(S.target)}` : S.target ? `${targetName(S.target)} · TV Controller` : 'TV Controller';
  $('#status-dot').className = 'dot ' + ({ connected: 'ok', connecting: 'busy', pairing: 'busy', error: 'err' }[st?.state] || '');
  if (r) {
    const parts = r.all.map((id) => ({ k: KIND_LABEL[device(id)?.kind] || id, s: S.states[id]?.state || 'idle' }));
    const allOn = parts.every((p) => p.s === 'connected');
    $('#sidebar-status').textContent = allOn ? `Connected · ${parts.map((p) => p.k).join(', ')}` : parts.map((p) => `${p.k} ${p.s === 'connected' ? 'connected' : p.s === 'connecting' ? 'connecting…' : p.s === 'pairing' ? 'pairing…' : p.s === 'error' ? 'error' : 'off'}`).join(' · ');
  } else $('#sidebar-status').textContent = '';
}

function appById(id) {
  for (const list of Object.values(S.apps)) { const a = list.find((x) => x.id === id); if (a) return a; }
  return null;
}
/** The state pill on the now card: what the TV is doing in one word. */
function statePill(st, m) {
  if (!st || st.state !== 'connected') return null;
  if (st.powered === false) return ['Standby', ''];
  if (m?.playerState === 'PLAYING') return ['Playing', 'playing'];
  if (m?.playerState === 'PAUSED') return ['Paused', ''];
  if (m?.playerState === 'BUFFERING') return ['Loading', ''];
  if (st.channel?.name || st.channel?.number) return ['Live TV', ''];
  if (st.imeOpen) return ['Typing', ''];
  if (st.currentApp) return ['Open', ''];
  return ['Home', ''];
}
function renderNow() {
  const st = activeState();
  const m = st?.media;
  const r = resolve(S.target);
  const mediaService = SERVICE[MEDIA_SERVICE[m?.appId]];
  const app = (m?.appId && appById(m.appId)) || (mediaService ? { ...mediaService, initials: mediaService.name.slice(0, 2) } : null)
    || (st?.currentApp && ((S.apps[S.target] || []).find((a) => a.id === st.currentApp.id) || appById(st.currentApp.id)));
  const mediaColor = app?.color || SERVICE[MEDIA_SERVICE[m?.appId]]?.color || 'var(--muted)';
  $('#now-card').style.setProperty('--media-color', mediaColor);
  $('#compact-now').style.setProperty('--media-color', mediaColor);
  renderCompactNow(st, app);
  const playingApp = app?.name || st?.currentApp?.name || st?.currentApp?.id;
  const label = playingApp ? 'Now on TV · ' + playingApp : 'Now on TV';
  $('#now-label').textContent = label;
  const pill = statePill(st, m);
  $('#now-state').classList.toggle('hidden', !pill);
  if (pill) { $('#now-state').textContent = pill[0]; $('#now-state').className = 'state-pill ' + pill[1]; }
  const android = hasAndroid();
  const liveBtn = $('#now-live');
  liveBtn.classList.toggle('hidden', !android || !st || st.state !== 'connected');
  const liveOn = !!(st?.liveView && (st.liveView.media || st.liveView.screen));
  liveBtn.setAttribute('aria-pressed', String(!!st?.liveView?.screen));
  liveBtn.textContent = st?.liveView?.screen ? 'Live screen · on' : st?.screenError ? 'Retry screen' : 'Live screen';
  liveBtn.title = st?.screenError ? 'Screen preview stopped. Playback reporting is still on. Click to retry the screen.' : 'Show the TV screen. Playback details keep updating when the screen preview is off.';
  const frame = st?.liveView?.screen && S.frames[st.liveId];
  $('#now-card').classList.toggle('live', !!frame);
  $('#now-more').disabled = !S.target;
  $('#now-ends').classList.add('hidden');
  const link = mediaLink(m);
  $('#now-open').classList.toggle('hidden', !link || !m?.playerState);
  const art = $('#now-art');
  // Re-render the art only when what it shows changes; live frames swap their src in place (see onScreen).
  const setArt = (html, key = html) => { if (art.dataset.key !== key) { art.dataset.key = key; art.innerHTML = html; imgFallback(art); } };
  if (frame === 'blank') setArt(`<div class="frame-blank">${app ? tileHtml(app, 'div') : ''}<span>Protected video · the TV hides it from screenshots</span></div><span class="live-badge">LIVE</span>`, 'blank:' + (app?.id || ''));
  else if (frame) setArt(`<img class="frame" src="${esc(frame)}" alt="What the TV shows"><span class="live-badge">LIVE</span>`, 'frame');
  const idle = !m || !m.playerState;
  $('.progress-row').classList.toggle('hidden', idle);
  // transport only when there is something to transport
  $('.now-actions').classList.toggle('hidden', idle);
  if (idle) {
    const ch = st?.channel;
    $('#now-title').textContent = ch && (ch.name || ch.number) ? [ch.number, ch.name].filter(Boolean).join(' · ') : st?.currentApp ? `${st.currentApp.name || st.currentApp.id} is open` : st?.powered === false ? 'TV is in standby' : st?.state === 'connected' ? 'Nothing playing' : st?.state === 'connecting' ? 'Connecting…' : st?.state === 'pairing' ? 'Pairing…' : 'Not connected';
    const sub = $('#now-sub');
    if (st?.playbackError && android && st.state === 'connected') { sub.innerHTML = 'Playback reporting interrupted · <button class="link" id="now-playback-retry">Reconnect playback</button>'; $('#now-playback-retry').onclick = () => setLive({ media: true, screen: false }); }
    else if (ch?.program) sub.textContent = ch.program;
    else if (st?.imeOpen) sub.textContent = 'The TV keyboard is open' + (st.imeField?.label ? ' · ' + st.imeField.label : '');
    else if (st?.currentApp && android && !liveOn && !S.adb?.available) { sub.innerHTML = 'Playback details for this app need ADB · <button class="link" id="now-adb">Set it up</button>'; $('#now-adb').onclick = () => openDevSheet(); }
    else if (st?.currentApp && android && !liveOn) { sub.innerHTML = 'Nothing reported yet · <button class="link" id="now-adb">Read playback over ADB</button>'; $('#now-adb').onclick = () => setLive({ media: true, screen: false }); }
    else sub.textContent = st?.currentApp ? 'Nothing playing yet' : '';
    if (!frame) setArt(app ? tileHtml(app, 'div') : '');
    $('#now-bar').style.width = '0';
    $('#now-pos').textContent = '0:00';
    $('#now-dur').textContent = '0:00';
    $$('#now-card .now-actions button.sq').forEach((b) => (b.disabled = !st || st.state !== 'connected' || st.powered === false));
    $('#now-title').title = $('#now-title').textContent;
    $('#now-sub').title = $('#now-sub').textContent;
    return;
  }
  $('#now-title').textContent = m.title || st.currentApp?.name || 'Playing';
  $('#now-title').title = $('#now-title').textContent;
  const via = r?.all.map((id) => S.states[id]).find((s) => s?.media === m);
  const viaLabel = m.source === 'adb' ? 'via ADB' : via ? 'via ' + KIND_LABEL[via.kind] : '';
  $('#now-sub').textContent = m.subtitle || '';
  $('#now-sub').title = [m.subtitle, viaLabel].filter(Boolean).join(' · ');
  if (!frame) setArt(m.artwork ? `<img src="${esc(m.artwork)}" alt="">` : app ? tileHtml(app, 'div') : '');
  $('#now-toggle').innerHTML = m.playerState === 'PLAYING' ? ICON_PAUSE : ICON_PLAY;
  $('#now-toggle').setAttribute('aria-label', m.playerState === 'PLAYING' ? 'Pause' : 'Play');
  $$('#now-card .now-actions button.sq').forEach((b) => (b.disabled = false));
  tickProgress();
}

/* ---------------- corner buttons around the ring ---------------- */

function fmtSkip(s) { return s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`; }
function cornerAction(pos) { return (S.settings?.corners && S.settings.corners[pos]) || CORNER_DEFAULT[pos]; }
function cornerDescribe(a) {
  if (a.type === 'skip') return `${a.seconds < 0 ? 'Back' : 'Forward'} ${Math.abs(a.seconds) >= 60 ? Math.round(Math.abs(a.seconds) / 60) + ' min' : Math.abs(a.seconds) + ' s'}`;
  if (a.type === 'key') return CORNER_KEYS.find((k) => k[0] === a.key)?.[1] || a.key;
  return `Open ${a.name}`;
}
function renderCorners() {
  for (const pos of ['tl', 'tr', 'bl', 'br']) {
    const b = $(`.remote .corner.${pos}`);
    const a = cornerAction(pos);
    const right = pos === 'tr' || pos === 'br';
    let icon = '', text = '';
    if (a.type === 'skip') { icon = a.seconds < 0 ? ICON_SKIP_BACK : ICON_SKIP_FWD; text = fmtSkip(Math.abs(a.seconds)); }
    else if (a.type === 'key') { text = CORNER_KEYS.find((k) => k[0] === a.key)?.[2] || a.key; }
    else { const app = appById(a.id); icon = `<span class="mini" style="background:${esc(app?.color || '#3A3F4B')}">${app?.icon ? `<img src="${esc(app.icon)}" alt="">` : esc(app?.initials || a.name.slice(0, 2))}</span>`; }
    // an app is its tile alone (the name is in the tooltip): the corner's safe area is only ~50 px wide
    b.innerHTML = text ? (right ? `<span>${esc(text)}</span>${icon}` : `${icon}<span>${esc(text)}</span>`) : icon;
    b.title = `${cornerDescribe(a)} · right-click to change`;
    b.setAttribute('aria-label', cornerDescribe(a));
  }
}
function runCorner(pos) {
  if (!S.target) return;
  const a = cornerAction(pos);
  if (a.type === 'skip') controller.device.skip(S.target, a.seconds).catch(showErr);
  else if (a.type === 'key') sendKey(a.key);
  else launch(a.id);
}
function cornerMenu(e, pos) {
  const set = (action) => saveSettings({ corners: { ...(S.settings.corners || {}), [pos]: action } }).then(renderCorners);
  const cur = JSON.stringify(cornerAction(pos));
  const mark = (a, label) => ({ label: (JSON.stringify(a) === cur ? '✓ ' : '') + label, run: () => set(a) });
  const items = [];
  for (const s of [10, 30, 60, 300]) items.push(mark({ type: 'skip', seconds: -s }, `Back ${fmtSkip(s)}`), mark({ type: 'skip', seconds: s }, `Forward ${fmtSkip(s)}`));
  for (const [key, label] of CORNER_KEYS) if (!(UNSUPPORTED[primaryKind()] || []).includes(key)) items.push(mark({ type: 'key', key }, label));
  const pinned = ((S.settings?.pinnedApps || {})[S.target] || []).map((id) => appById(id)).filter(Boolean).slice(0, 6);
  for (const app of pinned) items.push(mark({ type: 'app', id: app.id, name: app.name }, `Open ${app.name}`));
  if (S.settings?.corners?.[pos]) items.push({ label: 'Reset to default', run: () => { const c = { ...S.settings.corners }; delete c[pos]; saveSettings({ corners: c }).then(renderCorners); } });
  contextMenu(e, items);
}

/* ---------------- keyboard mode ---------------- */

/** Every key goes to the TV: arrows, Enter, Backspace and plain typing, until Esc. */
function setKeyMode(on) {
  if (on && (!S.target || activeState()?.state !== 'connected')) return toast('Connect to a TV first', 'error');
  S.keyMode = on;
  document.body.classList.toggle('keymode', on);
  $('#type-bar span').textContent = on ? 'Keyboard mode · every key goes to the TV · Esc to leave' : TYPE_BAR_TEXT;
  const b = $('#btn-keymode');
  b.setAttribute('aria-pressed', String(on));
  b.textContent = on ? 'Keyboard mode on · Esc to leave' : 'Keyboard mode';
  if (on) { closeSheets(); if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); }
}
/** In keyboard mode: handle one keydown; returns true when it was consumed. */
function keyModeKey(e) {
  if (!S.keyMode || anySheetOpen()) return false;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return false;
  if (e.key === 'Escape') { e.preventDefault(); setKeyMode(false); return true; }
  if (e.metaKey || e.ctrlKey || e.altKey) return false; // app shortcuts still work
  const nav = { ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', Enter: 'SELECT' }[e.key];
  e.preventDefault();
  if (nav) { sendKey(nav); return true; }
  if (e.key === 'Backspace') { controller.device.backspace(S.target).catch(showErr); flash('BACK'); return true; }
  if (e.key.length === 1) { controller.device.sendChar(S.target, e.key).catch(showErr); return true; }
  return true;
}

/* ---------------- activity feed ---------------- */

function renderActivity() {
  const sec = $('#live-section');
  const r = resolve(S.target);
  if (!r || !S.settings?.showActivity) return sec.classList.add('hidden');
  sec.classList.remove('hidden');
  const events = S.activity.filter((e) => r.all.includes(e.device));
  const shown = events.slice(-60).reverse();
  const hosts = new Set(r.all.map((id) => device(id)?.host).filter(Boolean));
  const multi = hosts.size > 1; // a room spanning two boxes: say which one spoke
  const list = $('#activity-list');
  const seen = Number(list.dataset.seen || 0); // rows newer than the last render slide in; the rest stay put
  list.innerHTML = shown.map((e, i) => activityRow(e, multi, e.id > seen && seen > 0, shown[i - 1]?.device)).join('') ||
    `<li class="empty-feed">${activeState()?.state === 'connected' ? 'What the TV reports shows up here: apps opening, playback, volume, its keyboard.' : 'Connect to see what the TV reports.'}</li>`;
  list.dataset.seen = String(Math.max(seen, ...events.map((e) => e.id), 0));
  $$('#activity-list .act').forEach((li, i) => {
    const e = shown[i];
    li.oncontextmenu = (ev) => { ev.preventDefault(); contextMenu(ev, [
      { label: 'Copy line', run: () => navigator.clipboard.writeText(`${clockTime(e.at)} ${e.text}${e.detail ? ' · ' + e.detail : ''}`) },
      ...(e.app && appById(e.app) ? [{ label: `Open ${appById(e.app).name}`, run: () => launch(e.app) }] : []),
      ...(e.detail && /^https?:/.test(e.detail) ? [{ label: 'Copy link', run: () => navigator.clipboard.writeText(e.detail) }] : []),
    ]); };
  });
  $('#live-sub').classList.toggle('hidden', activeState()?.state !== 'connected');
}
/** The chip that says which box spoke: never the main device, "TV" for the room's audio device, else a short name. */
function activityWho(e) {
  const r = resolve(S.target);
  if (!r) return '';
  const d = device(e.device);
  const primary = device(r.primary);
  if (!d || !primary || d.host === primary.host) return '';
  if (r.audio && device(r.audio)?.host === d.host) return 'TV';
  const n = shortName(d);
  return n.length > 16 ? n.slice(0, 15) + '…' : n;
}
function activityRow(e, multi, isNew, prevDevice) {
  const app = e.app && appById(e.app);
  const chip = multi ? activityWho(e) : '';
  const who = chip && prevDevice !== e.device ? `<span class="who">${esc(chip)}</span>` : '';
  const icon = app?.icon ? `<img class="ai" src="${esc(app.icon)}" alt="">` : '';
  return `<li class="act ${e.dir} kind-${esc(e.kind)}${isNew ? ' new' : ''}" data-at="${e.at}" title="${esc(clockTime(e.at))}"><span class="t">${esc(relTime(e.at))}</span><span class="d"></span><span class="b">${who}${icon}<strong>${esc(e.text)}</strong>${e.detail ? `<span class="dt">${esc(e.detail)}</span>` : ''}</span></li>`;
}
function tickActivityTimes() {
  $$('#activity-list .act').forEach((li) => { const t = li.querySelector('.t'); const v = relTime(Number(li.dataset.at)); if (t.textContent !== v) t.textContent = v; });
}
function pushActivity(e) {
  const i = S.activity.findIndex((x) => x.id === e.id);
  if (i >= 0) S.activity[i] = e; else S.activity.push(e);
  if (S.activity.length > 300) S.activity.splice(0, S.activity.length - 300);
  const r = resolve(S.target);
  if (r && r.all.includes(e.device)) { renderActivity(); if (S.compact || window.innerWidth < 820) renderCompactNow(activeState()); }
}
/** Latest line of the feed for the current target, for the compact strip. */
function latestActivity() {
  const r = resolve(S.target);
  if (!r) return null;
  for (let i = S.activity.length - 1; i >= 0; i--) if (r.all.includes(S.activity[i].device)) return S.activity[i];
  return null;
}

/* ---------------- live view (ADB) ---------------- */

async function setLive(opts) {
  if (!S.target) return;
  if (opts && !S.adb?.available) {
    toast('Reading playback from the TV needs ADB. Connect it in the setup panel.', 'error');
    return openDevSheet();
  }
  try {
    await controller.device.setLiveView(S.target, opts);
  } catch (err) {
    showErr(err);
  }
}
function toggleLive() {
  if (!hasAndroid()) return toast('Live view works with Android TV and Google TV devices', 'error');
  const st = activeState();
  setLive({ media: true, screen: !st?.liveView?.screen });
}
function nowMenu(e, anchor) {
  const st = activeState();
  const m = st?.media;
  const link = mediaLink(m);
  const items = [];
  if (link) {
    items.push({ label: 'Copy link', run: () => { navigator.clipboard.writeText(link); toast('Link copied'); } });
    items.push({ label: 'Open on this computer', run: () => controller.app.openExternal(link) });
  }
  if (m?.duration) items.push({ label: 'Play from the start', run: () => controller.device.seek(S.target, 0).catch(showErr) });
  if (m && m.title) items.push({ label: 'Copy title', run: () => { navigator.clipboard.writeText([m.title, m.subtitle].filter(Boolean).join(' · ')); toast('Title copied'); } });
  if (hasAndroid()) {
    const lv = st?.liveView;
    items.push({ label: lv?.screen ? '✓ Live view: screen + playback' : 'Live view: screen + playback', run: () => setLive({ media: true, screen: true }) });
    items.push({ label: lv && lv.media && !lv.screen ? '✓ Live view: playback only' : 'Live view: playback only', run: () => setLive({ media: true, screen: false }) });
    if (lv && (lv.media || lv.screen)) items.push({ label: 'Stop screen and playback reporting', run: () => setLive(null) });
    items.push({ label: 'Reconnect playback reporting', run: () => setLive({ media: true, screen: !!lv?.screen }) });
    items.push({ label: 'Screenshot…', run: async () => { await openDevSheet(); $('#adb-screenshot').click(); } });
  }
  items.push({ label: S.settings?.showActivity ? 'Hide activity feed' : 'Show activity feed', run: () => saveSettings({ showActivity: !S.settings.showActivity }).then(renderActivity) });
  contextMenu(e, items, anchor);
}

function renderCompactNow(st, app) {
  const m = st?.media;
  app = app || (st?.currentApp && appById(st.currentApp.id));
  $('#cnow-title').textContent = m?.title || st?.currentApp?.name || (st?.state === 'connected' ? 'Nothing playing' : 'Not connected');
  const last = latestActivity();
  const lastLine = last ? `${relTime(last.at)} · ${last.text}${last.detail && last.text.length + last.detail.length < 34 ? ' · ' + last.detail : ''}` : '';
  $('#cnow-sub').textContent = m ? [m.subtitle, m.playerState && m.playerState !== 'PLAYING' ? m.playerState.toLowerCase() : ''].filter(Boolean).join(' · ') : lastLine || (st?.currentApp ? 'open' : '');
  const art = $('#cnow-art');
  art.dataset.initials = app?.initials || '';
  art.innerHTML = m?.artwork ? `<img src="${esc(m.artwork)}" alt="">` : app ? (app.icon ? `<img src="${esc(app.icon)}" alt="">` : esc(app.initials)) : '';
  art.style.background = !m?.artwork && app?.color ? app.color : '';
  imgFallback(art);
  $('#cnow-toggle').innerHTML = m?.playerState === 'PLAYING' ? ICON_PAUSE : ICON_PLAY;
  $('#cnow-toggle').setAttribute('aria-label', m?.playerState === 'PLAYING' ? 'Pause' : 'Play');
  $('#cnow-toggle').disabled = !st || st.state !== 'connected';
}

let seekPreview = null;
function seekIdentity(m) { return JSON.stringify([S.target, m?.appId, m?.contentId, m?.title]); }
function tickProgress() {
  const m = activeState()?.media;
  const ends = $('#now-ends');
  const seek = $('#now-seek');
  seek.disabled = !m || m.source !== 'cast' || !(m.duration > 0) || activeState()?.state !== 'connected';
  seek.title = seek.disabled ? 'This playback session does not support seeking' : 'Drag to seek · arrow keys move 10 seconds';
  if (seekPreview && (seekPreview.identity !== seekIdentity(m) || seek.disabled || (seekPreview.until && Date.now() >= seekPreview.until))) seekPreview = null;
  if (seekPreview && !seekPreview.until) return;
  if (!m) { $('#now-bar').style.width = '0'; ends.classList.add('hidden'); return; }
  const elapsed = m.playerState === 'PLAYING' && m.updatedAt ? (Date.now() - m.updatedAt) / 1000 : 0;
  const known = Number.isFinite(m.duration) && m.duration > 0;
  $('#now-progress').classList.toggle('hidden', !known);
  $('#now-dur-wrap').classList.toggle('hidden', !known);
  if (!known) {
    // ADB and Roku sessions know the position but not always the length: a running clock instead of a bar.
    $('#now-bar').style.width = '0';
    $('#now-pos').textContent = m.currentTime !== undefined ? `at ${fmtTime((m.currentTime || 0) + elapsed)}` : '';
    ends.classList.add('hidden');
    return;
  }
  const pos = Math.max(0, Math.min(m.duration, seekPreview ? seekPreview.value : (m.currentTime || 0) + elapsed));
  seek.max = String(m.duration);
  seek.value = String(pos);
  seek.setAttribute('aria-valuetext', `${fmtTime(pos)} of ${fmtTime(m.duration)}`);
  $('#now-bar').style.width = (pos / m.duration) * 100 + '%';
  $('#now-pos').textContent = fmtTime(pos);
  $('#now-dur').textContent = fmtTime(m.duration);
  const left = m.duration - pos;
  const showEnds = m.playerState === 'PLAYING' && left > 90;
  ends.classList.toggle('hidden', !showEnds);
  if (showEnds) ends.textContent = 'ends ' + clockTime(Date.now() + left * 1000);
}

function renderContinue() {
  const row = $('#continue-row');
  const items = (S.settings?.watchHistory || []).filter((e) => e.service !== 'web' || e.artwork);
  $('#continue-section').classList.toggle('hidden', !S.target || !items.length);
  row.innerHTML = '';
  for (const e of items.slice(0, 12)) {
    const el = document.createElement('div');
    el.className = 'cw';
    el.tabIndex = 0;
    const svc = SERVICE[e.service] || SERVICE.web;
    el.style.setProperty('--service-color', svc.color);
    const pct = e.duration ? Math.min(100, ((e.position || 0) / e.duration) * 100) : 0;
    // No artwork (Stremio, Netflix without Cast metadata): a compact text card instead of an empty poster.
    if (!e.artwork) el.classList.add('text');
    el.innerHTML = e.artwork
      ? `<div class="thumb"><img src="${esc(e.artwork)}" alt="" loading="lazy"><span class="svc" style="background:${esc(svc.color)}">${esc(svc.name)}</span>${pct ? `<div class="bar" aria-label="${Math.round(pct)}% watched"><div style="width:${pct}%"></div></div>` : ''}</div>
      <div class="info"><strong>${esc(e.title)}</strong><small>${esc(e.subtitle || '')}${e.subtitle ? ' · ' : ''}${esc(timeAgo(e.at))}</small></div>`
      : `<div class="info"><span class="svc" style="background:${esc(svc.color)}">${esc(svc.name)}</span><strong>${esc(e.title)}</strong><small>${esc(e.subtitle || '')}${e.subtitle ? ' · ' : ''}${esc(timeAgo(e.at))}</small>${pct ? `<div class="bar" aria-label="${Math.round(pct)}% watched"><div style="width:${pct}%"></div></div>` : ''}</div>`;
    el.title = `Play ${e.title} on the TV`;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `Play ${e.title} on the TV`);
    imgFallback(el);
    el.onclick = () => playLink(e.url, { title: e.title, artwork: e.artwork });
    el.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); el.click(); } };
    el.oncontextmenu = (ev) => { ev.preventDefault(); contextMenu(ev, [
      { label: 'Play on TV', run: () => el.click() },
      { label: 'Copy link', run: () => navigator.clipboard.writeText(e.url) },
      { label: 'Remove', danger: true, run: async () => { S.settings = await controller.settings.removeHistory(e.id); renderContinue(); } },
    ]); };
    row.appendChild(el);
  }
}

function renderRemote() {
  const st = activeState();
  const kind = primaryKind();
  const connected = st?.state === 'connected';
  const playback = st?.media?.playerState;
  const transport = $('.remote button[data-key="PLAY_PAUSE"]');
  transport.innerHTML = playback === 'PLAYING' ? ICON_PAUSE : ICON_PLAY;
  transport.setAttribute('aria-label', playback === 'PLAYING' ? 'Pause' : playback === 'PAUSED' ? 'Play' : 'Play or pause');
  transport.title = transport.getAttribute('aria-label');
  const castOnly = kind === 'cast';
  const unsupported = new Set(UNSUPPORTED[kind] || []);
  $$('.remote button[data-key]').forEach((b) => {
    const k = b.dataset.key;
    b.classList.toggle('hidden', castOnly ? !CAST_ONLY_KEYS.includes(k) : unsupported.has(k));
    b.disabled = !connected;
  });
  $('#pad-area').classList.toggle('hidden', castOnly);
  $('#remote-top').classList.toggle('hidden', castOnly);
  $('#channel-box').classList.toggle('hidden', castOnly);
  $('#remote-utility').classList.toggle('hidden', castOnly);
  // Cast-only targets (speakers, a bare Chromecast) have no navigation: Home means "stop the running app".
  $('#remote-nav').classList.toggle('single', castOnly);
  $('#remote-nav button[data-key="HOME"]').innerHTML = castOnly ? 'Stop the running app' : '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9"/></svg><span>Home</span>';
  $('#remote-media').classList.toggle('two', false);
  $('#dpad').classList.toggle('off', !connected);
  $('#btn-numpad').classList.toggle('hidden', castOnly || unsupported.has('GUIDE') && kind === 'cast');
  $('#btn-keyboard').disabled = !connected || castOnly;
  $('#btn-numpad').disabled = !connected;
  $('#dpad').classList.toggle('hidden', S.numpad);
  $('#numpad').classList.toggle('hidden', !S.numpad);
  $('#pad-area').classList.toggle('numbers', S.numpad);
  $$('.remote [data-skip], .remote .corner').forEach((b) => (b.disabled = !connected));
  $$('.remote .cast-only-skip').forEach((b) => b.classList.toggle('hidden', !castOnly));
  renderCorners();
  $('#btn-keymode').disabled = !connected || castOnly;
  if ((!connected || castOnly) && S.keyMode) setKeyMode(false);
  $('#btn-numpad').setAttribute('aria-pressed', String(S.numpad));
  S.remotePresses?.forEach((press) => press.reconcile());
  const v = st?.volume;
  if (v) {
    const pct = Math.round(v.level * 100);
    if (document.activeElement !== $('#vol-slider')) $('#vol-slider').value = pct;
    $('#vol-label').textContent = (v.absolute !== undefined ? `${v.absolute}${v.max ? ' / ' + v.max : ''}` : pct + '%') + (v.muted ? ' · muted' : '');
  } else $('#vol-label').textContent = '—';
  const r = resolve(S.target);
  const canLevel = r && r.all.some((id) => device(id)?.capabilities.includes('volumeLevel') && S.states[id]?.state === 'connected');
  $('#vol-slider').disabled = !canLevel;
  $('#vol-slider').title = canLevel ? '' : 'This device only has volume up and down';
  const audio = r && device(r.audio);
  $('#vol-via').innerHTML = `<span>${esc(audio && r.audio !== r.primary ? `Volume · ${shortName(audio)}` : audio && primaryKind() === 'androidtv' ? 'Volume · HDMI‑CEC' : 'Volume')}</span>`;
  $('#vol-via').title = 'Choose which device the volume keys go to';
}

function tileHtml(a, tag = 'span') {
  return `<${tag} class="tile" data-initials="${esc(a.initials)}" style="background:${esc(a.color || '#2A2A2D')}">${a.icon ? `<img src="${esc(a.icon)}" alt="" loading="lazy">` : esc(a.initials)}</${tag}>`;
}

function renderPinned() {
  const target = S.target;
  $('#pins-manage').classList.toggle('hidden', !target || primaryKind() === 'cast');
  const apps = S.apps[target] || [];
  const pinnedIds = (S.settings?.pinnedApps?.[target]) || [];
  const pinned = pinnedIds.map((id) => apps.find((a) => a.id === id)).filter(Boolean).slice(0, 8);
  const html = pinned.map((a) => `<button class="tile" aria-label="Open ${esc(a.name)}" data-app="${esc(a.id)}" data-initials="${esc(a.initials)}" title="${esc(a.name)}" style="background:${esc(a.color || '#2A2A2D')}">${a.icon ? `<img src="${esc(a.icon)}" alt="">` : esc(a.initials)}</button>`).join('');
  $('#pinned-apps').innerHTML = pinned.map((a) => `<div class="pinned-item" data-pin-id="${esc(a.id)}">${tileHtml(a, 'span')}<button class="pinned-launch" data-app="${esc(a.id)}" title="Open ${esc(a.name)}" aria-label="Open ${esc(a.name)}"></button><span class="pinned-name">${esc(a.name)}</span></div>`).join('') || '<span class="muted small" style="grid-column:1/-1">Star an app to keep it here.</span>';
  $('#compact-apps').innerHTML = html;
  $$('#pinned-apps .pinned-launch, #compact-apps .tile').forEach((b) => (b.onclick = () => launch(b.dataset.app)));
  imgFallback($('#pinned-apps')); imgFallback($('#compact-apps'));
  bindPinDrag($('#pinned-apps'), '.pinned-item', target, true);
  bindPinDrag($('#compact-apps'), '[data-app]', target, true);
}

function renderApps() {
  const target = S.target;
  const apps = S.apps[target] || [];
  const hidden = new Set(S.settings?.hiddenApps?.[target] || []);
  const q = $('#apps-filter').value.trim().toLowerCase();
  const running = activeState()?.currentApp?.id;
  const grid = $('#apps-grid');
  const focusedApp = grid.contains(document.activeElement) ? document.activeElement.dataset.app : null;
  const focusedAction = document.activeElement.classList.contains('app-pin') ? '.app-pin' : '.app-main';
  const scrollTop = grid.scrollTop;
  grid.innerHTML = '';
  // Tiles cascade in the first time a device's list appears; later re-renders (filter, running app) stay still.
  grid.classList.toggle('animate', apps.length > 0 && grid.dataset.animated !== target);
  if (apps.length) grid.dataset.animated = target;
  const pins = new Set(S.settings?.pinnedApps?.[target] || []);
  const shown = apps.filter((a) => !hidden.has(a.id) && (S.appScope !== 'pinned' || pins.has(a.id)) && (!q || a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)));
  if (S.appScope === 'pinned') { const order = [...pins]; shown.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)); }
  shown.forEach((a, i) => {
    const el = document.createElement('div');
    el.className = 'app' + (a.id === running ? ' running' : '');
    el.dataset.app = a.id;
    el.style.setProperty('--app-color', a.color || 'var(--muted)');
    el.style.setProperty('--i', Math.min(i, 16));
    const pinned = pins.has(a.id);
    el.innerHTML = `<button class="app-main" data-app="${esc(a.id)}" aria-label="${esc(a.name + (a.id === running ? ', currently open on TV' : ', open on TV'))}" title="Open ${esc(a.name)}">${tileHtml(a, 'span')}<span class="name">${esc(a.name)}</span></button><button class="app-pin ${pinned ? 'is-pinned' : ''}" data-app="${esc(a.id)}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${esc(a.name)}" title="${pinned ? 'Unpin' : 'Pin'} ${esc(a.name)}" aria-pressed="${pinned}"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="${pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/></svg></button>`;
    imgFallback(el);
    el.querySelector('.app-main').onclick = () => launch(a.id);
    el.querySelector('.app-pin').onclick = () => togglePin(a.id);
    el.oncontextmenu = (e) => { e.preventDefault(); contextMenu(e, [
      { label: 'Open', run: () => launch(a.id) },
      { label: (S.settings.pinnedApps[target] || []).includes(a.id) ? 'Unpin' : 'Pin to sidebar', run: () => togglePin(a.id) },
      { label: 'Hide', run: () => hideApp(a.id) },
      ...(a.link ? [{ label: 'Copy launch link', run: () => navigator.clipboard.writeText(a.link) }] : []),
      ...(a.source === 'device' && primaryKind() === 'androidtv' && S.adb?.available ? [{ label: 'Uninstall (ADB)', danger: true, run: async () => { const r = await controller.adb.uninstall(target, a.id); toast(r.message, r.ok ? '' : 'error'); if (r.ok) loadApps(true); } }] : []),
    ]); };
    grid.appendChild(el);
  });
  grid.scrollTop = scrollTop;
  if (focusedApp) {
    const card = [...grid.children].find((el) => el.dataset.app === focusedApp);
    (card?.querySelector(focusedAction) || $('.app-scopes button.active')).focus({ preventScroll: true });
  }
  $('#apps-clear').classList.toggle('hidden', !q);
  $('#apps-count').textContent = `${shown.length} ${shown.length === 1 ? 'app' : 'apps'}`;
  $$('.app-scopes button').forEach((b) => { const on = b.dataset.scope === S.appScope; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
  const connected = activeState()?.state === 'connected';
  if (!shown.length) {
    const title = q ? 'No matching apps' : S.appScope === 'pinned' ? 'Your favourites go here' : connected ? 'No apps available' : 'Loading apps…';
    const detail = q ? `Try a different name or clear “${$('#apps-filter').value.trim()}”.` : S.appScope === 'pinned' ? 'Use the star on any app to pin it here.' : primaryKind() === 'cast' ? 'Cast-only devices do not have an app list.' : 'Apps appear here when your TV shares them.';
    grid.innerHTML = `<div class="apps-empty"><strong>${esc(title)}</strong><span>${esc(detail)}</span>${q || S.appScope === 'pinned' ? '<button id="apps-reset" class="small">Show all apps</button>' : ''}</div>`;
    const reset = $('#apps-reset');
    if (reset) reset.onclick = () => { S.appScope = 'all'; $('#apps-filter').value = ''; renderApps(); };
  }
  const src = apps[0]?.source;
  $('#apps-source').textContent = apps.length ? (src === 'device' ? 'On your TV' : 'Catalog') : '';
  const android = hasAndroid();
  $('#apps-install').classList.toggle('hidden', !android);
  $('#apps-install').textContent = src === 'device' ? 'Install APK' : 'Get TV apps';
  $('#apps-install').title = src === 'device' ? 'Install an Android app on the TV' : 'Connect to read the apps installed on your TV';
  const hiddenCount = (S.settings?.hiddenApps?.[target] || []).length;
  $('#apps-hint').innerHTML = (android && src !== 'device' ? 'Suggested apps · <button class="link" id="apps-hint-adb">Read the apps installed on your TV</button>. ' : '') +
    (hiddenCount ? `<button class="link" id="apps-unhide">${hiddenCount} hidden · show all</button>` : '');
  const un = $('#apps-unhide');
  if (un) un.onclick = () => { const h = { ...S.settings.hiddenApps }; delete h[target]; saveSettings({ hiddenApps: h }); };
  const hintAdb = $('#apps-hint-adb');
  if (hintAdb) hintAdb.onclick = () => openDevSheet();
}

function renderHistoryChips() {
  const h = S.settings?.textHistory || [];
  $('#history-chips').innerHTML = S.searchTab === 'tv' ? h.slice(0, 8).map((t) => `<button data-text="${esc(t)}">${esc(t.length > 32 ? t.slice(0, 32) + '…' : t)}</button>`).join('') + (h.length ? '<button class="ghost small" id="history-clear">Clear</button>' : '') : '';
  $$('#history-chips button[data-text]').forEach((b) => (b.onclick = () => { $('#type-input').value = b.dataset.text; sendText(b.dataset.text, true); }));
  const c = $('#history-clear');
  if (c) c.onclick = () => saveSettings({ textHistory: [] }).then(renderHistoryChips);
}

function renderScanStatus() {
  const st = S.scan;
  const el = $('#scan-status');
  if (!st) { el.textContent = ''; return; }
  const found = st.found.mdns + st.found.ssdp + st.found.scan;
  if (st.scan === 'running') el.innerHTML = '<span class="pulse"></span>Scanning the network…';
  else if (st.blocked) el.innerHTML = `<span>Local network access looks blocked${st.gateway ? ' (your router at ' + esc(st.gateway) + ' didn’t answer)' : ''}. ${S.platform === 'darwin' ? '<button class="link" id="scan-localnet">Allow it in Privacy &amp; Security</button>, and turn off any VPN.' : 'Check your VPN or firewall.'}</span>`;
  else if (found === 0 && S.devices.length === 0) el.textContent = st.scan === 'done' ? `Scanned ${st.scanned || 'the'} addresses; no TV answered. Is it on and on this Wi‑Fi?` : 'Nothing yet. Is the TV on and on this Wi‑Fi?';
  else el.textContent = `${S.devices.length} device${S.devices.length === 1 ? '' : 's'} on the network`;
  const ln = $('#scan-localnet');
  if (ln) ln.onclick = () => controller.app.openLocalNetworkSettings();
  $('#welcome-scan').disabled = st.scan === 'running';
  $('#welcome-scan').textContent = st.scan === 'running' ? 'Finding your TV…' : 'Find my TV';
  $('#btn-deepscan').disabled = st.scan === 'running';
  $('#btn-deepscan').textContent = st.scan === 'running' ? 'Scanning…' : 'Scan network';
  if (!$('#sheet-diag').classList.contains('hidden')) renderDiag();
}

function renderDiag() {
  const st = S.scan;
  if (!st) return;
  $('#diag-summary').textContent = `Interfaces: ${st.interfaces.join(', ') || 'none'} · mDNS ${st.mdns} · SSDP ${st.ssdp} · scan ${st.scan} · found ${st.found.mdns}/${st.found.ssdp}/${st.found.scan}${st.gateway ? ' · gateway ' + st.gateway + (st.blocked ? ' (no answer)' : ' (reachable)') : ''}`;
  $('#diag-log').textContent = st.log.join('\n') || '(no activity yet)';
  $('#diag-log').scrollTop = $('#diag-log').scrollHeight;
}

function updateStatusText(u) {
  if (!u) return '';
  return {
    idle: u.note || '', checking: 'Checking…', uptodate: `You have the latest version${u.checkedAt ? ' (checked ' + clockTime(u.checkedAt) + ')' : ''}.`, available: `${u.latest} is available.${u.installable || S.platform !== 'darwin' ? ' Use Update in the banner, or the button above.' : ' The download opens in your browser.'}`,
    downloading: `Downloading ${u.latest}… ${u.progress ?? 0}%`, ready: `${u.latest} is downloaded. Restart to update from the banner.`, error: `Could not check: ${u.note || 'unknown error'}`,
  }[u.state] || '';
}
function renderUpdate() {
  const u = S.update;
  const banner = $('#update-banner');
  const settings = $('#settings-update');
  if (!u) { banner.classList.add('hidden'); settings.textContent = ''; return; }
  settings.textContent = updateStatusText(u);
  settings.classList.toggle('error', u.state === 'error');
  $('#set-check-update').disabled = u.state === 'checking' || u.state === 'downloading';
  $('#set-check-update').textContent = u.state === 'available' ? (u.installable || S.platform !== 'darwin' ? 'Update now' : 'Download') : u.state === 'ready' ? 'Restart to update' : 'Check for updates';
  const show = !S.updateDismissed && (u.state === 'available' || u.state === 'ready' || u.state === 'downloading');
  banner.classList.toggle('hidden', !show);
  if (show) {
    const action = $('#update-action');
    if (u.state === 'downloading') {
      $('#update-text').textContent = `Downloading ${u.latest}… ${u.progress ?? 0}%`;
      action.textContent = 'Downloading';
      action.disabled = true;
    } else if (u.state === 'ready') {
      $('#update-text').textContent = `${u.latest} is ready`;
      action.textContent = 'Restart to update';
      action.disabled = false;
    } else {
      $('#update-text').textContent = `${u.latest} is available`;
      action.textContent = u.installable || S.platform !== 'darwin' ? 'Update' : 'Download';
      action.disabled = false;
    }
  }
}

function renderSleep() {
  const t = S.sleep;
  const current = !!t && t.target === S.target;
  const minutes = t ? Math.max(1, Math.ceil((t.at - Date.now()) / 60000)) : 0;
  $('#sleep-chip').classList.toggle('hidden', !t);
  $('#sleep-text').textContent = t ? `${targetName(t.target) || 'TV'} · off in ${minutes} min` : '';
  $('#btn-remote-tools').innerHTML = current ? `<span class="timer-dot" aria-hidden="true"></span> ${minutes} min` : 'Tools <span aria-hidden="true">⋯</span>';
  $('#btn-remote-tools').setAttribute('aria-label', current ? `Remote tools, sleep timer in ${minutes} minutes` : 'Remote tools');
  $('#btn-remote-tools').classList.toggle('timer-active', current);
  $('#sleep-description').textContent = t && !current ? 'Setting a timer here replaces the timer on your other TV.' : 'Turn off the TV after a little while.';
}
async function setRemoteSleep(minutes) {
  if (!S.target) return;
  try {
    S.sleep = await controller.app.sleepTimer(S.target, minutes);
    renderSleep();
    toast(`Off in ${minutes} minutes`);
  } catch (err) { showErr(err); }
}
function openRemoteTools() {
  $('#tools-target').textContent = targetName(S.target) || 'Choose a TV first';
  const connected = activeState()?.state === 'connected';
  $$('#sheet-remote-tools [data-sleep-minutes], #sleep-form input, #sleep-form button').forEach((b) => b.disabled = !connected);
  $('#tools-tab-corners').classList.toggle('hidden', primaryKind() === 'cast');
  $('#tools-tab-pins').classList.toggle('hidden', primaryKind() === 'cast' || !S.target);
  $('#tools-tab-playback').classList.toggle('hidden', !hasAndroid());
  const st = activeState();
  $('#playback-status').textContent = st?.playbackError ? 'Playback reporting was interrupted. Reconnect to try again.' : st?.liveView?.media ? 'Reading titles and playback state from the TV. A screen preview is not needed.' : 'For Netflix, Stremio and other native apps, enable playback reporting from the TV.';
  $('#playback-reconnect').disabled = !connected;
  $('#playback-reconnect').textContent = st?.liveView?.media || st?.playbackError ? 'Reconnect playback' : 'Enable playback reporting';
  renderSleep();
  renderCornerChoices();
  renderPinOrder();
  setRemoteToolsTab(S.remoteToolsTab || 'sleep');
  openSheet('#sheet-remote-tools');
}
function setRemoteToolsTab(tab) {
  const available = $$('.tools-tabs button').filter((b) => !b.classList.contains('hidden'));
  if (!available.some((b) => b.dataset.toolsTab === tab)) tab = available[0].dataset.toolsTab;
  S.remoteToolsTab = tab;
  $('.remote-tools-sheet .sheet-body').scrollTop = 0;
  $('.tools-tip').textContent = ({ sleep: 'Keep this computer awake and the controller running until the timer ends.', corners: 'Press and hold a direction to keep moving. Use Tab to focus a control, then Enter or Space to press it.', pins: 'Your order is saved for this TV and also used by pinned-app keyboard shortcuts.', playback: 'Screen preview and playback reporting can run independently.' })[tab];
  $$('.tools-tabs button').forEach((b) => {
    const active = b.dataset.toolsTab === tab;
    b.setAttribute('aria-selected', String(active)); b.tabIndex = active ? 0 : -1;
  });
  $$('[data-tools-panel]').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.toolsPanel !== tab));
}
function renderCornerChoices() {
  const groups = [
    ['Skip', [-300, -60, -30, -10, 10, 30, 60, 300].map((seconds) => ({ type: 'skip', seconds }))],
    ['TV controls', CORNER_KEYS.filter(([key]) => !(UNSUPPORTED[primaryKind()] || []).includes(key)).map(([key]) => ({ type: 'key', key }))],
    ['Pinned apps', (S.settings?.pinnedApps?.[S.target] || []).map((id) => appById(id)).filter(Boolean).map((app) => ({ type: 'app', id: app.id, name: app.name }))],
  ];
  $$('[data-edit-corner]').forEach((select) => {
    const current = JSON.stringify(cornerAction(select.dataset.editCorner));
    let found = false;
    select.innerHTML = groups.filter(([, actions]) => actions.length).map(([label, actions]) => `<optgroup label="${esc(label)}">${actions.map((action) => {
      const value = JSON.stringify(action), selected = value === current;
      if (selected) found = true;
      return `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(cornerDescribe(action))}</option>`;
    }).join('')}</optgroup>`).join('');
    if (!found) select.insertAdjacentHTML('afterbegin', `<option selected value="${esc(current)}">${esc(cornerDescribe(cornerAction(select.dataset.editCorner)))} (saved)</option>`);
  });
  $('#corners-reset').disabled = !Object.keys(S.settings?.corners || {}).length;
}

function bindPinDrag(container, selector, target, horizontal = false) {
  const rows = [...container.querySelectorAll(selector)];
  const idOf = (row) => row.dataset.pinId || row.dataset.app;
  for (const row of rows) {
    row.draggable = false;
    row.classList.add('pin-draggable');
    row.classList.toggle('pin-drag-horizontal', horizontal);
    row.title = `${row.title ? row.title + ' · ' : ''}Drag to reorder`;
    row.querySelectorAll('img').forEach((img) => img.draggable = false);
    row.ondragstart = (event) => event.preventDefault();
    let press = null, suppressClickUntil = 0;
    row.addEventListener('click', (event) => {
      if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    const clear = (release = true) => {
      if (press?.frame) cancelAnimationFrame(press.frame);
      const pointer = press?.pointer, capture = press?.capture;
      press = null;
      rows.forEach((item) => item.classList.remove('pin-dragging', 'pin-drop-before', 'pin-drop-after'));
      row.style.transform = '';
      if (release && pointer !== undefined && capture?.hasPointerCapture(pointer)) capture.releasePointerCapture(pointer);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('keydown', escape);
    };
    const cancel = () => { if (press?.moving) suppressClickUntil = Date.now() + 500; clear(); };
    const escape = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } };
    const locate = () => {
      if (!press) return;
      rows.forEach((item) => item.classList.remove('pin-drop-before', 'pin-drop-after'));
      const hit = document.elementFromPoint(press.x, press.y)?.closest(selector);
      press.destination = hit && container.contains(hit) && hit !== row ? hit : null;
      if (!press.destination) return;
      const rect = hit.getBoundingClientRect();
      press.after = horizontal ? press.x > rect.left + rect.width / 2 : press.y > rect.top + rect.height / 2;
      hit.classList.add(press.after ? 'pin-drop-after' : 'pin-drop-before');
    };
    const scroll = () => {
      if (!press?.moving) return;
      if (S.target !== target || !row.isConnected) return cancel();
      let parent = container;
      while (parent && !(parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(getComputedStyle(parent).overflowY))) parent = parent.parentElement;
      if (parent) {
        const rect = parent.getBoundingClientRect();
        const delta = press.y < rect.top + 32 ? -8 : press.y > rect.bottom - 32 ? 8 : 0;
        if (delta) { parent.scrollTop += delta; locate(); }
      }
      press.frame = requestAnimationFrame(scroll);
    };
    row.onpointerdown = (event) => {
      if (press || event.isPrimary === false || event.button !== 0 || container.dataset.saving || event.target.closest('[data-pin-action]')) return;
      press = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moving: false, capture: event.target.closest('button') || row };
      press.capture.setPointerCapture(event.pointerId);
      window.addEventListener('blur', cancel);
      document.addEventListener('keydown', escape);
    };
    row.onpointermove = (event) => {
      if (!press || event.pointerId !== press.pointer) return;
      if (S.target !== target || !row.isConnected) return cancel();
      press.x = event.clientX; press.y = event.clientY;
      if (!press.moving && Math.hypot(press.x - press.startX, press.y - press.startY) < 6) return;
      event.preventDefault();
      if (!press.moving) { press.moving = true; row.classList.add('pin-dragging'); scroll(); }
      row.style.transform = `translate(${press.x - press.startX}px, ${press.y - press.startY}px)`;
      locate();
    };
    row.onpointercancel = cancel;
    row.onlostpointercapture = cancel;
    row.onpointerup = async (event) => {
      if (!press || event.pointerId !== press.pointer) return;
      const moved = idOf(row), destination = press.destination && idOf(press.destination), after = press.after, moving = press.moving;
      if (moving) { event.preventDefault(); suppressClickUntil = Date.now() + 500; }
      clear(false);
      if (!moving || !destination || S.target !== target || container.dataset.saving) return;
      const old = S.settings?.pinnedApps?.[target] || [];
      if (!old.includes(moved) || !old.includes(destination)) return;
      const next = old.filter((id) => id !== moved);
      next.splice(next.indexOf(destination) + (after ? 1 : 0), 0, moved);
      if (next.every((id, index) => id === old[index])) return;
      container.dataset.saving = 'true';
      try {
        await saveSettings({ pinnedApps: { ...S.settings.pinnedApps, [target]: next } });
        if (!$('#sheet-remote-tools').classList.contains('hidden')) { renderPinOrder(); renderCornerChoices(); }
        toast('App order saved');
      } catch (err) { showErr(err); }
      finally { delete container.dataset.saving; }
    };
  }
}

function renderCredentialNote(s) {
  $('#set-encrypt-note').textContent = s.encryptCredentials ? (S.platform === 'darwin' ? 'Uses macOS Keychain. macOS may ask for access after an update.' : S.platform === 'win32' ? 'Uses Windows account encryption (DPAPI).' : 'Uses your desktop keyring when available.') : 'Off: pairings stay in a local file restricted to your user account. The file is not encrypted.';
}

function renderPinOrder(restoreFocus) {
  const target = S.target;
  const ids = S.settings?.pinnedApps?.[target] || [];
  const list = $('#pin-order');
  const focused = restoreFocus || (list.contains(document.activeElement) ? { app: document.activeElement.dataset.pinId, action: document.activeElement.dataset.pinAction } : null);
  list.innerHTML = ids.map((id, index) => {
    const app = (S.apps[target] || []).find((a) => a.id === id) || { name: id, initials: '?', color: 'var(--raised)' };
    return `<div class="pin-order-row${index >= 8 ? ' beyond-remote' : ''}" data-pin-id="${esc(id)}"><span class="pin-drag-handle" aria-hidden="true">⠿</span><span class="pin-order-number">${index + 1}</span>${tileHtml(app)}<span class="pin-order-name" title="${esc(app.name)}">${esc(app.name)}</span><button data-pin-id="${esc(id)}" data-pin-action="up" aria-label="Move ${esc(app.name)} earlier" ${index === 0 ? 'disabled' : ''}>↑</button><button data-pin-id="${esc(id)}" data-pin-action="down" aria-label="Move ${esc(app.name)} later" ${index === ids.length - 1 ? 'disabled' : ''}>↓</button><button data-pin-id="${esc(id)}" data-pin-action="remove" aria-label="Unpin ${esc(app.name)}">×</button></div>`;
  }).join('') || '<p class="muted small">No pinned apps yet. Use the star on an app to add it here.</p>';
  imgFallback(list);
  bindPinDrag(list, '.pin-order-row', target);
  list.querySelectorAll('button').forEach((button) => {
    button.onclick = async () => {
      const current = [...(S.settings?.pinnedApps?.[target] || [])];
      const index = current.indexOf(button.dataset.pinId), action = button.dataset.pinAction;
      if (index < 0) return;
      if (action === 'remove') current.splice(index, 1);
      else { const next = index + (action === 'up' ? -1 : 1); if (next < 0 || next >= current.length) return; [current[index], current[next]] = [current[next], current[index]]; }
      list.querySelectorAll('button').forEach((b) => b.disabled = true);
      try {
        await saveSettings({ pinnedApps: { ...S.settings.pinnedApps, [target]: current } });
        renderPinOrder({ app: action === 'remove' ? current[Math.min(index, current.length - 1)] : button.dataset.pinId, action }); renderCornerChoices();
        if (action === 'remove') { if (!current.length) $('#tools-tab-pins').focus(); toast('App unpinned'); }
      } catch (err) { renderPinOrder(); showErr(err); }
    };
  });
  if (focused) {
    const buttons = [...list.querySelectorAll('button')];
    const same = buttons.find((b) => b.dataset.pinId === focused.app && b.dataset.pinAction === focused.action && !b.disabled);
    (same || buttons.find((b) => b.dataset.pinId === focused.app && !b.disabled))?.focus();
  }
}

/** Single, replaceable volume toast with a level bar. */
function volumeOsd() {
  const v = activeState()?.volume;
  if (!v) return;
  const pct = Math.round(v.level * 100);
  if (!S.osd || !S.osd.isConnected) {
    S.osd = document.createElement('div');
    S.osd.className = 'toast osd';
    S.osd.innerHTML = '<span>Volume</span><div class="bar"><div></div></div><strong></strong>';
    $('#toasts').appendChild(S.osd);
  }
  S.osd.querySelector('.bar div').style.width = (v.muted ? 0 : pct) + '%';
  S.osd.querySelector('strong').textContent = (v.absolute !== undefined ? v.absolute : pct + '%') + (v.muted ? ' · muted' : '');
  clearTimeout(S.osd.timer);
  S.osd.timer = setTimeout(() => { const el = S.osd; S.osd = null; if (el) { el.classList.add('leaving'); setTimeout(() => el.remove(), 250); } }, 1400);
}

function renderAll() {
  renderDevices(); renderHeader(); renderNow(); renderActivity(); renderRemote(); renderPinned(); renderApps(); renderContinue(); renderScanStatus(); renderUpdate(); renderSleep();
}

/** Something playable was copied: offer it once, when the window comes to the front. */
async function offerClipboard() {
  if (!S.settings?.clipboardOffers || !S.target || anySheetOpen() || document.visibilityState !== 'visible') return;
  let t = '';
  try { t = ((await controller.app.readClipboard()) || '').trim(); } catch { return; }
  if (!isUrl(t) || t === S.lastClipOffer) return;
  S.lastClipOffer = t;
  if (isMediaUrl(t)) {
    if (castCapable()) toastAction(`Cast the ${mediaKind(t)} you copied to ${targetName(S.target)}?`, 'Cast', () => playLink(t));
    return;
  }
  const svc = linkService(t);
  if (!svc) return;
  toastAction(`Play the ${svc} link you copied on ${targetName(S.target)}?`, 'Play', () => playLink(t));
}

/* ---------------- actions ---------------- */

async function sendKey(key, direction, target = S.target) {
  if (!target) return;
  flash(key);
  if (key === 'VOLUME_UP' || key === 'VOLUME_DOWN' || key === 'MUTE') S.lastVolumeAction = Date.now();
  try {
    await controller.device.sendKey(target, key, direction || 'SHORT');
    if (key === 'VOLUME_UP' || key === 'VOLUME_DOWN' || key === 'MUTE') setTimeout(volumeOsd, 350);
  } catch (err) {
    showErr(err);
  }
}
async function launch(appId) {
  if (!S.target) return;
  try {
    await controller.device.launchApp(S.target, appId);
    const a = (S.apps[S.target] || []).find((x) => x.id === appId);
    toast(`Opening ${a?.name || appId}`);
  } catch (err) {
    showErr(err);
  }
}
async function playLink(url, meta) {
  if (!S.target) return toast('Pick a device first', 'error');
  try {
    if (isMediaUrl(url) && castCapable()) {
      // A bare media file: no app knows the link, but the Cast receiver plays it directly.
      const title = meta?.title || decodeURIComponent(new URL(url).pathname.split('/').pop() || url);
      await controller.device.castUrl(S.target, { url, title });
      toast(`Casting ${title} to ${targetName(S.target)}`);
    } else {
      await controller.device.openLink(S.target, url, meta);
      toast(`Playing ${meta?.title || 'link'} on ${targetName(S.target)}`);
    }
    closeSheets();
  } catch (err) {
    showErr(err);
  }
}
async function loadApps(refresh) {
  if (!S.target) return;
  const t = S.target;
  try {
    S.apps[t] = await controller.device.listApps(t, refresh);
  } catch (err) {
    if (refresh) showErr(err);
  }
  if (S.target === t) { renderApps(); renderPinned(); renderNow(); }
}
async function saveSettings(patch) {
  S.settings = await controller.settings.set(patch);
  document.body.classList.toggle('reduce-motion', !!S.settings.reduceMotion);
  applyTheme();
  renderPinned(); renderApps(); renderContinue();
}
function togglePin(appId) {
  const pins = { ...(S.settings.pinnedApps || {}) };
  const list = pins[S.target] || [];
  pins[S.target] = list.includes(appId) ? list.filter((x) => x !== appId) : [...list, appId];
  saveSettings({ pinnedApps: pins });
}
function hideApp(appId) {
  const hidden = { ...(S.settings.hiddenApps || {}) };
  hidden[S.target] = [...new Set([...(hidden[S.target] || []), appId])];
  saveSettings({ hiddenApps: hidden });
}
async function sendText(text, fromHistory) {
  if (!S.target || !text) return;
  try {
    const how = await controller.device.sendText(S.target, text, { private: $('#type-private').checked });
    $('#type-context').textContent = how === 'ime' ? 'Sent to the field on the TV.' : how === 'keys' ? 'Sent as key presses (lower case only).' : 'Sent.';
    if (!$('#type-private').checked && !fromHistory) {
      await saveSettings({ textHistory: [text, ...(S.settings.textHistory || []).filter((t) => t !== text)].slice(0, 20) });
      renderHistoryChips();
    }
  } catch (err) {
    $('#type-context').textContent = err.message;
  }
}

/* ---------------- type / search sheet ---------------- */

async function openTypeSheet(field, tab) {
  if (!S.target) return toast('Pick a device first', 'error');
  openSheet('#sheet-type');
  setSearchTab(tab || (field ? 'tv' : S.searchTab));
  const input = $('#type-input');
  input.value = field?.value || '';
  if (field) {
    $('#type-ontv').classList.remove('hidden');
    $('#type-ontv-value').textContent = field.value || '(empty)';
    $('#type-context').textContent = field.label ? `Field on the TV: ${field.label}` : 'The TV keyboard is open.';
  } else $('#type-ontv').classList.add('hidden');
  input.focus();
  input.select();
  try {
    const clip = ((await controller.app.readClipboard()) || '').trim();
    $('#clip-text').textContent = clip ? clip.slice(0, 120) : 'Nothing copied yet';
    $('#clip-box').classList.toggle('empty-clip', !clip);
    $('#clip-paste').disabled = !clip;
    $('#clip-open').classList.toggle('hidden', !isUrl(clip));
  } catch { $('#clip-text').textContent = 'Clipboard unavailable'; $('#clip-box').classList.add('empty-clip'); $('#clip-paste').disabled = true; $('#clip-open').classList.add('hidden'); }
}
/** Brands whose own cross-app search we can drive: Google TV (search box + keyboard), Roku (ECP). */
function tvSearchAvailable() { return ['androidtv', 'roku'].includes(primaryKind()); }
/** Stremio's search deep link only works on its Android TV app; show the tab when that app is on the TV (or the list is a catalog). */
function stremioAvailable() {
  if (primaryKind() !== 'androidtv') return false;
  const apps = S.apps[S.target] || [];
  return !apps.length || apps[0].source !== 'device' || apps.some((a) => a.id === 'com.stremio.one');
}
function visibleTabs() { return ['tv', ...(tvSearchAvailable() ? ['tvsearch'] : []), 'youtube', 'netflix', 'disney', 'prime', ...(stremioAvailable() ? ['stremio'] : [])]; }
function setSearchTab(tab) {
  if (tab === 'tvsearch' && !tvSearchAvailable()) tab = 'tv';
  if (tab === 'stremio' && !stremioAvailable()) tab = 'tv';
  S.searchTab = tab;
  $('#type-tabs [data-tab="tvsearch"]').classList.toggle('hidden', !tvSearchAvailable());
  $('#type-tabs [data-tab="stremio"]').classList.toggle('hidden', !stremioAvailable());
  $$('#type-tabs .tab').forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
  const destination = $('#type-destination');
  destination.innerHTML = visibleTabs().map((key) => `<option value="${key}">${esc($('#type-tabs [data-tab="' + key + '"]').textContent)}</option>`).join('');
  destination.value = tab;
  $('#type-target').textContent = S.target ? `To ${targetName(S.target)}` : 'Choose a TV to get started';
  const tv = tab === 'tv';
  const tvs = tab === 'tvsearch';
  $('#type-options').classList.toggle('hidden', !tv);
  $('#type-footer').classList.toggle('hidden', !tv);
  $('#search-results').classList.toggle('hidden', tv || tvs);
  $('#type-input').placeholder = tv ? 'Start typing. Enter sends.' : tvs ? 'Search across the TV’s apps. Enter opens the results on the TV.' : tab === 'youtube' ? 'Search YouTube. Enter plays the first result.' : `Search ${SERVICE[tab].name}. Enter opens the results on the TV.`;
  $('#type-send').textContent = tv ? 'Send' : tab === 'youtube' ? 'Play' : 'Search on TV';
  $('#type-context').textContent = tv ? 'Goes to the focused field on the TV.' : tvs ? (primaryKind() === 'roku' ? 'Uses Roku’s own search; pick a result on the TV.' : 'Opens the TV’s search box, types your words and submits. Works with the Google TV home screen search.') : tab === 'youtube' ? (S.settings?.localOnly ? 'Local network only is on: Enter opens the search on the TV.' : 'Results from YouTube’s public search. Click one to play it on the TV.') : `Opens ${SERVICE[tab].name}’s search on the TV.`;
  renderHistoryChips();
  if (!tv && !tvs) { S.results = []; renderResults(); if ($('#type-input').value.trim()) runSearch(); }
}
function runSearch() {
  clearTimeout(S.searchTimer);
  const q = $('#type-input').value.trim();
  if (S.searchTab !== 'youtube' || !q) { S.results = []; renderResults(); return; }
  S.searchTimer = setTimeout(async () => {
    $('#type-context').textContent = 'Searching…';
    try {
      S.results = await controller.device.search(S.target, 'youtube', q);
      S.selectedResult = 0;
      $('#type-context').textContent = S.results.length ? 'Enter plays the highlighted result. ↑↓ to pick.' : 'No results; Enter opens the search on the TV instead.';
    } catch {
      S.results = [];
      $('#type-context').textContent = 'Search unavailable; Enter opens the search on the TV instead.';
    }
    renderResults();
  }, 350);
}
function renderResults() {
  const el = $('#search-results');
  el.innerHTML = '';
  S.results.forEach((r, i) => {
    const d = document.createElement('div');
    d.className = 'result' + (i === S.selectedResult ? ' selected' : '');
    d.innerHTML = `${r.thumbnail ? `<img src="${esc(r.thumbnail)}" alt="" loading="lazy">` : '<span class="thumb-ph"></span>'}<div class="t"><strong>${esc(r.title)}</strong><small>${esc(r.channel || '')}${r.duration ? ' · ' + esc(r.duration) : ''}</small></div>${i === S.selectedResult ? '<kbd>⏎</kbd>' : ''}`;
    d.onclick = () => playLink(r.url, { title: r.title, artwork: r.thumbnail });
    d.onmouseenter = () => { S.selectedResult = i; $$('.result').forEach((x, j) => x.classList.toggle('selected', j === i)); };
    imgFallback(d);
    el.appendChild(d);
  });
}
async function submitSheet() {
  const q = $('#type-input').value.trim();
  if (S.searchTab === 'tv') {
    if (isUrl(q)) return playLink(q);
    await sendText(q);
    if ($('#type-live').checked) sendKey('SELECT');
    return;
  }
  if (!q) return;
  if (S.searchTab === 'tvsearch') {
    $('#type-context').textContent = 'Searching on the TV…';
    try {
      await controller.device.searchOnTv(S.target, q);
      toast(`Searching ${targetName(S.target)} for “${q}”`);
      closeSheets();
    } catch (err) {
      $('#type-context').textContent = errText(err);
    }
    return;
  }
  if (S.searchTab === 'youtube' && S.results.length) {
    const r = S.results[S.selectedResult] || S.results[0];
    return playLink(r.url, { title: r.title, artwork: r.thumbnail });
  }
  const url = await controller.device.searchUrl(S.searchTab, q);
  if (!url) return toast(`${SERVICE[S.searchTab].name} has no search link`, 'error');
  await playLink(url, { title: `Search: ${q}` });
}

/* ---------------- other sheets ---------------- */

function openRoomEditor(room) {
  const sel = (id, allowNone) => {
    $(id).innerHTML = (allowNone ? '<option value="">Same as main device</option>' : '') +
      S.devices.map((d) => `<option value="${esc(d.id)}">${esc(displayName(d))} · ${esc(KIND_LABEL[d.kind])}</option>`).join('');
  };
  sel('#room-primary', false);
  sel('#room-audio', true);
  $('#room-name').value = room?.name && !room.id?.startsWith('auto-') ? room.name : (device(room?.primary) ? displayName(device(room.primary)) : '') + ' room';
  $('#room-primary').value = room?.primary || '';
  $('#room-audio').value = room?.audio || '';
  $('#room-delete').classList.toggle('hidden', !room?.id || room.id.startsWith('auto-'));
  $('#room-save').onclick = async () => {
    const primary = $('#room-primary').value;
    const audio = $('#room-audio').value || undefined;
    const id = room?.id && !room.id.startsWith('auto-') ? room.id : 'r' + Date.now().toString(36);
    const host = device(primary)?.host;
    const companions = S.devices.filter((d) => d.host === host && d.id !== primary && d.id !== audio).map((d) => d.id);
    const saved = await controller.rooms.save({ id, name: $('#room-name').value.trim() || 'Room', primary, audio, power: [primary, audio].filter(Boolean), companions });
    S.rooms = await controller.rooms.list();
    closeSheets();
    open('room:' + saved.id);
    toast('Room saved');
  };
  $('#room-delete').onclick = async () => {
    await controller.rooms.delete(room.id);
    S.rooms = await controller.rooms.list();
    if (S.target === 'room:' + room.id) S.target = null;
    closeSheets();
    renderAll();
  };
  openSheet('#sheet-room');
  $('#room-name').focus();
}

function showPairing(id, how) {
  S.pairing = { id, how };
  $('#pair-name').textContent = device(id) ? displayName(device(id)) : id;
  $('#pair-code-mode').classList.toggle('hidden', how !== 'code');
  $('#pair-prompt-mode').classList.toggle('hidden', how !== 'prompt');
  $('#pair-error').textContent = '';
  $('#pair-code').value = '';
  openSheet('#sheet-pair');
  if (how === 'code') $('#pair-code').focus();
}

function setSettingsTab(tab) {
  S.settingsTab = tab;
  $$('#sheet-settings .stab').forEach((b) => { const on = b.dataset.stab === tab; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
  $$('#sheet-settings .spanel').forEach((p) => p.classList.toggle('active', p.dataset.spanel === tab));
}
function openSettings(tab) {
  if (!['general', 'shortcuts', 'behaviour', 'privacy', 'updates'].includes(tab)) tab = undefined;
  const s = S.settings;
  $('#set-palette').value = s.palette || 'charcoal';
  $$('#set-theme button').forEach((b) => b.classList.toggle('active', b.dataset.theme === (s.theme || 'dark')));
  $$('#set-accent button').forEach((b) => b.classList.toggle('active', b.dataset.accent === (s.accent || 'neutral')));
  $('#set-motion').checked = !!s.reduceMotion;
  $('#set-login').checked = !!s.openAtLogin;
  $('#set-login').disabled = !(S.platform === 'darwin' || S.platform === 'win32');
  $('#set-starthidden').checked = !!s.startHidden;
  $('#set-shortcuts').checked = !!s.globalShortcuts;
  $('#set-shortcut-compact').value = s.shortcutCompact || '';
  $('#set-shortcut-compact').placeholder = S.defaultShortcuts.compact;
  $('#set-shortcut-type').value = s.shortcutType || '';
  $('#set-shortcut-type').placeholder = S.defaultShortcuts.type;
  $('#set-pinnedhotkeys').checked = !!s.pinnedHotkeys;
  $('#set-volumehotkeys').checked = !!s.volumeHotkeys;
  $('#set-adbauto').checked = !!s.adbAuto;
  $('#set-mediakeys').checked = !!s.mediaKeys;
  $('#set-popkeyboard').checked = !!s.popOnKeyboard;
  $('#set-ontop').checked = !!s.compactAlwaysOnTop;
  $('#set-icons').checked = !!s.fetchIcons;
  $('#set-textmode').value = s.textMode || 'auto';
  $('#set-localonly').checked = !!s.localOnly;
  $('#set-autoupdate').checked = !!s.autoUpdateCheck;
  $('#set-autoupdate').disabled = !!s.localOnly;
  $('#set-icons').disabled = !!s.localOnly;
  $('#set-encrypt').checked = !!s.encryptCredentials;
  $('#set-clipoffers').checked = !!s.clipboardOffers;
  $('#set-notify').checked = !!s.notifyPlayback;
  $('#set-activity').checked = !!s.showActivity;
  renderCredentialNote(s);
  $('#set-clipoffers-note').textContent = S.platform === 'darwin' ? 'macOS may ask once to allow reading the clipboard' : 'When the window comes to the front';
  renderUpdate();
  setSettingsTab(tab || S.settingsTab || 'general');
  openSheet('#sheet-settings');
}

function openHelp() {
  $('#help-global-compact').textContent = S.settings.shortcutCompact || S.defaultShortcuts.compact;
  $('#help-global-type').textContent = S.settings.shortcutType || S.defaultShortcuts.type;
  openSheet('#sheet-help');
}

/* ---------------- developer tools (ADB) ---------------- */

async function openDevSheet(apkPath) {
  if (!S.target) return toast('Pick a device first', 'error');
  if (!hasAndroid()) return toast('Installing apps works on Android TV and Google TV devices', 'error');
  $('#dev-name').textContent = targetName(S.target);
  $('#apk-status').textContent = '';
  $('#adb-connect-status').textContent = '';
  $('#adb-shot').classList.add('hidden');
  openSheet('#sheet-dev');
  renderAdb();
  S.adb = await controller.adb.status();
  renderAdb();
  if (apkPath) installApk(apkPath);
}
function renderAdb() {
  const st = S.adb;
  const box = $('#adb-download-box');
  const prog = $('#adb-progress');
  if (!st) { $('#adb-status').textContent = 'Checking for ADB…'; return; }
  if (st.downloading !== undefined) {
    prog.classList.remove('hidden');
    prog.firstElementChild.style.width = st.downloading + '%';
    $('#adb-status').textContent = `Downloading platform‑tools… ${st.downloading}%`;
    box.classList.add('hidden');
    return;
  }
  prog.classList.add('hidden');
  if (st.available) {
    const where = st.source === 'managed' ? 'the copy this app downloaded' : st.source === 'path' ? 'your PATH' : st.path;
    $('#adb-status').textContent = `ADB ${st.version || ''} is ready · ${where}`;
    box.classList.add('hidden');
  } else {
    $('#adb-status').textContent = st.error ? `Download failed: ${st.error}` : 'ADB is not on this computer. Download Google’s platform‑tools (about 10 MB), or point to an adb you already have.';
    box.classList.remove('hidden');
    $('#adb-terms').checked = !!S.settings.adbTermsAccepted;
    $('#adb-download').disabled = !S.settings.adbTermsAccepted;
  }
  for (const id of ['#adb-connect', '#apk-choose', '#adb-screenshot', '#adb-refresh-apps', '#adb-live']) $(id).disabled = !st.available;
}
async function installApk(apkPath) {
  if (!S.target) return;
  if (!$('#sheet-dev').classList.contains('hidden') === false) await openDevSheet();
  if (!S.adb?.available) { $('#apk-status').textContent = 'Set up ADB first (step 1).'; return; }
  $('#apk-status').textContent = `Installing ${basename(apkPath)} on ${targetName(S.target)}… If the TV asks, choose Allow.`;
  try {
    const r = await controller.adb.install(S.target, apkPath);
    $('#apk-status').textContent = r.message;
    toast(r.message, r.ok ? '' : 'error');
    if (r.ok) loadApps(true);
  } catch (err) {
    $('#apk-status').textContent = err.message;
    showErr(err);
  }
}

/* ---------------- init ---------------- */

async function init() {
  S.platform = await controller.app.platform();
  S.mod = S.platform === 'darwin' ? '⌘' : 'Ctrl+';
  if (S.platform !== 'darwin') document.body.classList.add('not-mac');
  if (S.platform === 'win32') document.body.classList.add('win');
  $$('[data-mod]').forEach((k) => (k.textContent = (S.platform === 'darwin' ? '⌘' : 'Ctrl+') + (k.textContent.startsWith('⌥') ? (S.platform === 'darwin' ? '⌥' : 'Alt+') + k.textContent.slice(1) : k.textContent)));
  S.defaultShortcuts = await controller.app.defaultShortcuts();
  S.settings = await controller.settings.get();
  document.body.classList.toggle('reduce-motion', !!S.settings.reduceMotion);
  applyTheme();
  S.rooms = await controller.rooms.list();
  S.devices = await controller.discovery.list();
  S.scan = await controller.discovery.status();
  S.update = await controller.update.status();
  S.sleep = await controller.app.sleepStatus();
  S.activity = await controller.device.activity();
  $('#settings-about').textContent = `TV Controller ${await controller.app.version()}`;
  renderAll();
  controller.adb.status().then((st) => { S.adb = st; }).catch(() => undefined);
  // Don't offer a link that was already on the clipboard before the app opened (only read it when offers are on).
  if (S.settings.clipboardOffers) { try { S.lastClipOffer = ((await controller.app.readClipboard()) || '').trim(); } catch { /* clipboard unavailable */ } }
  // Just updated: one line, with a way to see what changed.
  const version = await controller.app.version();
  if (S.settings.lastRunVersion && S.settings.lastRunVersion !== version) {
    toastAction(`Updated to ${version}`, 'What’s new', () => controller.app.openExternal(`https://github.com/thesiyonara/tv-controller/releases/tag/v${version}`), 12000);
  }
  if (S.settings.lastRunVersion !== version) controller.settings.set({ lastRunVersion: version }).then((s) => (S.settings = s));

  controller.discovery.onUpdate((devices) => { S.devices = devices; renderDevices(); renderHeader(); renderScanStatus(); });
  controller.discovery.onStatus((st) => { S.scan = st; renderScanStatus(); });
  controller.rooms.onUpdate((rooms) => { S.rooms = rooms; renderDevices(); });
  controller.settings.onHistory((history) => { if (S.settings) { S.settings.watchHistory = history; renderContinue(); } });
  controller.update.onStatus((u) => { S.update = u; renderUpdate(); });
  controller.adb.onStatus((st) => { S.adb = st; renderAdb(); });
  controller.app.onSleep((t) => { S.sleep = t; renderSleep(); });
  controller.device.onActivity(pushActivity);
  controller.device.onScreen((id, frame) => {
    if (frame) S.frames[id] = frame; else delete S.frames[id];
    const r = resolve(S.target);
    if (!r || !r.all.includes(id)) return;
    const img = $('#now-art img.frame');
    if (frame && frame !== 'blank' && img) img.src = frame; else renderNow();
  });
  setInterval(tickActivityTimes, 10000);
  window.addEventListener('focus', () => setTimeout(offerClipboard, 150));
  controller.device.onState((st) => {
    const prev = S.states[st.id];
    S.states[st.id] = st;
    const r = resolve(S.target);
    if (r && r.all.includes(st.id)) {
      renderHeader(); renderNow(); renderRemote();
      if (prev?.currentApp?.id !== st.currentApp?.id) renderApps();
      // Volume changed from the TV's own remote: show the same on-screen level we show for our keys.
      const vp = prev?.volume, vn = st.volume;
      const audioId = S.states[r.audio]?.volume ? r.audio : r.primary;
      if (vp && vn && st.id === audioId && ((vp.absolute ?? Math.round(vp.level * 100)) !== (vn.absolute ?? Math.round(vn.level * 100)) || vp.muted !== vn.muted) && Date.now() - S.lastVolumeAction > 1500 && document.visibilityState === 'visible') volumeOsd();
      if (prev?.state === 'connected' && st.state !== 'connected') renderActivity();
      // ADB just started reporting for this TV: swap the catalog for the TV's own app list.
      if (!prev?.liveView && st.liveView && st.kind === 'androidtv' && (S.apps[S.target] || [])[0]?.source !== 'device') loadApps(true);
      if (st.state === 'connected' && prev?.state !== 'connected') {
        if (S.pairing?.id === st.id) { S.pairing = null; closeSheets(); toast('Paired'); }
        loadApps(false);
      }
      if (st.state === 'error' && S.pairing?.id === st.id) $('#pair-error').textContent = st.error || 'Failed';
      else if (st.state === 'error' && st.error && prev?.error !== st.error) showErr(new Error(st.error));
    }
    renderDevices();
  });
  controller.device.onPairingRequested((id, how) => showPairing(id, how));
  controller.device.onKeyboardOpened((id, field) => { const r = resolve(S.target); if (r && r.all.includes(id)) openTypeSheet(field, 'tv'); });
  controller.app.onCommand((cmd) => {
    if (cmd === 'compact:on' || cmd === 'compact:off') { S.compact = cmd === 'compact:on'; document.body.classList.toggle('compact', S.compact); return; }
    if (cmd === 'type:open') return openTypeSheet();
    if (cmd === 'settings:open') return openSettings(cmd === 'settings:open' && S.update && S.update.state !== 'idle' && S.update.state !== 'uptodate' ? 'updates' : undefined);
    if (cmd === 'help:open') return openHelp();
    if (cmd.startsWith('pinned:')) {
      const target = S.target || S.settings.lastTarget;
      const id = ((S.settings.pinnedApps && S.settings.pinnedApps[target]) || [])[Number(cmd.slice(7))];
      if (id && target) { if (!S.target) open(target); launch(id); }
      return;
    }
    if (cmd.startsWith('key:')) return sendKey(cmd.slice(4));
  });

  // Title bar
  $('#device-picker').onclick = (e) => {
    const rooms = S.rooms.filter((r) => !r.id.startsWith('auto-'));
    const items = [
      ...rooms.map((r) => ({ label: ('room:' + r.id === S.target ? '✓ ' : '') + r.name, run: () => open('room:' + r.id) })),
      ...groupsByHost().filter((g) => !g.entries.some((x) => inSavedRoom(x, rooms))).map((g) => ({ label: (targetForGroup(g) === S.target ? '✓ ' : '') + g.name, run: () => open(targetForGroup(g)) })),
    ];
    if (!items.length) items.push({ label: 'No TVs found yet', run: () => {} });
    contextMenu(e, items, e.currentTarget);
  };
  $('#type-bar').onclick = () => openTypeSheet();
  $('#btn-keyboard').onclick = () => openTypeSheet(undefined, 'tv');
  $('#now-live').onclick = toggleLive;
  $('#now-more').onclick = (e) => nowMenu(e, e.currentTarget);
  $('#now-card').oncontextmenu = (e) => { if (!S.target) return; e.preventDefault(); nowMenu(e); };

  $('#adb-live').onclick = () => { closeSheets(); toggleLive(); };
  $('#btn-compact').onclick = () => controller.app.setCompact(!S.compact);
  $('#btn-settings').onclick = () => openSettings();
  $('#btn-help').onclick = openHelp;
  $('#welcome-scan').onclick = () => $('#btn-deepscan').click();
  $('#btn-rescan').onclick = () => { controller.discovery.rescan(false); toast('Looking for TVs…'); };
  $('#btn-devtools').onclick = (e) => contextMenu(e, [
    { label: 'Scan the network', run: () => { controller.discovery.rescan(true); S.toolsOpen = true; renderDevices(); } },
    { label: 'Add by IP address…', run: () => { S.toolsOpen = true; renderDevices(); $('#manual').open = true; $('#manual-host').focus(); } },
    { label: 'Discovery details…', run: () => { renderDiag(); openSheet('#sheet-diag'); } },
    ...(S.toolsOpen ? [{ label: 'Hide these controls', run: () => { S.toolsOpen = false; renderDevices(); } }] : []),
  ], e.currentTarget);
  $('#btn-link').onclick = () => {
    const s = linkSuggestion();
    const box = s?.box || S.devices.find((d) => d.kind === 'androidtv') || S.devices.find((d) => KEYS_KINDS.includes(d.kind));
    if (!box) return toast('Nothing to link yet: no streaming box found', 'error');
    openRoomEditor({ primary: box.id, audio: s?.tv.id });
  };
  $('#vol-via').onclick = (e) => {
    e.stopPropagation();
    if (!S.target) return;
    const r = resolve(S.target);
    const candidates = S.devices.filter((d) => d.id !== r.primary && (TV_KINDS.includes(d.kind) || d.kind === 'roku' || (d.kind === 'cast' && d.host !== device(r.primary)?.host)));
    const items = candidates.map((d) => ({ label: `${d.id === r.audio ? '✓ ' : ''}${displayName(d)} · ${KIND_LABEL[d.kind]}`, run: () => linkDevices(r.primary, d.id, r.room && !r.room.id.startsWith('auto-') ? r.room.name : undefined) }));
    items.push({ label: `${r.audio === r.primary ? '✓ ' : ''}${device(r.primary) ? displayName(device(r.primary)) : 'This device'} (HDMI‑CEC)`, run: () => linkDevices(r.primary, undefined, r.room && !r.room.id.startsWith('auto-') ? r.room.name : undefined) });
    if (!candidates.length) items.unshift({ label: 'No TV found to route volume to yet', run: () => {} });
    contextMenu(e, items, e.currentTarget);
  };
  $('#btn-deepscan').onclick = () => controller.discovery.rescan(true);
  $('#btn-diag').onclick = () => { renderDiag(); openSheet('#sheet-diag'); };
  $('#diag-rescan').onclick = () => controller.discovery.rescan(true);
  $('#diag-localnet').onclick = () => controller.app.openLocalNetworkSettings();
  $('#manual-add').onclick = async () => {
    const host = $('#manual-host').value.trim();
    if (!host) return;
    const d = await controller.discovery.addManual($('#manual-kind').value, host);
    $('#manual-host').value = '';
    open(d.id);
  };
  $('#manual-host').addEventListener('keydown', (e) => e.key === 'Enter' && $('#manual-add').click());

  // Each physical press has one release, including cancellation and window changes.
  S.remotePresses = $$('button[data-key]').map((button) => bindRemotePress(button, {
    target: () => S.target,
    send: (target, direction) => sendKey(button.dataset.key, direction, target),
  }));
  $('#btn-numpad').onclick = () => { S.numpad = !S.numpad; renderRemote(); };
  $('#btn-keymode').onclick = () => setKeyMode(!S.keyMode);
  $('#btn-remote-tools').onclick = openRemoteTools;
  $('#pins-manage').onclick = () => { S.remoteToolsTab = 'pins'; openRemoteTools(); };
  $$('.tools-tabs button').forEach((button) => {
    button.onclick = () => setRemoteToolsTab(button.dataset.toolsTab);
    button.onkeydown = (e) => {
      const tabs = $$('.tools-tabs button').filter((b) => !b.classList.contains('hidden'));
      let index = tabs.indexOf(button);
      if (e.key === 'ArrowRight') index = (index + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
      else if (e.key === 'Home') index = 0;
      else if (e.key === 'End') index = tabs.length - 1;
      else return;
      e.preventDefault(); setRemoteToolsTab(tabs[index].dataset.toolsTab); tabs[index].focus();
    };
  });
  $('#playback-reconnect').onclick = async () => { closeSheets(); await setLive({ media: true, screen: !!activeState()?.liveView?.screen }); };
  $$('[data-sleep-minutes]').forEach((b) => b.onclick = () => setRemoteSleep(Number(b.dataset.sleepMinutes)));
  $('#sleep-form').onsubmit = (e) => {
    e.preventDefault();
    const minutes = Number($('#sleep-minutes').value);
    if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440) setRemoteSleep(minutes);
  };
  $$('[data-edit-corner]').forEach((select) => select.onchange = async () => {
    try {
      await saveSettings({ corners: { ...(S.settings.corners || {}), [select.dataset.editCorner]: JSON.parse(select.value) } });
      renderCorners(); $('#corners-reset').disabled = false;
    } catch (err) { showErr(err); renderCornerChoices(); }
  });
  $('#corners-reset').onclick = async () => {
    try { await saveSettings({ corners: {} }); renderCorners(); renderCornerChoices(); } catch (err) { showErr(err); }
  };
  for (const b of $$('.remote [data-skip]')) {
    b.onclick = () => {
      if (!S.target) return;
      b.classList.add('pressed'); setTimeout(() => b.classList.remove('pressed'), 140);
      controller.device.skip(S.target, Number(b.dataset.skip)).catch(showErr);
    };
  }
  for (const b of $$('.remote .corner')) {
    b.onclick = () => { b.classList.add('pressed'); setTimeout(() => b.classList.remove('pressed'), 140); runCorner(b.dataset.corner); };
    b.oncontextmenu = (e) => { e.preventDefault(); if (S.target) cornerMenu(e, b.dataset.corner); };
  }
  let volTimer = null;
  $('#vol-slider').oninput = (e) => {
    clearTimeout(volTimer);
    S.lastVolumeAction = Date.now();
    const level = Number(e.target.value) / 100;
    $('#vol-label').textContent = Math.round(level * 100) + '%';
    volTimer = setTimeout(() => controller.device.setVolume(S.target, level).catch(showErr), 80);
  };
  $('#volume-box').addEventListener('wheel', (e) => { e.preventDefault(); sendKey(e.deltaY < 0 ? 'VOLUME_UP' : 'VOLUME_DOWN'); }, { passive: false });
  $('button[data-key="POWER"]').oncontextmenu = (e) => { e.preventDefault(); if (!S.target) return; contextMenu(e, [
    ...[15, 30, 60, 90].map((m) => ({ label: `Turn off in ${m} min`, run: () => setRemoteSleep(m) })),
    ...(S.sleep ? [{ label: 'Cancel sleep timer', run: () => controller.app.sleepTimer(S.sleep.target, null).then(() => { S.sleep = null; renderSleep(); }) }] : []),
  ]); };
  $('#sleep-cancel').onclick = () => controller.app.sleepTimer(S.sleep?.target || S.target, null).then(() => { S.sleep = null; renderSleep(); }).catch(showErr);
  setInterval(renderSleep, 30000);

  // Now playing
  $$('#now-card button[data-media]').forEach((b) => (b.onclick = () => {
    const a = b.dataset.media === 'toggle' ? (activeState()?.media?.playerState === 'PLAYING' ? 'pause' : 'play') : b.dataset.media;
    controller.device.media(S.target, a).catch(showErr);
  }));
  $('#cnow-toggle').onclick = () => {
    const st = activeState();
    if (st?.media) controller.device.media(S.target, st.media.playerState === 'PLAYING' ? 'pause' : 'play').catch(showErr);
    else sendKey('PLAY_PAUSE');
  };
  const seek = $('#now-seek');
  const previewSeek = () => {
    seekPreview = { identity: seekIdentity(activeState()?.media), value: Number(seek.value) };
    $('#now-bar').style.width = (Number(seek.value) / Number(seek.max)) * 100 + '%';
    $('#now-pos').textContent = fmtTime(Number(seek.value));
    seek.setAttribute('aria-valuetext', `${fmtTime(Number(seek.value))} of ${fmtTime(Number(seek.max))}`);
  };
  const commitSeek = () => {
    if (seek.disabled || !seekPreview || seekPreview.identity !== seekIdentity(activeState()?.media)) { seekPreview = null; tickProgress(); return; }
    const pending = seekPreview;
    pending.until = Date.now() + 3000;
    controller.device.seek(S.target, pending.value).catch((err) => { if (seekPreview === pending) seekPreview = null; tickProgress(); showErr(err); });
  };
  seek.oninput = previewSeek;
  seek.onchange = commitSeek;
  seek.onblur = () => { if (seekPreview && !seekPreview.until) { seekPreview = null; tickProgress(); } };
  seek.onkeydown = (e) => {
    const steps = { ArrowLeft: -10, ArrowDown: -10, ArrowRight: 10, ArrowUp: 10, PageDown: -60, PageUp: 60 };
    if (!(e.key in steps) && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    seek.value = String(e.key === 'Home' ? 0 : e.key === 'End' ? Number(seek.max) : Math.max(0, Math.min(Number(seek.max), Number(seek.value) + steps[e.key])));
    previewSeek(); commitSeek();
  };
  setInterval(tickProgress, 1000);

  // Apps
  $('#apps-filter').oninput = renderApps;
  $('#apps-clear').onclick = () => { $('#apps-filter').value = ''; renderApps(); $('#apps-filter').focus(); };
  $$('.app-scopes button').forEach((b) => b.onclick = () => { S.appScope = b.dataset.scope; renderApps(); });
  $('#apps-refresh').onclick = () => { toast('Refreshing apps…'); loadApps(true); };
  $('#apps-install').onclick = () => openDevSheet();

  // Type / search sheet
  $$('#type-tabs .tab').forEach((b) => (b.onclick = () => { setSearchTab(b.dataset.tab); $('#type-input').focus(); }));
  let liveTimer = null;
  $('#type-input').addEventListener('input', (e) => {
    if (S.searchTab !== 'tv') return runSearch();
    if (!$('#type-live').checked) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => sendText(e.target.value, true), 250);
  });
  $('#type-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitSheet(); }
    else if (e.key === 'Escape') closeSheets();
    else if (e.key === 'Tab') { e.preventDefault(); const tabs = visibleTabs(); setSearchTab(tabs[(tabs.indexOf(S.searchTab) + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length]); }
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && S.results.length) { e.preventDefault(); S.selectedResult = (S.selectedResult + (e.key === 'ArrowDown' ? 1 : -1) + S.results.length) % S.results.length; renderResults(); }
  });
  $('#type-send').onclick = submitSheet;
  $('#type-destination').onchange = (e) => { setSearchTab(e.target.value); $('#type-input').focus(); };
  $('#type-clear').onclick = () => controller.device.clearText(S.target, ($('#type-ontv-value').textContent || '').length || 30).catch(showErr);
  $('#clip-paste').onclick = async () => sendText((await controller.app.readClipboard()).trim());
  $('#clip-open').onclick = async () => playLink((await controller.app.readClipboard()).trim());

  // Pairing
  $('#pair-submit').onclick = async () => {
    const code = $('#pair-code').value.trim();
    if (code.length !== 6) return ($('#pair-error').textContent = 'The code has 6 characters.');
    $('#pair-error').textContent = '';
    try { await controller.device.sendPairingCode(S.pairing.id, code); } catch (err) { $('#pair-error').textContent = err.message; }
  };
  $('#pair-code').addEventListener('keydown', (e) => e.key === 'Enter' && $('#pair-submit').click());

  // Settings
  $$('#set-theme button').forEach((b) => (b.onclick = () => saveSettings({ theme: b.dataset.theme }).then(() => $$('#set-theme button').forEach((x) => x.classList.toggle('active', x === b)))));
  $$('#sheet-settings .stab').forEach((b) => (b.onclick = () => setSettingsTab(b.dataset.stab)));
  $('#set-open-help').onclick = () => { closeSheets(); openHelp(); };
  $('#now-open').onclick = () => { const l = mediaLink(activeState()?.media); if (l) controller.app.openExternal(l); };
  $('#set-palette').onchange = (e) => saveSettings({ palette: e.target.value });
  $$('#set-accent button').forEach((b) => (b.onclick = () => saveSettings({ accent: b.dataset.accent }).then(() => $$('#set-accent button').forEach((x) => x.classList.toggle('active', x === b)))));
  for (const [id, key] of [['#set-shortcuts', 'globalShortcuts'], ['#set-mediakeys', 'mediaKeys'], ['#set-ontop', 'compactAlwaysOnTop'], ['#set-icons', 'fetchIcons'], ['#set-motion', 'reduceMotion'], ['#set-pinnedhotkeys', 'pinnedHotkeys'], ['#set-popkeyboard', 'popOnKeyboard'], ['#set-login', 'openAtLogin'], ['#set-starthidden', 'startHidden'], ['#set-localonly', 'localOnly'], ['#set-autoupdate', 'autoUpdateCheck'], ['#set-encrypt', 'encryptCredentials'], ['#set-clipoffers', 'clipboardOffers'], ['#set-notify', 'notifyPlayback'], ['#set-activity', 'showActivity'], ['#set-volumehotkeys', 'volumeHotkeys'], ['#set-adbauto', 'adbAuto']]) {
    $(id).onchange = (e) => saveSettings({ [key]: e.target.checked }).then(() => { if (key === 'localOnly') { $('#set-autoupdate').disabled = e.target.checked; $('#set-icons').disabled = e.target.checked; } if (key === 'showActivity') renderActivity(); if (key === 'encryptCredentials') renderCredentialNote(S.settings); });
  }
  $('#set-textmode').onchange = (e) => saveSettings({ textMode: e.target.value });
  $('#set-shortcut-compact').onchange = (e) => saveSettings({ shortcutCompact: e.target.value.trim() });
  $('#set-shortcut-type').onchange = (e) => saveSettings({ shortcutType: e.target.value.trim() });
  $('#set-clear-history').onclick = () => saveSettings({ watchHistory: [] }).then(() => toast('Cleared'));
  $('#set-logs').onclick = () => controller.app.openLogs();
  $('#set-check-update').onclick = async () => {
    const u = S.update;
    if (u && (u.state === 'available' || u.state === 'ready')) return controller.update.apply().catch(showErr);
    $('#settings-update').textContent = 'Checking…';
    S.update = await controller.update.check();
    renderUpdate();
    toast(updateStatusText(S.update) || 'Checked', S.update?.state === 'error' ? 'error' : undefined);
  };
  $('#update-action').onclick = () => controller.update.apply().catch(showErr);
  $('#update-dismiss').onclick = () => { S.updateDismissed = true; renderUpdate(); };

  // Developer tools
  $('#adb-terms').onchange = (e) => { saveSettings({ adbTermsAccepted: e.target.checked }); $('#adb-download').disabled = !e.target.checked; };
  $('#adb-terms-link').onclick = (e) => { e.preventDefault(); controller.app.openExternal(e.target.href); };
  $('#adb-download').onclick = async () => { try { S.adb = await controller.adb.download(); renderAdb(); toast('ADB is ready'); } catch (err) { showErr(err); S.adb = await controller.adb.status(); renderAdb(); } };
  $('#adb-pick').onclick = async () => { const st = await controller.adb.pick(); if (st) { S.adb = st; renderAdb(); toast(st.available ? 'ADB is ready' : 'That file did not answer as adb', st.available ? '' : 'error'); } };
  $('#adb-connect').onclick = async () => {
    $('#adb-connect-status').textContent = 'Connecting…';
    try {
      const r = await controller.adb.connect(S.target);
      $('#adb-connect-status').textContent = r.state === 'connected' ? `${r.message} The TV's own app list and playback reporting are on from now on.` : r.message;
      if (r.state === 'connected') { loadApps(true); if (!activeState()?.liveView) setLive({ media: true, screen: false }); }
    } catch (err) {
      $('#adb-connect-status').textContent = errText(err);
    }
  };
  $('#apk-choose').onclick = async () => { const p = await controller.adb.pickApk(); if (p) installApk(p); };
  $('#adb-screenshot').onclick = async () => {
    const box = $('#adb-shot');
    box.classList.remove('hidden'); box.innerHTML = '<div class="muted small" style="padding:12px">Capturing…</div>';
    try { const url = await controller.adb.screenshot(S.target); box.innerHTML = `<img src="${url}" alt="TV screenshot">`; } catch (err) { box.innerHTML = `<div class="muted small" style="padding:12px">${esc(err.message)}</div>`; }
  };
  $('#adb-refresh-apps').onclick = () => { toast('Reading the app list from the TV…'); loadApps(true); };
  const dz = $('#apk-drop');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('over'); const f = [...e.dataTransfer.files].find((x) => /\.apk$/i.test(x.name)); if (f) installApk(controller.app.pathForFile(f)); else toast('Drop an .apk file', 'error'); });

  // Drop anywhere: links play, text is typed, .apk files install
  const hint = $('#drop-hint');
  document.addEventListener('dragenter', (e) => { e.preventDefault(); S.dragDepth++; hint.classList.remove('hidden'); });
  document.addEventListener('dragleave', () => { S.dragDepth = Math.max(0, S.dragDepth - 1); if (!S.dragDepth) hint.classList.add('hidden'); });
  document.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    S.dragDepth = 0; hint.classList.add('hidden');
    const apk = [...(e.dataTransfer.files || [])].find((f) => /\.apk$/i.test(f.name));
    if (apk) return openDevSheet(controller.app.pathForFile(apk));
    const t = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').trim().split('\n')[0];
    if (!t) return;
    if (isUrl(t)) playLink(t); else sendText(t);
  });

  // Close buttons / overlays
  $$('[data-close]').forEach((b) => (b.onclick = () => {
    if (S.pairing && !$('#sheet-pair').classList.contains('hidden')) { controller.device.disconnect(S.pairing.id); S.pairing = null; }
    closeSheets();
  }));
  $$('.overlay').forEach((o) => o.addEventListener('mousedown', (e) => e.target === o && closeSheets()));

  // Global keyboard
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Tab' && anySheetOpen()) {
      const overlay = $$('.overlay').find((o) => !o.classList.contains('hidden'));
      const items = [...overlay.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')].filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
      const first = items[0], last = items[items.length - 1];
      if (!first) { e.preventDefault(); return; }
      if (!overlay.contains(document.activeElement) || (!e.shiftKey && document.activeElement === last)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      return;
    }
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName);
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); return openTypeSheet(); }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); return setKeyMode(!S.keyMode); }
    if (keyModeKey(e)) return;
    if (mod && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); return controller.app.setCompact(!S.compact); }
    if (mod && e.key.toLowerCase() === 'v' && !typing && S.target) {
      e.preventDefault();
      controller.app.readClipboard().then((t) => { t = (t || '').trim(); if (!t) return; if (isUrl(t)) playLink(t); else sendText(t); });
      return;
    }
    if (e.key === 'Escape' && $$('.ctx').length) { $$('.ctx').forEach((c) => c.remove()); return; }
    if (e.key === 'Escape' && anySheetOpen()) { e.preventDefault(); closeSheets(); return; }
    if (typing) return;
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('button, [role="button"]')) return;
    if (e.key === '?' && !anySheetOpen()) { e.preventDefault(); return openHelp(); }
    if (!S.target || anySheetOpen()) return;
    if ((e.key === 'l' || e.key === 'L') && !mod && hasAndroid() && !activeState()?.imeOpen) { e.preventDefault(); return toggleLive(); }
    const key = KEYBOARD_MAP[e.key];
    // While the TV shows its keyboard, plain typing goes straight into the sheet (and so to the TV).
    if (!key && !mod && !e.altKey && e.key.length === 1 && activeState()?.imeOpen && activeState()?.state === 'connected') {
      e.preventDefault();
      openTypeSheet(activeState().imeField || { value: '' }, 'tv').then(() => { $('#type-input').value = e.key; });
      return;
    }
    if (key) { e.preventDefault(); sendKey(key); }
  });

  // Restore last target
  S.compact = await controller.app.isCompact();
  document.body.classList.toggle('compact', S.compact);
  const last = S.settings.lastTarget;
  if (last && (last.startsWith('room:') ? S.rooms.some((r) => 'room:' + r.id === last) : device(last))) open(last);
}

$('#btn-compact-more').addEventListener('click', () => {
  const expanded = document.body.classList.toggle('compact-expanded');
  $('#btn-compact-more').setAttribute('aria-expanded', String(expanded));
  $('#btn-compact-more').textContent = expanded ? 'Fewer controls' : 'More controls';
});
init();
