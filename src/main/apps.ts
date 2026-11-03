/**
 * App catalog + optional ADB-based app listing for Android TV.
 *
 * The Android TV Remote protocol can launch apps by deep link but cannot list
 * what's installed. Two sources:
 *  1. A curated catalog of common TV apps with known deep links (always available).
 *  2. `adb` over the LAN, when the user enabled "USB debugging" on the TV and has
 *     adb on their PATH. We then list third-party packages and their labels.
 */
import type { AppInfo } from '../shared/types';
import { adb } from './adb';
import { colorFor, initials } from './drivers/driver';

interface CatalogEntry {
  id: string;
  name: string;
  link: string;
  color: string;
  initials?: string;
}

const CATALOG: CatalogEntry[] = [
  { id: 'com.google.android.youtube.tv', name: 'YouTube', link: 'https://www.youtube.com', color: '#C4302B', initials: 'YT' },
  { id: 'com.netflix.ninja', name: 'Netflix', link: 'https://www.netflix.com/title', color: '#B20710', initials: 'N' },
  { id: 'com.disney.disneyplus', name: 'Disney+', link: 'https://www.disneyplus.com', color: '#0F3E8C', initials: 'D+' },
  { id: 'com.amazon.amazonvideo.livingroom', name: 'Prime Video', link: 'https://app.primevideo.com', color: '#0F6E8C', initials: 'PV' },
  { id: 'com.plexapp.android', name: 'Plex', link: 'plex://', color: '#8A6508', initials: 'Px' },
  { id: 'com.spotify.tv.android', name: 'Spotify', link: 'spotify://', color: '#1A7F43', initials: 'Sp' },
  { id: 'tv.twitch.android.app', name: 'Twitch', link: 'https://www.twitch.tv', color: '#5A3E9C', initials: 'Tw' },
  { id: 'com.apple.atve.androidtv.appletv', name: 'Apple TV', link: 'https://tv.apple.com', color: '#3A3F4B', initials: 'TV' },
  { id: 'com.hbo.hbonow', name: 'Max', link: 'https://play.max.com', color: '#2F3FA8', initials: 'Mx' },
  { id: 'com.hulu.livingroomplus', name: 'Hulu', link: 'https://www.hulu.com', color: '#1F7A3E', initials: 'Hu' },
  { id: 'org.jellyfin.androidtv', name: 'Jellyfin', link: 'jellyfin://', color: '#7A3E9C', initials: 'Jf' },
  { id: 'org.xbmc.kodi', name: 'Kodi', link: 'kodi://', color: '#1F5E9C', initials: 'K' },
  { id: 'com.valvesoftware.steamlink', name: 'Steam Link', link: 'steamlink://', color: '#2A475E', initials: 'SL' },
  { id: 'com.tubitv', name: 'Tubi', link: 'https://tubitv.com', color: '#C2550D', initials: 'Tb' },
  { id: 'tv.pluto.android', name: 'Pluto TV', link: 'https://pluto.tv', color: '#3D4B9C', initials: 'Pl' },
  { id: 'com.google.android.youtube.tvmusic', name: 'YouTube Music', link: 'https://music.youtube.com', color: '#B23A3A', initials: 'YM' },
  { id: 'com.stremio.one', name: 'Stremio', link: 'stremio://', color: '#7B2CBF', initials: 'St' },
  { id: 'org.videolan.vlc', name: 'VLC', link: 'vlc://', color: '#E85D04', initials: 'VL' },
  { id: 'com.teamsmart.videomanager.tv', name: 'SmartTube', link: 'https://www.youtube.com', color: '#B23A3A', initials: 'ST' },
  { id: 'tv.emby.embyatv', name: 'Emby', link: 'emby://', color: '#4C9A2A', initials: 'Em' },
  { id: 'ar.tvplayer.tv', name: 'TiviMate', link: 'tivimate://', color: '#2F5FA8', initials: 'TM' },
  { id: 'com.crunchyroll.crunchyroid', name: 'Crunchyroll', link: 'https://www.crunchyroll.com', color: '#C2550D', initials: 'Cr' },
  { id: 'com.peacocktv.peacockandroid', name: 'Peacock', link: 'https://www.peacocktv.com', color: '#1F5E9C', initials: 'Pe' },
  { id: 'com.cbs.ott', name: 'Paramount+', link: 'https://www.paramountplus.com', color: '#1F4EA8', initials: 'P+' },
  { id: 'com.google.android.apps.tv.launcherx', name: 'Home', link: 'android.intent.action.MAIN', color: '#3A3F4B', initials: 'Ho' },
  { id: 'com.android.tv.settings', name: 'Settings', link: 'android.settings.SETTINGS', color: '#3A3F4B', initials: 'Se' },
];

