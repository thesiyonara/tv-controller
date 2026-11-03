// Deep-link parsing and per-brand launch targets. Pure functions; no network, no devices.
const assert = require('assert');
const { parseLink, launchTargets, searchLink } = require('../dist/main/deeplink.js');

const cases = [
  ['https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=10', 'youtube', 'aqz-KE-bpKQ'],
  ['https://youtu.be/aqz-KE-bpKQ', 'youtube', 'aqz-KE-bpKQ'],
  ['https://m.youtube.com/shorts/abcdefghijk', 'youtube', 'abcdefghijk'],
  ['https://www.netflix.com/title/80057281', 'netflix', '80057281'],
  ['https://www.netflix.com/watch/81234567?trackId=1', 'netflix', '81234567'],
  ['https://www.twitch.tv/somechannel', 'twitch', 'somechannel'],
  ['https://example.com/x', 'web', undefined],
  ['not a url', 'web', undefined],
];
for (const [url, service, id] of cases) {
  const p = parseLink(url);
  assert.strictEqual(p.service, service, url);
  assert.strictEqual(p.id, id, url);
}
assert.strictEqual(parseLink('https://www.youtube.com/results?search_query=big+buck').query, 'big buck');

const yt = launchTargets(parseLink('https://youtu.be/aqz-KE-bpKQ'));
assert.strictEqual(yt.roku.appId, '837');
assert.strictEqual(yt.roku.params.contentId, 'aqz-KE-bpKQ');
assert.strictEqual(yt.samsung.metaTag, 'v=aqz-KE-bpKQ');
assert.strictEqual(yt.webos.contentId, 'aqz-KE-bpKQ');
assert.strictEqual(yt.cast.appId, '233637DE');

const nf = launchTargets(parseLink('https://www.netflix.com/title/80057281'));
assert.strictEqual(nf.roku.appId, '12');
assert.strictEqual(nf.samsung.metaTag, 'm=80057281');
assert.strictEqual(nf.webos.contentId, 'm=80057281');

assert.ok(searchLink('youtube', 'big buck bunny').url.includes('search_query=big%20buck%20bunny'));
assert.strictEqual(searchLink('plex', 'x'), undefined);
console.log('deeplink: ok');

// Stremio: search and detail deep links on the Android app
const st = parseLink('stremio:///search?search=the%20bear');
assert.strictEqual(st.service, 'stremio');
assert.strictEqual(st.query, 'the bear');
assert.strictEqual(launchTargets(st).android, 'stremio:///search?search=the%20bear');
assert.strictEqual(parseLink('https://web.strem.io/#/detail/series/tt14452776/tt14452776:1:1').id, 'tt14452776');
assert.ok(searchLink('stremio', 'the bear').url.startsWith('stremio:///search?search='));
console.log('deeplink stremio: ok');

// Play Store titles → app names; package guesses for Google TV system apps
const { playTitleToName } = require('../dist/main/icons.js');
const { guessName } = require('../dist/main/apps.js');
assert.strictEqual(playTitleToName('Netflix - Apps on Google Play'), 'Netflix');
assert.strictEqual(playTitleToName('YouTube TV: Live TV &amp; more - Apps on Google Play'), 'YouTube TV: Live TV & more');
assert.strictEqual(playTitleToName('Apps on Google Play'), undefined);
assert.strictEqual(guessName('com.android.vending'), 'Google Play Store');
assert.strictEqual(guessName('com.google.android.youtube.tvunplugged'), 'YouTube TV');
assert.strictEqual(guessName('com.example.airwave'), 'Airwave');
console.log('app names: ok');
