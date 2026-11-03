/**
 * JSON-file persistence in Electron's userData directory:
 *  - credentials per device id (Android TV cert, Samsung token, webOS client key)
 *  - known devices (so the UI can show them before discovery answers)
 *  - rooms (linked devices that act as one remote)
 *  - user settings
 */
import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import type { DeviceKind, Room, Settings } from '../shared/types';
export type { Room };

export interface PairingCert {
  key: string;
  cert: string;
}

export interface KnownDevice {
  id: string;
  kind: DeviceKind;
  host: string;
  port: number;
  name: string;
  model?: string;
  manual?: boolean;
  /** stable identity (Cast uuid, Samsung device id, SSDP USN, mDNS instance name) */
  identity?: string;
  /** MAC address for Wake-on-LAN, learned from the ARP table after a connection */
  mac?: string;
  lastSeen?: number;
}

interface StoreShape {
  /** plain credentials: only used when OS encryption is unavailable */
  credentials: Record<string, unknown>;
  /** base64(safeStorage.encryptString(JSON of credentials)) when encryption is available */
  credentialsEnc?: string;
  knownDevices: Record<string, KnownDevice>;
  rooms: Record<string, Room>;
  settings: Settings;
}

const DEFAULT_SETTINGS: Settings = {
  pinnedApps: {},
  hiddenApps: {},
  textHistory: [],
  compactAlwaysOnTop: true,
  globalShortcuts: true,
  mediaKeys: false,
  textMode: 'auto',
  watchHistory: [],
  fetchIcons: true,
  reduceMotion: false,
  popOnKeyboard: true,
  pinnedHotkeys: false,
  theme: 'dark',
  palette: 'charcoal',
  accent: 'coral',
  openAtLogin: false,
  startHidden: false,
  deviceNames: {},
  adbTermsAccepted: false,
  localOnly: false,
  autoUpdateCheck: true,
  encryptCredentials: process.platform === 'win32',
  dismissedLinkHints: [],
  // macOS 26 shows a pasteboard-privacy alert for background clipboard reads, so this is opt-in there.
  clipboardOffers: process.platform !== 'darwin',
  notifyPlayback: false,
  showActivity: true,
  volumeHotkeys: false,
  adbHosts: [],
  adbAuto: true,
  corners: {},
};

const DEFAULTS: StoreShape = { credentials: {}, knownDevices: {}, rooms: {}, settings: DEFAULT_SETTINGS };

class Store {
  private file: string;
  private data: StoreShape;

  constructor() {
    this.file = path.join(app.getPath('userData'), 'android-tv-controller.json');
    this.data = this.read();
  }

  private read(): StoreShape {
    try {
      return sanitize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  private dirty = false;
  private writeTimer?: NodeJS.Timeout;

  /** Coalesce bursts of changes (discovery touches the store often) into one write. */
  private write(): void {
    this.dirty = true;
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => this.flush(), 150);
  }

  /** Write now (atomically: temp file + rename). Called on quit. */
  flush(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = undefined;
    if (!this.dirty) return;
    this.dirty = false;
    if (this.credsCache) {
      if (this.data.settings.encryptCredentials && canEncrypt()) {
        this.data.credentialsEnc = safeStorage.encryptString(JSON.stringify(this.credsCache)).toString('base64');
        this.data.credentials = {};
      } else {
        this.data.credentials = this.credsCache;
        delete this.data.credentialsEnc;
      }
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.file);
    } catch {
      this.dirty = true; // try again on the next change
    }
  }

  /**
   * A device changed address (DHCP) or we learned its stable identity after first
   * seeing it by IP: move everything keyed by the old id to the new one so pairings,
   * rooms and pins survive.
   */
  migrateDevice(oldId: string, newId: string): void {
    if (oldId === newId) return;
    const c = this.creds();
    if (c[oldId] !== undefined) {
      if (c[newId] === undefined) c[newId] = c[oldId];
      delete c[oldId];
    }
    const kd = this.data.knownDevices;
    if (kd[oldId]) {
      kd[newId] = { ...kd[oldId], ...(kd[newId] ?? {}), id: newId };
      delete kd[oldId];
    }
    const m = (x?: string) => (x === oldId ? newId : x);
    for (const r of Object.values(this.data.rooms)) {
      r.primary = m(r.primary)!;
      r.audio = m(r.audio);
      r.power = r.power?.map((x) => m(x)!);
      r.companions = r.companions?.map((x) => m(x)!);
    }
    const s = this.data.settings;
    for (const key of ['pinnedApps', 'hiddenApps'] as const) {
      const map = s[key];
      if (map[oldId]) {
        map[newId] = map[newId] ?? map[oldId];
        delete map[oldId];
      }
    }
    if (s.lastTarget === oldId) s.lastTarget = newId;
    for (const w of s.watchHistory) if (w.target === oldId) w.target = newId;
    this.write();
  }

