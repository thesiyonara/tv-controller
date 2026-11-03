/**
 * DeviceManager: owns one driver per connected device and routes commands.
 *
 * Targets can be a device id (`androidtv:192.168.1.42`) or a room id (`room:abc`).
 * A room links devices that physically form one setup, e.g. a Google TV plugged
 * into a Samsung: navigation/apps/text go to the primary device, volume/mute go
 * to the audio device, power goes to all of the room's power devices.
 *
 * It also keeps the local "continue watching" list: whenever a Cast session
 * reports what's playing (title + content id) we remember a deep link that
 * reopens it. No accounts involved; this is only what this computer has seen.
 */
import { EventEmitter } from 'events';
import { selectMedia } from '../shared/media-selection';
export { mediaScore } from '../shared/media-selection';
import type { ActivityEvent, AppInfo, CastMedia, DeviceKind, DeviceState, KeyDirection, LiveViewOptions, RemoteKey, VideoResult, WatchEntry } from '../shared/types';
import { ActivityLog, type NewEvent } from './activity';
import { adb } from './adb';
import { Discovery } from './discovery';
import { TvDriver } from './drivers/driver';
import { AndroidTvDriver } from './drivers/androidtv';
import { CastDriver } from './drivers/cast';
import { RokuDriver } from './drivers/roku';
import { SamsungDriver } from './drivers/samsung';
import { WebosDriver } from './drivers/webos';
import { parseLink, searchLink, SERVICE_META, type Service } from './deeplink';
import { searchYouTube } from './youtube';
import { lookupMac, sendMagicPacket } from './wol';
import { getStore, type Room } from './store';

const VOLUME_KEYS: ReadonlySet<RemoteKey> = new Set(['VOLUME_UP', 'VOLUME_DOWN', 'MUTE']);
const POWER_KEYS: ReadonlySet<RemoteKey> = new Set(['POWER', 'POWER_ON', 'POWER_OFF']);
const INPUT_KEYS: ReadonlySet<RemoteKey> = new Set(['INPUT', 'CHANNEL_UP', 'CHANNEL_DOWN']);

/** Cast receiver app id -> service, for turning observed playback into a reopenable link. */
const CAST_APP_SERVICE: Record<string, Service> = {
  '233637DE': 'youtube',
  CA5E8412: 'netflix',
  '9381F2BD': 'disney',
  '17608BC8': 'prime',
  CC32E753: 'spotify',
  '06ee44ee': 'plex',
  '9ac17e67': 'twitch',
  '6B8D3C9E': 'max',
};

export class DeviceManager extends EventEmitter {
  private drivers = new Map<string, TvDriver>();
  private lastRecorded = new Map<string, number>(); // watch entry id -> timestamp
  private macLearned = new Set<string>();
  private liveStarting = new Set<string>();
  private liveRetries = new Map<string, NodeJS.Timeout>();
  private lastState = new Map<string, DeviceState>();
  readonly activity = new ActivityLog();
  /** devices whose live view the user turned off this session (don't restart it automatically) */
  private liveOptOut = new Set<string>();
  /** keyboard-mode keystrokes, gathered into one feed line per pause */
  private typing = new Map<string, { text: string; timer: NodeJS.Timeout }>();

  constructor(
    private discovery: Discovery,
    private appVersion: string,
  ) {
    super();
    this.activity.on('event', (e: ActivityEvent) => this.emit('activity', e));
    // A device moved to a new IP: drop the driver keyed by the old id (its socket is dead anyway).
    discovery.on('migrated', (oldId: string, newId: string) => {
      const d = this.drivers.get(oldId);
      if (d) {
        d.removeAllListeners();
        void d.disconnect();
        this.drivers.delete(oldId);
        this.emit('state', { ...d.state, state: 'disconnected' });
      }
      this.macLearned.delete(oldId);
      this.emit('rooms', this.rooms());
      this.emit('migrated', oldId, newId);
    });
  }

  // ---- drivers ----

