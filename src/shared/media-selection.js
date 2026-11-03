/* A foreground playback session beats a richer report left over from another app. */
(function (root) {
  const services = {
    CA5E8412: 'netflix', 'com.netflix.ninja': 'netflix', 'com.netflix.mediaclient': 'netflix',
    '233637DE': 'youtube', 'com.google.android.youtube.tv': 'youtube',
    'com.stremio.one': 'stremio', 'com.stremio': 'stremio',
    '9381F2BD': 'disney', 'com.disney.disneyplus': 'disney',
    '17608BC8': 'prime', 'com.amazon.amazonvideo.livingroom': 'prime',
  };
  const service = (id) => services[id] || id;
  function mediaScore(media) {
    return (media.title ? 4 : 0) + (media.duration ? 2 : 0) + (media.artwork ? 1 : 0) + (media.playerState === 'PLAYING' ? 1 : 0);
  }
  function selectMedia(states) {
    const connected = states.filter((state) => state && state.state === 'connected');
    const candidates = connected.map((state) => state.media).filter((media) => media && media.playerState !== 'IDLE');
    const android = connected.find((state) => state.kind === 'androidtv');
    const foreground = service(android?.currentApp?.id);
    const adb = candidates.find((media) => media.source === 'adb' && (!foreground || service(media.appId) === foreground || media.playerState === 'PLAYING' || media.playerState === 'BUFFERING'));
    const foregroundKnown = !!services[android?.currentApp?.id];
    const liveApp = adb ? service(adb.appId) : foreground;
    // Only compare known identities. Unknown Cast receivers remain eligible without an ADB report.
    const sameApp = liveApp ? candidates.filter((media) => service(media.appId) === liveApp) : [];
    const filtered = sameApp.length ? sameApp : candidates.filter((media) => !foregroundKnown || !services[media.appId] || service(media.appId) === foreground);
    return filtered.sort((a, b) => mediaScore(b) - mediaScore(a))[0];
  }
  const api = { selectMedia, mediaScore };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TVMedia = api;
})(typeof window === 'undefined' ? globalThis : window);
