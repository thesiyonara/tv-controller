/**
 * Types shared between the main process, preload bridge, and renderer.
 * Keep this file free of Node/Electron imports so it can be referenced from anywhere.
 */

/** One driver per protocol family. A physical TV can expose several (e.g. Google TV = androidtv + cast). */
export type DeviceKind = 'androidtv' | 'cast' | 'roku' | 'samsung' | 'webos';

export const DEVICE_KIND_LABEL: Record<DeviceKind, string> = {
  androidtv: 'Android TV remote',
  cast: 'Google Cast',
  roku: 'Roku',
  samsung: 'Samsung TV',
  webos: 'LG webOS',
};

/** Things a driver can do; the UI shows/hides controls based on these. */
export type Capability =
  | 'keys' // D-pad / navigation / media keys
  | 'text' // type text into the focused field
  | 'power'
  | 'volume' // volume up/down keys
  | 'volumeLevel' // set/read an absolute level
  | 'apps' // list installed apps
  | 'launch' // launch an app by id or deep link
  | 'media' // play/pause/seek a media session with status
  | 'cast'; // load an arbitrary media URL

export interface DiscoveredDevice {
  /** Stable id: `${kind}:${host}` */
  id: string;
  kind: DeviceKind;
  /** Friendly name advertised on the network */
  name: string;
  host: string;
  port: number;
  model?: string;
  /** Raw TXT / SSDP fields for debugging */
  meta: Record<string, string>;
  /** True if we hold credentials (cert / token / client key) for this device */
  paired: boolean;
  /** How this device asks for permission the first time */
  pairing: 'none' | 'code' | 'prompt';
  capabilities: Capability[];
  lastSeen?: number;
  /** how it was found: mDNS, SSDP, scan, manual, stored */
  via?: string;
  /** stable identity (Cast uuid, Samsung device id, SSDP USN, mDNS instance name) */
  identity?: string;
  /** MAC for Wake-on-LAN, when learned */
  mac?: string;
  manual?: boolean;
}

export interface DiscoveryStatus {
  mdns: 'idle' | 'listening' | 'error';
  ssdp: 'idle' | 'listening' | 'error';
  scan: 'idle' | 'running' | 'done';
  interfaces: string[];
  found: { mdns: number; ssdp: number; scan: number };
  /** hosts probed by the last subnet scan */
  scanned?: number;
  /** the default gateway, when known */
  gateway?: string;
  /** true when even the gateway didn't answer: OS permission, VPN or firewall is blocking LAN access */
  blocked?: boolean;
  log: string[];
}

export interface UpdateInfo {
  state: 'idle' | 'checking' | 'uptodate' | 'available' | 'downloading' | 'ready' | 'error';
  current: string;
  latest?: string;
  progress?: number;
  url?: string;
  /** macOS: the zip the app can install over itself; `installable` says the bundle location is writable */
  zipUrl?: string;
  installable?: boolean;
  notes?: string;
  note?: string;
  checkedAt?: number;
}

export type ConnectionState = 'disconnected' | 'pairing' | 'connecting' | 'connected' | 'error';

export interface TextField {
  value: string;
  start: number;
  end: number;
  label?: string;
}

export interface MediaInfo {
  /** Cast receiver app id / package of the app playing */
  appId?: string;
  /** where this came from: a Cast media session (full metadata), ADB (title/position only), or the TV's own API */
  source?: 'cast' | 'adb' | 'roku' | 'webos';
  /** Provider content id (YouTube video id, Netflix title id, media URL…) */
  contentId?: string;
  title?: string;
  subtitle?: string;
  artwork?: string;
  playerState?: 'IDLE' | 'PLAYING' | 'PAUSED' | 'BUFFERING' | string;
  /** seconds, as of `updatedAt` */
  currentTime?: number;
  duration?: number;
  updatedAt?: number;
}

export interface DeviceState {
  id: string;
  kind: DeviceKind;
  host: string;
  state: ConnectionState;
  powered?: boolean;
  /** level 0..1; `absolute`/`max` when the device reports steps (e.g. 12/100) */
  volume?: { level: number; muted: boolean; absolute?: number; max?: number };
  /** Running app: id is the package / Roku app id / webOS app id */
  currentApp?: { id: string; name?: string };
  media?: MediaInfo;
  /** On-screen keyboard open on the TV */
  imeOpen?: boolean;
  imeField?: TextField;
  /** Live TV channel (Roku TVs, LG) when the tuner is showing */
  channel?: { number?: string; name?: string; program?: string };
  /** Live view over ADB is streaming frames for this device */
  liveView?: LiveViewOptions;
  /** Playback reporting failed; remote controls can still be connected. */
  playbackError?: string;
  /** Screen capture failed independently of playback reporting. */
  screenError?: string;
  model?: string;
  vendor?: string;
  error?: string;
}

