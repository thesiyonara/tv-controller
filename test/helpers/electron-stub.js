// Lets main-process modules load in plain node for tests: `require('electron')` returns a tiny stand-in
// (a temp userData folder, no keychain, no native images). Install it before requiring anything from dist/.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tvc-test-'));
const stub = {
  app: {
    getPath: (name) => (name === 'userData' ? userData : path.join(userData, name)),
    isReady: () => true,
    getVersion: () => '0.0.0-test',
    getName: () => 'TV Controller',
    on: () => stub.app,
    once: () => stub.app,
  },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toBitmap: () => Buffer.alloc(0) }) },
  net: { request: () => { throw new Error('no network in tests'); } },
  Notification: class { static isSupported() { return false; } },
  shell: {}, dialog: {}, clipboard: { readText: () => '' }, ipcMain: { handle: () => undefined }, BrowserWindow: class {}, Menu: {}, Tray: class {}, screen: {}, session: {}, powerMonitor: { on: () => undefined }, globalShortcut: {}, nativeTheme: { shouldUseDarkColors: true },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return stub;
  return load.call(this, request, ...rest);
};
module.exports = { stub, userData };
