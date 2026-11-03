/**
 * LG webOS TV driver (2014+ models).
 *
 * Control: WebSocket wss://host:3001 (TLS, self-signed) or ws://host:3000.
 *   Handshake: {type:"register", payload:{pairingType:"PROMPT", manifest, "client-key"}}
 *   First time the TV shows an "Allow" prompt; it answers {type:"registered", payload:{"client-key"}}
 *   which we store. Afterwards: {type:"request", id, uri:"ssap://…", payload}.
 * Keys go over a second socket obtained from ssap://com.webos.service.networkinput/getPointerInputSocket
 *   as plain text frames: "type:button\nname:HOME\n\n".
 * Power ON needs Wake-on-LAN (not implemented yet); power OFF is ssap://system/turnOff.
 */
import WebSocket from 'ws';
import type { AppInfo, Capability, KeyDirection, RemoteKey } from '../../shared/types';
import { WEBOS_KEYS } from '../../shared/keys';
import type { LaunchTarget, ParsedLink } from '../deeplink';
import { getStore } from '../store';
import { TvDriver, colorFor, initials } from './driver';

interface WebosCredential {
  clientKey: string;
}

const MANIFEST = {
  manifestVersion: 1,
  appVersion: '1.1',
  signed: {
    created: '20140509',
    appId: 'com.lge.test',
    vendorId: 'com.lge',
    localizedAppNames: { '': 'Android TV Controller' },
    localizedVendorNames: { '': 'LG Electronics' },
    permissions: ['TEST_SECURE', 'CONTROL_INPUT_TEXT', 'CONTROL_MOUSE_AND_KEYBOARD', 'READ_INSTALLED_APPS', 'READ_LGE_SDX', 'READ_NOTIFICATIONS', 'SEARCH', 'WRITE_SETTINGS', 'WRITE_NOTIFICATION_ALERT', 'CONTROL_POWER', 'READ_CURRENT_CHANNEL', 'READ_RUNNING_APPS', 'READ_UPDATE_INFO', 'UPDATE_FROM_REMOTE_APP', 'READ_LGE_TV_INPUT_EVENTS', 'READ_TV_CURRENT_TIME'],
    serial: '2f930e2d2cfe083771f68e4fe7bb07',
  },
  permissions: ['LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP', 'CLOSE', 'TEST_OPEN', 'TEST_PROTECTED', 'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK', 'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_MEDIA_PLAYBACK', 'CONTROL_INPUT_TV', 'CONTROL_POWER', 'READ_APP_STATUS', 'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST', 'READ_NETWORK_STATE', 'READ_RUNNING_APPS', 'READ_TV_CHANNEL_LIST', 'WRITE_NOTIFICATION_TOAST', 'READ_POWER_STATE', 'READ_COUNTRY_INFO', 'READ_SETTINGS', 'CONTROL_TV_SCREEN', 'CONTROL_TV_STANBY', 'CONTROL_FAVORITE_GROUP', 'CONTROL_USER_INFO', 'CHECK_BLUETOOTH_DEVICE', 'CONTROL_BLUETOOTH', 'CONTROL_TIMER_INFO', 'STB_INTERNAL_CONNECTION', 'CONTROL_RECORDING', 'READ_RECORDING_STATE', 'WRITE_RECORDING_LIST', 'READ_RECORDING_LIST', 'READ_RECORDING_SCHEDULE', 'WRITE_RECORDING_SCHEDULE', 'READ_STORAGE_DEVICE_LIST', 'READ_TV_PROGRAM_INFO', 'CONTROL_BOX_CHANNEL', 'READ_TV_ACR_AUTH_TOKEN', 'READ_TV_CONTENT_STATE', 'READ_TV_CURRENT_TIME', 'ADD_LAUNCHER_CHANNEL', 'SET_CHANNEL_SKIP', 'RELEASE_CHANNEL_SKIP', 'CONTROL_CHANNEL_BLOCK', 'DELETE_SELECT_CHANNEL', 'CONTROL_CHANNEL_GROUP', 'SCAN_TV_CHANNELS', 'CONTROL_TV_POWER', 'CONTROL_WOL'],
  signatures: [{ signatureVersion: 1, signature: 'eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2Iiwia2V5SWQiOiJ0ZXN0LXNpZ25pbmctY2VydCIsInNpZ25hdHVyZVZlcnNpb24iOjF9.hrVRgjCwXVvE2OOSpDZ58hR+59aFNwYDyjQgKk3auukd7pcegmE2CzPCa0bJ0ZsRAcKkCTJrWo5iDzNhMBWRyaMOv5zWSrthlf7G128qvIlpMT0YNY+n/FaOHE73uLrS/g7swl3/qH/BGFG2Hu4RlL48eb3lLKqTt2xKHdCs6Cd4RMfJPYnzgvI4BNrFUKsjkcu+WD4OO2A27Pq1n50cMchmcaXadJhGrOqH5YmHdOCj5NSHzJYrsW0HPlpuAx/ECMeIZYDh6RMqaFM2DXzdKX9NmmyqzJ3o/0lkk/N97gfVRLW5hA29yeAwaCViZNCP8iC9aO0q9fQojoa7NQnAtw==' }],
};