/** What the "device talks back" feed shows: one line per thing the TV reported or we sent. */
export interface ActivityEvent {
  id: number;
  at: number;
  /** device id the event belongs to */
  device: string;
  kind:
    | 'connect' | 'disconnect' | 'pairing' | 'error'
    | 'app' | 'play' | 'pause' | 'stop' | 'volume' | 'mute' | 'power' | 'keyboard' | 'channel'
    | 'launch' | 'link' | 'text' | 'install' | 'sleep' | 'info';
  /** 'in' = reported by the TV, 'out' = sent from this computer */
  dir: 'in' | 'out';
  text: string;
  detail?: string;
  /** app package / id, so the renderer can show its icon */
  app?: string;
}

/** ADB-backed live view of an Android TV: media session polling and/or screen frames. */
export interface LiveViewOptions {
  /** poll `dumpsys media_session` for what native apps are playing (title, state, position) */
  media: boolean;
  /** stream downscaled screenshots of what the TV shows (a few per second at most) */
  screen: boolean;
}

/** Protocol-neutral key names. Each driver maps these to its own codes. */
export type RemoteKey =
  | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'SELECT'
  | 'BACK' | 'HOME' | 'MENU' | 'EXIT' | 'INFO'
  | 'POWER' | 'POWER_ON' | 'POWER_OFF'
  | 'VOLUME_UP' | 'VOLUME_DOWN' | 'MUTE'
  | 'PLAY_PAUSE' | 'PLAY' | 'PAUSE' | 'STOP' | 'NEXT' | 'PREVIOUS' | 'REWIND' | 'FAST_FORWARD'
  | 'SEARCH' | 'ASSIST' | 'SETTINGS' | 'INPUT' | 'CHANNEL_UP' | 'CHANNEL_DOWN' | 'CAPTIONS' | 'GUIDE'
  | 'DIGIT_0' | 'DIGIT_1' | 'DIGIT_2' | 'DIGIT_3' | 'DIGIT_4' | 'DIGIT_5' | 'DIGIT_6' | 'DIGIT_7' | 'DIGIT_8' | 'DIGIT_9'
  | 'RED' | 'GREEN' | 'YELLOW' | 'BLUE';

export type KeyDirection = 'SHORT' | 'START_LONG' | 'END_LONG';

export interface AppInfo {
  /** Driver-specific id: Android package, Roku app id, webOS app id, Samsung app id */
  id: string;
  name: string;
  /** Deep link that opens it (Android), when known */
  link?: string;
  /** data: or http(s): icon url when the TV gives us one */
  icon?: string;
  /** Short initials for the tile when there's no icon */
  initials: string;
  /** Tile colour when there's no icon */
  color?: string;
  source: 'device' | 'catalog';
  pinned?: boolean;
  hidden?: boolean;
}

export interface CastMedia {
  url: string;
  contentType?: string;
  title?: string;
}

/** Devices linked into one remote (e.g. Google TV plugged into a Samsung). */
export interface Room {
  id: string;
  name: string;
  /** navigation, apps, text */
  primary: string;
  /** volume / mute / input; defaults to primary */
  audio?: string;
  /** devices to power-toggle together; defaults to [primary] */
  power?: string[];
  /** other protocols of the same box (e.g. the Cast side of a Google TV) for now-playing/media */
  companions?: string[];
}

/** Something the app saw playing (or launched) that can be re-opened straight into playback. */
export interface WatchEntry {
  id: string; // `${service}:${contentId}` or a hash of the url
  service: string;
  title: string;
  subtitle?: string;
  artwork?: string;
  url: string;
  /** target it was seen on, so "Continue watching" can prefer that device */
  target?: string;
  at: number;
  /** seconds, when known */
  position?: number;
  duration?: number;
}

export interface VideoResult {
  id: string;
  title: string;
  channel?: string;
  duration?: string;
  thumbnail: string;
  url: string;
}

