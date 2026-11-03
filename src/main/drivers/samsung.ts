/**
 * Samsung Tizen TV driver (2016+ models).
 *
 * Remote control: WebSocket wss://host:8002/api/v2/channels/samsung.remote.control
 *   First connection makes the TV show an "Allow" prompt; it then returns a token
 *   we store and send on later connections (no prompt again).
 *   Keys:  {method:"ms.remote.control", params:{Cmd:"Click", DataOfCmd:"KEY_HOME", TypeOfRemote:"SendRemoteKey"}}
 *   Text:  Cmd = base64(text), TypeOfRemote:"SendInputString", then "SendInputEnd"
 *   Apps:  ms.channel.emit ed.installedApp.get / ed.apps.launch
 * Info:  http://host:8001/api/v2/  (name, model, power state)
 * Absolute volume/mute: UPnP RenderingControl SOAP on port 9197 — this is what makes
 *   the "Google TV plugged into a Samsung" combo work: we set the TV's real volume.
 */
import http from 'http';
import WebSocket from 'ws';
import type { AppInfo, Capability, KeyDirection, RemoteKey } from '../../shared/types';
import { SAMSUNG_KEYS } from '../../shared/keys';
import type { LaunchTarget, ParsedLink } from '../deeplink';
import { getStore } from '../store';
import { TvDriver, colorFor, initials } from './driver';

const APP_NAME = 'Android TV Controller';

/** Tizen app ids worth asking "are you on screen?" (the TV has no foreground-app query). */
const SAMSUNG_KNOWN_APPS: Record<string, string> = {
  '111299001912': 'YouTube',
  '11101200001': 'Netflix',
  '3201512006785': 'Prime Video',
  '3201901017640': 'Disney+',
  '3201606009684': 'Spotify',
  '3201807016597': 'Apple TV',
  '3201512006963': 'Plex',
  '3201601007625': 'Hulu',
};

interface SamsungCredential {
  token: string;
}

export class SamsungDriver extends TvDriver {
  readonly capabilities: Capability[] = ['keys', 'text', 'power', 'volume', 'volumeLevel', 'apps', 'launch'];
  private ws?: WebSocket;
  private pending = new Map<string, (data: any) => void>();
  private volumePoll?: NodeJS.Timeout;
  private powerPoll?: NodeJS.Timeout;
  private appsCache?: AppInfo[];
  private appPoll?: NodeJS.Timeout;
  private generation = 0;
  private cancelOpen?: () => void;

