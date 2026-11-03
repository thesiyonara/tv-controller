// Activity feed derivation (pure state diffs) and the ADB media_session parser.
const assert = require('assert');
const { diffState, prettyPackage, ActivityLog } = require('../dist/main/activity.js');
const { parseMediaSessions, pickSession, toMedia } = require('../dist/main/live.js');

const base = { id: 'androidtv:1', kind: 'androidtv', host: '1', state: 'connected' };
const kinds = (prev, next) => diffState(prev, next).map((e) => e.kind + ':' + e.text + (e.detail ? ' (' + e.detail + ')' : ''));

assert.deepStrictEqual(kinds(undefined, { ...base, model: 'Chromecast', vendor: 'Google' }), ['connect:Connected (Google Chromecast)']);
assert.deepStrictEqual(kinds({ ...base, state: 'connecting' }, base), ['connect:Connected']);
assert.deepStrictEqual(kinds(base, { ...base, state: 'disconnected' }), ['disconnect:Disconnected']);
assert.deepStrictEqual(kinds(base, { ...base, state: 'error', error: 'boom' }), ['disconnect:Connection lost (boom)']);
assert.deepStrictEqual(kinds({ ...base, state: 'disconnected' }, { ...base, state: 'pairing' }), ['pairing:Waiting for you to allow it on the TV']);
assert.deepStrictEqual(kinds(base, { ...base, currentApp: { id: 'com.netflix.ninja' } }), ['app:Opened Netflix']);
assert.deepStrictEqual(kinds({ ...base, currentApp: { id: 'x', name: 'YouTube' } }, base), ['app:Home screen']);
assert.deepStrictEqual(kinds({ ...base, powered: true }, { ...base, powered: false }), ['power:Went to standby']);
const playing = { ...base, media: { title: 'Severance', subtitle: 'S2 E3', contentId: '81', playerState: 'PLAYING' } };
assert.deepStrictEqual(kinds(base, playing), ['play:Playing (Severance · S2 E3)']);
assert.deepStrictEqual(kinds(playing, { ...playing, media: { ...playing.media, playerState: 'PAUSED' } }), ['pause:Paused (Severance · S2 E3)']);
assert.deepStrictEqual(kinds({ ...playing, media: { ...playing.media, playerState: 'PAUSED' } }, playing), ['play:Resumed (Severance · S2 E3)']);
assert.deepStrictEqual(kinds(playing, { ...playing, media: { ...playing.media, playerState: 'IDLE' } }), ['stop:Finished (Severance · S2 E3)']);
assert.deepStrictEqual(kinds(playing, base), ['stop:Stopped (Severance · S2 E3)']);
assert.deepStrictEqual(kinds(playing, { ...playing, media: { ...playing.media, currentTime: 99 } }), [], 'progress alone is not an event');
const vol = (a, muted = false) => ({ ...base, volume: { level: a / 100, muted, absolute: a, max: 100 } });
assert.deepStrictEqual(kinds(vol(10), vol(12)), ['volume:Volume 12']);
assert.deepStrictEqual(kinds(vol(10), vol(10, true)), ['mute:Muted']);
assert.deepStrictEqual(kinds(base, vol(10)), [], 'first volume report is not an event');
assert.deepStrictEqual(kinds(base, { ...base, imeOpen: true, imeField: { value: '', start: 0, end: 0, label: 'Search' } }), ['keyboard:Keyboard open on the TV (Search)']);
assert.deepStrictEqual(kinds(base, { ...base, channel: { number: '5', name: 'BBC One', program: 'News' } }), ['channel:Channel 5 BBC One (News)']);
// a disconnect swallows the consequences (media cleared, keyboard closed)
assert.deepStrictEqual(kinds({ ...playing, imeOpen: true }, { ...base, state: 'disconnected' }), ['disconnect:Disconnected']);

assert.strictEqual(prettyPackage('tv.twitch.android.app'), 'Twitch');
assert.strictEqual(prettyPackage('com.plexapp.android'), 'Plexapp');
assert.strictEqual(prettyPackage('Netflix'), 'Netflix');

const log = new ActivityLog();
const seen = [];
log.on('event', (e) => seen.push(e.id));
log.observe(vol(10), vol(11));
log.observe(vol(11), vol(12));
log.add({ device: 'androidtv:1', kind: 'launch', dir: 'out', text: 'Open YouTube' });
assert.strictEqual(log.list().length, 2, 'volume steps coalesce');
assert.deepStrictEqual(seen, [1, 1, 2]);
assert.strictEqual(log.list()[0].text, 'Volume 12');
assert.deepStrictEqual(log.list(['other']), []);

const dump = `MEDIA SESSION SERVICE (dumpsys media_session)

  Sessions Stack - have 2 sessions:
    Plex com.plexapp.android/Plex (userId=0)
      ownerPid=1, ownerUid=10, userId=0
      package=com.plexapp.android
      active=true
      flags=3
      controllers: 1
      state=PlaybackState {state=3, position=125000, buffered position=0, speed=1.0, updated=5, actions=55, custom actions=[], active item id=-1, error=null}
      audioAttrs=null
      metadata: size=7, description=Big Buck Bunny, Blender, null
      queueTitle=null, size=0
    YouTube com.google.android.youtube.tv/YouTube (userId=0)
      package=com.google.android.youtube.tv
      active=false
      state=PlaybackState {state=PAUSED(2), position=10, buffered position=0, speed=0.0, updated=1, actions=0, custom actions=[], active item id=-1, error=null}
      metadata: size=5, description=Old video, Channel, null
`;
const sessions = parseMediaSessions(dump);
assert.strictEqual(sessions.length, 2);
assert.deepStrictEqual(sessions[0], { pkg: 'com.plexapp.android', active: true, state: 3, position: 125000, title: 'Big Buck Bunny', subtitle: 'Blender' });
assert.strictEqual(sessions[1].state, 2, 'PAUSED(2) form parsed');
const picked = pickSession(sessions);
assert.strictEqual(picked.pkg, 'com.plexapp.android');
const media = toMedia(picked);
assert.strictEqual(media.playerState, 'PLAYING');
assert.strictEqual(media.currentTime, 125);
assert.strictEqual(media.source, 'adb');
assert.strictEqual(pickSession([]), undefined);
console.log('activity: ok');

// Two protocols of one box reporting the same thing within seconds: one line.
{
  const l = new ActivityLog();
  l.add({ device: 'cast:1', kind: 'play', dir: 'in', text: 'Playing', detail: 'Severance' });
  l.add({ device: 'androidtv:1', kind: 'play', dir: 'in', text: 'Playing', detail: 'Severance' });
  l.add({ device: 'androidtv:1', kind: 'play', dir: 'in', text: 'Playing', detail: 'Other' });
  assert.strictEqual(l.list().length, 2, 'duplicate across devices dropped');
  console.log('activity dedupe: ok');
}
