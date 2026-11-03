/**
 * Deep links: turn a URL (from the clipboard, history, or a search result)
 * into something each TV brand can open straight into playback.
 *
 * Every brand has a different way to say "open YouTube at video X":
 *   Android TV  : app link  https://www.youtube.com/watch?v=X
 *   Roku        : /launch/837?contentId=X&mediaType=live
 *   Samsung     : ed.apps.launch appId 111299001912 metaTag "v=X"
 *   LG webOS    : system.launcher/launch { id: "youtube.leanback.v4", contentId: X }
 */

export type Service = 'youtube' | 'netflix' | 'disney' | 'prime' | 'spotify' | 'twitch' | 'plex' | 'max' | 'hulu' | 'appletv' | 'stremio' | 'web';

export interface ParsedLink {
  service: Service;
  url: string;
  /** Video / title id when the URL has one */
  id?: string;
  /** Free-text search when the URL is a search page */
  query?: string;
}

export interface LaunchTarget {
  android?: string; // app link
  roku?: { appId: string; params?: Record<string, string> };
  samsung?: { appId: string; metaTag?: string; type?: 'DEEP_LINK' | 'NATIVE_LAUNCH' };
  webos?: { id: string; contentId?: string; params?: Record<string, unknown> };
  cast?: { appId: string };
}

export const SERVICE_META: Record<Service, { name: string; androidPackage?: string; home: string; search?: (q: string) => string; color: string; initials: string }> = {
  youtube: { name: 'YouTube', androidPackage: 'com.google.android.youtube.tv', home: 'https://www.youtube.com', search: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, color: '#C4302B', initials: 'YT' },
  netflix: { name: 'Netflix', androidPackage: 'com.netflix.ninja', home: 'https://www.netflix.com/title', search: (q) => `https://www.netflix.com/search?q=${encodeURIComponent(q)}`, color: '#B20710', initials: 'N' },
  disney: { name: 'Disney+', androidPackage: 'com.disney.disneyplus', home: 'https://www.disneyplus.com', search: (q) => `https://www.disneyplus.com/search?q=${encodeURIComponent(q)}`, color: '#0F3E8C', initials: 'D+' },
  prime: { name: 'Prime Video', androidPackage: 'com.amazon.amazonvideo.livingroom', home: 'https://app.primevideo.com', search: (q) => `https://app.primevideo.com/search?phrase=${encodeURIComponent(q)}`, color: '#0F6E8C', initials: 'PV' },
  spotify: { name: 'Spotify', androidPackage: 'com.spotify.tv.android', home: 'spotify://', search: (q) => `spotify:search:${encodeURIComponent(q)}`, color: '#1A7F43', initials: 'Sp' },
  twitch: { name: 'Twitch', androidPackage: 'tv.twitch.android.app', home: 'https://www.twitch.tv', search: (q) => `https://www.twitch.tv/search?term=${encodeURIComponent(q)}`, color: '#5A3E9C', initials: 'Tw' },
  plex: { name: 'Plex', androidPackage: 'com.plexapp.android', home: 'plex://', color: '#8A6508', initials: 'Px' },
  max: { name: 'Max', androidPackage: 'com.hbo.hbonow', home: 'https://play.max.com', color: '#2F3FA8', initials: 'Mx' },
  hulu: { name: 'Hulu', androidPackage: 'com.hulu.livingroomplus', home: 'https://www.hulu.com', search: (q) => `https://www.hulu.com/search?q=${encodeURIComponent(q)}`, color: '#1F7A3E', initials: 'Hu' },
  appletv: { name: 'Apple TV', androidPackage: 'com.apple.atve.androidtv.appletv', home: 'https://tv.apple.com', color: '#3A3F4B', initials: 'TV' },
  // Stremio's Android TV app registers the stremio:// scheme; its routes mirror the web app (/search?search=…, /detail/…).
  stremio: { name: 'Stremio', androidPackage: 'com.stremio.one', home: 'stremio:///', search: (q) => `stremio:///search?search=${encodeURIComponent(q)}`, color: '#7B2CBF', initials: 'St' },
  web: { name: 'Link', home: '', color: '#3A3F4B', initials: '↗' },
};

