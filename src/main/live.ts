/**
 * Live view of an Android TV over ADB.
 *
 * Two optional streams, each a slow poll (the TV is on the LAN; nothing leaves it):
 *   media  — `dumpsys media_session`: the active media session of *any* app,
 *            Cast-aware or not (title, subtitle, playing/paused, position).
 *            This is what tells us about Plex, Stremio, Kodi, SmartTube, local
 *            players… apps the Cast protocol never reports.
 *   screen — `screencap` downscaled to a small JPEG, a frame every few seconds.
 *            Protected video (Netflix & co.) comes out black by design; menus,
 *            YouTube and most apps show fine.
 *
 * Needs the ADB setup the user did for sideloading (Developer options + Allow).
 */
import { nativeImage } from 'electron';
import { EventEmitter } from 'events';
import type { LiveViewOptions, MediaInfo } from '../shared/types';
import { adb } from './adb';

const MEDIA_EVERY_MS = 4000;
const SCREEN_EVERY_MS = 2500;
const FRAME_WIDTH = 800;

export interface AdbMediaSession {
  pkg: string;
  active: boolean;
  /** Android PlaybackState code: 0 none 1 stopped 2 paused 3 playing 6 buffering … */
  state: number;
  /** milliseconds */
  position?: number;
  title?: string;
  subtitle?: string;
}

const STATE_NAME: Record<number, MediaInfo['playerState']> = { 1: 'IDLE', 2: 'PAUSED', 3: 'PLAYING', 4: 'PLAYING', 5: 'PLAYING', 6: 'BUFFERING', 8: 'BUFFERING' };

/** Parse `dumpsys media_session` (Android 9–14 layouts). Sessions in stack order (most recent first). */
export function parseMediaSessions(dump: string): AdbMediaSession[] {
  const sessions: AdbMediaSession[] = [];
  let cur: AdbMediaSession | undefined;
  for (const raw of dump.split('\n')) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^package=(\S+)/.exec(line))) {
      cur = { pkg: m[1], active: false, state: 0 };
      sessions.push(cur);
      continue;
    }
    if (!cur) continue;
    if ((m = /^active=(true|false)/.exec(line))) cur.active = m[1] === 'true';
    else if ((m = /^state=PlaybackState\s*\{(.*)\}/.exec(line))) {
      const body = m[1];
      const st = /\bstate=(?:[A-Z_]+\()?(\d+)\)?/.exec(body);
      const pos = /\bposition=(-?\d+)/.exec(body);
      if (st) cur.state = Number(st[1]);
      if (pos && Number(pos[1]) >= 0) cur.position = Number(pos[1]);
    } else if ((m = /^metadata:\s*(?:size=\d+,\s*description=)?(.*)$/.exec(line))) {
      // MediaDescription is a three-field tuple; keep commas in its title where possible.
      const tuple = /^(.*), ([^,]*), ([^,]*)$/.exec(m[1]);
      const parts = tuple ? tuple.slice(1) : m[1].split(', ');
      const clean = (s?: string) => (s && s !== 'null' ? s.trim() : undefined);
      cur.title = clean(parts[0]);
      cur.subtitle = clean(parts[1]);
    }
  }
  return sessions;
}

/** The session worth showing: active and playing first, then active and paused/buffering. */
export function pickSession(sessions: AdbMediaSession[], preferredPackage?: string): AdbMediaSession | undefined {
  const live = sessions.filter((s) => s.active && ['PLAYING', 'BUFFERING', 'PAUSED'].includes(STATE_NAME[s.state] || ''));
  const preferred = live.filter((s) => s.pkg === preferredPackage);
  const candidates = preferred.length ? preferred : live;
  return candidates.find((s) => STATE_NAME[s.state] === 'PLAYING')
    ?? candidates.find((s) => STATE_NAME[s.state] === 'BUFFERING')
    ?? candidates.find((s) => STATE_NAME[s.state] === 'PAUSED');
}

export function toMedia(s: AdbMediaSession): MediaInfo {
  return {
    source: 'adb',
    appId: s.pkg,
    title: s.title,
    subtitle: s.subtitle,
    playerState: STATE_NAME[s.state] ?? 'IDLE',
    currentTime: s.position !== undefined ? s.position / 1000 : undefined,
    updatedAt: Date.now(),
  };
}