  protected async open(): Promise<void> {
    if (this.ws) return;
    const generation = ++this.generation;
    this.update({ state: 'connecting', error: undefined });

    // Device info over plain HTTP (also tells us whether the TV is on).
    try {
      const info = JSON.parse(await httpGet(`http://${this.ctx.host}:8001/api/v2/`));
      if (generation !== this.generation || !this.wantConnected) return;
      this.update({ model: info.device?.modelName, vendor: 'Samsung', powered: info.device?.PowerState !== 'standby' });
    } catch {
      /* TV may be off or an older model; continue to the websocket */
    }
    if (generation !== this.generation || !this.wantConnected) return;

    const token = getStore().getCredential<SamsungCredential>(this.ctx.id)?.token;
    const name = Buffer.from(APP_NAME).toString('base64');
    const url = `wss://${this.ctx.host}:8002/api/v2/channels/samsung.remote.control?name=${name}${token ? `&token=${token}` : ''}`;
    const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 8000 });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.ws !== ws) return; // this attempt is over already
        this.wantConnected = false; // don't keep re-prompting the TV every 30 s
        reject(new Error('The TV did not answer. Is it on, and did you press Allow?'));
      }, 35_000);
      this.cancelOpen = () => {
        clearTimeout(timer);
        reject(new Error('Connection cancelled'));
      };

      ws.on('open', () => {
        if (this.ws !== ws || !this.wantConnected) return;
        // Only a reachable TV can display an Allow prompt. Keep failed or stalled
        // network handshakes in the connecting state so retry/status UI is accurate.
        if (!token) {
          this.update({ state: 'pairing' });
          this.emit('pairingRequested', 'prompt');
        }
      });
      ws.on('message', (raw) => {
        if (this.ws !== ws || generation !== this.generation) return;
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return; // `null`, a bare string or number: not a message
        if (msg.event === 'ms.channel.connect') {
          clearTimeout(timer);
          this.cancelOpen = undefined;
          const newToken = msg.data?.token;
          if (newToken && newToken !== token) {
            getStore().setCredential(this.ctx.id, { token: String(newToken) } satisfies SamsungCredential);
            this.emit('credentials');
          }
          this.update({ state: 'connected', error: undefined, powered: this._state.powered ?? true });
          this.startVolumePoll();
          this.startPowerPoll();
          this.startAppPoll();
          resolve();
        } else if (msg.event === 'ms.channel.unauthorized') {
          clearTimeout(timer);
          if (token) {
            // Our stored token was revoked on the TV; forget it so the next attempt prompts again.
            getStore().deleteCredential(this.ctx.id);
            this.emit('credentials');
          }
          this.wantConnected = false;
          reject(new Error(token ? 'The TV no longer trusts this computer. Connect again to allow it.' : 'The TV denied the connection. Allow it on the TV screen and try again.'));
        } else if (msg.event === 'ed.installedApp.get') {
          this.pending.get('apps')?.(msg.data?.data ?? []);
        } else if (msg.event === 'ms.remote.imeStart') {
          // The TV opened its on-screen keyboard: same flow as Android TV (the type sheet pops).
          const field = { value: '', start: 0, end: 0 };
          this.update({ imeOpen: true, imeField: field });
          this.emit('keyboardOpened', field);
        } else if (msg.event === 'ms.remote.imeUpdate') {
          let value = '';
          try {
            value = Buffer.from(String(msg.data ?? ''), 'base64').toString('utf8');
          } catch {
            /* not base64 */
          }
          this.update({ imeOpen: true, imeField: { value, start: value.length, end: value.length } });
        } else if (msg.event === 'ms.remote.imeEnd') {
          this.update({ imeOpen: false, imeField: undefined });
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on('close', () => {
        clearTimeout(timer);
        if (this.ws !== ws) return;
        this.ws = undefined;
        this.stopVolumePoll();
        this.stopPowerPoll();
        this.stopAppPoll();
        // Dropped before the handshake finished (the TV timed out its Allow prompt, or rebooted): settle the
        // caller now; the base class reconnects. Dropped later: an ordinary loss.
        if (this._state.state === 'connected') this.lost();
        else reject(new Error('The TV closed the connection before pairing finished.'));
      });
    }).catch((err: Error) => {
      if (generation !== this.generation) throw err;
      this.cancelOpen = undefined;
      if (this.ws === ws) {
        ws.terminate();
        this.ws = undefined;
      }
      // a newer attempt may already be running (the close above schedules one); its state is its own
      if (!this.ws) this.update({ state: 'error', error: err.message });
      if (this._state.state !== 'connected') this.lost();
      throw err;
    });
  }

  protected async close(): Promise<void> {
    this.generation += 1;
    this.cancelOpen?.();
    this.cancelOpen = undefined;
    this.stopVolumePoll();
    this.stopPowerPoll();
    this.stopAppPoll();
    const ws = this.ws;
    this.ws = undefined;
    ws?.removeAllListeners();
    // ws emits an error when an unfinished handshake is cancelled. The attempt
    // has already been settled above; retain a listener through socket teardown.
    ws?.on('error', () => undefined);
    if (ws?.readyState === WebSocket.CONNECTING) ws.terminate();
    else ws?.close();
  }

  protected async launchLink(link: ParsedLink, t: LaunchTarget): Promise<void> {
    if (!t.samsung) throw new Error(`No Samsung app known for ${link.service} links`);
    this.send({
      method: 'ms.channel.emit',
      params: { event: 'ed.apps.launch', to: 'host', data: { action_type: t.samsung.type ?? 'DEEP_LINK', appId: t.samsung.appId, metaTag: t.samsung.metaTag ?? '' } },
    });
  }

  async forget(): Promise<void> {
    await this.disconnect();
    getStore().deleteCredential(this.ctx.id);
    this.emit('credentials');
  }

  private send(payload: unknown): void {
    this.requireConnected();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Not connected to the TV');
    this.ws.send(JSON.stringify(payload));
  }

  private remote(cmd: string, dataOfCmd: string, typeOfRemote = 'SendRemoteKey'): void {
    this.send({ method: 'ms.remote.control', params: { Cmd: cmd, DataOfCmd: dataOfCmd, Option: 'false', TypeOfRemote: typeOfRemote } });
  }

  async sendKey(key: RemoteKey, direction: KeyDirection = 'SHORT'): Promise<void> {
    if (key === 'POWER_ON') return; // connected means on; waking from off is Wake-on-LAN (devices.ts)
    const k = SAMSUNG_KEYS[key];
    if (!k) this.unsupported(`Key ${key}`);
    if (direction === 'START_LONG') return this.remote('Press', k);
    if (direction === 'END_LONG') return this.remote('Release', k);
    this.remote('Click', k);
    if (key === 'VOLUME_UP' || key === 'VOLUME_DOWN' || key === 'MUTE') setTimeout(() => void this.readVolume(), 300);
  }

  async sendText(text: string): Promise<'native'> {
    this.remote(Buffer.from(text).toString('base64'), 'base64', 'SendInputString');
    return 'native';
  }

  async clearText(count = 1): Promise<void> {
    for (let i = 0; i < count; i++) {
      this.remote('Click', 'KEY_BACK_MHP');
      await sleep(40);
    }
  }

  async listApps(refresh = false): Promise<AppInfo[]> {
    if (this.appsCache && !refresh) return this.appsCache;
    const raw = await new Promise<any[]>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('TV did not return its app list')), 6000);
      this.pending.set('apps', (data) => {
        clearTimeout(t);
        resolve(data);
      });
      this.send({ method: 'ms.channel.emit', params: { event: 'ed.installedApp.get', to: 'host' } });
    });
    this.appsCache = raw.map((a) => ({
      id: String(a.appId),
      name: String(a.name),
      icon: a.icon ? `data:image/png;base64,${a.icon}` : undefined,
      initials: initials(String(a.name)),
      color: colorFor(String(a.appId)),
      source: 'device' as const,
      link: a.app_type === 2 ? 'DEEP_LINK' : 'NATIVE_LAUNCH',
    }));
    return this.appsCache;
  }

  async launchApp(appId: string): Promise<void> {
    const app = this.appsCache?.find((a) => a.id === appId);
    this.send({
      method: 'ms.channel.emit',
      params: { event: 'ed.apps.launch', to: 'host', data: { action_type: app?.link ?? 'DEEP_LINK', appId, metaTag: '' } },
    });
  }

  // ---- which app is on screen: Tizen has no "foreground app" call, but each known app answers whether it is visible ----
  private startAppPoll(): void {
    void this.readVisibleApp();
    this.appPoll = setInterval(() => void this.readVisibleApp(), 15_000);
  }
  private stopAppPoll(): void {
    if (this.appPoll) clearInterval(this.appPoll);
    this.appPoll = undefined;
  }
  private async readVisibleApp(): Promise<void> {
    if (this._state.powered === false) return;
    const candidates = Object.entries(SAMSUNG_KNOWN_APPS);
    const results = await Promise.all(
      candidates.map(async ([id, name]) => {
        try {
          const info = JSON.parse(await httpGet(`http://${this.ctx.host}:8001/api/v2/applications/${id}`));
          return info.visible ? { id, name: this.appsCache?.find((a) => a.id === id)?.name ?? name } : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    const visible = results.find(Boolean);
    if (visible?.id !== this._state.currentApp?.id) this.update({ currentApp: visible });
  }

  // ---- standby detection: the websocket stays open while the TV is "off" (quick start), the info endpoint says so ----
  private startPowerPoll(): void {
    this.powerPoll = setInterval(() => void this.readPower(), 20_000);
  }
  private stopPowerPoll(): void {
    if (this.powerPoll) clearInterval(this.powerPoll);
    this.powerPoll = undefined;
  }
  private async readPower(): Promise<void> {
    try {
      const info = JSON.parse(await httpGet(`http://${this.ctx.host}:8001/api/v2/`));
      const powered = info.device?.PowerState !== 'standby';
      if (powered !== this._state.powered) this.update({ powered });
    } catch {
      /* unreachable right now; the websocket close will tell us if it's really gone */
    }
  }

  // ---- absolute volume via UPnP RenderingControl ----
  private startVolumePoll(): void {
    void this.readVolume();
    this.volumePoll = setInterval(() => void this.readVolume(), 10_000);
  }
  private stopVolumePoll(): void {
    if (this.volumePoll) clearInterval(this.volumePoll);
    this.volumePoll = undefined;
  }

  private async readVolume(): Promise<void> {
    try {
      const vol = await this.soap('GetVolume', '');
      const mute = await this.soap('GetMute', '');
      const level = parseInt(/<CurrentVolume>(\d+)</.exec(vol)?.[1] ?? '', 10);
      const muted = /<CurrentMute>1</.test(mute);
      if (!Number.isNaN(level)) this.update({ volume: { level: level / 100, muted, absolute: level, max: 100 } });
    } catch {
      /* UPnP not available on this model; keys still work */
    }
  }

  async setVolume(level: number): Promise<void> {
    this.requireConnected();
    const v = Math.round(Math.min(1, Math.max(0, level)) * 100);
    await this.soap('SetVolume', `<DesiredVolume>${v}</DesiredVolume>`);
    this.update({ volume: { level: v / 100, muted: this._state.volume?.muted ?? false, absolute: v, max: 100 } });
  }

  async setMuted(muted: boolean): Promise<void> {
    this.requireConnected();
    await this.soap('SetMute', `<DesiredMute>${muted ? 1 : 0}</DesiredMute>`);
    this.update({ volume: { ...(this._state.volume ?? { level: 0, absolute: 0, max: 100 }), muted } });
  }

  private soap(action: string, args: string): Promise<string> {
    const body =
      `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
      `<s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel>${args}</u:${action}></s:Body></s:Envelope>`;
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: this.ctx.host, port: 9197, path: '/upnp/control/RenderingControl1', method: 'POST', timeout: 3000, headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPACTION: `"urn:schemas-upnp-org:service:RenderingControl:1#${action}"`,
          'Content-Length': Buffer.byteLength(body),
        } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => ((res.statusCode ?? 500) >= 400 ? reject(new Error(`UPnP HTTP ${res.statusCode}`)) : resolve(Buffer.concat(chunks).toString())));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(body);
    });
  }
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
