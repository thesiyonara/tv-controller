/**
 * The contract every TV protocol driver implements.
 *
 * One driver instance == one connection to one device. The DeviceManager
 * creates drivers from discovery results, forwards IPC calls, and relays the
 * driver's events to the renderer.
 *
 * Drivers must:
 *  - emit 'state' with a full DeviceState whenever anything changes
 *  - emit 'pairingRequested' when the TV needs the user (code entry, or a prompt on the TV)
 *  - call `lost()` when the connection drops so the base class can reconnect
 *  - throw plain Errors with user-readable messages for unsupported actions
 *  - never talk to anything but the device's LAN address
 */
import { EventEmitter } from 'events';
import type {
  AppInfo,
  Capability,
  CastMedia,
  DeviceKind,
  DeviceState,
  KeyDirection,
  RemoteKey,
  TextField,
} from '../../shared/types';
import { launchTargets, parseLink, type LaunchTarget, type ParsedLink } from '../deeplink';

export interface DriverEvents {
  state: (state: DeviceState) => void;
  pairingRequested: (how: 'code' | 'prompt') => void;
  keyboardOpened: (field: TextField) => void;
  /** credentials changed (paired or revoked); discovery should refresh `paired` flags */
  credentials: () => void;
  /** a live-view frame (JPEG data: URL), or null when the live view stopped */
  screen: (frame: string | null) => void;
  /** the live view stopped on its own (ADB went away) */
  liveError: (err: Error) => void;
}

export interface DriverContext {
  id: string;
  kind: DeviceKind;
  host: string;
  port: number;
  name: string;
  appVersion: string;
}

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 20000, 30000];

export abstract class TvDriver extends EventEmitter {
  abstract readonly capabilities: Capability[];
  protected _state: DeviceState;
  /** true between connect() and disconnect(): drop-outs reconnect automatically */
  protected wantConnected = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  /** bumped by every connect()/disconnect(), so an attempt that was cancelled or superseded can't report late */
  private attemptSeq = 0;

  constructor(protected ctx: DriverContext) {
    super();
    this._state = { id: ctx.id, kind: ctx.kind, host: ctx.host, state: 'disconnected' };
  }

  get state(): DeviceState {
    return this._state;
  }

  protected update(patch: Partial<DeviceState>): void {
    this._state = { ...this._state, ...patch };
    this.emit('state', this._state);
  }

  protected requireConnected(): void {
    if (this._state.state !== 'connected') throw new Error('Not connected to the TV');
  }

  protected unsupported(what: string): never {
    throw new Error(`${what} is not supported on this device`);
  }

  // ---- lifecycle ----

  /** Public entry: marks the driver as wanted and opens the connection. */
  async connect(): Promise<void> {
    this.wantConnected = true;
    this.clearReconnect();
    const attempt = ++this.attemptSeq;
    try {
      await this.open();
    } catch (err) {
      // disconnect() or a newer connect() happened while this attempt was pending: it has nothing to say any more
      if (!this.wantConnected || attempt !== this.attemptSeq) return;
      if (this._state.state !== 'error') this.update({ state: 'error', error: (err as Error).message });
    }
    if (!this.wantConnected || attempt !== this.attemptSeq) return;
    if (this._state.state === 'connected') this.reconnectAttempt = 0;
    // A TV that is off (or asleep) at launch should be picked up when it comes back.
    else if (this._state.state !== 'pairing') this.scheduleReconnect();
  }

  /** Public exit: stops reconnecting and closes. */
  async disconnect(): Promise<void> {
    this.wantConnected = false;
    this.attemptSeq += 1;
    this.clearReconnect();
    await this.close();
    this.update({ state: 'disconnected', media: undefined, imeOpen: false, imeField: undefined });
  }

  /** Open the protocol connection; resolve when connected or set an error state. */
  protected abstract open(): Promise<void>;
  /** Tear down sockets/timers without touching `wantConnected`. */
  protected abstract close(): Promise<void>;