  private create(id: string): TvDriver {
    const d = this.discovery.get(id);
    if (!d) throw new Error(`Unknown device ${id}`);
    const ctx = { id: d.id, kind: d.kind, host: d.host, port: d.port, name: d.name, appVersion: this.appVersion };
    const driver = make(d.kind, ctx);
    driver.on('state', (state: DeviceState) => {
      const previous = this.lastState.get(id);
      this.emit('state', state);
      this.activity.observe(this.lastState.get(id), state);
      this.lastState.set(id, state);
      this.observeMedia(state);
      if (state.state === 'connected' && !this.macLearned.has(id)) {
        this.macLearned.add(id);
        void lookupMac(d.host).then((mac) => mac && this.discovery.setMac(id, mac));
      }
      if (state.state === 'connected' && previous?.state !== 'connected') this.autoLive(id, driver);
    });
    driver.on('pairingRequested', (how: 'code' | 'prompt') => this.emit('pairingRequested', id, how));
    driver.on('keyboardOpened', (field) => this.emit('keyboardOpened', id, field));
    driver.on('credentials', () => this.discovery.refreshPairedFlags());
    driver.on('screen', (frame: string | null) => this.emit('screen', id, frame));
    driver.on('liveError', (err: Error) => {
      this.note(id, 'error', `Playback reporting interrupted: ${err.message}`);
      this.retryLive(id, driver);
    });
    this.drivers.set(id, driver);
    return driver;
  }

  /** Add an outgoing line to the feed ("Open Netflix", "Typed …"). */
  note(deviceId: string, kind: ActivityEvent['kind'], text: string, extra: Partial<NewEvent> = {}): void {
    this.activity.add({ device: deviceId, kind, dir: 'out', text, ...extra });
  }

  /** Recent activity for a target (room → all of its devices), oldest first. */
  activityFor(target?: string): ActivityEvent[] {
    if (!target) return this.activity.list();
    try {
      return this.activity.list(this.resolve(target).all);
    } catch {
      return [];
    }
  }

  /**
   * A Google TV that already accepted ADB from this computer: start reading what it plays as soon
   * as it connects (no screen frames), so Plex/Stremio/Kodi titles show without touching a toggle.
   */
  private adbTried = new Set<string>();

  private autoLive(id: string, driver: TvDriver): void {
    if (!(driver instanceof AndroidTvDriver) || this.liveOptOut.has(id) || driver.state.liveView || this.liveStarting.has(id)) return;
    if (!getStore().settings().adbAuto) return;
    const host = driver.state.host;
    this.liveStarting.add(id);
    void (async () => {
      if (!(await adb.binary())) return;
      if (!getStore().settings().adbHosts.includes(host)) {
        // adb is installed but this TV never accepted us through the app: one quiet attempt per session.
        // Debugging off → refused → leave it alone. Debugging on → the TV shows "Allow?" → give the user a minute.
        if (this.adbTried.has(host)) return;
        this.adbTried.add(host);
        for (let i = 0; i < 7; i++) {
          const r = await adb.connect(host).catch(() => ({ state: 'failed' as const, message: '' }));
          if (r.state === 'connected') break;
          if (r.state !== 'unauthorized') return;
          if (i === 0) this.note(id, 'info', 'The TV is asking whether to allow debugging from this computer');
          await new Promise((res) => setTimeout(res, 10_000));
        }
        if (!getStore().settings().adbHosts.includes(host)) return;
      }
      if (this.drivers.get(id) !== driver || driver.state.state !== 'connected' || driver.state.liveView || this.liveOptOut.has(id) || !getStore().settings().adbAuto) return;
      driver.setLiveView({ media: true, screen: false });
      this.note(id, 'info', 'Reading what the TV plays over ADB');
    })().catch(() => this.retryLive(id, driver)).finally(() => this.liveStarting.delete(id));
  }

  private retryLive(id: string, driver: TvDriver): void {
    if (this.liveRetries.has(id) || this.liveOptOut.has(id) || !getStore().settings().adbAuto
      || !getStore().settings().adbHosts.includes(driver.state.host)) return;
    const timer = setTimeout(() => {
      this.liveRetries.delete(id);
      if (this.drivers.get(id) === driver && driver.state.state === 'connected') this.autoLive(id, driver);
    }, 30_000);
    timer.unref();
    this.liveRetries.set(id, timer);
  }

  /** Live view over ADB for the Android TV behind a target. */
  setLiveView(target: string, opts: LiveViewOptions | null): void {
    const r = this.resolve(target);
    const id = [r.primary, ...r.all].find((x) => this.discovery.get(x)?.kind === 'androidtv');
    if (!id) throw new Error('Live view needs an Android TV or Google TV device.');
    const d = this.driver(id);
    if (!(d instanceof AndroidTvDriver)) throw new Error('Live view needs an Android TV or Google TV device.');
    if (opts && (opts.media || opts.screen)) this.liveOptOut.delete(id);
    else {
      this.liveOptOut.add(id);
      clearTimeout(this.liveRetries.get(id));
      this.liveRetries.delete(id);
    }
    d.setLiveView(opts);
    if (opts && (opts.media || opts.screen)) this.note(id, 'info', opts.screen ? 'Live view on (screen + playback)' : 'Live view on (playback)');
    else this.note(id, 'info', 'Live view off');
  }

