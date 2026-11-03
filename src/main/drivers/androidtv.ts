/**
 * Android TV / Google TV driver (Remote protocol v2).
 *
 *   open()
 *     no stored cert → generate one, run PAIRING (6467); emit 'pairingRequested' ('code');
 *                      wait for sendPairingCode(); on success store the cert.
 *     cert present   → open the REMOTE session (6466). The base class reconnects on drop-outs.
 *
 * Text: if the TV has a text field open (IME messages) we replace its content in one
 * message; otherwise we inject one key event per character (works in most search boxes).
 * Apps: the protocol can't list installed apps. We use a curated catalog with deep links,
 * official icons from the public Play Store page, and `adb` when the user enabled it.
 */
import type { AppInfo, Capability, KeyDirection, LiveViewOptions, RemoteKey } from '../../shared/types';
import { ANDROID_KEYS } from '../../shared/keys';
import { getStore, type PairingCert } from '../store';

type StoredPairing = PairingCert & { fingerprint?: string };
import { Pairing, generateCertificate, defaultClientName } from '../remote/pairing';
import { RemoteSession, charToKey } from '../remote/session';
import { androidCatalog, listAppsViaAdb } from '../apps';
import { initials } from './driver';
import { androidAppInfo } from '../icons';
import { AdbLive } from '../live';
import type { LaunchTarget, ParsedLink } from '../deeplink';
import { TvDriver } from './driver';

const SERVICE_NAME = 'Android TV Controller';

export class AndroidTvDriver extends TvDriver {
  readonly capabilities: Capability[] = ['keys', 'text', 'power', 'volume', 'apps', 'launch'];
  private remote?: RemoteSession;
  private pairing?: Pairing;
  private appsCache?: AppInfo[];
  private tlsRejections = 0;
  private live?: AdbLive;

  private get cert(): StoredPairing | undefined {
    return getStore().getCredential<StoredPairing>(this.ctx.id);
  }

  protected async open(): Promise<void> {
    if (this.remote || this.pairing) return; // already connecting/connected/pairing
    if (!this.cert) {
      await this.pair();
      if (!this.cert) return; // failed/cancelled; state already set
    }
    await this.openRemote();
  }

  protected async close(): Promise<void> {
    this.setLiveView(null);
    this.pairing?.cancel();
    this.pairing = undefined;
    const remote = this.remote;
    this.remote = undefined;
    remote?.removeAllListeners();
    remote?.close();
  }

  private async pair(): Promise<void> {
    const cert = generateCertificate(SERVICE_NAME);
    const pairing = new Pairing(this.ctx.host, cert, { clientName: defaultClientName() });
    this.pairing = pairing;
    this.update({ state: 'pairing', error: undefined });
    pairing.on('secret', () => this.emit('pairingRequested', 'code'));

    let ok = false;
    let reason = '';
    try {
      ok = await pairing.start();
    } catch (err) {
      reason = (err as Error).message;
    }
    this.pairing = undefined;

    if (ok) {
      getStore().setCredential(this.ctx.id, { ...cert, fingerprint: pairing.peerFingerprint } satisfies StoredPairing);
      this.emit('credentials');
    } else if (this.wantConnected) {
      this.wantConnected = false; // don't loop on a failed pairing; the user retries
      this.update({ state: 'error', error: reason || 'Pairing failed.' });
    }
  }

  async sendPairingCode(code: string): Promise<void> {
    if (!this.pairing) throw new Error('Not pairing');
    // A checksum mismatch is caught here without bothering the TV; stay in 'pairing' so the user can retype.
    if (!this.pairing.sendCode(code)) throw new Error('That code doesn’t match what the TV shows. Check it and try again.');
    this.update({ state: 'connecting' });
  }

