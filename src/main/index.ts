/**
 * Electron main process: owns discovery, device drivers, the tray, global
 * shortcuts and the window. The renderer never touches the network.
 *
 * Platform notes
 *  macOS   : hidden-inset title bar, template tray icon, an app menu with the
 *            standard Edit roles (without it ⌘C/⌘V don't work in inputs).
 *            Default hotkeys avoid ⌥Space, which Alfred and Raycast own.
 *  Windows : default frame with the menu bar hidden, white tray icon for the
 *            dark taskbar, AppUserModelID for taskbar grouping, Ctrl+Shift+Space
 *            instead of Alt+Space (which opens the window's system menu).
 *  Linux   : same as Windows minus the AppUserModelID.
 */
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, Tray, shell, screen, session, powerMonitor } from 'electron';
import fs from 'fs';
import path from 'path';
import { IPC } from '../shared/ipc';
import type { CastMedia, DeviceKind, DeviceState, KeyDirection, LiveViewOptions, RemoteKey, Settings, SleepTimer, WindowBounds } from '../shared/types';
import { Discovery } from './discovery';
import { DeviceManager } from './devices';
import { androidIcon } from './icons';
import { Updater } from './updater';
import { installCrashLogging, log, logPath } from './log';
import { adb } from './adb';
import { getStore, type Room } from './store';

const isDev = process.argv.includes('--dev');
const isMac = process.platform === 'darwin';
const FULL_SIZE = { width: 1200, height: 780 };
const COMPACT_SIZE = { width: 340, height: 620 };
const COMPACT_MIN = { width: 280, height: 420 };
const COMPACT_MAX = { width: 420, height: 740 };
const ASSETS = path.join(__dirname, '..', '..', 'assets');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const APP_VERSION: string = require('../../package.json').version;

installCrashLogging();

// The app was called "Android TV Controller" until 0.7: adopt that data folder once so pairings, rooms and settings carry over.
(function adoptLegacyData() {
  try {
    const current = app.getPath('userData');
    const legacy = path.join(app.getPath('appData'), 'Android TV Controller');
    const store = 'android-tv-controller.json';
    if (legacy !== current && fs.existsSync(path.join(legacy, store)) && !fs.existsSync(path.join(current, store))) {
      fs.cpSync(legacy, current, { recursive: true, force: false, errorOnExist: false });
    }
  } catch {
    /* start fresh */
  }
})();

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let compact = false;
let quitting = false;
let sleep: { target: string; at: number; handle: NodeJS.Timeout } | null = null;
let nowPlayingLabel = '';
/** media title we last notified about and when, so a pause/resume or a second protocol doesn't notify twice */
let notified: { title: string; at: number } | undefined;

const discovery = new Discovery();
const devices = new DeviceManager(discovery, APP_VERSION);
const updater = new Updater(APP_VERSION);

if (process.platform === 'win32') app.setAppUserModelId('dev.thesiyonara.androidtvcontroller');

// Single instance: a second launch just focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

/** RFC1918 / link-local / loopback / .local names: the only destinations allowed in local-only mode. */
function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.local')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

function defaultShortcuts(): { compact: string; type: string } {
  return isMac ? { compact: 'Control+Alt+Space', type: 'Control+Alt+K' } : { compact: 'Control+Shift+Space', type: 'Control+Shift+K' };
}

// ---- window ----------------------------------------------------------------

/** Stored bounds, but only if they are still (mostly) on a connected display. */
function savedBounds(key: 'windowBounds' | 'compactBounds'): WindowBounds | undefined {
  const b = getStore().settings()[key];
  if (!b) return undefined;
  // Keep the two modes from contaminating each other: a "full" window narrower than the
  // three-column layout, or a "compact" one wider than a remote, is treated as unset.
  if (key === 'windowBounds' && (b.width < 820 || b.height < 560)) return undefined;
  if (key === 'compactBounds' && (b.width < COMPACT_MIN.width || b.width > COMPACT_MAX.width || b.height < COMPACT_MIN.height || b.height > COMPACT_MAX.height)) return undefined;
  const area = screen.getDisplayMatching(b).workArea;
  const visible = b.x + b.width > area.x + 40 && b.x < area.x + area.width - 40 && b.y >= area.y - 10 && b.y < area.y + area.height - 40;
  return visible ? b : undefined;
}

