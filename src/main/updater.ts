/**
 * One-click updates.
 *
 *  Windows / Linux : electron-updater against GitHub Releases. Downloads in the
 *                    background; the UI offers "Restart to update".
 *  macOS           : the build is not Apple-signed, so Squirrel.Mac can't swap it
 *                    in place. We do it ourselves: download the release zip, unpack
 *                    it next to our data, and on "Restart to update" a tiny shell
 *                    script waits for the app to quit, replaces the bundle and
 *                    opens it again. Files this app writes carry no quarantine
 *                    flag, so Gatekeeper doesn't ask again. If the bundle isn't
 *                    writable (still on the dmg, or an admin install) we fall back
 *                    to opening the dmg download.
 *
 * Checks run at launch (after a short delay) and every 6 hours. Nothing is sent
 * except the plain GitHub API request.
 */
import { app, net, shell } from 'electron';
import { execFile, spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import type { UpdateInfo } from '../shared/types';
import { getStore } from './store';
import { log } from './log';

const REPO = 'thesiyonara/tv-controller';
const BUNDLE_ID = 'dev.thesiyonara.androidtvcontroller';
const CHECK_EVERY_MS = 6 * 3600 * 1000;

export class Updater extends EventEmitter {
  private info: UpdateInfo = { state: 'idle', current: app.getVersion() };
  private auto: any; // electron-updater's AutoUpdater, loaded lazily (not on macOS)
  private timer?: NodeJS.Timeout;
  private staged?: { version: string; appPath: string };
  private staging = false;

  constructor(private currentVersion: string) {
    super();
    this.info.current = currentVersion;
  }

  status(): UpdateInfo {
    return this.info;
  }

  private set(patch: Partial<UpdateInfo>): void {
    this.info = { ...this.info, ...patch };
    this.emit('status', this.info);
  }

  start(): void {
    if (!app.isPackaged) {
      this.set({ state: 'idle', note: 'Updates are only checked in packaged builds.' });
      return;
    }
    if (process.platform !== 'darwin') this.setupElectronUpdater();
    const auto = () => {
      const s = getStore().settings();
      if (s.localOnly || !s.autoUpdateCheck) return;
      void this.check();
    };
    setTimeout(auto, 8000);
    this.timer = setInterval(auto, CHECK_EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private setupElectronUpdater(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { autoUpdater } = require('electron-updater');
      this.auto = autoUpdater;
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.setFeedURL({ provider: 'github', owner: REPO.split('/')[0], repo: REPO.split('/')[1] });
      autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }));
      autoUpdater.on('update-available', (u: any) => this.set({ state: 'downloading', latest: u.version, progress: 0 }));
      autoUpdater.on('update-not-available', () => this.set({ state: 'uptodate', checkedAt: Date.now() }));
      autoUpdater.on('download-progress', (p: any) => this.set({ state: 'downloading', progress: Math.round(p.percent) }));
      autoUpdater.on('update-downloaded', (u: any) => this.set({ state: 'ready', latest: u.version, progress: 100 }));
      autoUpdater.on('error', (e: Error) => this.set({ state: 'error', note: friendlyUpdateError(e.message) }));
    } catch (err) {
      this.set({ state: 'error', note: `Updater unavailable: ${(err as Error).message}` });
    }
  }

  async check(): Promise<UpdateInfo> {
    if (!app.isPackaged) return this.info;
    if (getStore().settings().localOnly) {
      this.set({ state: 'idle', note: 'Local network only is on; updates are not checked.' });
      return this.info;
    }
    if (this.auto) {
      try {
        await this.auto.checkForUpdates();
      } catch (err) {
        this.set({ state: 'error', note: (err as Error).message });
      }
      return this.info;
    }
    if (this.staging || this.info.state === 'ready') return this.info; // already on it
    // macOS: manual check against GitHub
    this.set({ state: 'checking' });
    try {
      const rel = JSON.parse(await fetchText(`https://api.github.com/repos/${REPO}/releases/latest`));
      const latest = String(rel.tag_name ?? '').replace(/^v/, '');
      if (!latest) throw new Error('No release found');
      if (compareVersions(latest, this.currentVersion) > 0) {
        const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
        const assets: Array<{ name: string; browser_download_url: string }> = rel.assets ?? [];
        const dmg = assets.find((a) => /\.dmg$/.test(a.name) && a.name.includes(`mac-${arch}`)) ?? assets.find((a) => /\.dmg$/.test(a.name));
        const zip = assets.find((a) => /\.zip$/.test(a.name) && a.name.includes(`mac-${arch}`));
        this.set({
          state: 'available',
          latest,
          url: dmg?.browser_download_url ?? rel.html_url,
          zipUrl: zip?.browser_download_url,
          installable: Boolean(zip) && canInstallInPlace(),
          notes: rel.body ?? '',
          checkedAt: Date.now(),
        });
      } else {
        this.set({ state: 'uptodate', latest, checkedAt: Date.now() });
      }
    } catch (err) {
      this.set({ state: 'error', note: friendlyUpdateError((err as Error).message), checkedAt: Date.now() });
    }
    return this.info;
  }

  /**
   * Windows/Linux: quit and run the downloaded installer.
   * macOS: first call downloads and stages the new version; once ready, the next call swaps it in and relaunches.
   * Falls back to opening the dmg download when the bundle can't be replaced.
   */
  async apply(): Promise<void> {
    if (this.auto && this.info.state === 'ready') {
      this.auto.quitAndInstall(false, true);
      return;
    }
    if (process.platform === 'darwin') {
      if (this.info.state === 'ready' && this.staged) return this.installAndRelaunch();
      if (this.info.state === 'available' && this.info.installable && this.info.zipUrl) return this.stage();
      if (this.info.state === 'downloading') return;
    }
    if (this.info.url) await shell.openExternal(this.info.url);
  }

  /** Download the zip and unpack it under userData/updates; verify it is really this app. */
  private async stage(): Promise<void> {
    const version = this.info.latest!;
    const url = this.info.zipUrl!;
    const dir = path.join(app.getPath('userData'), 'updates');
    this.staging = true;
    this.set({ state: 'downloading', progress: 0 });
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const zip = path.join(dir, `v${version}.zip`);
      await downloadToFile(url, zip, (pct) => this.set({ state: 'downloading', progress: pct }));
      const out = path.join(dir, 'unpacked');
      fs.mkdirSync(out);
      await run('/usr/bin/ditto', ['-x', '-k', zip, out]);
      const appName = fs.readdirSync(out).find((f) => f.endsWith('.app'));
      if (!appName) throw new Error('the archive did not contain an app');
      const appPath = path.join(out, appName);
      const plist = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
      if (!plist.includes(BUNDLE_ID)) throw new Error('the archive is not TV Controller');
      fs.rmSync(zip, { force: true });
      this.staged = { version, appPath };
      log.info('updater', `staged ${version} at ${appPath}`);
      this.set({ state: 'ready', progress: 100 });
    } catch (err) {
      log.warn('updater', `staging failed: ${(err as Error).message}`);
      this.set({ state: 'error', note: `Could not download the update: ${(err as Error).message}. You can still get it from the Releases page.` });
    } finally {
      this.staging = false;
    }
  }

  /** Hand over to a detached shell script that swaps the bundle once we've quit, then quit. */
  private installAndRelaunch(): void {
    const target = bundlePath();
    const src = this.staged?.appPath;
    if (!target || !src) return;
    const dir = path.join(app.getPath('userData'), 'updates');
    const script = path.join(dir, 'install.sh');
    const logFile = path.join(app.getPath('userData'), 'logs', 'update.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(
      script,
      [
        '#!/bin/sh',
        `PID=${process.pid}`,
        `TARGET=${sq(target)}`,
        `SRC=${sq(src)}`,
        `exec >> ${sq(logFile)} 2>&1`,
        'echo "$(date) installing $SRC over $TARGET"',
        'i=0; while kill -0 "$PID" 2>/dev/null && [ $i -lt 150 ]; do sleep 0.2; i=$((i+1)); done',
        // the app may have been renamed between versions: install under the new bundle name next to the old one
        'DEST="$(dirname "$TARGET")/$(basename "$SRC")"',
        'rm -rf "$TARGET.updating"',
        'mv "$TARGET" "$TARGET.updating" || { echo "could not move the old app"; exit 1; }',
        'if ditto "$SRC" "$DEST"; then rm -rf "$TARGET.updating"; echo "installed $DEST"; else rm -rf "$DEST"; mv "$TARGET.updating" "$TARGET"; DEST="$TARGET"; echo "copy failed, restored the old app"; fi',
        'xattr -dr com.apple.quarantine "$DEST" 2>/dev/null',
        'open "$DEST"',
        'echo "$(date) done"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    log.info('updater', `installing ${this.staged!.version} in place of ${target}`);
    const child = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' });
    child.unref();
    app.quit();
  }
}

/** The running .app bundle, from the executable path. */
function bundlePath(): string | undefined {
  return /^(.*\.app)\/Contents\/MacOS\//.exec(process.execPath)?.[1];
}

/** Can we replace our own bundle? Not while running from the dmg or from a folder we can't write. */
function canInstallInPlace(): boolean {
  if (!app.isPackaged || process.platform !== 'darwin') return false;
  const b = bundlePath();
  if (!b) return false;
  try {
    fs.accessSync(path.dirname(b), fs.constants.W_OK);
    fs.accessSync(b, fs.constants.W_OK);
    return !b.startsWith('/Volumes/');
  } catch {
    return false;
  }
}

function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 120_000 }, (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve()));
  });
}