  /** Drivers call this when the connection drops on its own. */
  protected lost(error?: string): void {
    if (this._state.state !== 'error') this.update({ state: 'disconnected', media: undefined, imeOpen: false, imeField: undefined, error });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.wantConnected || this.reconnectTimer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      if (!this.wantConnected) return;
      try {
        await this.open();
        if (!this.wantConnected) return;
        if (this._state.state === 'connected') this.reconnectAttempt = 0;
        else this.scheduleReconnect();
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  /** After the computer wakes from sleep: drop a possibly half-dead socket and reconnect right away. */
  async reconnect(): Promise<void> {
    if (!this.wantConnected) return;
    this.clearReconnect();
    this.reconnectAttempt = 0;
    await this.close();
    if (this._state.state === 'connected') this.update({ state: 'disconnected', media: undefined, imeOpen: false, imeField: undefined });
    try {
      await this.open();
    } catch {
      /* scheduleReconnect below */
    }
    if (this._state.state !== 'connected' && this._state.state !== 'pairing') this.scheduleReconnect();
  }

  /** Drop stored credentials. Default: nothing stored. */
  async forget(): Promise<void> {
    await this.disconnect();
  }
  /** Only for pairing === 'code' devices. */
  async sendPairingCode(_code: string): Promise<void> {
    this.unsupported('Pairing code');
  }

  // ---- control (override what the protocol supports) ----
  async sendKey(_key: RemoteKey, _direction?: KeyDirection): Promise<void> {
    this.unsupported('Key input');
  }
  async sendText(_text: string): Promise<'ime' | 'keys' | 'native'> {
    this.unsupported('Text input');
  }
  async clearText(_count?: number): Promise<void> {
    this.unsupported('Text input');
  }
  /** Keyboard mode: one character. Brands whose text API appends can just send it. */
  async sendChar(ch: string): Promise<'ime' | 'keys' | 'native'> {
    return this.sendText(ch);
  }
  /** Keyboard mode: delete one character. */
  async backspace(): Promise<void> {
    return this.clearText(1);
  }
  async launchApp(_appId: string, _link?: string): Promise<void> {
    this.unsupported('Launching apps');
  }
  async listApps(_refresh?: boolean): Promise<AppInfo[]> {
    return [];
  }
  async setVolume(_level: number): Promise<void> {
    this.unsupported('Setting volume level');
  }
  async setMuted(_muted: boolean): Promise<void> {
    this.unsupported('Mute');
  }
  async media(_action: 'play' | 'pause' | 'stop' | 'next' | 'previous'): Promise<void> {
    this.unsupported('Media control');
  }
  async seek(_seconds: number): Promise<void> {
    this.unsupported('Seeking');
  }
  async castUrl(_media: CastMedia): Promise<void> {
    this.unsupported('Casting a URL');
  }
  /** Open the TV's own cross-app search with a query. */
  async searchOnTv(_query: string): Promise<void> {
    this.unsupported('Searching on the TV');
  }

  /** Open a URL straight into playback. Parses it and hands the brand-specific target to launchLink(). */
  async openLink(url: string): Promise<void> {
    const link = parseLink(url);
    await this.launchLink(link, launchTargets(link));
  }
  protected async launchLink(_link: ParsedLink, _t: LaunchTarget): Promise<void> {
    this.unsupported('Opening links');
  }
}

export function initials(name: string): string {
  const words = name.replace(/[^A-Za-z0-9+ ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).replace(/^(.)(.)/, (_m, a, b) => a.toUpperCase() + b);
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Deterministic tile colour for apps without an icon. Dark enough for light text (>=4.5:1). */
export function colorFor(key: string): string {
  const palette = ['#B23A3A', '#9C4B2E', '#8A6508', '#2E7D4F', '#1F6E7A', '#2F5FA8', '#5A3E9C', '#8A3A7A', '#3A3F4B', '#1F5E9C'];
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}
