/**
 * The activity feed: what the TV reported and what we sent, as short timestamped
 * lines ("Opened Netflix", "Playing Severance · S2 E3", "Volume 14", "Keyboard
 * open on the TV"). Events are derived from DeviceState transitions, so every
 * driver feeds it for free; the DeviceManager adds the outgoing side (launches,
 * links, typed text) itself.
 *
 * Kept in memory only (last 300 events). Nothing is written to disk.
 */
import { EventEmitter } from 'events';
import type { ActivityEvent, DeviceState } from '../shared/types';

const MAX_EVENTS = 300;
/** repeated volume steps within this window update the previous line instead of adding one */
const COALESCE_MS = 2500;

export type NewEvent = Omit<ActivityEvent, 'id' | 'at'> & { at?: number };

export class ActivityLog extends EventEmitter {
  private events: ActivityEvent[] = [];
  private seq = 0;

  /** Oldest first. */
  list(deviceIds?: string[]): ActivityEvent[] {
    return deviceIds ? this.events.filter((e) => deviceIds.includes(e.device)) : [...this.events];
  }

  add(e: NewEvent): ActivityEvent {
    const last = this.events[this.events.length - 1];
    const at = e.at ?? Date.now();
    // Volume steps and mute flips are chatter: while nothing else happened on that device, the last line just updates.
    const chatter = (k: ActivityEvent['kind']) => k === 'volume' || k === 'mute';
    if (last && chatter(e.kind) && chatter(last.kind) && last.device === e.device && at - last.at < (e.kind === last.kind ? 60_000 : COALESCE_MS * 8)) {
      last.kind = e.kind;
      last.text = e.text;
      last.detail = e.detail;
      last.at = at;
      this.emit('event', last);
      return last;
    }
    // Two protocols of one box (Cast + ADB, Google TV + Cast) often report the same thing seconds apart: say it once.
    for (let i = this.events.length - 1; i >= 0 && at - this.events[i].at < 6000; i--) {
      const p = this.events[i];
      if (p.device !== e.device && p.kind === e.kind && p.text === e.text && (p.detail ?? '') === (e.detail ?? '') && p.dir === e.dir) return p;
    }
    const ev: ActivityEvent = { id: ++this.seq, at, ...e };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.emit('event', ev);
    return ev;
  }

  /** Record whatever changed between two states of the same device. */
  observe(prev: DeviceState | undefined, next: DeviceState): void {
    for (const e of diffState(prev, next)) this.add(e);
  }
}

function appLabel(app?: { id: string; name?: string }): string {
  if (!app) return '';
  return app.name || prettyPackage(app.id);
}

/** "com.netflix.ninja" → "Netflix", "tv.twitch.android.app" → "Twitch". */
export function prettyPackage(pkg: string): string {
  if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/i.test(pkg)) return pkg;
  const skip = new Set(['com', 'org', 'net', 'io', 'tv', 'android', 'androidtv', 'app', 'apps', 'ninja', 'mobile', 'client', 'leanback', 'livingroom', 'google']);
  const parts = pkg.split('.').filter((p) => !skip.has(p.toLowerCase()));
  const word = parts[0] ?? pkg.split('.').pop() ?? pkg;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function mediaKey(s?: DeviceState): string | undefined {
  const m = s?.media;
  if (!m) return undefined;
  return m.contentId || m.title || undefined;
}

function mediaTitle(s?: DeviceState): string {
  const m = s?.media;
  if (!m) return '';
  return [m.title, m.subtitle].filter(Boolean).join(' · ') || appLabel(s?.currentApp) || 'media';
}

function volumeText(v: NonNullable<DeviceState['volume']>): string {
  return `Volume ${v.absolute !== undefined ? v.absolute : Math.round(v.level * 100) + '%'}`;
}