  /** Window hidden/minimised: keep the media poll, pause screen frames (they cost the TV a screencap each). */
  setScreenPaused(paused: boolean): void {
    for (const d of this.drivers.values()) if (d instanceof AndroidTvDriver) d.pauseScreen(paused);
  }

  /** After the computer wakes: reconnect everything that should be connected. */
  async reconnectAll(): Promise<void> {
    await Promise.all([...this.drivers.values()].map((d) => d.reconnect().catch(() => undefined)));
  }

  private driver(id: string): TvDriver {
    return this.drivers.get(id) ?? this.create(id);
  }

  private connected(id: string): TvDriver {
    const d = this.drivers.get(id);
    if (!d || d.state.state !== 'connected') throw new Error('Not connected');
    return d;
  }

  getState(id: string): DeviceState {
    const d = this.drivers.get(id);
    if (d) return d.state;
    const disc = this.discovery.get(id);
    return { id, kind: disc?.kind ?? 'androidtv', host: disc?.host ?? '', state: 'disconnected' };
  }

  // ---- rooms ----

  rooms(): Room[] {
    return getStore().rooms();
  }

  saveRoom(room: Room): Room {
    getStore().setRoom(room);
    this.emit('rooms', this.rooms());
    return room;
  }

  deleteRoom(id: string): void {
    getStore().deleteRoom(id);
    this.emit('rooms', this.rooms());
  }

  /** Devices a target resolves to, by role. */
  private resolve(target: string): { primary: string; audio: string; power: string[]; all: string[] } {
    if (target.startsWith('room:')) {
      const room = getStore().getRoom(target.slice(5));
      if (!room) throw new Error('Unknown room');
      const audio = room.audio ?? room.primary;
      const power = room.power?.length ? room.power : [room.primary];
      return { primary: room.primary, audio, power, all: [...new Set([room.primary, audio, ...power, ...(room.companions ?? [])])] };
    }
    return { primary: target, audio: target, power: [target], all: [target] };
  }

  // ---- lifecycle ----

  async connect(target: string): Promise<void> {
    const { all } = this.resolve(target);
    await Promise.all(all.map((id) => this.driver(id).connect().catch(() => undefined)));
  }

  async disconnect(target: string): Promise<void> {
    const { all } = this.resolve(target);
    for (const id of all) {
      clearTimeout(this.liveRetries.get(id));
      this.liveRetries.delete(id);
      const d = this.drivers.get(id);
      if (d) {
        await d.disconnect();
        d.removeAllListeners();
        this.drivers.delete(id);
        const state: DeviceState = { ...d.state, state: 'disconnected' };
        this.emit('state', state);
        this.activity.observe(this.lastState.get(id), state);
        this.lastState.set(id, state);
      }
    }
  }

  async forget(id: string): Promise<void> {
    const d = this.driver(id);
    await d.forget();
    d.removeAllListeners();
    this.drivers.delete(id);
    this.discovery.refreshPairedFlags();
  }

  sendPairingCode(id: string, code: string): Promise<void> {
    return this.driver(id).sendPairingCode(code);
  }

  // ---- control (room-aware) ----

  async sendKey(target: string, key: RemoteKey, direction?: KeyDirection): Promise<void> {
    const r = this.resolve(target);
    if (VOLUME_KEYS.has(key)) return this.firstThatWorks([r.audio, r.primary], (d) => d.sendKey(key, direction));
    if (POWER_KEYS.has(key)) return this.power(r.power, key);
    if (INPUT_KEYS.has(key)) return this.firstThatWorks([r.audio, r.primary], (d) => d.sendKey(key, direction));
    return this.connected(r.primary).sendKey(key, direction);
  }