/** Built-in webOS app ids that aren't in listLaunchPoints with a friendly title. */
const WEBOS_APP_NAMES: Record<string, string> = {
  'com.webos.app.livetv': 'Live TV',
  'com.webos.app.hdmi1': 'HDMI 1',
  'com.webos.app.hdmi2': 'HDMI 2',
  'com.webos.app.hdmi3': 'HDMI 3',
  'com.webos.app.hdmi4': 'HDMI 4',
  'com.webos.app.home': 'Home',
  'com.webos.app.browser': 'Web Browser',
  'youtube.leanback.v4': 'YouTube',
  netflix: 'Netflix',
  amazon: 'Prime Video',
  'com.disney.disneyplus-prod': 'Disney+',
  'spotify-beehive': 'Spotify',
  'com.apple.appletv': 'Apple TV',
};

export class WebosDriver extends TvDriver {
  readonly capabilities: Capability[] = ['keys', 'text', 'power', 'volume', 'volumeLevel', 'apps', 'launch', 'media'];
  private ws?: WebSocket;
  private input?: WebSocket;
  private seq = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private appsCache?: AppInfo[];

  protected async open(): Promise<void> {
    if (this.ws) return;
    this.update({ state: 'connecting', error: undefined });
    const clientKey = getStore().getCredential<WebosCredential>(this.ctx.id)?.clientKey;

    const ws = new WebSocket(`wss://${this.ctx.host}:3001`, { rejectUnauthorized: false, handshakeTimeout: 8000 });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.ws !== ws) return;
        this.wantConnected = false;
        reject(new Error('The TV did not answer. Is it on, and did you press Allow?'));
      }, 60_000);

      ws.on('open', () => {
        if (!clientKey) {
          this.update({ state: 'pairing' });
          this.emit('pairingRequested', 'prompt');
        }
        ws.send(JSON.stringify({ type: 'register', id: 'register_0', payload: { forcePairing: false, pairingType: 'PROMPT', 'client-key': clientKey, manifest: MANIFEST } }));
      });
      ws.on('message', (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return; // `null`, a bare string or number: not a message
        if (msg.type === 'registered') {
          clearTimeout(timer);
          const key = msg.payload?.['client-key'];
          if (key && key !== clientKey) {
            getStore().setCredential(this.ctx.id, { clientKey: String(key) } satisfies WebosCredential);
            this.emit('credentials');
          }
          this.update({ state: 'connected', error: undefined, powered: true });
          void this.afterConnect();
          resolve();
          return;
        }
        if (msg.type === 'error' && msg.id === 'register_0') {
          clearTimeout(timer);
          this.wantConnected = false;
          if (clientKey && /403|unauthor|denied|cancel/i.test(String(msg.error))) {
            getStore().deleteCredential(this.ctx.id);
            this.emit('credentials');
          }
          reject(new Error(`The TV refused: ${msg.error ?? 'unknown error'}`));
          return;
        }
        const p = typeof msg.id === 'string' && this.pending.get(msg.id);
        if (p) {
          if (msg.type === 'error') p.reject(new Error(msg.error ?? 'TV error'));
          else p.resolve(msg.payload ?? {});
          if (!msg.payload?.subscribed) this.pending.delete(msg.id);
          if (msg.id.startsWith('sub_')) this.onSubscription(msg.id, msg.payload);
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on('close', () => {
        clearTimeout(timer);
        if (this.ws === ws) {
          this.ws = undefined;
          this.input?.close();
          this.input = undefined;
          if (this._state.state === 'connected') this.lost();
          else reject(new Error('The TV closed the connection before pairing finished.'));
        }
      });
    }).catch((err: Error) => {
      if (this.ws === ws) {
        ws.terminate();
        this.ws = undefined;
      }
      if (!this.ws) this.update({ state: 'error', error: err.message });
      throw err;
    });
  }

  private async afterConnect(): Promise<void> {
    try {
      await this.subscribe('sub_volume', 'ssap://audio/getVolume');
      await this.subscribe('sub_app', 'ssap://com.webos.applicationManager/getForegroundAppInfo');
      const info = await this.request('ssap://system/getSystemInfo');
      this.update({ model: info.modelName, vendor: 'LG' });
    } catch {
      /* optional */
    }
    this.subscribeChannel();
    // Text fields: the TV says when one gets focus, so the type sheet can pop like it does for Android TV.
    this.subscribe('sub_keyboard', 'ssap://com.webos.service.ime/registerRemoteKeyboard').catch(() => undefined);
    // Standby / screen off: the socket stays open on newer models, the power service tells the truth.
    this.subscribe('sub_power', 'ssap://com.webos.service.tvpower/power/getPowerState').catch(() => undefined);
  }

  private channelSubscribed = false;
  /** Live TV: channel changes arrive as a subscription; the TV refuses it while no tuner is active, so retry when Live TV opens. */
  private subscribeChannel(): void {
    if (this.channelSubscribed) return;
    this.channelSubscribed = true;
    this.subscribe('sub_channel', 'ssap://tv/getCurrentChannel').catch(() => {
      this.channelSubscribed = false;
    });
  }

  private onSubscription(id: string, payload: any): void {
    if (!payload || typeof payload !== 'object') return; // an error reply (e.g. no tuner for getCurrentChannel) has none
    if (id === 'sub_volume') {
      const level = payload.volumeStatus?.volume ?? payload.volume;
      const muted = payload.volumeStatus?.muteStatus ?? payload.muted;
      if (typeof level === 'number') this.update({ volume: { level: level / 100, muted: Boolean(muted), absolute: level, max: 100 } });
    } else if (id === 'sub_app') {
      const appId = typeof payload.appId === 'string' ? payload.appId : undefined;
      const name = this.appsCache?.find((a) => a.id === appId)?.name ?? (appId ? WEBOS_APP_NAMES[appId] : undefined);
      this.update({ currentApp: appId ? { id: appId, name } : undefined, channel: appId === 'com.webos.app.livetv' ? this._state.channel : undefined });
      if (appId === 'com.webos.app.livetv') this.subscribeChannel();
    } else if (id === 'sub_channel') {
      const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number') && String(v) ? String(v) : undefined;
      if (text(payload.channelNumber) || text(payload.channelName)) {
        this.update({ channel: { number: text(payload.channelNumber), name: text(payload.channelName), program: text(payload.programName) } });
      }
    } else if (id === 'sub_power') {
      const s = String(payload.state ?? '');
      if (s) this.update({ powered: s === 'Active' || s === 'Screen Saver' });
    } else if (id === 'sub_keyboard') {
      const w = payload.currentWidget;
      if (!w) return;
      if (w.focus) {
        const field = { value: '', start: 0, end: 0, label: w.contentType === 'password' ? 'Password' : undefined };
        const wasOpen = this._state.imeOpen;
        this.update({ imeOpen: true, imeField: field });
        if (!wasOpen) this.emit('keyboardOpened', field);
      } else this.update({ imeOpen: false, imeField: undefined });
    }
  }

  protected async close(): Promise<void> {
    this.channelSubscribed = false;
    const ws = this.ws;
    this.ws = undefined;
    this.input?.close();
    this.input = undefined;
    ws?.removeAllListeners();
    ws?.close();
  }

  protected async launchLink(link: ParsedLink, t: LaunchTarget): Promise<void> {
    if (!t.webos) throw new Error(`No LG app known for ${link.service} links`);
    await this.request('ssap://system.launcher/launch', { id: t.webos.id, ...(t.webos.contentId ? { contentId: t.webos.contentId } : {}), ...(t.webos.params ?? {}) });
  }

  async forget(): Promise<void> {
    await this.disconnect();
    getStore().deleteCredential(this.ctx.id);
    this.emit('credentials');
  }

  private request(uri: string, payload?: unknown, id = `req_${++this.seq}`): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected to the TV'));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ type: 'request', id, uri, payload: payload ?? {} }));
      setTimeout(() => {
        if (this.pending.get(id)?.reject === reject) {
          this.pending.delete(id);
          reject(new Error('TV did not answer'));
        }
      }, 6000);
    });
  }

  private subscribe(id: string, uri: string): Promise<any> {
    if (!this.ws) return Promise.reject(new Error('Not connected'));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ type: 'subscribe', id, uri, payload: {} }));
    });
  }

  private async inputSocket(): Promise<WebSocket> {
    if (this.input && this.input.readyState === WebSocket.OPEN) return this.input;
    const { socketPath } = await this.request('ssap://com.webos.service.networkinput/getPointerInputSocket');
    const sock = new WebSocket(socketPath, { rejectUnauthorized: false, handshakeTimeout: 5000 });
    await new Promise<void>((resolve, reject) => {
      sock.once('open', () => resolve());
      sock.once('error', reject);
    });
    sock.on('close', () => {
      if (this.input === sock) this.input = undefined;
    });
    this.input = sock;
    return sock;
  }

  async sendKey(key: RemoteKey, _direction: KeyDirection = 'SHORT'): Promise<void> {
    this.requireConnected();
    switch (key) {
      case 'POWER':
      case 'POWER_OFF':
        await this.request('ssap://system/turnOff');
        return;
      case 'POWER_ON':
        throw new Error('Turning an LG TV on needs Wake-on-LAN (coming soon). Use the TV remote.');
      case 'PLAY_PAUSE':
        await this.request('ssap://media.controls/play');
        return;
      case 'NEXT':
        await this.request('ssap://media.controls/fastForward');
        return;
      case 'PREVIOUS':
        await this.request('ssap://media.controls/rewind');
        return;
      default: {
        const name = WEBOS_KEYS[key];
        if (!name) this.unsupported(`Key ${key}`);
        const sock = await this.inputSocket();
        sock.send(`type:button\nname:${name}\n\n`);
      }
    }
  }

  async sendText(text: string): Promise<'native'> {
    await this.request('ssap://com.webos.service.ime/insertText', { text, replace: 0 });
    return 'native';
  }

  async clearText(count = 1): Promise<void> {
    await this.request('ssap://com.webos.service.ime/deleteCharacters', { count });
  }

  async listApps(refresh = false): Promise<AppInfo[]> {
    if (this.appsCache && !refresh) return this.appsCache;
    const { launchPoints } = await this.request('ssap://com.webos.applicationManager/listLaunchPoints');
    this.appsCache = (launchPoints ?? []).map((lp: any) => ({
      id: String(lp.id),
      name: String(lp.title),
      icon: lp.largeIcon || lp.icon || undefined,
      initials: initials(String(lp.title)),
      color: colorFor(String(lp.id)),
      source: 'device' as const,
    }));
    return this.appsCache!;
  }

  async launchApp(appId: string, link?: string): Promise<void> {
    await this.request('ssap://system.launcher/launch', link ? { id: appId, contentId: link } : { id: appId });
  }

  async setVolume(level: number): Promise<void> {
    await this.request('ssap://audio/setVolume', { volume: Math.round(Math.min(1, Math.max(0, level)) * 100) });
  }

  async setMuted(muted: boolean): Promise<void> {
    await this.request('ssap://audio/setMute', { mute: muted });
  }

  async media(action: 'play' | 'pause' | 'stop' | 'next' | 'previous'): Promise<void> {
    const uri: Record<typeof action, string> = {
      play: 'ssap://media.controls/play',
      pause: 'ssap://media.controls/pause',
      stop: 'ssap://media.controls/stop',
      next: 'ssap://media.controls/fastForward',
      previous: 'ssap://media.controls/rewind',
    };
    await this.request(uri[action]);
  }
}
