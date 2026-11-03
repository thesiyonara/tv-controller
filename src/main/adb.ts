/**
 * ADB (Android Debug Bridge) for Android TV / Google TV: sideload APKs, list the
 * real installed apps, take a screenshot, uninstall.
 *
 * We never bundle adb (Google's SDK terms require the user to accept them). Instead:
 *   1. use `adb` from PATH or a user-provided path, else
 *   2. download Google's official platform-tools zip into userData after the user
 *      accepts the terms in the app, extract it with the OS `tar` (macOS and
 *      Windows 10+ both ship one), and use that copy.
 *
 * The TV must have Developer options → USB/Network debugging enabled, and the
 * user must accept the "Allow debugging?" prompt the TV shows on first connect.
 * That prompt is the TV's own consent screen; nothing here bypasses it.
 */
import { app, net } from 'electron';
import { execFile, spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AdbResult, AdbStatus } from '../shared/types';

const PLATFORM_TOOLS_URL: Record<string, string> = {
  darwin: 'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip',
  win32: 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
  linux: 'https://dl.google.com/android/repository/platform-tools-latest-linux.zip',
};
export const SDK_TERMS_URL = 'https://developer.android.com/studio/terms';

function managedDir(): string {
  return path.join(app.getPath('userData'), 'platform-tools');
}

/**
 * Where people usually have adb. GUI apps on macOS don't get the shell's PATH (no
 * /opt/homebrew/bin), so "it's installed" needs these explicit looks.
 */
export function knownAdbPaths(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      '/opt/homebrew/bin/adb',
      '/usr/local/bin/adb',
      path.join(home, 'Library/Android/sdk/platform-tools/adb'),
      path.join(home, 'Android/Sdk/platform-tools/adb'),
      '/opt/homebrew/share/android-commandlinetools/platform-tools/adb',
      '/usr/local/share/android-commandlinetools/platform-tools/adb',
      path.join(home, 'platform-tools/adb'),
      path.join(home, 'Downloads/platform-tools/adb'),
      path.join(home, 'Desktop/platform-tools/adb'),
      '/Applications/platform-tools/adb',
    ];
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return [
      path.join(local, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
      path.join(home, 'platform-tools', 'adb.exe'),
      path.join(home, 'Downloads', 'platform-tools', 'adb.exe'),
      path.join(home, 'Desktop', 'platform-tools', 'adb.exe'),
      'C:\\platform-tools\\adb.exe',
      'C:\\adb\\adb.exe',
      path.join(home, 'scoop', 'shims', 'adb.exe'),
      'C:\\ProgramData\\chocolatey\\bin\\adb.exe',
    ];
  }
  return [
    path.join(home, 'Android/Sdk/platform-tools/adb'),
    '/usr/bin/adb',
    '/usr/local/bin/adb',
    path.join(home, 'platform-tools/adb'),
    path.join(home, 'Downloads/platform-tools/adb'),
  ];
}
function managedBinary(): string {
  return path.join(managedDir(), process.platform === 'win32' ? 'adb.exe' : 'adb');
}

function run(bin: string, args: string[], opts: { timeout?: number; maxBuffer?: number; binary?: boolean } = {}): Promise<{ code: number; stdout: string | Buffer; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: opts.timeout ?? 20_000, maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024, windowsHide: true, encoding: opts.binary ? 'buffer' : 'utf8' } as any,
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout: stdout as any, stderr: String(stderr ?? '') }),
    );
  });
}

export class AdbManager extends EventEmitter {
  private st: AdbStatus = { available: false };
  private customPath?: string;

  setCustomPath(p?: string): void {
    this.customPath = p || undefined;
  }

  private resolved?: { path: string; at: number };

  /** Resolve the adb binary: custom path, the app's own copy, known install locations, then PATH. Cached for a minute. */
  async binary(): Promise<string | undefined> {
    if (this.resolved && Date.now() - this.resolved.at < 60_000 && (this.resolved.path === 'adb' || fs.existsSync(this.resolved.path))) return this.resolved.path;
    const candidates = [this.customPath, managedBinary(), ...knownAdbPaths(), 'adb'].filter(Boolean) as string[];
    for (const c of candidates) {
      if (c !== 'adb' && !fs.existsSync(c)) continue;
      const r = await run(c, ['version'], { timeout: 5000 });
      if (r.code === 0) {
        this.resolved = { path: c, at: Date.now() };
        return c;
      }
    }
    this.resolved = undefined;
    return undefined;
  }

  async status(): Promise<AdbStatus> {
    this.resolved = undefined; // a status check is the moment to look again
    const bin = await this.binary();
    if (!bin) {
      this.st = { ...this.st, available: false, path: undefined, version: undefined };
    } else {
      const r = await run(bin, ['version'], { timeout: 5000 });
      const version = /Android Debug Bridge version ([\d.]+)/.exec(String(r.stdout))?.[1];
      const source: AdbStatus['source'] = bin === this.customPath ? 'custom' : bin === managedBinary() ? 'managed' : bin === 'adb' ? 'path' : 'found';
      this.st = { ...this.st, available: true, path: bin, source, version, error: undefined };
    }
    this.emit('status', this.st);
    return this.st;
  }