/** GitHub answers 404 for everything on a private repository; say so instead of printing the status code. */
function friendlyUpdateError(message: string): string {
  if (/404/.test(message)) return `The update feed is not reachable. The GitHub repository ${REPO} is private, so release files can’t be downloaded without signing in. Make the repository public (or publish releases to a public one) to enable updates.`;
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout/i.test(message)) return 'Could not reach GitHub to check for updates. Is the computer online?';
  return message;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'follow' });
    req.setHeader('User-Agent', 'android-tv-controller');
    req.setHeader('Accept', 'application/vnd.github+json');
    const chunks: Buffer[] = [];
    const t = setTimeout(() => {
      req.abort();
      reject(new Error('timeout'));
    }, 10_000);
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => {
        clearTimeout(t);
        if ((res.statusCode ?? 500) >= 400) reject(new Error(`GitHub HTTP ${res.statusCode}`));
        else resolve(Buffer.concat(chunks).toString('utf8'));
      });
      res.on('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    req.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    req.end();
  });
}

/** Stream a release asset to disk with progress; GitHub redirects to its CDN, which `net` follows. */
function downloadToFile(url: string, file: string, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'follow' });
    req.setHeader('User-Agent', 'android-tv-controller');
    const out = fs.createWriteStream(file);
    let total = 0, got = 0, last = -1;
    const fail = (e: Error) => { out.destroy(); reject(e); };
    const t = setTimeout(() => { req.abort(); fail(new Error('download timed out')); }, 10 * 60_000);
    req.on('response', (res) => {
      if ((res.statusCode ?? 500) >= 400) { clearTimeout(t); return fail(new Error(`HTTP ${res.statusCode}`)); }
      total = Number(res.headers['content-length'] ?? 0);
      res.on('data', (chunk) => {
        got += chunk.length;
        out.write(chunk);
        const pct = total ? Math.floor((got / total) * 100) : 0;
        if (pct !== last) { last = pct; onProgress(pct); }
      });
      res.on('end', () => { clearTimeout(t); out.end(() => resolve()); });
      res.on('error', (e) => { clearTimeout(t); fail(e); });
    });
    req.on('error', (e) => { clearTimeout(t); fail(e); });
    req.end();
  });
}