let boundsTimer: NodeJS.Timeout | undefined;
function persistBounds(now = false): void {
  if (boundsTimer) clearTimeout(boundsTimer);
  const save = () => {
    boundsTimer = undefined;
    if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    const b = win.getBounds();
    getStore().updateSettings(compact ? { compactBounds: b } : { windowBounds: b });
  };
  if (now) save();
  else boundsTimer = setTimeout(save, 400);
}

function isLightTheme(): boolean {
  const t = getStore().settings().theme;
  return t === 'light' || (t === 'system' && !require('electron').nativeTheme.shouldUseDarkColors);
}
function themeBackground(): string {
  const colors = { charcoal: ['#F5F4F1', '#141313'], sand: ['#F4EDE0', '#211C17'], plum: ['#F6EFF4', '#20151F'], ocean: ['#F0F3FA', '#0C1019'] };
  return colors[getStore().settings().palette || 'charcoal'][isLightTheme() ? 0 : 1];
}
/** Windows 11: native caption buttons drawn over our title bar, in the theme's colours. */
function titleBarOverlay(): Electron.TitleBarOverlayOptions {
  const panels = { charcoal: ['#FFFEFB', '#1C1A19'], sand: ['#FFFAF0', '#2A241D'], plum: ['#FFFAFE', '#2B1D2A'], ocean: ['#FFFFFF', '#121825'] };
  return { color: panels[getStore().settings().palette || 'charcoal'][isLightTheme() ? 0 : 1], symbolColor: isLightTheme() ? '#262220' : '#F7F2EC', height: 52 };
}

/** Keep web controls aligned with native window buttons, which do not follow page zoom. */
function applyZoom(): void {
  if (!win || win.isDestroyed()) return;
  if (win.webContents.getZoomFactor() !== 1) win.webContents.setZoomFactor(1);
}

function createWindow(opts: { hidden?: boolean } = {}): void {
  const saved = savedBounds('windowBounds');
  win = new BrowserWindow({
    ...(saved ?? FULL_SIZE),
    minWidth: 820,
    minHeight: 560,
    title: 'TV Controller',
    backgroundColor: themeBackground(),
    icon: process.platform === 'linux' ? path.join(ASSETS, 'icon.png') : undefined,
    titleBarStyle: isMac ? 'hiddenInset' : process.platform === 'win32' ? 'hidden' : 'default',
    ...(process.platform === 'win32' ? { titleBarOverlay: titleBarOverlay() } : {}),
    trafficLightPosition: { x: 16, y: 18 },
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!opts.hidden) win?.show();
  });
  // The renderer is a local page; it never navigates anywhere.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  win.on('resize', () => { applyZoom(); persistBounds(); });
  win.on('move', () => persistBounds());
  win.webContents.on('did-finish-load', () => applyZoom());
  // Live-view screen frames are only worth capturing while someone can see them.
  win.on('hide', () => devices.setScreenPaused(true));
  win.on('minimize', () => devices.setScreenPaused(true));
  win.on('show', () => devices.setScreenPaused(false));
  win.on('restore', () => devices.setScreenPaused(false));
  // Closing hides to the tray; Quit lives in the tray/app menu.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
    const s = getStore().settings();
    if (process.platform === 'win32' && tray && !s.trayHintShown) {
      tray.displayBalloon({ iconType: 'info', title: 'Still running', content: 'TV Controller keeps running in the tray. Right-click the tray icon to quit.' });
      getStore().updateSettings({ trayHintShown: true });
    }
  });
  win.on('closed', () => (win = null));
  // Links clicked in the renderer open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow(): void {
  if (!win) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function setCompact(on: boolean): void {
  if (!win || on === compact) {
    if (win) send(IPC.app.command, on ? 'compact:on' : 'compact:off');
    return;
  }
  if (win.isMaximized()) win.unmaximize();
  persistBounds(true); // remember the bounds of the mode we're leaving
  compact = on;
  const settings = getStore().settings();
  if (on) {
    win.setMinimumSize(COMPACT_MIN.width, COMPACT_MIN.height);
    win.setMaximumSize(COMPACT_MAX.width, COMPACT_MAX.height);
    win.setMaximizable(false); // compact mode should never become a full-height empty column
    const b = savedBounds('compactBounds');
    if (b) win.setBounds(b, true);
    else win.setSize(COMPACT_SIZE.width, COMPACT_SIZE.height, true);
    win.setAlwaysOnTop(settings.compactAlwaysOnTop, 'floating');
  } else {
    win.setAlwaysOnTop(false);
    win.setMaximizable(true);
    win.setMaximumSize(20000, 20000);
    win.setMinimumSize(820, 560);
    const b = savedBounds('windowBounds');
    if (b) win.setBounds(b, true);
    else win.setSize(FULL_SIZE.width, FULL_SIZE.height, true);
  }
  send(IPC.app.command, on ? 'compact:on' : 'compact:off');
  applyZoom();
  updateTrayMenu();
}