  private async openRemote(): Promise<void> {
    const cert = this.cert;
    if (!cert) return;
    const remote = new RemoteSession(this.ctx.host, cert, this.ctx.port || 6466, this.ctx.appVersion, cert.fingerprint);
    this.remote = remote;
    this.update({ state: 'connecting', error: undefined });

    remote.on('ready', () => {
      this.tlsRejections = 0;
      this.update({ state: 'connected', error: undefined });
    });
    remote.on('deviceInfo', (info) => this.update({ model: info.model, vendor: info.vendor }));
    remote.on('powered', (powered) => this.update({ powered }));
    remote.on('volume', (v) =>
      this.update({ volume: { level: v.maximum ? v.level / v.maximum : 0, muted: v.muted, absolute: v.level, max: v.maximum } }),
    );
    remote.on('currentApp', (pkg) => this.update({ currentApp: { id: pkg, name: this.appName(pkg) } }));
    remote.on('imeShow', (field) => {
      this.update({ imeOpen: true, imeField: field });
      this.emit('keyboardOpened', field);
    });
    remote.on('imeField', (field) => this.update({ imeField: field, imeOpen: field !== undefined }));
    remote.on('error', (err) => {
      if (!remote.ready && /alert|certificate|EPROTO|handshake/i.test(err.message)) {
        // TLS alert during handshake: the TV rejected our certificate. Only after it
        // happens twice in a row do we conclude the TV revoked us (a sleeping TV can
        // also reset the socket once).
        this.tlsRejections += 1;
        if (this.tlsRejections >= 2) {
          getStore().deleteCredential(this.ctx.id);
          this.emit('credentials');
          this.wantConnected = false;
          this.update({ state: 'error', error: 'The TV no longer trusts this computer. Connect again to re-pair.' });
          return;
        }
      }
      if (this._state.state !== 'error') this.update({ error: err.message });
    });
    remote.on('close', () => {
      if (this.remote !== remote) return;
      this.remote = undefined;
      this.lost();
    });

    try {
      await remote.connect();
    } catch (err) {
      this.remote = undefined;
      if (/CERT_CHANGED/.test((err as Error).message)) {
        // The TV's identity changed (factory reset, or something between us and it). Never send keys to it blindly.
        getStore().deleteCredential(this.ctx.id);
        this.emit('credentials');
        this.wantConnected = false;
        this.update({ state: 'error', error: 'This TV’s security certificate changed since you paired (was it reset?). Connect again to pair it fresh.' });
        return;
      }
      this.update({ state: 'disconnected', error: friendly(err as Error) });
      this.lost();
    }
  }

  async forget(): Promise<void> {
    await this.disconnect();
    getStore().deleteCredential(this.ctx.id);
    this.emit('credentials');
  }

  private session(): RemoteSession {
    if (!this.remote?.ready) throw new Error('Not connected to the TV');
    return this.remote;
  }

  async sendKey(key: RemoteKey, direction: KeyDirection = 'SHORT'): Promise<void> {
    const s = this.session();
    // KEYCODE_POWER toggles; WAKEUP/SLEEP are ignored by many TVs. Guard the toggle with the state the TV reports.
    if (key === 'POWER_ON' || key === 'POWER_OFF') {
      const wantOn = key === 'POWER_ON';
      if (this._state.powered === wantOn) return;
      s.sendKey('KEYCODE_POWER', 'SHORT');
      return;
    }
    s.sendKey(ANDROID_KEYS[key], direction);
  }

  async sendText(text: string): Promise<'ime' | 'keys' | 'native'> {
    const remote = this.session();
    const mode = getStore().settings().textMode;
    if (mode !== 'keys' && remote.imeAvailable) {
      remote.sendText(text);
      return 'ime';
    }
    if (mode === 'ime') throw new Error('No text field is open on the TV');
    for (const ch of text) {
      const k = charToKey(ch);
      if (!k) continue;
      remote.sendKey(k);
      await sleep(30); // TVs drop keys sent back-to-back
    }
    return 'keys';
  }

  /**
   * The TV's own search across its apps: press Search, wait for the search box's keyboard,
   * type, and go. If the TV answers with a voice session instead (some launchers do), back out
   * and say so rather than leaving the TV listening to a microphone we never send.
   */
  async searchOnTv(query: string): Promise<void> {
    const remote = this.session();
    let voice = false;
    const onVoice = () => { voice = true; };
    remote.once('voiceBegin', onVoice);
    try {
      remote.sendKey('KEYCODE_SEARCH');
      const t0 = Date.now();
      while (!remote.imeAvailable && !voice && Date.now() - t0 < 4000) await sleep(100);
      if (voice) {
        remote.sendKey('KEYCODE_BACK');
        throw new Error('This TV opens voice search on the Search key. Use the YouTube tab, or type into the search box after opening it on the TV.');
      }
      if (!remote.imeAvailable) throw new Error('The TV did not open a search box. Open search on the TV first, then use Type on TV.');
      remote.sendText(query);
      await sleep(200);
      remote.sendKey('KEYCODE_ENTER');
    } finally {
      remote.removeListener('voiceBegin', onVoice);
    }
  }

  /** Keyboard mode: append to the TV's field over the IME protocol, or inject the key when no field is open. */
  async sendChar(ch: string): Promise<'ime' | 'keys' | 'native'> {
    const remote = this.session();
    if (getStore().settings().textMode !== 'keys' && remote.imeAvailable) {
      remote.sendText((remote.field?.value ?? '') + ch);
      return 'ime';
    }
    const k = charToKey(ch);
    if (k) remote.sendKey(k);
    return 'keys';
  }

