/**
 * App icons without bundling trademarks.
 *
 * Priority:
 *  1. The TV itself (Samsung/LG/Roku hand us icons; drivers set `icon` directly).
 *  2. For Android packages: the app's public Play Store page `og:image` — the
 *     official icon, fetched anonymously (no sign-in), cached on disk in userData.
 *  3. For well-known packages that aren't on the Play Store (sideload favourites
 *     like Stremio or SmartTube) or when the Play page can't be read: the app's
 *     own website icon via a favicon service.
 *  4. Fallback: initials on a coloured tile (renderer).
 *
 * Nothing here is verified against the live Play Store from the dev sandbox; the
 * parser is defensive and any failure simply yields "no icon".
 */
import { app, net } from 'electron';
import fs from 'fs';
import path from 'path';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TTL_MS = 30 * 24 * 3600 * 1000;

let dir: string | undefined;
function cacheDir(): string {
  if (!dir) {
    dir = path.join(app.getPath('userData'), 'icons');
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

const inflight = new Map<string, Promise<AndroidAppInfo>>();

/** Package → website, for the favicon fallback. Only popular TV apps; everything else gets initials. */
const PACKAGE_SITES: Record<string, string> = {
  'com.google.android.youtube.tv': 'youtube.com',
  'com.google.android.youtube.tvmusic': 'music.youtube.com',
  'com.netflix.ninja': 'netflix.com',
  'com.disney.disneyplus': 'disneyplus.com',
  'com.amazon.amazonvideo.livingroom': 'primevideo.com',
  'com.plexapp.android': 'plex.tv',
  'com.spotify.tv.android': 'spotify.com',
  'tv.twitch.android.app': 'twitch.tv',
  'com.apple.atve.androidtv.appletv': 'tv.apple.com',
  'com.hbo.hbonow': 'max.com',
  'com.hulu.livingroomplus': 'hulu.com',
  'org.jellyfin.androidtv': 'jellyfin.org',
  'org.xbmc.kodi': 'kodi.tv',
  'com.valvesoftware.steamlink': 'store.steampowered.com',
  'com.tubitv': 'tubitv.com',
  'tv.pluto.android': 'pluto.tv',
  'com.stremio.one': 'stremio.com',
  'org.videolan.vlc': 'videolan.org',
  'com.teamsmart.videomanager.tv': 'smarttubeapp.github.io',
  'tv.emby.embyatv': 'emby.media',
  'ar.tvplayer.tv': 'tivimate.com',
  'com.esaba.downloader': 'aftvnews.com',
  'com.crunchyroll.crunchyroid': 'crunchyroll.com',
  'com.peacocktv.peacockandroid': 'peacocktv.com',
  'com.cbs.ott': 'paramountplus.com',
  'com.vimeo.android.videoapp': 'vimeo.com',
  'com.dazn': 'dazn.com',
  'com.mubi': 'mubi.com',
};

export interface AndroidAppInfo {
  /** data: URL, when an icon could be fetched */
  icon?: string;
  /** the app's real name from its Play Store page (e.g. "YouTube TV" for …youtube.tvunplugged) */
  name?: string;
}

/** data: URL for the package's official icon, or undefined. */
export function androidIcon(pkg: string): Promise<string | undefined> {
  return androidAppInfo(pkg).then((i) => i.icon);
}

/** Official icon and name for a package, from its public Play Store page (cached a month). */
export function androidAppInfo(pkg: string): Promise<AndroidAppInfo> {
  const cached = readCache(pkg);
  if (cached) return Promise.resolve(cached);
  let p = inflight.get(pkg);
  if (!p) {
    p = fetchPlayInfo(pkg)
      .then(async (info) => (info.icon ? info : { ...info, icon: await fetchSiteIcon(pkg) }))
      .then((info) => {
        writeCache(pkg, info); // an empty record is a negative cache, so we don't hammer the store
        return info;
      })
      .catch(() => ({}) as AndroidAppInfo)
      .finally(() => inflight.delete(pkg));
    inflight.set(pkg, p);
  }
  return p;
}

function cachePath(pkg: string): string {
  return path.join(cacheDir(), pkg.replace(/[^a-zA-Z0-9._-]/g, '_') + '.json');
}

function readCache(pkg: string): AndroidAppInfo | undefined {
  try {
    const p = cachePath(pkg);
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs > TTL_MS) return undefined;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as AndroidAppInfo;
  } catch {
    /* fall through: older versions cached the icon alone in a .txt */
  }
  try {
    const p = cachePath(pkg).replace(/\.json$/, '.txt');
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs > TTL_MS) return undefined;
    const v = fs.readFileSync(p, 'utf8');
    return v === 'none' ? {} : { icon: v };
  } catch {
    return undefined;
  }
}