/** Which service a URL belongs to, and the content id if any. */
export function parseLink(raw: string): ParsedLink {
  const url = raw.trim();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { service: 'web', url };
  }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  const path = u.pathname;

  if (host === 'youtu.be') return { service: 'youtube', url, id: path.slice(1).split('/')[0] };
  if (host.endsWith('youtube.com')) {
    if (path === '/watch') return { service: 'youtube', url, id: u.searchParams.get('v') ?? undefined };
    const m = /^\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{6,})/.exec(path);
    if (m) return { service: 'youtube', url, id: m[2] };
    if (path === '/results') return { service: 'youtube', url, query: u.searchParams.get('search_query') ?? undefined };
    return { service: 'youtube', url };
  }
  if (host.endsWith('netflix.com')) {
    const m = /\/(?:title|watch)\/(\d+)/.exec(path);
    if (m) return { service: 'netflix', url, id: m[1] };
    if (path.startsWith('/search')) return { service: 'netflix', url, query: u.searchParams.get('q') ?? undefined };
    return { service: 'netflix', url };
  }
  if (host.endsWith('disneyplus.com')) return { service: 'disney', url, id: /\/(?:video|movies|series)\/[^/]*\/?([A-Za-z0-9]+)?/.exec(path)?.[1] };
  if (host.endsWith('primevideo.com') || host.endsWith('amazon.com')) return { service: 'prime', url, id: /\/(?:detail|dp)\/([A-Z0-9]+)/.exec(path)?.[1] };
  if (host.endsWith('spotify.com') || u.protocol === 'spotify:') return { service: 'spotify', url };
  if (host.endsWith('twitch.tv')) return { service: 'twitch', url, id: path.split('/')[1] || undefined };
  if (host.endsWith('plex.tv') || u.protocol === 'plex:') return { service: 'plex', url };
  if (host.endsWith('max.com') || host.endsWith('hbomax.com')) return { service: 'max', url };
  if (host.endsWith('hulu.com')) return { service: 'hulu', url };
  if (host.endsWith('tv.apple.com')) return { service: 'appletv', url };
  if (u.protocol === 'stremio:' || host === 'app.strem.io' || host === 'web.strem.io') {
    const q = u.searchParams.get('search') ?? (u.hash.includes('search=') ? decodeURIComponent(u.hash.split('search=')[1].split('&')[0]) : null);
    return { service: 'stremio', url, query: q ?? undefined, id: /\/detail\/[^/]+\/([^/?#]+)/.exec(path + u.hash)?.[1] };
  }
  return { service: 'web', url };
}

/** Per-brand launch instructions for a parsed link. */
export function launchTargets(link: ParsedLink): LaunchTarget {
  const t: LaunchTarget = {};
  switch (link.service) {
    case 'youtube': {
      t.android = link.url;
      t.cast = { appId: '233637DE' };
      if (link.id) {
        t.roku = { appId: '837', params: { contentId: link.id, mediaType: 'live' } };
        t.samsung = { appId: '111299001912', metaTag: `v=${link.id}`, type: 'DEEP_LINK' };
        t.webos = { id: 'youtube.leanback.v4', contentId: link.id };
      } else {
        t.roku = { appId: '837' };
        t.samsung = { appId: '111299001912', type: 'NATIVE_LAUNCH' };
        t.webos = { id: 'youtube.leanback.v4' };
      }
      break;
    }
    case 'netflix': {
      t.android = link.url;
      t.cast = { appId: 'CA5E8412' };
      if (link.id) {
        t.roku = { appId: '12', params: { contentId: link.id, mediaType: 'movie' } };
        t.samsung = { appId: '11101200001', metaTag: `m=${link.id}`, type: 'DEEP_LINK' };
        t.webos = { id: 'netflix', contentId: `m=${link.id}` };
      } else {
        t.roku = { appId: '12' };
        t.samsung = { appId: '11101200001', type: 'NATIVE_LAUNCH' };
        t.webos = { id: 'netflix' };
      }
      break;
    }
    case 'disney':
      t.android = link.url;
      t.roku = { appId: '291097' };
      t.samsung = { appId: '3201901017640', type: 'NATIVE_LAUNCH' };
      t.webos = { id: 'com.disney.disneyplus-prod' };
      break;
    case 'prime':
      t.android = link.url;
      t.roku = { appId: '13', params: link.id ? { contentId: link.id, mediaType: 'movie' } : undefined };
      t.samsung = { appId: '3201512006785', type: 'NATIVE_LAUNCH' };
      t.webos = { id: 'amazon', contentId: link.id };
      break;
    case 'spotify':
      t.android = link.url;
      t.roku = { appId: '22297' };
      t.samsung = { appId: '3201606009684', type: 'NATIVE_LAUNCH' };
      t.webos = { id: 'spotify-beehive' };
      break;
    case 'twitch':
      t.android = link.url;
      t.roku = { appId: '50539' };
      t.webos = { id: 'tv.twitch.twitch' };
      break;
    case 'plex':
      t.android = link.url;
      t.roku = { appId: '13535' };
      t.samsung = { appId: '3201512006963', type: 'NATIVE_LAUNCH' };
      t.webos = { id: 'cdp-30' };
      break;
    case 'max':
      t.android = link.url;
      t.roku = { appId: '61322' };
      t.webos = { id: 'hbomax' };
      break;
    case 'hulu':
      t.android = link.url;
      t.roku = { appId: '2285' };
      t.samsung = { appId: '3201601007625', type: 'NATIVE_LAUNCH' };
      t.webos = { id: 'hulu' };
      break;
    case 'appletv':
      t.android = link.url;
      t.roku = { appId: '551012' };
      t.samsung = { appId: '3201807016597', type: 'NATIVE_LAUNCH' };
      t.webos = { id: 'com.apple.appletv' };
      break;
    case 'stremio':
      // only the Android app takes deep links; the Samsung/LG web versions have no documented scheme
      t.android = link.url.startsWith('http') ? `stremio:///${link.url.split('#/')[1] ?? ''}` : link.url;
      break;
    default:
      t.android = link.url; // Android TV will hand an unknown https:// link to whichever app claims it
  }
  return t;
}

/** Search deep link for a service, or undefined when it has none. */
export function searchLink(service: Service, query: string): ParsedLink | undefined {
  const s = SERVICE_META[service];
  if (!s.search) return undefined;
  return { service, url: s.search(query), query };
}