  // credentials (pairing certificates, tokens, client keys)
  private credsCache?: Record<string, unknown>;

  /** Decrypted credentials, materialised lazily: safeStorage only works once the app is ready. */
  private creds(): Record<string, unknown> {
    if (this.credsCache) return this.credsCache;
    if (this.data.credentialsEnc) {
      if (!canEncrypt()) return {}; // not ready yet or no keychain: don't cache, don't clobber
      try {
        this.credsCache = JSON.parse(safeStorage.decryptString(Buffer.from(this.data.credentialsEnc, 'base64')));
      } catch {
        return {}; // keep the encrypted copy intact if access was declined or temporarily unavailable
      }
    } else {
      this.credsCache = { ...(this.data.credentials ?? {}) };
    }
    return this.credsCache!;
  }
  /** Whether credentials are (or will be) encrypted at rest on this machine. */
  credentialsEncrypted(): boolean {
    return this.data.settings.encryptCredentials && canEncrypt();
  }
  getCredential<T>(deviceId: string): T | undefined {
    return this.creds()[deviceId] as T | undefined;
  }
  setCredential(deviceId: string, value: unknown): void {
    this.creds()[deviceId] = value;
    this.write();
  }
  deleteCredential(deviceId: string): void {
    delete this.creds()[deviceId];
    this.write();
  }
  hasCredential(deviceId: string): boolean {
    return this.creds()[deviceId] !== undefined;
  }

  // known devices
  rememberDevice(d: KnownDevice): void {
    this.data.knownDevices[d.id] = { ...this.data.knownDevices[d.id], ...d };
    this.write();
  }
  forgetDevice(id: string): void {
    delete this.data.knownDevices[id];
    this.write();
  }
  knownDevices(): KnownDevice[] {
    return Object.values(this.data.knownDevices);
  }

  // rooms
  rooms(): Room[] {
    return Object.values(this.data.rooms);
  }
  getRoom(id: string): Room | undefined {
    return this.data.rooms[id];
  }
  setRoom(room: Room): void {
    this.data.rooms[room.id] = room;
    this.write();
  }
  deleteRoom(id: string): void {
    delete this.data.rooms[id];
    this.write();
  }

  // settings
  settings(): Settings {
    return { ...this.data.settings };
  }
  updateSettings(patch: Partial<Settings>): Settings {
    this.data.settings = { ...this.data.settings, ...patch };
    this.write();
    return this.settings();
  }

  /** Insert/refresh a watch-history entry at the top (max 30). */
  recordWatch(entry: import('../shared/types').WatchEntry): Settings {
    const rest = this.data.settings.watchHistory.filter((e) => e.id !== entry.id);
    this.data.settings.watchHistory = [entry, ...rest].slice(0, 30);
    this.write();
    return this.settings();
  }

  removeWatch(id: string): Settings {
    this.data.settings.watchHistory = this.data.settings.watchHistory.filter((e) => e.id !== id);
    this.write();
    return this.settings();
  }
}

const KINDS: DeviceKind[] = ['androidtv', 'cast', 'roku', 'samsung', 'webos'];
const DEFAULT_PORT: Record<DeviceKind, number> = { androidtv: 6466, cast: 8009, roku: 8060, samsung: 8002, webos: 3001 };

const isObj = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);
const stringMap = (v: unknown): Record<string, string> => (isObj(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => isStr(x))) : {});
const stringListMap = (v: unknown): Record<string, string[]> => (isObj(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => Array.isArray(x)).map(([k, x]) => [k, strings(x)])) : {});
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);
const bounds = (v: unknown) => (isObj(v) && [v.x, v.y, v.width, v.height].every((n) => typeof n === 'number' && Number.isFinite(n)) ? { x: v.x, y: v.y, width: v.width, height: v.height } : undefined);