  /**
   * Power for a group of devices, as a whole: if anything is on, POWER turns
   * everything off; otherwise it turns everything on. Devices that are off and
   * unreachable get a Wake-on-LAN packet when we know their MAC.
   */
  private async power(ids: string[], key: RemoteKey): Promise<void> {
    const items = ids.map((id) => ({ id, d: this.drivers.get(id), disc: this.discovery.get(id) }));
    const isOn = (d?: TvDriver) => d?.state.state === 'connected' && d.state.powered !== false;
    const anyOn = items.some((x) => isOn(x.d));
    const wantOn = key === 'POWER_ON' ? true : key === 'POWER_OFF' ? false : !anyOn;
    for (const { id } of items) this.note(id, 'power', wantOn ? 'Turn on' : 'Turn off');
    const results = await Promise.allSettled(
      items.map(async ({ id, d, disc }) => {
        const name = disc?.name ?? id;
        const connected = d?.state.state === 'connected';
        if (wantOn) {
          if (connected) {
            if (d!.state.powered === false) await d!.sendKey('POWER_ON');
            return;
          }
          if (disc?.mac) {
            await sendMagicPacket(disc.mac, disc.host);
            this.driver(id).connect().catch(() => undefined);
            return;
          }
          // Streaming boxes keep their remote port up in standby: connect, then wake.
          const drv = this.driver(id);
          await drv.connect();
          if (drv.state.state === 'connected') return drv.sendKey('POWER_ON');
          throw new Error(`${name} is off and can’t be woken over the network yet`);
        }
        if (!connected || d!.state.powered === false) return; // already off
        await d!.sendKey('POWER_OFF');
      }),
    );
    if (results.length && results.every((x) => x.status === 'rejected')) throw (results[0] as PromiseRejectedResult).reason;
  }

  private async firstThatWorks(ids: string[], fn: (d: TvDriver) => Promise<void>): Promise<void> {
    let lastErr: Error | undefined;
    for (const id of [...new Set(ids)]) {
      const d = this.drivers.get(id);
      if (!d || d.state.state !== 'connected') continue;
      try {
        return await fn(d);
      } catch (e) {
        lastErr = e as Error;
      }
    }
    throw lastErr ?? new Error('Not connected');
  }

  async sendText(target: string, text: string, opts?: { private?: boolean }): Promise<'ime' | 'keys' | 'native'> {
    const primary = this.resolve(target).primary;
    const d = this.connected(primary);
    const how = await d.sendText(text);
    // Never echo secrets into the feed: the sheet's "don't keep" switch, or a field the TV calls a password.
    const secret = opts?.private || /pass(word|code|phrase)|\bpin\b|secret/i.test(d.state.imeField?.label ?? '');
    this.note(primary, 'text', secret ? 'Typed (hidden)' : `Typed “${text.length > 48 ? text.slice(0, 47) + '…' : text}”`);
    return how;
  }

  clearText(target: string, count?: number): Promise<void> {
    return this.connected(this.resolve(target).primary).clearText(count);
  }

  /** Keyboard mode: one character; the feed gets one "Typed …" line per burst, never per key. */
  async sendChar(target: string, ch: string): Promise<'ime' | 'keys' | 'native'> {
    const primary = this.resolve(target).primary;
    const d = this.connected(primary);
    const how = await d.sendChar(ch);
    this.bufferTyping(primary, (t) => t + ch, d);
    return how;
  }

  async backspace(target: string): Promise<void> {
    const primary = this.resolve(target).primary;
    const d = this.connected(primary);
    await d.backspace();
    this.bufferTyping(primary, (t) => t.slice(0, -1), d);
  }

  private bufferTyping(id: string, edit: (t: string) => string, d: TvDriver): void {
    const cur = this.typing.get(id);
    if (cur) clearTimeout(cur.timer);
    const text = edit(cur?.text ?? '');
    const timer = setTimeout(() => {
      this.typing.delete(id);
      if (!text.trim()) return;
      const secret = /pass(word|code|phrase)|\bpin\b|secret/i.test(d.state.imeField?.label ?? '');
      this.note(id, 'text', secret ? 'Typed (hidden)' : `Typed “${text.length > 48 ? text.slice(0, 47) + '…' : text}”`);
    }, 1500);
    this.typing.set(id, { text, timer });
  }