/** True when (nearly) every sampled pixel is black. */
export function isBlank(img: Electron.NativeImage): boolean {
  const { width, height } = img.getSize();
  if (!width || !height) return true;
  const bmp = img.toBitmap(); // BGRA
  const step = Math.max(4, Math.floor(bmp.length / 4 / 4000) * 4); // ~4000 samples
  let dark = 0, total = 0;
  for (let i = 0; i + 2 < bmp.length; i += step) {
    total++;
    if (bmp[i] < 18 && bmp[i + 1] < 18 && bmp[i + 2] < 18) dark++;
  }
  return total > 0 && dark / total > 0.985;
}

export class AdbLive extends EventEmitter {
  private mediaTimer?: NodeJS.Timeout;
  private screenTimer?: NodeJS.Timeout;
  private opts: LiveViewOptions = { media: false, screen: false };
  private busyMedia = false;
  private busyScreen = false;
  private failures = { media: 0, screen: 0 };
  private lastKey?: string;
  private paused = false;
  private generation = 0;

  /** Skip screen captures while nobody can see them; the media poll keeps the feed alive. */
  pauseScreen(paused: boolean): void {
    this.paused = paused;
    if (!paused && this.opts.screen) void this.pollScreen();
  }

  constructor(private host: string, private currentPackage?: () => string | undefined) {
    super();
  }

  get options(): LiveViewOptions {
    return this.opts;
  }

  set(opts: LiveViewOptions | null): void {
    this.generation++;
    this.opts = opts ?? { media: false, screen: false };
    this.failures = { media: 0, screen: 0 };
    if (this.opts.media && !this.mediaTimer) {
      void this.pollMedia();
      this.mediaTimer = setInterval(() => void this.pollMedia(), MEDIA_EVERY_MS);
    } else if (!this.opts.media && this.mediaTimer) {
      clearInterval(this.mediaTimer);
      this.mediaTimer = undefined;
      this.lastKey = undefined;
      this.emit('media', undefined);
    }
    if (this.opts.screen && !this.screenTimer) {
      void this.pollScreen();
      this.screenTimer = setInterval(() => void this.pollScreen(), SCREEN_EVERY_MS);
    } else if (!this.opts.screen && this.screenTimer) {
      clearInterval(this.screenTimer);
      this.screenTimer = undefined;
      this.emit('screen', null);
    }
  }

  stop(): void {
    this.set(null);
  }

  get running(): boolean {
    return Boolean(this.mediaTimer || this.screenTimer);
  }

  private async pollMedia(): Promise<void> {
    if (this.busyMedia || !this.opts.media) return;
    this.busyMedia = true;
    const generation = this.generation;
    try {
      const dump = await adb.shellQuick(this.host, ['dumpsys', 'media_session']);
      if (generation !== this.generation || !this.opts.media) return;
      const s = pickSession(parseMediaSessions(dump), this.currentPackage?.());
      const key = s ? JSON.stringify(s) : '';
      if (key !== this.lastKey) {
        this.lastKey = key;
        this.emit('media', s ? toMedia(s) : undefined);
      }
      this.failures.media = 0;
    } catch (err) {
      if (generation === this.generation) this.fail(err as Error, 'media');
    } finally {
      this.busyMedia = false;
    }
  }

  private async pollScreen(): Promise<void> {
    if (this.busyScreen || this.paused || !this.opts.screen) return;
    this.busyScreen = true;
    const generation = this.generation;
    try {
      const png = await adb.screenshotRaw(this.host);
      if (generation !== this.generation || !this.opts.screen) return;
      const img = nativeImage.createFromBuffer(png);
      if (img.isEmpty()) throw new Error('The TV returned an empty frame');
      const { width } = img.getSize();
      const small = width > FRAME_WIDTH ? img.resize({ width: FRAME_WIDTH, quality: 'good' }) : img;
      // Protected video (DRM) comes back as a black frame; say so instead of showing a black box.
      this.emit('screen', isBlank(small) ? 'blank' : `data:image/jpeg;base64,${small.toJPEG(70).toString('base64')}`);
      this.failures.screen = 0;
    } catch (err) {
      if (generation === this.generation) this.fail(err as Error, 'screen');
    } finally {
      this.busyScreen = false;
    }
  }

  private fail(err: Error, stream: 'media' | 'screen'): void {
    // A broken screenshot command must not take healthy playback reporting down.
    if (++this.failures[stream] >= 3) {
      if (stream === 'screen' && this.opts.media) {
        clearInterval(this.screenTimer);
        this.screenTimer = undefined;
        this.opts = { ...this.opts, screen: false };
        this.emit('screen', null);
        this.emit('screenError', err);
        return;
      }
      this.stop();
      this.emit('error', err);
    }
  }
}