function writeCache(pkg: string, info: AndroidAppInfo): void {
  try {
    fs.writeFileSync(cachePath(pkg), JSON.stringify(info));
  } catch {
    /* ignore */
  }
}

/** "Netflix - Apps on Google Play" → "Netflix" */
export function playTitleToName(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const name = title
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/\s+[-–—]\s+(Apps|Android Apps) on Google Play\s*$/i, '')
    .trim();
  return name && !/Google Play$/i.test(name) && name.length < 60 ? name : undefined;
}

async function fetchPlayInfo(pkg: string): Promise<AndroidAppInfo> {
  const html = await fetchText(`https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=en`);
  if (!html) return {};
  const t = /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/.exec(html) ?? /<meta[^>]+content="([^"]+)"[^>]+property="og:title"/.exec(html) ?? /<title>([^<]+)<\/title>/.exec(html);
  const name = playTitleToName(t?.[1]);
  const m = /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/.exec(html) ?? /<meta[^>]+content="([^"]+)"[^>]+property="og:image"/.exec(html);
  let url = m?.[1];
  if (!url) return { name };
  url = url.replace(/&amp;/g, '&');
  // Play serves a resizable image: ask for a 128px square.
  url = url.replace(/=w\d+-h\d+(-rw)?$/, '=w128-h128-rw').replace(/=s\d+(-rw)?$/, '=s128-rw');
  const bytes = await fetchBytes(url);
  if (!bytes || bytes.length < 200) return { name };
  const type = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : bytes.subarray(0, 4).toString() === 'RIFF' ? 'image/webp' : 'image/png';
  return { name, icon: `data:${type};base64,${bytes.toString('base64')}` };
}

/** The app's website icon (128px) for well-known packages, via Google's favicon service. */
async function fetchSiteIcon(pkg: string): Promise<string | undefined> {
  const site = PACKAGE_SITES[pkg];
  if (!site) return undefined;
  const bytes = await fetchBytes(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(site)}&sz=128`);
  if (!bytes || bytes.length < 200) return undefined; // the service returns a tiny default for unknown sites
  const type = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : bytes.subarray(0, 4).toString() === 'RIFF' ? 'image/webp' : bytes[0] === 0 ? 'image/x-icon' : 'image/png';
  return `data:${type};base64,${bytes.toString('base64')}`;
}

function fetchText(url: string): Promise<string | undefined> {
  return fetchBytes(url).then((b) => b?.toString('utf8'));
}

function fetchBytes(url: string): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const req = net.request({ url, redirect: 'follow' });
    req.setHeader('User-Agent', UA);
    req.setHeader('Accept-Language', 'en');
    const chunks: Buffer[] = [];
    const t = setTimeout(() => {
      req.abort();
      resolve(undefined);
    }, 10_000);
    req.on('response', (res) => {
      if ((res.statusCode ?? 500) >= 400) {
        clearTimeout(t);
        return resolve(undefined);
      }
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => {
        clearTimeout(t);
        resolve(Buffer.concat(chunks));
      });
      res.on('error', () => {
        clearTimeout(t);
        resolve(undefined);
      });
    });
    req.on('error', () => {
      clearTimeout(t);
      resolve(undefined);
    });
    req.end();
  });
}

export { fetchText };
