/**
 * Roku driver — External Control Protocol (ECP), plain HTTP on port 8060.
 * No pairing. Works on Roku players and Roku TVs (TVs also take volume/power keys).
 *
 *   POST /keypress/<Key>       keys; Lit_<char> types a character
 *   POST /launch/<appId>       launch channel
 *   GET  /query/apps           installed channels (XML)
 *   GET  /query/active-app     foreground channel
 *   GET  /query/media-player   playback state/position
 *   GET  /query/device-info    name, model, power mode
 *   GET  /query/icon/<appId>   PNG icon
 */
import http from 'http';
import type { AppInfo, Capability, KeyDirection, RemoteKey } from '../../shared/types';
import { ROKU_KEYS } from '../../shared/keys';
import type { LaunchTarget, ParsedLink } from '../deeplink';
import { TvDriver, colorFor, initials } from './driver';

export class RokuDriver extends TvDriver {
  readonly capabilities: Capability[] = ['keys', 'text', 'power', 'volume', 'apps', 'launch', 'media'];
  private poll?: NodeJS.Timeout;
  private appsCache?: AppInfo[];

  private base(): string {
    return `http://${this.ctx.host}:${this.ctx.port || 8060}`;
  }

  protected async open(): Promise<void> {
    if (this.poll) return;
    this.update({ state: 'connecting', error: undefined });
    try {
      const info = await this.get('/query/device-info');
      this.update({
        state: 'connected',
        model: xmlTag(info, 'model-name'),
        vendor: 'Roku',
        powered: /PowerOn/i.test(xmlTag(info, 'power-mode') ?? 'PowerOn'),
        error: undefined,
      });
    } catch (err) {
      this.update({ state: 'error', error: `Roku not reachable: ${(err as Error).message}` });
      throw err;
    }
    await this.refreshStatus();
    this.poll = setInterval(() => void this.refreshStatus(), 5000);
  }

  protected async close(): Promise<void> {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    this.failures = 0;
  }

  private failures = 0;

  protected async launchLink(link: ParsedLink, t: LaunchTarget): Promise<void> {
    this.requireConnected();
    if (!t.roku) throw new Error(`No Roku channel known for ${link.service} links`);
    const q = t.roku.params ? '?' + new URLSearchParams(t.roku.params).toString() : '';
    await this.post(`/launch/${encodeURIComponent(t.roku.appId)}${q}`);
  }

  private async refreshStatus(): Promise<void> {
    try {
      const [active, player] = await Promise.all([this.get('/query/active-app'), this.get('/query/media-player')]);
      const appId = /<app id="([^"]+)"/.exec(active)?.[1];
      const appName = />([^<]+)<\/app>/.exec(active)?.[1];
      const state = /<player[^>]*state="([^"]+)"/.exec(player)?.[1];
      const pos = xmlTag(player, 'position');
      const dur = xmlTag(player, 'duration');
      // Roku TVs: the tuner app (id "tvinput.dtv") exposes channel + programme info.
      let channel: { number?: string; name?: string; program?: string } | undefined;
      if (appId && /^tvinput\./.test(appId)) {
        try {
          const ch = await this.get('/query/tv-active-channel');
          channel = { number: xmlTag(ch, 'number'), name: xmlTag(ch, 'name'), program: xmlTag(ch, 'program-title') };
        } catch {
          /* not a TV */
        }
      }
      this.update({
        currentApp: appId && appName && appName !== 'Roku' ? { id: appId, name: appName } : undefined,
        channel,
        media:
          state && state !== 'none' && state !== 'close'
            ? {
                source: 'roku',
                appId,
                playerState: state === 'play' ? 'PLAYING' : state === 'pause' ? 'PAUSED' : state.toUpperCase(),
                currentTime: pos ? parseFloat(pos) / 1000 : undefined,
                duration: dur ? parseFloat(dur) / 1000 : undefined,
                updatedAt: Date.now(),
              }
            : undefined,
      });
      this.failures = 0;
    } catch {
      // Three missed polls in a row (15s): treat as gone and let the base class reconnect.
      if (++this.failures >= 3 && this.poll) {
        clearInterval(this.poll);
        this.poll = undefined;
        this.failures = 0;
        this.lost('Roku stopped answering');
      }
    }
  }

  async sendKey(key: RemoteKey, direction: KeyDirection = 'SHORT'): Promise<void> {
    this.requireConnected();
    const k = ROKU_KEYS[key];
    if (!k) this.unsupported(`Key ${key}`);
    if (direction === 'START_LONG') return void (await this.post(`/keydown/${k}`));
    if (direction === 'END_LONG') return void (await this.post(`/keyup/${k}`));
    await this.post(`/keypress/${k}`);
  }

  /** Roku's own search across channels (ECP /search/browse), shown on the TV for the user to pick. */
  async searchOnTv(query: string): Promise<void> {
    this.requireConnected();
    await this.post('/search/browse?' + new URLSearchParams({ keyword: query }).toString());
  }

  async sendText(text: string): Promise<'native'> {
    this.requireConnected();
    for (const ch of text) {
      await this.post(`/keypress/Lit_${encodeURIComponent(ch)}`);
    }
    return 'native';
  }

  async clearText(count = 1): Promise<void> {
    for (let i = 0; i < count; i++) await this.post('/keypress/Backspace');
  }

  async launchApp(appId: string): Promise<void> {
    this.requireConnected();
    await this.post(`/launch/${encodeURIComponent(appId)}`);
  }

  async listApps(refresh = false): Promise<AppInfo[]> {
    if (this.appsCache && !refresh) return this.appsCache;
    const xml = await this.get('/query/apps');
    const apps: AppInfo[] = [];
    const re = /<app id="([^"]+)"[^>]*>([^<]+)<\/app>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      apps.push({
        id: m[1],
        name: m[2],
        icon: `${this.base()}/query/icon/${m[1]}`,
        initials: initials(m[2]),
        color: colorFor(m[1]),
        source: 'device',
      });
    }
    this.appsCache = apps;
    return apps;
  }

  async media(action: 'play' | 'pause' | 'stop' | 'next' | 'previous'): Promise<void> {
    const key: Record<typeof action, RemoteKey> = { play: 'PLAY', pause: 'PAUSE', stop: 'STOP', next: 'FAST_FORWARD', previous: 'REWIND' };
    await this.sendKey(key[action]);
  }

  // ---- http ----
  private get(path: string): Promise<string> {
    return request('GET', this.base() + path);
  }
  private post(path: string): Promise<string> {
    return request('POST', this.base() + path);
  }
}

function request(method: 'GET' | 'POST', url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, timeout: 4000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 400) reject(new Error(`HTTP ${res.statusCode}`));
        else resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function xmlTag(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];
}