export function androidCatalog(): AppInfo[] {
  return CATALOG.map((c) => ({
    id: c.id,
    name: c.name,
    link: c.link,
    initials: c.initials ?? initials(c.name),
    color: c.color,
    source: 'catalog',
  }));
}

/**
 * List the TV's launcher apps over ADB. Throws if adb is missing, the TV refuses,
 * or debugging is off — callers fall back to the catalog.
 */
export async function listAppsViaAdb(host: string): Promise<AppInfo[]> {
  if (!(await adb.binary())) throw new Error('adb not installed');
  // Only packages with a LEANBACK_LAUNCHER activity are "TV apps".
  const out = await adb.shell(host, ['cmd', 'package', 'query-activities', '--brief', '-c', 'android.intent.category.LEANBACK_LAUNCHER', '-a', 'android.intent.action.MAIN']);
  const ids = new Set<string>();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^([a-zA-Z0-9_.]+)\/[\w.$]+$/);
    if (m) ids.add(m[1]);
  }
  const catalog = new Map(androidCatalog().map((a) => [a.id, a]));
  return [...ids].map((id) => {
    const known = catalog.get(id);
    const name = known?.name ?? guessName(id);
    return {
      id,
      name,
      link: known?.link,
      initials: known?.initials ?? initials(name),
      color: known?.color ?? colorFor(id),
      source: 'device' as const,
    };
  });
}

/** Packages that ship on most Google TVs but aren't in the launch catalog; the Play Store name fills in the rest. */
export const KNOWN_PACKAGE_NAMES: Record<string, string> = {
  'com.android.vending': 'Google Play Store',
  'com.google.android.youtube.tvunplugged': 'YouTube TV',
  'com.google.android.youtube.tvkids': 'YouTube Kids',
  'com.google.android.videos': 'Google TV',
  'com.google.android.apps.mediashell': 'Chromecast built-in',
  'com.google.android.tvlauncher': 'Android TV Home',
  'com.spocky.projengmenu': 'Projectivy Launcher',
  'com.wbd.stream': 'Max',
  'com.instagram.android': 'Instagram',
  'com.google.android.play.games': 'Play Games',
  'com.google.android.apps.youtube.music': 'YouTube Music',
  'com.android.tv.settings': 'Settings',
  'com.google.android.tv.frameworkpackagestubs': 'Android TV system',
  'com.amazon.amazonvideo.livingroom': 'Prime Video',
  'com.apple.atve.androidtv.appletv': 'Apple TV',
  'com.google.android.tv.remote.service': 'Remote service',
  'com.google.android.apps.tv.dreamx': 'Ambient mode',
  'com.droidlogic.mboxlauncher': 'Box launcher',
  'org.jellyfin.androidtv': 'Jellyfin',
};

export function guessName(pkg: string): string {
  const known = KNOWN_PACKAGE_NAMES[pkg];
  if (known) return known;
  const parts = pkg.split('.').filter((p) => !['com', 'org', 'net', 'tv', 'android', 'app', 'apps', 'androidtv', 'io', 'livingroom', 'mobile', 'client'].includes(p));
  const last = parts[parts.length - 1] ?? pkg;
  return last.charAt(0).toUpperCase() + last.slice(1);
}