  async backspace(): Promise<void> {
    const remote = this.session();
    if (remote.imeAvailable) {
      const v = remote.field?.value ?? '';
      remote.sendText(v.slice(0, -1));
      return;
    }
    remote.sendKey('KEYCODE_DEL');
  }

  async clearText(count = 1): Promise<void> {
    const remote = this.session();
    if (remote.imeAvailable) {
      remote.sendText('');
      return;
    }
    for (let i = 0; i < count; i++) {
      remote.sendKey('KEYCODE_DEL');
      await sleep(30);
    }
  }

  async launchApp(appId: string, link?: string): Promise<void> {
    const remote = this.session();
    const target = link ?? this.appsCache?.find((a) => a.id === appId)?.link ?? androidCatalog().find((a) => a.id === appId)?.link;
    if (!target) throw new Error('No launch link known for this app. Enable ADB or add a deep link.');
    remote.sendAppLink(target);
  }

  protected async launchLink(link: ParsedLink, t: LaunchTarget): Promise<void> {
    this.session().sendAppLink(t.android ?? link.url);
  }

  async listApps(refresh = false): Promise<AppInfo[]> {
    if (this.appsCache && !refresh) return this.appsCache;
    const catalog = androidCatalog();
    const installed = await listAppsViaAdb(this.ctx.host).catch(() => undefined);
    let apps: AppInfo[];
    if (installed) {
      const byPkg = new Map(catalog.map((a) => [a.id, a]));
      apps = installed.map((p) => ({ ...(byPkg.get(p.id) ?? p), source: 'device' as const }));
    } else {
      apps = catalog;
    }
    const s = getStore().settings();
    if (s.fetchIcons && !s.localOnly) {
      const catalogIds = new Set(catalog.map((c) => c.id));
      await Promise.all(
        apps.map(async (a) => {
          const info = await androidAppInfo(a.id);
          if (info.icon) a.icon = info.icon;
          // the TV gives us packages, not labels: the Play Store name beats a guess from the package
          if (info.name && !catalogIds.has(a.id) && a.source === 'device') {
            a.name = info.name;
            a.initials = initials(info.name);
          }
        }),
      );
    }
    this.appsCache = apps;
    return apps;
  }

  private appName(pkg: string): string | undefined {
    return (this.appsCache ?? androidCatalog()).find((a) => a.id === pkg)?.name;
  }

  // ---- live view over ADB ----

  pauseScreen(paused: boolean): void {
    this.live?.pauseScreen(paused);
  }

  /** Start/stop polling the TV over ADB for its media session and/or screen. */
  setLiveView(opts: LiveViewOptions | null): void {
    const on = Boolean(opts && (opts.media || opts.screen));
    if (!on) {
      if (!this.live) return;
      this.live.stop();
      this.live.removeAllListeners();
      this.live = undefined;
      const patch: Partial<typeof this._state> = { liveView: undefined, playbackError: undefined, screenError: undefined };
      if (this._state.media?.source === 'adb') patch.media = undefined;
      this.update(patch);
      this.emit('screen', null);
      return;
    }
    if (!this.live) {
      const live = new AdbLive(this.ctx.host, () => this._state.currentApp?.id);
      this.live = live;
      live.on('media', (m) => {
        if (this.live !== live) return;
        // ADB fills in what Cast doesn't know about; a Cast session with a title wins.
        if (m) this.update({ media: { ...m, title: m.title, subtitle: m.subtitle }, currentApp: this._state.currentApp ?? (m.appId ? { id: m.appId, name: this.appName(m.appId) } : undefined) });
        else if (this._state.media?.source === 'adb') this.update({ media: undefined });
      });
      live.on('screen', (frame: string | null) => this.live === live && this.emit('screen', frame));
      live.on('screenError', (err: Error) => {
        if (this.live !== live) return;
        this.update({ liveView: { ...live.options }, screenError: err.message });
      });
      live.on('error', (err: Error) => {
        if (this.live !== live) return;
        this.live = undefined;
        this.update({ liveView: undefined, playbackError: err.message, media: this._state.media?.source === 'adb' ? undefined : this._state.media });
        this.emit('screen', null);
        this.emit('liveError', err);
      });
    }
    this.live.set(opts);
    this.update({ liveView: { ...opts! }, playbackError: undefined, screenError: undefined });
  }
}

function friendly(err: Error): string {
  if (/ECONNREFUSED/.test(err.message)) return 'The TV refused the connection. Is it on?';
  if (/EHOSTUNREACH|ETIMEDOUT|ENETUNREACH/.test(err.message)) return 'The TV is not reachable on the network.';
  return err.message;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