  /** Download Google's platform-tools (after the user accepted the SDK terms in the UI). */
  async download(): Promise<AdbStatus> {
    const url = PLATFORM_TOOLS_URL[process.platform];
    if (!url) throw new Error('No platform-tools build for this OS');
    const dir = app.getPath('userData');
    const zip = path.join(dir, 'platform-tools.zip');
    this.st = { ...this.st, downloading: 0, error: undefined };
    this.emit('status', this.st);
    try {
      await this.fetchToFile(url, zip, (p) => {
        this.st = { ...this.st, downloading: p };
        this.emit('status', this.st);
      });
      fs.rmSync(managedDir(), { recursive: true, force: true });
      const r = await run('tar', ['-xf', zip, '-C', dir], { timeout: 120_000 });
      if (r.code !== 0) throw new Error(`Could not extract platform-tools: ${r.stderr || 'tar failed'}`);
      if (process.platform !== 'win32') fs.chmodSync(managedBinary(), 0o755);
      fs.rmSync(zip, { force: true });
    } catch (err) {
      this.st = { ...this.st, downloading: undefined, error: (err as Error).message };
      this.emit('status', this.st);
      throw err;
    }
    this.st = { ...this.st, downloading: undefined };
    return this.status();
  }

  private fetchToFile(url: string, file: string, onProgress: (pct: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = net.request({ url, redirect: 'follow' });
      req.setHeader('User-Agent', 'android-tv-controller');
      const out = fs.createWriteStream(file);
      let total = 0;
      let got = 0;
      req.on('response', (res) => {
        if ((res.statusCode ?? 500) >= 400) return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        total = Number(res.headers['content-length'] ?? 0);
        res.on('data', (chunk) => {
          got += chunk.length;
          out.write(chunk);
          if (total) onProgress(Math.round((got / total) * 100));
        });
        res.on('end', () => out.end(() => resolve()));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  }

  private async bin(): Promise<string> {
    const b = await this.binary();
    if (!b) throw new Error('ADB is not installed. Download it from the Developer tools panel first.');
    return b;
  }

  /** Connect over the network. The TV shows "Allow debugging?" the first time. */
  async connect(host: string): Promise<{ state: 'connected' | 'unauthorized' | 'offline' | 'failed'; message: string }> {
    const bin = await this.bin();
    const target = `${host}:5555`;
    const r = await run(bin, ['connect', target], { timeout: 15_000 });
    const out = String(r.stdout) + r.stderr;
    if (/failed to connect|Connection refused|cannot connect/i.test(out)) {
      return { state: 'failed', message: 'The TV refused the debugging connection. Enable Developer options → USB debugging (and Network debugging if shown) on the TV.' };
    }
    // The state after connect tells us whether the user has accepted the prompt yet.
    const d = await run(bin, ['devices', '-l'], { timeout: 10_000 });
    const line = String(d.stdout).split('\n').find((l) => l.startsWith(target)) ?? '';
    if (/\bdevice\b/.test(line)) {
      this.emit('connected', host);
      return { state: 'connected', message: 'Connected over ADB.' };
    }
    if (/unauthorized/.test(line)) return { state: 'unauthorized', message: 'Look at the TV and choose Allow (tick "Always allow from this computer").' };
    if (/offline/.test(line)) return { state: 'offline', message: 'The TV reports ADB offline. Toggle USB debugging off and on, then try again.' };
    return { state: 'failed', message: out.trim() || 'Could not connect over ADB.' };
  }

  /** Sideload an APK. Resolves with a readable result; never throws for install failures. */
  async install(host: string, apkPath: string): Promise<AdbResult> {
    const bin = await this.bin();
    if (!fs.existsSync(apkPath)) return { ok: false, output: '', message: 'That APK file does not exist any more.' };
    const c = await this.connect(host);
    if (c.state !== 'connected') return { ok: false, output: '', message: c.message };
    const r = await run(bin, ['-s', `${host}:5555`, 'install', '-r', apkPath], { timeout: 10 * 60_000 });
    const out = (String(r.stdout) + '\n' + r.stderr).trim();
    if (/Success/.test(out)) return { ok: true, output: out, message: `Installed ${path.basename(apkPath)}.` };
    const reason = /INSTALL_FAILED_[A-Z_]+|INSTALL_PARSE_FAILED_[A-Z_]+/.exec(out)?.[0];
    const friendly: Record<string, string> = {
      INSTALL_FAILED_NO_MATCHING_ABIS: 'This APK was built for a different processor (no matching ABI). Look for an arm64/armeabi-v7a build.',
      INSTALL_FAILED_OLDER_SDK: 'This APK needs a newer Android version than the TV has.',
      INSTALL_FAILED_UPDATE_INCOMPATIBLE: 'An app with the same package but a different signature is already installed. Uninstall it first.',
      INSTALL_FAILED_INSUFFICIENT_STORAGE: 'The TV is out of storage.',
      INSTALL_FAILED_VERSION_DOWNGRADE: 'A newer version is already installed.',
      INSTALL_PARSE_FAILED_NOT_APK: 'That file is not a valid APK.',
      INSTALL_FAILED_USER_RESTRICTED: 'The TV blocked the install. Check Developer options → "Install via USB"/"Unknown sources".',
    };
    return { ok: false, output: out, message: (reason && friendly[reason]) || `Install failed${reason ? ` (${reason})` : ''}.` };
  }

  async uninstall(host: string, pkg: string): Promise<AdbResult> {
    const bin = await this.bin();
    const c = await this.connect(host);
    if (c.state !== 'connected') return { ok: false, output: '', message: c.message };
    const r = await run(bin, ['-s', `${host}:5555`, 'uninstall', pkg], { timeout: 60_000 });
    const out = (String(r.stdout) + r.stderr).trim();
    return /Success/.test(out) ? { ok: true, output: out, message: `Uninstalled ${pkg}.` } : { ok: false, output: out, message: `Could not uninstall ${pkg}: ${out}` };
  }

  /** PNG screenshot of what the TV is showing, as a data: URL. */
  async screenshot(host: string): Promise<string> {
    const buf = await this.screenshotRaw(host);
    return `data:image/png;base64,${buf.toString('base64')}`;
  }

  /** Raw PNG bytes of the screen. Used by the live view, which polls: connects only when needed. */
  async screenshotRaw(host: string): Promise<Buffer> {
    const bin = await this.bin();
    await this.ensureConnected(host);
    const r = await run(bin, ['-s', `${host}:5555`, 'exec-out', 'screencap', '-p'], { timeout: 30_000, binary: true, maxBuffer: 64 * 1024 * 1024 });
    const buf = r.stdout as Buffer;
    if (r.code !== 0 || !buf || buf.length < 100 || buf[0] !== 0x89) {
      this.connectedAt.delete(host);
      throw new Error('The TV did not return a screenshot (some apps block capture).');
    }
    return buf;
  }

  private connectedAt = new Map<string, number>();

  /** `connect` is two process spawns; for polling, trust a connection made in the last minute. */
  private async ensureConnected(host: string): Promise<void> {
    const t = this.connectedAt.get(host);
    if (t && Date.now() - t < 60_000) return;
    const c = await this.connect(host);
    if (c.state !== 'connected') throw new Error(c.message);
    this.connectedAt.set(host, Date.now());
  }

  /** Shell for pollers: skips the connect dance while the link is known to be up; retries once after reconnecting. */
  async shellQuick(host: string, cmd: string[]): Promise<string> {
    const bin = await this.bin();
    await this.ensureConnected(host);
    const r = await run(bin, ['-s', `${host}:5555`, 'shell', ...cmd], { timeout: 15_000 });
    if (r.code === 0) return String(r.stdout);
    this.connectedAt.delete(host);
    await this.ensureConnected(host);
    const again = await run(bin, ['-s', `${host}:5555`, 'shell', ...cmd], { timeout: 15_000 });
    if (again.code !== 0) throw new Error(again.stderr || 'adb shell failed');
    return String(again.stdout);
  }

  /** Launch an app by package via its TV launcher activity. */
  async launch(host: string, pkg: string): Promise<AdbResult> {
    const bin = await this.bin();
    const c = await this.connect(host);
    if (c.state !== 'connected') return { ok: false, output: '', message: c.message };
    const r = await run(bin, ['-s', `${host}:5555`, 'shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LEANBACK_LAUNCHER', '1'], { timeout: 20_000 });
    const out = (String(r.stdout) + r.stderr).trim();
    return /Events injected: 1/.test(out) ? { ok: true, output: out, message: `Opened ${pkg}.` } : { ok: false, output: out, message: `Could not open ${pkg}.` };
  }

  /** Raw shell, for the app list. */
  async shell(host: string, cmd: string[]): Promise<string> {
    const bin = await this.bin();
    const c = await this.connect(host);
    if (c.state !== 'connected') throw new Error(c.message);
    const r = await run(bin, ['-s', `${host}:5555`, 'shell', ...cmd], { timeout: 30_000 });
    if (r.code !== 0) throw new Error(r.stderr || 'adb shell failed');
    return String(r.stdout);
  }

  /** Keep a reference so the server process doesn't linger when the app quits. */
  async killServer(): Promise<void> {
    const b = await this.binary();
    if (b) await new Promise<void>((resolve) => spawn(b, ['kill-server'], { windowsHide: true }).on('exit', () => resolve()).on('error', () => resolve()));
  }
}

export const adb = new AdbManager();
