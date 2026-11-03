/**
 * Preload: the only bridge between the sandboxed renderer and the main process.
 * Exposes a typed `window.controller` object (see ControllerApi in shared/types).
 *
 * NOTE: the renderer runs with sandbox:true, so this file cannot `require` other
 * project files at runtime. It is bundled into a single file by esbuild (see
 * package.json "bundle:preload"); tsc only type-checks it.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC } from '../shared/ipc';
import type { ControllerApi } from '../shared/types';

function subscribe(channel: string, cb: (...args: any[]) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: any[]) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: ControllerApi = {
  discovery: {
    rescan: (deep) => ipcRenderer.invoke(IPC.discovery.rescan, deep),
    list: () => ipcRenderer.invoke(IPC.discovery.list),
    addManual: (kind, host, name) => ipcRenderer.invoke(IPC.discovery.addManual, kind, host, name),
    forget: (id) => ipcRenderer.invoke(IPC.discovery.forget, id),
    status: () => ipcRenderer.invoke(IPC.discovery.status),
    onUpdate: (cb) => subscribe(IPC.discovery.update, cb),
    onStatus: (cb) => subscribe(IPC.discovery.statusEvent, cb),
  },
  adb: {
    status: () => ipcRenderer.invoke(IPC.adb.status),
    download: () => ipcRenderer.invoke(IPC.adb.download),
    connect: (target) => ipcRenderer.invoke(IPC.adb.connect, target),
    pickApk: () => ipcRenderer.invoke(IPC.adb.pickApk),
    pick: () => ipcRenderer.invoke(IPC.adb.pick),
    install: (target, apkPath) => ipcRenderer.invoke(IPC.adb.install, target, apkPath),
    uninstall: (target, pkg) => ipcRenderer.invoke(IPC.adb.uninstall, target, pkg),
    screenshot: (target) => ipcRenderer.invoke(IPC.adb.screenshot, target),
    onStatus: (cb) => subscribe(IPC.adb.statusEvent, cb),
  },
  update: {
    status: () => ipcRenderer.invoke(IPC.update.status),
    check: () => ipcRenderer.invoke(IPC.update.check),
    apply: () => ipcRenderer.invoke(IPC.update.apply),
    onStatus: (cb) => subscribe(IPC.update.statusEvent, cb),
  },
  device: {
    connect: (id) => ipcRenderer.invoke(IPC.device.connect, id),
    disconnect: (id) => ipcRenderer.invoke(IPC.device.disconnect, id),
    forget: (id) => ipcRenderer.invoke(IPC.device.forget, id),
    sendPairingCode: (id, code) => ipcRenderer.invoke(IPC.device.sendPairingCode, id, code),
    sendKey: (id, key, direction) => ipcRenderer.invoke(IPC.device.sendKey, id, key, direction),
    sendText: (id, text, opts) => ipcRenderer.invoke(IPC.device.sendText, id, text, opts),
    clearText: (id, count) => ipcRenderer.invoke(IPC.device.clearText, id, count),
    sendChar: (id, ch) => ipcRenderer.invoke(IPC.device.sendChar, id, ch),
    backspace: (id) => ipcRenderer.invoke(IPC.device.backspace, id),
    skip: (id, seconds) => ipcRenderer.invoke(IPC.device.skip, id, seconds),
    launchApp: (id, appId, link) => ipcRenderer.invoke(IPC.device.launchApp, id, appId, link),
    listApps: (id, refresh) => ipcRenderer.invoke(IPC.device.listApps, id, refresh),
    setVolume: (id, level) => ipcRenderer.invoke(IPC.device.setVolume, id, level),
    setMuted: (id, muted) => ipcRenderer.invoke(IPC.device.setMuted, id, muted),
    media: (id, action) => ipcRenderer.invoke(IPC.device.media, id, action),
    seek: (id, seconds) => ipcRenderer.invoke(IPC.device.seek, id, seconds),
    castUrl: (id, media) => ipcRenderer.invoke(IPC.device.castUrl, id, media),
    openLink: (id, url, meta) => ipcRenderer.invoke(IPC.device.openLink, id, url, meta),
    search: (id, service, query) => ipcRenderer.invoke(IPC.device.search, id, service, query),
    searchOnTv: (id, query) => ipcRenderer.invoke(IPC.device.searchOnTv, id, query),
    searchUrl: (service, query) => ipcRenderer.invoke(IPC.device.searchUrl, service, query),
    getState: (id) => ipcRenderer.invoke(IPC.device.getState, id),
    activity: (target) => ipcRenderer.invoke(IPC.device.activity, target),
    setLiveView: (target, opts) => ipcRenderer.invoke(IPC.device.setLiveView, target, opts),
    onActivity: (cb) => subscribe(IPC.device.activityEvent, cb),
    onScreen: (cb) => subscribe(IPC.device.screen, cb),
    onState: (cb) => subscribe(IPC.device.state, cb),
    onPairingRequested: (cb) => subscribe(IPC.device.pairingRequested, cb),
    onKeyboardOpened: (cb) => subscribe(IPC.device.keyboardOpened, cb),
  },
  rooms: {
    list: () => ipcRenderer.invoke(IPC.rooms.list),
    save: (room) => ipcRenderer.invoke(IPC.rooms.save, room),
    delete: (id) => ipcRenderer.invoke(IPC.rooms.delete, id),
    onUpdate: (cb) => subscribe(IPC.rooms.update, cb),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settings.get),
    set: (patch) => ipcRenderer.invoke(IPC.settings.set, patch),
    removeHistory: (id) => ipcRenderer.invoke(IPC.settings.removeHistory, id),
    onHistory: (cb) => subscribe(IPC.settings.history, cb),
  },
  app: {
    readClipboard: () => ipcRenderer.invoke(IPC.app.readClipboard),
    setCompact: (on) => ipcRenderer.invoke(IPC.app.setCompact, on),
    isCompact: () => ipcRenderer.invoke(IPC.app.isCompact),
    version: () => ipcRenderer.invoke(IPC.app.version),
    platform: () => ipcRenderer.invoke(IPC.app.platform),
    appIcon: (pkg) => ipcRenderer.invoke(IPC.app.appIcon, pkg),
    defaultShortcuts: () => ipcRenderer.invoke(IPC.app.defaultShortcuts),
    openExternal: (url) => ipcRenderer.invoke(IPC.app.openExternal, url),
    openLocalNetworkSettings: () => ipcRenderer.invoke(IPC.app.openLocalNetworkSettings),
    openLogs: () => ipcRenderer.invoke(IPC.app.openLogs),
    pathForFile: (file) => webUtils.getPathForFile(file),
    sleepTimer: (target, minutes) => ipcRenderer.invoke(IPC.app.sleepTimer, target, minutes),
    sleepStatus: () => ipcRenderer.invoke(IPC.app.sleepStatus),
    onSleep: (cb) => subscribe(IPC.app.sleepEvent, cb),
    onCommand: (cb) => subscribe(IPC.app.command, cb),
  },
};

contextBridge.exposeInMainWorld('controller', api);