// ---- tray ------------------------------------------------------------------

function trayIcon(): Electron.NativeImage {
  const file = isMac ? 'tray-macTemplate.png' : process.platform === 'win32' ? 'tray-win.png' : 'tray-linux.png';
  const img = nativeImage.createFromPath(path.join(ASSETS, file));
  if (isMac) img.setTemplateImage(true);
  return img;
}

function sleepLabel(): string {
  if (!sleep) return 'Sleep timer';
  const mins = Math.max(1, Math.round((sleep.at - Date.now()) / 60_000));
  return `Sleep timer: ${mins} min left`;
}

function updateTrayMenu(): void {
  if (!tray) return;
  const target = getStore().settings().lastTarget;
  const sleepItems: Electron.MenuItemConstructorOptions[] = [15, 30, 60, 90].map((m) => ({ label: `${m} minutes`, enabled: Boolean(target), click: () => setSleepTimer(target!, m) }));
  const menu = Menu.buildFromTemplate([
    ...(nowPlayingLabel ? [{ label: nowPlayingLabel, enabled: false }, { type: 'separator' as const }] : []),
    { label: 'Open TV Controller', click: () => showWindow() },
    { label: 'Compact remote', type: 'checkbox', checked: compact, click: (item) => { showWindow(); setCompact(item.checked); } },
    { type: 'separator' },
    { label: 'Play / Pause', click: () => send(IPC.app.command, 'key:PLAY_PAUSE') },
    { label: 'Mute', click: () => send(IPC.app.command, 'key:MUTE') },
    { label: 'Volume up', click: () => send(IPC.app.command, 'key:VOLUME_UP') },
    { label: 'Volume down', click: () => send(IPC.app.command, 'key:VOLUME_DOWN') },
    { label: 'Home', click: () => send(IPC.app.command, 'key:HOME') },
    { label: 'Power', click: () => send(IPC.app.command, 'key:POWER') },
    { label: 'Type on the TV…', click: () => { showWindow(); send(IPC.app.command, 'type:open'); } },
    { label: sleepLabel(), submenu: [...sleepItems, { type: 'separator' }, { label: 'Off', enabled: Boolean(sleep), click: () => setSleepTimer(sleep?.target ?? target ?? '', null) }] },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function createTray(): void {
  try {
    tray = new Tray(trayIcon());
  } catch (err) {
    log.warn('tray', `no tray on this desktop: ${(err as Error).message}`);
    return;
  }
  tray.setToolTip('TV Controller');
  updateTrayMenu();
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  setInterval(() => sleep && updateTrayMenu(), 60_000);
}

// ---- app menu (macOS) --------------------------------------------------------

function createAppMenu(): void {
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: async () => { showWindow(); await updater.check(); send(IPC.app.command, 'settings:open'); } },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Command+,', click: () => { showWindow(); send(IPC.app.command, 'settings:open'); } },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [
        { label: 'Compact remote', accelerator: 'Command+Shift+C', click: () => setCompact(!compact) },
        { label: 'Type on the TV…', accelerator: 'Command+K', click: () => send(IPC.app.command, 'type:open') },
        { label: 'Keyboard shortcuts', accelerator: 'Command+/', click: () => send(IPC.app.command, 'help:open') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ role: 'toggleDevTools' as const }] : []),
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
    {
      role: 'help',
      submenu: [
        { label: 'Project on GitHub', click: () => shell.openExternal('https://github.com/thesiyonara/tv-controller') },
        { label: 'Show Log File', click: () => shell.showItemInFolder(logPath()) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- global shortcuts ----------------------------------------------------------

function registerShortcuts(settings: Settings): void {
  globalShortcut.unregisterAll();
  const def = defaultShortcuts();
  const tryRegister = (acc: string, fn: () => void) => {
    try {
      if (!globalShortcut.register(acc, fn)) log.warn('shortcuts', `could not register ${acc} (taken by another app?)`);
    } catch (err) {
      log.warn('shortcuts', `invalid accelerator ${acc}: ${(err as Error).message}`);
    }
  };
  if (settings.globalShortcuts) {
    tryRegister(settings.shortcutCompact || def.compact, () => {
      if (win?.isVisible() && win.isFocused()) win.hide();
      else {
        showWindow();
        if (!compact) setCompact(true);
      }
    });
    tryRegister(settings.shortcutType || def.type, () => {
      showWindow();
      send(IPC.app.command, 'type:open');
    });
  }
  if (settings.mediaKeys) {
    tryRegister('MediaPlayPause', () => send(IPC.app.command, 'key:PLAY_PAUSE'));
    tryRegister('MediaNextTrack', () => send(IPC.app.command, 'key:NEXT'));
    tryRegister('MediaPreviousTrack', () => send(IPC.app.command, 'key:PREVIOUS'));
    tryRegister('MediaStop', () => send(IPC.app.command, 'key:STOP'));
  }
  if (settings.pinnedHotkeys) {
    for (let i = 1; i <= 8; i++) tryRegister(`CommandOrControl+Alt+${i}`, () => send(IPC.app.command, `pinned:${i - 1}`));
  }
  if (settings.volumeHotkeys) {
    tryRegister('CommandOrControl+Alt+Up', () => send(IPC.app.command, 'key:VOLUME_UP'));
    tryRegister('CommandOrControl+Alt+Down', () => send(IPC.app.command, 'key:VOLUME_DOWN'));
    tryRegister('CommandOrControl+Alt+M', () => send(IPC.app.command, 'key:MUTE'));
  }
}

// ---- sleep timer ----------------------------------------------------------------

function sleepStatus(): SleepTimer {
  return sleep ? { target: sleep.target, at: sleep.at } : null;
}

function setSleepTimer(target: string, minutes: number | null): SleepTimer {
  if (sleep) {
    clearTimeout(sleep.handle);
    sleep = null;
  }
  if (target && minutes && minutes > 0) {
    const at = Date.now() + minutes * 60_000;
    const handle = setTimeout(async () => {
      sleep = null;
      send(IPC.app.sleepEvent, null);
      updateTrayMenu();
      try {
        await devices.sendKey(target, 'POWER_OFF');
        log.info('sleep', `turned off ${target}`);
      } catch (err) {
        log.warn('sleep', `power off failed for ${target}: ${(err as Error).message}`);
      }
    }, minutes * 60_000);
    sleep = { target, at, handle };
    try {
      devices.note(target.startsWith('room:') ? (getStore().getRoom(target.slice(5))?.primary ?? target) : target, 'sleep', `Sleep timer: off in ${minutes} min`);
    } catch {
      /* unknown target */
    }
  }
  send(IPC.app.sleepEvent, sleepStatus());
  updateTrayMenu();
  return sleepStatus();
}

// ---- wiring ------------------------------------------------------------------

function wireEvents(): void {
  discovery.on('update', (list) => send(IPC.discovery.update, list));
  discovery.on('status', (st) => {
    send(IPC.discovery.statusEvent, st);
    const last = st.log[st.log.length - 1];
    if (last) log.info('discovery', last.slice(9));
  });
  updater.on('status', (st) => {
    send(IPC.update.statusEvent, st);
    if (st.state === 'error') log.warn('updater', st.note ?? 'error');
  });
  adb.on('status', (st) => send(IPC.adb.statusEvent, st));
  // A TV accepted debugging from this computer: remember it so playback reporting can start on its own next time.
  adb.on('connected', (host: string) => {
    const s = getStore().settings();
    if (!s.adbHosts.includes(host)) getStore().updateSettings({ adbHosts: [...s.adbHosts, host] });
  });
  devices.on('state', (state: DeviceState) => {
    send(IPC.device.state, state);
    if (state.state === 'error' && state.error) log.warn('device', `${state.id}: ${state.error}`);
    const m = state.media;
    if (m?.title && (m.playerState === 'PLAYING' || m.playerState === 'PAUSED')) {
      const label = `${m.playerState === 'PLAYING' ? '▶' : '⏸'} ${m.title}`.slice(0, 60);
      if (label !== nowPlayingLabel) {
        nowPlayingLabel = label;
        updateTrayMenu();
        tray?.setToolTip(`${label}\nTV Controller`);
      }
      // "Something started playing" while the window is out of sight: a quiet desktop notification (opt-in).
      if (m.playerState === 'PLAYING' && !(notified && notified.title === m.title && Date.now() - notified.at < 10 * 60_000)) {
        notified = { title: m.title, at: Date.now() };
        const hidden = !win || win.isDestroyed() || !win.isVisible() || !win.isFocused();
        if (hidden && getStore().settings().notifyPlayback && Notification.isSupported()) {
          const name = discovery.get(state.id)?.name ?? 'the TV';
          const n = new Notification({ title: `Now playing on ${name}`, body: [m.title, m.subtitle].filter(Boolean).join(' · '), silent: true });
          n.on('click', () => showWindow());
          n.show();
        }
      }
    } else if (state.state !== 'connected' && nowPlayingLabel) {
      nowPlayingLabel = '';
      updateTrayMenu();
      tray?.setToolTip('TV Controller');
    }
  });
  devices.on('activity', (e) => send(IPC.device.activityEvent, e));
  devices.on('screen', (id: string, frame: string | null) => send(IPC.device.screen, id, frame));
  // Waking from sleep: sockets are often half-dead; reconnect now instead of waiting for timeouts.
  powerMonitor.on('resume', () => {
    log.info('power', 'resumed: reconnecting');
    discovery.rescan(false);
    void devices.reconnectAll();
  });
  devices.on('pairingRequested', (id, how) => {
    send(IPC.device.pairingRequested, id, how);
    showWindow();
  });
  devices.on('keyboardOpened', (id, field) => {
    send(IPC.device.keyboardOpened, id, field);
    if (getStore().settings().popOnKeyboard) showWindow();
  });
  devices.on('rooms', (rooms) => send(IPC.rooms.update, rooms));
  devices.on('history', (history) => send(IPC.settings.history, history));
}

function registerIpc(): void {
  // discovery
  ipcMain.handle(IPC.discovery.rescan, (_e, deep?: boolean) => discovery.rescan(deep ?? true));
  ipcMain.handle(IPC.discovery.list, () => discovery.list());
  ipcMain.handle(IPC.discovery.addManual, (_e, kind: DeviceKind, host: string, name?: string) => discovery.addManual(kind, host, name));
  ipcMain.handle(IPC.discovery.forget, (_e, id: string) => discovery.forget(id));
  ipcMain.handle(IPC.discovery.status, () => discovery.getStatus());

  // updates
  ipcMain.handle(IPC.update.status, () => updater.status());
  ipcMain.handle(IPC.update.check, () => updater.check());
  ipcMain.handle(IPC.update.apply, () => updater.apply());

  // devices (target = device id or room id)
  ipcMain.handle(IPC.device.connect, (_e, t: string) => devices.connect(t));
  ipcMain.handle(IPC.device.disconnect, (_e, t: string) => devices.disconnect(t));
  ipcMain.handle(IPC.device.forget, (_e, id: string) => devices.forget(id));
  ipcMain.handle(IPC.device.sendPairingCode, (_e, id: string, code: string) => devices.sendPairingCode(id, code));
  ipcMain.handle(IPC.device.sendKey, (_e, t: string, key: RemoteKey, dir?: KeyDirection) => devices.sendKey(t, key, dir));
  ipcMain.handle(IPC.device.sendText, (_e, t: string, text: string, opts?: { private?: boolean }) => devices.sendText(t, text, opts));
  ipcMain.handle(IPC.device.clearText, (_e, t: string, count?: number) => devices.clearText(t, count));
  ipcMain.handle(IPC.device.sendChar, (_e, t: string, ch: string) => devices.sendChar(t, String(ch).slice(0, 4)));
  ipcMain.handle(IPC.device.backspace, (_e, t: string) => devices.backspace(t));
  ipcMain.handle(IPC.device.skip, (_e, t: string, seconds: number) => devices.skip(t, Math.max(-600, Math.min(600, Number(seconds) || 0))));
  ipcMain.handle(IPC.device.launchApp, (_e, t: string, appId: string, link?: string) => devices.launchApp(t, appId, link));
  ipcMain.handle(IPC.device.listApps, (_e, t: string, refresh?: boolean) => devices.listApps(t, refresh));
  ipcMain.handle(IPC.device.setVolume, (_e, t: string, level: number) => devices.setVolume(t, level));
  ipcMain.handle(IPC.device.setMuted, (_e, t: string, muted: boolean) => devices.setMuted(t, muted));
  ipcMain.handle(IPC.device.media, (_e, t: string, action: 'play' | 'pause' | 'stop' | 'next' | 'previous') => devices.media(t, action));
  ipcMain.handle(IPC.device.seek, (_e, t: string, s: number) => devices.seek(t, s));
  ipcMain.handle(IPC.device.castUrl, (_e, t: string, m: CastMedia) => devices.castUrl(t, m));
  ipcMain.handle(IPC.device.openLink, (_e, t: string, url: string, meta?: { title?: string; artwork?: string }) => devices.openLink(t, url, meta));
  ipcMain.handle(IPC.device.search, (_e, t: string, service: string, q: string) => devices.search(t, service, q));
  ipcMain.handle(IPC.device.searchOnTv, (_e, t: string, q: string) => devices.searchOnTv(t, q));
  ipcMain.handle(IPC.device.searchUrl, (_e, service: string, q: string) => devices.searchUrl(service, q));
  ipcMain.handle(IPC.device.getState, (_e, t: string) => (t.startsWith('room:') ? devices.roomState(t) : devices.getState(t)));
  ipcMain.handle(IPC.device.activity, (_e, t?: string) => devices.activityFor(t));
  ipcMain.handle(IPC.device.setLiveView, (_e, t: string, opts: LiveViewOptions | null) => devices.setLiveView(t, opts));

  // rooms
  ipcMain.handle(IPC.rooms.list, () => devices.rooms());
  ipcMain.handle(IPC.rooms.save, (_e, room: Room) => devices.saveRoom(room));
  ipcMain.handle(IPC.rooms.delete, (_e, id: string) => devices.deleteRoom(id));

  // settings
  ipcMain.handle(IPC.settings.get, () => getStore().settings());
  ipcMain.handle(IPC.settings.set, (_e, patch: Partial<Settings>) => {
    const s = getStore().updateSettings(patch);
    registerShortcuts(s);
    if (compact && win) win.setAlwaysOnTop(s.compactAlwaysOnTop, 'floating');
    if ('lastTarget' in patch) updateTrayMenu();
    if (('theme' in patch || 'palette' in patch) && win) {
      win.setBackgroundColor(themeBackground());
      if (process.platform === 'win32') win.setTitleBarOverlay(titleBarOverlay());
    }
    if ('adbPath' in patch) adb.setCustomPath(s.adbPath);
    if (('openAtLogin' in patch || 'startHidden' in patch) && (isMac || process.platform === 'win32')) {
      try {
        // "Start hidden" is our own setting (applied in createWindow); the OS flag was removed in recent macOS.
        app.setLoginItemSettings({ openAtLogin: s.openAtLogin });
      } catch (err) {
        log.warn('login', (err as Error).message);
      }
    }
    return s;
  });
  ipcMain.handle(IPC.settings.removeHistory, (_e, id: string) => getStore().removeWatch(id));

  // app
  ipcMain.handle(IPC.app.readClipboard, () => clipboard.readText());
  ipcMain.handle(IPC.app.setCompact, (_e, on: boolean) => setCompact(on));
  ipcMain.handle(IPC.app.isCompact, () => compact);
  ipcMain.handle(IPC.app.version, () => APP_VERSION);
  ipcMain.handle(IPC.app.platform, () => process.platform);
  ipcMain.handle(IPC.app.appIcon, (_e, pkg: string) => {
    const s = getStore().settings();
    return s.fetchIcons && !s.localOnly ? androidIcon(pkg) : undefined;
  });
  ipcMain.handle(IPC.app.defaultShortcuts, () => defaultShortcuts());
  ipcMain.handle(IPC.app.openExternal, (_e, url: string) => (/^https?:/.test(url) ? shell.openExternal(url) : undefined));
  // macOS: System Settings → Privacy & Security → Local Network (the usual reason discovery finds nothing)
  ipcMain.handle(IPC.app.openLocalNetworkSettings, () =>
    isMac ? shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork') : undefined,
  );
  ipcMain.handle(IPC.app.openLogs, () => shell.showItemInFolder(logPath()));
  ipcMain.handle(IPC.app.sleepTimer, (_e, target: string, minutes: number | null) => setSleepTimer(target, minutes));
  ipcMain.handle(IPC.app.sleepStatus, () => sleepStatus());

  // adb (sideloading etc.) — only ever against the Android TV behind a target
  ipcMain.handle(IPC.adb.status, () => adb.status());
  ipcMain.handle(IPC.adb.download, () => {
    const s = getStore().settings();
    if (s.localOnly) throw new Error('Local network only is on. Turn it off in Settings to download platform-tools, or install adb yourself.');
    if (!s.adbTermsAccepted) throw new Error('Accept the Android SDK terms first.');
    return adb.download();
  });
  ipcMain.handle(IPC.adb.connect, (_e, t: string) => adb.connect(devices.adbHost(t)));
  ipcMain.handle(IPC.adb.pick, async () => {
    const r = await dialog.showOpenDialog(win ?? undefined!, { title: 'Choose the adb program', properties: ['openFile', 'showHiddenFiles'], filters: process.platform === 'win32' ? [{ name: 'adb', extensions: ['exe'] }] : [] });
    if (r.canceled || !r.filePaths[0]) return undefined;
    getStore().updateSettings({ adbPath: r.filePaths[0] });
    adb.setCustomPath(r.filePaths[0]);
    return adb.status();
  });
  ipcMain.handle(IPC.adb.pickApk, async () => {
    const r = await dialog.showOpenDialog(win ?? undefined!, { title: 'Choose an APK to install on the TV', filters: [{ name: 'Android package', extensions: ['apk'] }], properties: ['openFile'] });
    return r.canceled ? undefined : r.filePaths[0];
  });
  ipcMain.handle(IPC.adb.install, async (_e, t: string, apkPath: string) => {
    if (!/\.apk$/i.test(apkPath)) throw new Error('Only .apk files can be installed.');
    log.info('adb', `install ${path.basename(apkPath)} -> ${t}`);
    const host = devices.adbHost(t);
    const r = await adb.install(host, apkPath);
    if (r.ok) devices.note(`androidtv:${host}`, 'install', `Installed ${path.basename(apkPath)}`);
    return r;
  });
  ipcMain.handle(IPC.adb.uninstall, (_e, t: string, pkg: string) => adb.uninstall(devices.adbHost(t), pkg));
  ipcMain.handle(IPC.adb.screenshot, (_e, t: string) => adb.screenshot(devices.adbHost(t)));
}

app.whenReady().then(() => {
  log.info('app', `start v${APP_VERSION} on ${process.platform} ${process.arch}, electron ${process.versions.electron}`);
  // No page in this app needs camera, microphone, location, notifications or anything else.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // "Local network only": the window (artwork, icons from TVs) may only fetch from private addresses.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (!getStore().settings().localOnly) return callback({});
    let host = '';
    try {
      host = new URL(details.url).hostname;
    } catch {
      return callback({ cancel: true });
    }
    callback({ cancel: !isPrivateHost(host) });
  });
  registerIpc();
  wireEvents();
  createAppMenu();
  const s = getStore().settings();
  createWindow({ hidden: s.startHidden });
  createTray();
  // Credentials are decrypted by the OS keychain only once the app is ready; refresh the "paired" badges now.
  discovery.refreshPairedFlags();
  log.info('store', getStore().credentialsEncrypted() ? 'credentials encrypted with the OS keychain' : 'OS keychain unavailable: credentials stored as plain JSON (0600)');
  discovery.start();
  updater.start();
  adb.setCustomPath(s.adbPath);
  registerShortcuts(getStore().settings());

  app.on('activate', () => showWindow());
});

app.on('window-all-closed', () => {
  // Keep running in the tray on all platforms; Quit is in the tray/app menu.
});

app.on('before-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  discovery.stop();
  updater.stop();
  void devices.disconnectAll();
  void adb.killServer();
  getStore().flush();
  log.info('app', 'quit');
});