export interface Settings {
  /** Device ids pinned in the sidebar order */
  pinnedApps: Record<string, string[]>; // deviceId -> app ids
  hiddenApps: Record<string, string[]>;
  textHistory: string[];
  compactAlwaysOnTop: boolean;
  globalShortcuts: boolean;
  mediaKeys: boolean;
  /** 'auto' tries the TV keyboard protocol first then falls back to key events */
  textMode: 'auto' | 'ime' | 'keys';
  watchHistory: WatchEntry[];
  lastTarget?: string;
  /** Electron accelerator strings; platform defaults when empty */
  shortcutCompact?: string;
  shortcutType?: string;
  /** fetch official icons from the public Play Store page for Android apps */
  fetchIcons: boolean;
  reduceMotion: boolean;
  /** bring the window forward when the TV opens its keyboard */
  popOnKeyboard: boolean;
  /** Ctrl/Cmd+Alt+1..8 open the pinned apps of the last used device from anywhere */
  pinnedHotkeys: boolean;
  trayHintShown?: boolean;
  windowBounds?: WindowBounds;
  compactBounds?: WindowBounds;
  theme: 'dark' | 'light' | 'system';
  palette: 'charcoal' | 'sand' | 'plum' | 'ocean';
  accent: 'neutral' | 'coral' | 'mint' | 'amber' | 'violet' | 'sky';
  openAtLogin: boolean;
  startHidden: boolean;
  /** user-chosen display names, by device id */
  deviceNames: Record<string, string>;
  /** the user accepted Google's SDK terms for downloading platform-tools */
  adbTermsAccepted: boolean;
  adbPath?: string;
  /** No internet at all: no update checks, icon or search lookups, platform-tools download, or web images. */
  localOnly: boolean;
  /** Check GitHub for new releases at launch and every 6 hours. */
  autoUpdateCheck: boolean;
  /** Encrypt pairings with the OS keychain (macOS asks for keychain access; off by default there). */
  encryptCredentials: boolean;
  /** "Link these two?" suggestions the user dismissed, as `${boxId}+${tvId}` */
  dismissedLinkHints: string[];
  /** When a copied link can play on the TV, offer it (toast) when the window comes to the front. */
  clipboardOffers: boolean;
  /** Desktop notification when something starts playing while the window is hidden. */
  notifyPlayback: boolean;
  /** Show the activity feed under the now-playing card. */
  showActivity: boolean;
  /** version that last ran, for the "updated, what's new" note */
  lastRunVersion?: string;
  /** Ctrl/Cmd+Alt+Up/Down/M change the TV's volume from any app */
  volumeHotkeys: boolean;
  /** TVs that accepted an ADB connection from this computer (so playback reporting can start on its own) */
  adbHosts: string[];
  /** when adb is installed and the TV accepted it before: read what's playing automatically */
  adbAuto: boolean;
  /** what the four buttons around the d-pad ring do (tl/tr/bl/br); defaults are skip 10 s / 1 min */
  corners: Record<string, CornerAction>;
}

export type CornerAction = { type: 'skip'; seconds: number } | { type: 'key'; key: RemoteKey } | { type: 'app'; id: string; name: string };

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A pending "turn the TV off at …" timer, or null. */
export type SleepTimer = { target: string; at: number } | null;

export interface AdbStatus {
  available: boolean;
  path?: string;
  /** managed = downloaded by the app; found = a known install location (Homebrew, Android SDK, Downloads…) */
  source?: 'managed' | 'path' | 'custom' | 'found';
  version?: string;
  /** 0–100 while platform-tools is downloading */
  downloading?: number;
  error?: string;
}

export interface AdbResult {
  ok: boolean;
  output: string;
  message: string;
}