/** Pure: the events a transition from `prev` to `next` produces, in order. */
export function diffState(prev: DeviceState | undefined, next: DeviceState): NewEvent[] {
  const out: NewEvent[] = [];
  const dev = next.id;
  const ev = (kind: ActivityEvent['kind'], text: string, extra: Partial<NewEvent> = {}): void => {
    out.push({ device: dev, kind, dir: 'in', text, ...extra });
  };

  const wasConnected = prev?.state === 'connected';
  const isConnected = next.state === 'connected';
  if (isConnected && !wasConnected) {
    const what = [next.vendor, next.model].filter(Boolean).join(' ');
    ev('connect', 'Connected', what ? { detail: what } : {});
  } else if (wasConnected && !isConnected) {
    ev('disconnect', next.state === 'error' ? 'Connection lost' : 'Disconnected', next.error ? { detail: next.error } : {});
    return out; // everything else (media cleared, keyboard closed) is a consequence of this
  }
  if (next.state === 'pairing' && prev?.state !== 'pairing') ev('pairing', 'Waiting for you to allow it on the TV');
  if (next.state === 'error' && next.error && next.error !== prev?.error && !(wasConnected && !isConnected)) ev('error', next.error);
  if (!prev) return out;

  if (prev.powered !== undefined && next.powered !== undefined && prev.powered !== next.powered) ev('power', next.powered ? 'Woke up' : 'Went to standby');

  if (prev.currentApp?.id !== next.currentApp?.id) {
    if (next.currentApp) ev('app', `Opened ${appLabel(next.currentApp)}`, { app: next.currentApp.id });
    else if (prev.currentApp) ev('app', 'Home screen');
  }

  const pk = mediaKey(prev);
  const nk = mediaKey(next);
  const ps = prev.media?.playerState;
  const ns = next.media?.playerState;
  if (next.media && nk && nk !== pk) {
    if (ns === 'PAUSED') ev('pause', 'Paused', { detail: mediaTitle(next), app: next.media.appId });
    else if (ns === 'BUFFERING') ev('play', 'Loading', { detail: mediaTitle(next), app: next.media.appId });
    else if (ns && ns !== 'IDLE') ev('play', 'Playing', { detail: mediaTitle(next), app: next.media.appId });
  } else if (next.media && nk && ns !== ps) {
    if (ns === 'PAUSED' && ps === 'PLAYING') ev('pause', 'Paused', { detail: mediaTitle(next), app: next.media.appId });
    else if (ns === 'PLAYING' && (ps === 'PAUSED' || ps === 'BUFFERING' || ps === 'IDLE' || !ps)) ev('play', ps === 'PAUSED' ? 'Resumed' : 'Playing', { detail: mediaTitle(next), app: next.media.appId });
    else if (ns === 'IDLE' && ps && ps !== 'IDLE') ev('stop', 'Finished', { detail: mediaTitle(prev) });
  } else if (prev.media && pk && !next.media && isConnected) {
    ev('stop', 'Stopped', { detail: mediaTitle(prev) });
  }

  if (prev.volume && next.volume) {
    const pa = prev.volume.absolute ?? Math.round(prev.volume.level * 100);
    const na = next.volume.absolute ?? Math.round(next.volume.level * 100);
    if (pa !== na) ev('volume', volumeText(next.volume));
    if (prev.volume.muted !== next.volume.muted) ev('mute', next.volume.muted ? 'Muted' : 'Unmuted');
  }

  if (!prev.imeOpen && next.imeOpen) ev('keyboard', 'Keyboard open on the TV', next.imeField?.label ? { detail: next.imeField.label } : next.imeField?.value ? { detail: `“${next.imeField.value}”` } : {});

  const pc = prev.channel;
  const nc = next.channel;
  if (nc && (nc.number !== pc?.number || nc.name !== pc?.name || (nc.program && nc.program !== pc?.program))) {
    ev('channel', ['Channel', nc.number, nc.name].filter(Boolean).join(' '), nc.program ? { detail: nc.program } : {});
  }
  return out;
}