  /**
   * Skip by a number of seconds. A Cast session seeks exactly; otherwise the app's own skip
   * keys on the primary device (Netflix, YouTube, Disney+ … treat ⏪/⏩ as 10 s steps).
   */
  async skip(target: string, seconds: number): Promise<void> {
    const r = this.resolve(target);
    for (const id of this.mediaCapable(r.all)) {
      const d = this.drivers.get(id);
      const m = d?.state.media;
      if (d && m && m.source === 'cast' && m.currentTime !== undefined && d.state.state === 'connected') {
        const elapsed = m.playerState === 'PLAYING' && m.updatedAt ? (Date.now() - m.updatedAt) / 1000 : 0;
        const to = Math.max(0, m.currentTime + elapsed + seconds);
        await d.seek(m.duration ? Math.min(m.duration, to) : to);
        this.note(id, 'link', `${seconds < 0 ? 'Back' : 'Forward'} ${Math.abs(seconds) >= 60 ? Math.round(Math.abs(seconds) / 60) + ' min' : Math.abs(seconds) + ' s'}`);
        return;
      }
    }
    const d = this.connected(r.primary);
    const key: RemoteKey = seconds < 0 ? 'REWIND' : 'FAST_FORWARD';
    const presses = Math.max(1, Math.round(Math.abs(seconds) / 10));
    for (let i = 0; i < presses; i++) {
      await d.sendKey(key);
      if (presses > 1) await new Promise((r2) => setTimeout(r2, 90));
    }
  }

  async launchApp(target: string, appId: string, link?: string): Promise<void> {
    const primary = this.resolve(target).primary;
    const d = this.connected(primary);
    await d.launchApp(appId, link);
    // The name comes from the cached list; don't hold the caller up if it has to be fetched first.
    const apps = await Promise.race([d.listApps().catch(() => [] as AppInfo[]), new Promise<AppInfo[]>((r) => setTimeout(() => r([]), 300))]);
    this.note(primary, 'launch', `Open ${apps.find((a) => a.id === appId)?.name ?? appId}`, { app: appId });
  }

  listApps(target: string, refresh?: boolean): Promise<AppInfo[]> {
    return this.connected(this.resolve(target).primary).listApps(refresh);
  }

  setVolume(target: string, level: number): Promise<void> {
    const r = this.resolve(target);
    return this.firstThatWorks([r.audio, r.primary], (d) => d.setVolume(level));
  }

  setMuted(target: string, muted: boolean): Promise<void> {
    const r = this.resolve(target);
    return this.firstThatWorks([r.audio, r.primary], (d) => d.setMuted(muted));
  }

  media(target: string, action: 'play' | 'pause' | 'stop' | 'next' | 'previous'): Promise<void> {
    const r = this.resolve(target);
    // A media session (Cast) is the most accurate; otherwise fall back to media keys on the primary.
    return this.firstThatWorks([...this.mediaCapable(r.all), r.primary], async (d) => {
      if (d.capabilities.includes('media') && d.state.media) return d.media(action);
      const key: Record<typeof action, RemoteKey> = { play: 'PLAY', pause: 'PAUSE', stop: 'STOP', next: 'NEXT', previous: 'PREVIOUS' };
      return d.sendKey(key[action]);
    });
  }

  seek(target: string, seconds: number): Promise<void> {
    const r = this.resolve(target);
    return this.firstThatWorks(this.mediaCapable(r.all), (d) => d.seek(seconds));
  }

  async castUrl(target: string, media: CastMedia): Promise<void> {
    const r = this.resolve(target);
    await this.firstThatWorks(r.all.filter((id) => this.drivers.get(id)?.capabilities.includes('cast')), (d) => d.castUrl(media));
    const name = media.title ?? media.url.split('/').pop()?.split('?')[0] ?? media.url;
    this.note(r.all.find((id) => this.drivers.get(id)?.capabilities.includes('cast')) ?? r.primary, 'link', `Cast ${name}`, { detail: media.url });
  }

  /** The TV's own search, on the primary device. */
  async searchOnTv(target: string, query: string): Promise<void> {
    const primary = this.resolve(target).primary;
    await this.connected(primary).searchOnTv(query);
    this.note(primary, 'text', `Searched the TV for “${query}”`);
  }

  /** Open a URL straight into playback: the primary device first, then any companion that can. */
  async openLink(target: string, url: string, meta?: { title?: string; artwork?: string }): Promise<void> {
    const r = this.resolve(target);
    await this.firstThatWorks([r.primary, ...r.all], (d) => d.openLink(url));
    const link = parseLink(url);
    const svc = SERVICE_META[link.service].name;
    if (link.query) this.note(r.primary, 'link', `Search “${link.query}” in ${svc}`);
    else this.note(r.primary, 'link', `Play ${meta?.title ?? (link.id ? `${svc} ${link.id}` : svc)}`, { detail: link.service === 'web' ? url : svc });
    // Searches are not things to continue watching; only real titles (or links with a title) are remembered.
    if (!link.query && (link.service !== 'web' || meta?.title)) {
      this.record({
        id: link.id ? `${link.service}:${link.id}` : `${link.service}:${hash(url)}`,
        service: link.service,
        title: meta?.title ?? (link.query ? `Search: ${link.query}` : SERVICE_META[link.service].name),
        artwork: meta?.artwork,
        url,
        target,
        at: Date.now(),
      });
    }
  }