/** The API exposed to the renderer by the preload script via contextBridge. */
export interface ControllerApi {
  discovery: {
    /** re-query mDNS/SSDP; deep=true also scans the subnet */
    rescan(deep?: boolean): Promise<void>;
    list(): Promise<DiscoveredDevice[]>;
    addManual(kind: DeviceKind, host: string, name?: string): Promise<DiscoveredDevice>;
    forget(id: string): Promise<void>;
    status(): Promise<DiscoveryStatus>;
    onUpdate(cb: (devices: DiscoveredDevice[]) => void): () => void;
    onStatus(cb: (status: DiscoveryStatus) => void): () => void;
  };
  adb: {
    status(): Promise<AdbStatus>;
    /** download Google's platform-tools; only after the terms were accepted */
    download(): Promise<AdbStatus>;
    connect(target: string): Promise<{ state: 'connected' | 'unauthorized' | 'offline' | 'failed'; message: string }>;
    pickApk(): Promise<string | undefined>;
    /** choose an adb binary by hand (sets the custom path) */
    pick(): Promise<AdbStatus | undefined>;
    install(target: string, apkPath: string): Promise<AdbResult>;
    uninstall(target: string, pkg: string): Promise<AdbResult>;
    screenshot(target: string): Promise<string>;
    onStatus(cb: (st: AdbStatus) => void): () => void;
  };
  update: {
    status(): Promise<UpdateInfo>;
    check(): Promise<UpdateInfo>;
    apply(): Promise<void>;
    onStatus(cb: (info: UpdateInfo) => void): () => void;
  };
  device: {
    connect(id: string): Promise<void>;
    disconnect(id: string): Promise<void>;
    forget(id: string): Promise<void>;
    sendPairingCode(id: string, code: string): Promise<void>;
    sendKey(id: string, key: RemoteKey, direction?: KeyDirection): Promise<void>;
    /** `private` keeps the text out of the activity feed (password fields are hidden automatically) */
    sendText(id: string, text: string, opts?: { private?: boolean }): Promise<'ime' | 'keys' | 'native'>;
    clearText(id: string, count?: number): Promise<void>;
    /** keyboard mode: one character, appended to the TV's field (or injected as a key) */
    sendChar(id: string, ch: string): Promise<'ime' | 'keys' | 'native'>;
    /** keyboard mode: delete one character in the TV's field */
    backspace(id: string): Promise<void>;
    /** skip by seconds: absolute seek when a session supports it, else the app's own skip keys */
    skip(id: string, seconds: number): Promise<void>;
    launchApp(id: string, appId: string, link?: string): Promise<void>;
    listApps(id: string, refresh?: boolean): Promise<AppInfo[]>;
    setVolume(id: string, level: number): Promise<void>;
    setMuted(id: string, muted: boolean): Promise<void>;
    media(id: string, action: 'play' | 'pause' | 'stop' | 'next' | 'previous'): Promise<void>;
    seek(id: string, seconds: number): Promise<void>;
    castUrl(id: string, media: CastMedia): Promise<void>;
    /** Open a URL (YouTube/Netflix/… link) straight into playback on the target's main device. */
    openLink(id: string, url: string, meta?: { title?: string; artwork?: string }): Promise<void>;
    /** Search a service: YouTube returns playable results; others return a search deep link. */
    search(id: string, service: string, query: string): Promise<VideoResult[]>;
    /** Open the TV's own search (across its apps) with this query: Google TV via its search box, Roku via ECP. */
    searchOnTv(id: string, query: string): Promise<void>;
    searchUrl(service: string, query: string): Promise<string | undefined>;
    getState(id: string): Promise<DeviceState>;
    /** recent activity for a target (room or device), newest last */
    activity(target?: string): Promise<ActivityEvent[]>;
    /** turn the ADB live view on/off for the Android TV behind a target */
    setLiveView(target: string, opts: LiveViewOptions | null): Promise<void>;
    onActivity(cb: (event: ActivityEvent) => void): () => void;
    /** a live-view frame (JPEG data: URL) for a device */
    onScreen(cb: (deviceId: string, frame: string | null) => void): () => void;
    onState(cb: (state: DeviceState) => void): () => void;
    onPairingRequested(cb: (id: string, how: 'code' | 'prompt') => void): () => void;
    onKeyboardOpened(cb: (id: string, field: TextField) => void): () => void;
  };
  rooms: {
    list(): Promise<Room[]>;
    save(room: Room): Promise<Room>;
    delete(id: string): Promise<void>;
    onUpdate(cb: (rooms: Room[]) => void): () => void;
  };
  settings: {
    get(): Promise<Settings>;
    set(patch: Partial<Settings>): Promise<Settings>;
    removeHistory(id: string): Promise<Settings>;
    onHistory(cb: (history: WatchEntry[]) => void): () => void;
  };
  app: {
    readClipboard(): Promise<string>;
    setCompact(compact: boolean): Promise<void>;
    isCompact(): Promise<boolean>;
    version(): Promise<string>;
    platform(): Promise<string>;
    /** official icon for an Android package (data: URL) or undefined */
    appIcon(pkg: string): Promise<string | undefined>;
    defaultShortcuts(): Promise<{ compact: string; type: string }>;
    openExternal(url: string): Promise<void>;
    /** macOS only: opens System Settings → Privacy & Security → Local Network */
    openLocalNetworkSettings(): Promise<void>;
    /** reveal the log file in Finder / Explorer */
    openLogs(): Promise<void>;
    /** absolute path of a dropped File (sandboxed renderers can't read it themselves) */
    pathForFile(file: File): string;
    /** set (minutes) or cancel (null) the sleep timer for a target */
    sleepTimer(target: string, minutes: number | null): Promise<SleepTimer>;
    sleepStatus(): Promise<SleepTimer>;
    onSleep(cb: (timer: SleepTimer) => void): () => void;
    onCommand(cb: (command: string) => void): () => void; // from tray / global shortcuts
  };
}