/**
 * The file is ours, but it can still be hand-edited, truncated by a crash or written by an older version:
 * every field is checked for shape so that nothing downstream has to (a null list here used to crash the
 * app at launch). Booleans and simple strings fall back to their defaults; lists keep their valid items.
 */
export function sanitize(raw: unknown): StoreShape {
  const r = isObj(raw) ? raw : {};
  const s = isObj(r.settings) ? r.settings : {};
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS, ...s };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (typeof DEFAULT_SETTINGS[key] === 'boolean' && typeof merged[key] !== 'boolean') merged[key] = DEFAULT_SETTINGS[key];
  }
  const settings: Settings = {
    ...(merged as unknown as Settings),
    pinnedApps: stringListMap(s.pinnedApps),
    hiddenApps: stringListMap(s.hiddenApps),
    textHistory: strings(s.textHistory),
    adbHosts: strings(s.adbHosts),
    dismissedLinkHints: strings(s.dismissedLinkHints),
    deviceNames: stringMap(s.deviceNames),
    corners: isObj(s.corners) ? Object.fromEntries(Object.entries(s.corners).filter(([, a]) => isObj(a) && isStr(a.type))) : {},
    watchHistory: (Array.isArray(s.watchHistory) ? s.watchHistory : []).filter((e: unknown) => isObj(e) && isStr(e.id) && isStr(e.url) && isStr(e.title)),
    textMode: oneOf(s.textMode, ['auto', 'ime', 'keys'] as const, 'auto'),
    theme: oneOf(s.theme, ['dark', 'light', 'system'] as const, DEFAULT_SETTINGS.theme),
    palette: oneOf(s.palette, ['charcoal', 'sand', 'plum', 'ocean'] as const, DEFAULT_SETTINGS.palette),
    accent: oneOf(s.accent, ['neutral', 'coral', 'mint', 'amber', 'violet', 'sky'] as const, 'neutral'),
    lastTarget: isStr(s.lastTarget) ? s.lastTarget : undefined,
    shortcutCompact: isStr(s.shortcutCompact) ? s.shortcutCompact : undefined,
    shortcutType: isStr(s.shortcutType) ? s.shortcutType : undefined,
    adbPath: isStr(s.adbPath) ? s.adbPath : undefined,
    lastRunVersion: isStr(s.lastRunVersion) ? s.lastRunVersion : undefined,
    windowBounds: bounds(s.windowBounds),
    compactBounds: bounds(s.compactBounds),
  };
  const knownDevices: Record<string, KnownDevice> = {};
  for (const d of Object.values(isObj(r.knownDevices) ? r.knownDevices : {})) {
    if (!isObj(d) || !KINDS.includes(d.kind) || !isStr(d.host) || !d.host) continue;
    const id = isStr(d.id) && d.id ? d.id : `${d.kind}:${d.host}`;
    knownDevices[id] = { ...d, id, kind: d.kind, host: d.host, port: typeof d.port === 'number' ? d.port : DEFAULT_PORT[d.kind as DeviceKind], name: isStr(d.name) && d.name ? d.name : d.host } as KnownDevice;
  }
  const rooms: Record<string, Room> = {};
  for (const room of Object.values(isObj(r.rooms) ? r.rooms : {})) {
    if (!isObj(room) || !isStr(room.id) || !room.id || !isStr(room.primary) || !room.primary) continue;
    rooms[room.id] = { ...room, id: room.id, primary: room.primary, name: isStr(room.name) && room.name ? room.name : 'Room', audio: isStr(room.audio) ? room.audio : undefined, power: Array.isArray(room.power) ? strings(room.power) : undefined, companions: Array.isArray(room.companions) ? strings(room.companions) : undefined } as Room;
  }
  return { credentials: isObj(r.credentials) ? r.credentials : {}, credentialsEnc: isStr(r.credentialsEnc) ? r.credentialsEnc : undefined, knownDevices, rooms, settings };
}

function canEncrypt(): boolean {
  try {
    return app.isReady() && safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

let instance: Store | undefined;
export function getStore(): Store {
  if (!instance) instance = new Store();
  return instance;
}