  /** Search a service. YouTube returns playable results; other services return [] (caller opens the search page). */
  async search(_target: string, service: string, query: string): Promise<VideoResult[]> {
    if (getStore().settings().localOnly) return []; // the renderer opens the search on the TV instead
    if (service === 'youtube') return searchYouTube(query);
    return [];
  }

  searchUrl(service: string, query: string): string | undefined {
    return searchLink(service as Service, query)?.url;
  }

  private mediaCapable(ids: string[]): string[] {
    const selected = selectMedia(ids.map((id) => this.drivers.get(id)?.state));
    return ids.filter((id) => {
      const d = this.drivers.get(id);
      return d?.capabilities.includes('media') && selected && d.state.media === selected;
    });
  }

  /** The Android TV behind a target, for ADB features. Throws for other brands. */
  adbHost(target: string): string {
    const r = this.resolve(target);
    const candidates = [r.primary, ...r.all].map((id) => this.discovery.get(id)).filter(Boolean);
    const atv = candidates.find((d) => d!.kind === 'androidtv') ?? candidates.find((d) => d!.kind === 'cast');
    if (!atv) throw new Error('Sideloading needs an Android TV or Google TV device.');
    return atv!.host;
  }

  /** Combined state for a room: primary's state plus the audio device's volume and the best media session. */
  roomState(roomId: string): DeviceState {
    const r = this.resolve(roomId);
    const primary = this.getState(r.primary);
    const audio = this.getState(r.audio);
    const media = selectMedia(r.all.map((id) => this.getState(id)));
    return { ...primary, id: roomId, volume: audio.volume ?? primary.volume, media };
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.drivers.keys()].map((id) => this.disconnect(id)));
  }

  // ---- continue watching ----

  private observeMedia(state: DeviceState): void {
    const m = state.media;
    if (!m?.title || !m.contentId || m.playerState !== 'PLAYING') return;
    const service = (m.appId && CAST_APP_SERVICE[m.appId]) ?? (/^https?:/.test(m.contentId) ? 'web' : undefined);
    if (!service) return;
    const url =
      service === 'youtube' ? `https://www.youtube.com/watch?v=${m.contentId}`
      : service === 'netflix' ? `https://www.netflix.com/watch/${m.contentId}`
      : service === 'web' ? m.contentId
      : SERVICE_META[service].home;
    const id = `${service}:${service === 'web' ? hash(m.contentId) : m.contentId}`;
    const last = this.lastRecorded.get(id) ?? 0;
    if (Date.now() - last < 30_000) return; // refresh position at most every 30s
    this.lastRecorded.set(id, Date.now());
    const target = this.targetFor(state.id);
    this.record({
      id,
      service,
      title: m.title,
      subtitle: m.subtitle,
      artwork: m.artwork ?? (service === 'youtube' ? `https://i.ytimg.com/vi/${m.contentId}/mqdefault.jpg` : undefined),
      url,
      target,
      at: Date.now(),
      position: m.currentTime,
      duration: m.duration,
    });
  }

  /** The room a device belongs to (so "continue watching" reopens on the right setup), else the device. */
  private targetFor(deviceId: string): string {
    const room = getStore().rooms().find((r) => [r.primary, r.audio, ...(r.companions ?? [])].includes(deviceId));
    return room ? `room:${room.id}` : deviceId;
  }

  private record(entry: WatchEntry): void {
    const settings = getStore().recordWatch(entry);
    this.emit('history', settings.watchHistory);
  }
}

function hash(s: string): string {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

function make(kind: DeviceKind, ctx: ConstructorParameters<typeof AndroidTvDriver>[0]): TvDriver {
  switch (kind) {
    case 'androidtv':
      return new AndroidTvDriver(ctx);
    case 'cast':
      return new CastDriver(ctx);
    case 'roku':
      return new RokuDriver(ctx);
    case 'samsung':
      return new SamsungDriver(ctx);
    case 'webos':
      return new WebosDriver(ctx);
  }
}
