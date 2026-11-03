/**
 * Google Cast (CASTV2) driver. Wraps `castv2-client`.
 *
 * Two layers: receiver (volume/mute, running app, stop app) and media
 * (play/pause/seek/load on apps that expose the media namespace).
 * Cast cannot press Home or move a cursor; that's the Android TV driver's job.
 */
import { Client, DefaultMediaReceiver } from 'castv2-client';
import type { ReceiverStatus, MediaStatus } from 'castv2-client';
import type { Capability, CastMedia, DeviceState, RemoteKey } from '../../shared/types';
import type { LaunchTarget, ParsedLink } from '../deeplink';
import { TvDriver } from './driver';

const MEDIA_NAMESPACE = 'urn:x-cast:com.google.cast.media';

export class CastDriver extends TvDriver {
  readonly capabilities: Capability[] = ['volumeLevel', 'media', 'cast', 'launch'];
  private client?: Client;
  private player?: DefaultMediaReceiver;
  private mediaStatus?: MediaStatus;
  private receiverSession?: string;
  private joiningSession?: string;

  protected async open(): Promise<void> {
    if (this.client) return;
    const client = new Client();
    this.client = client;
    this.update({ state: 'connecting', error: undefined });

    // Everything below checks `this.client === client`: an attempt that was torn down (refused, timed out,
    // disconnected) must not touch the state of the attempt that replaced it.
    client.on('error', (err: Error) => {
      if (this.client !== client) return;
      this.update({ state: 'error', error: err.message });
      this.teardown(client);
      this.lost();
    });
    client.on('close', () => {
      if (this.client === client) {
        this.teardown(client);
        this.lost();
      }
    });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Cast connect timeout')), 8000);
      client.once('error', (err: Error) => {
        clearTimeout(t);
        reject(err);
      });
      client.connect(this.ctx.host, () => {
        clearTimeout(t);
        resolve();
      });
    }).catch((err: Error) => {
      if (this.client === client) {
        this.update({ state: 'error', error: err.message });
        this.teardown(client);
      }
      throw err;
    });
    if (this.client !== client) return; // torn down while connecting (disconnect, or an error already handled above)

    client.receiver.on('status', (status: ReceiverStatus) => this.applyReceiverStatus(status));
    client.getStatus((err, status) => {
      if (!err && status && this.client === client) this.applyReceiverStatus(status);
    });
    this.update({ state: 'connected', error: undefined, powered: true });
  }

  private teardown(client: Client): void {
    if (this.client !== client) return;
    try {
      this.player?.close();
      client.close();
    } catch {
      /* ignore */
    }
    this.player = undefined;
    this.mediaStatus = undefined;
    this.receiverSession = undefined;
    this.joiningSession = undefined;
    this.client = undefined;
  }

  protected async close(): Promise<void> {
    if (this.client) this.teardown(this.client);
  }

  private applyReceiverStatus(status: ReceiverStatus): void {
    // Receiver volume updates can omit applications; omission is not a return to Home.
    if (status.applications === undefined) {
      if (status.volume) this.update({ volume: { level: status.volume.level, muted: status.volume.muted } });
      return;
    }
    const app = status.applications?.[0];
    const running = app && !app.isIdleScreen ? app : undefined;
    if (this.receiverSession !== running?.sessionId) {
      this.mediaStatus = undefined;
      this.joiningSession = undefined;
    }
    this.receiverSession = running?.sessionId;
    const patch: Partial<DeviceState> = {
      volume: status.volume ? { level: status.volume.level, muted: status.volume.muted } : this._state.volume,
      currentApp: running ? { id: running.appId, name: running.displayName } : undefined,
    };
    // The session we were listening to is gone (the TV switched apps, or went home): drop its title and clock
    // right away instead of letting a stale "Playing …" keep ticking while another app is on screen.
    const attached = this.player?.session?.sessionId;
    if (this.player && (!running || running.sessionId !== attached)) {
      try {
        this.player.close();
      } catch {
        /* ignore */
      }
      this.player = undefined;
      patch.media = undefined;
    } else if (!running && this._state.media) {
      patch.media = undefined;
    }
    this.update(patch);
    void this.joinMediaSession();
  }

  /** Join the running app's media session if it exposes the media namespace. */
  private joinMediaSession(): Promise<void> {
    return new Promise((resolve) => {
      const client = this.client;
      if (!client) return resolve();
      const expectedSession = this.receiverSession;
      if (!expectedSession) return resolve();
      client.getSessions((err, apps) => {
        if (this.client !== client || this.receiverSession !== expectedSession || err) return resolve();
        if (!apps?.length) {
          this.player?.close();
          this.player = undefined;
          this.clearMedia();
          return resolve();
        }
        const app = apps.find((a) => (!expectedSession || a.sessionId === expectedSession) && a.namespaces?.some((n) => n.name === MEDIA_NAMESPACE));
        if (!app) {
          // the running app has no media channel: nothing to report (and nothing old to keep)
          if (this.player) {
            this.player.close();
            this.player = undefined;
          }
          if (this._state.media) this.clearMedia();
          return resolve();
        }
        if (this.player && this.player.session?.sessionId === app.sessionId) return resolve();
        if (this.joiningSession === app.sessionId) return resolve();
        this.joiningSession = app.sessionId;
        client.join(app, DefaultMediaReceiver, (joinErr, player) => {
          if (this.joiningSession === app.sessionId) this.joiningSession = undefined;
          if (this.client !== client || this.receiverSession !== expectedSession) { player?.close(); return resolve(); }
          if (joinErr || !player) return resolve();
          this.attachPlayer(player);
          player.getStatus((statusError, ms) => {
            if (this.player !== player || statusError) return resolve();
            // a fresh session with nothing loaded yet (Netflix at its menu) reports no media at all
            if (ms) this.applyMediaStatus(ms);
            else if (this._state.media) this.clearMedia();
            resolve();
          });
        });
      });
    });
  }

  private attachPlayer(player: DefaultMediaReceiver): void {
    this.player?.close();
    this.player = player;
    this.mediaStatus = undefined;
    player.on('status', (ms: MediaStatus) => { if (this.player === player) this.applyMediaStatus(ms); });
  }

  private clearMedia(): void {
    this.mediaStatus = undefined;
    if (this._state.media) this.update({ media: undefined });
  }

  private applyMediaStatus(ms: MediaStatus): void {
    if (ms.playerState === 'IDLE') {
      this.mediaStatus = undefined;
      // nothing loaded: an idle session is "nothing playing", not a title to show
      if (this._state.media) this.clearMedia();
      return;
    }
    // Cast deliberately omits MediaInformation when only position/state changes.
    const previous = this._state.media;
    const changed = (ms.mediaSessionId !== undefined && this.mediaStatus?.mediaSessionId !== undefined && ms.mediaSessionId !== this.mediaStatus.mediaSessionId)
      || (ms.media?.contentId !== undefined && this.mediaStatus?.media?.contentId !== undefined && ms.media.contentId !== this.mediaStatus.media.contentId);
    const base = changed ? undefined : this.mediaStatus;
    const elapsed = !changed && previous?.playerState === 'PLAYING' && previous.updatedAt ? Math.max(0, (Date.now() - previous.updatedAt) / 1000) : 0;
    const position = ms.currentTime ?? (!changed && previous?.currentTime !== undefined ? previous.currentTime + elapsed : undefined);
    ms = {
      ...base, ...ms, currentTime: position,
      media: ms.media ? { ...base?.media, ...ms.media, metadata: ms.media.metadata ?? base?.media?.metadata } : base?.media,
    };
    this.mediaStatus = ms;
    if (!ms.media && !ms.playerState) return;
    const meta = ms.media?.metadata;
    // TV shows (Netflix, Disney+, Prime via Cast Connect) report the series separately from the episode:
    // show the series as the title and "S2 E3 · Episode name" underneath, like the TV's own overlay.
    const series = meta?.seriesTitle;
    const se = series && (meta?.season !== undefined || meta?.episode !== undefined) ? `S${meta?.season ?? '?'} E${meta?.episode ?? '?'}` : undefined;
    const title = series ?? meta?.title;
    const subtitle = series ? [se, meta?.title].filter(Boolean).join(' · ') || meta?.subtitle : (meta?.subtitle ?? meta?.artist ?? meta?.albumName);
    this.update({
      media: {
        source: 'cast',
        appId: this._state.currentApp?.id,
        contentId: ms.media?.contentId,
        title,
        subtitle: subtitle || undefined,
        // YouTube on Google TV often sends no image; its thumbnails follow the video id, so build one.
        artwork: meta?.images?.[0]?.url ?? (this._state.currentApp?.id === '233637DE' && ms.media?.contentId && /^[A-Za-z0-9_-]{8,}$/.test(ms.media.contentId) ? `https://i.ytimg.com/vi/${ms.media.contentId}/mqdefault.jpg` : undefined),
        playerState: ms.playerState,
        currentTime: ms.currentTime,
        duration: ms.media?.duration,
        updatedAt: Date.now(),
      },
    });
  }

  private requireClient(): Client {
    this.requireConnected();
    if (!this.client) throw new Error('Not connected');
    return this.client;
  }

  private requirePlayer(): DefaultMediaReceiver {
    this.requireConnected();
    if (!this.player) throw new Error('Nothing is playing through Cast right now');
    return this.player;
  }

  /** Cast has no keys; translate the media/volume ones so room routing works. */
  async sendKey(key: RemoteKey): Promise<void> {
    switch (key) {
      case 'PLAY_PAUSE':
        return this.media(this._state.media?.playerState === 'PLAYING' ? 'pause' : 'play');
      case 'PLAY':
        return this.media('play');
      case 'PAUSE':
        return this.media('pause');
      case 'STOP':
        return this.media('stop');
      case 'VOLUME_UP':
        return this.setVolume((this._state.volume?.level ?? 0) + 0.05);
      case 'VOLUME_DOWN':
        return this.setVolume((this._state.volume?.level ?? 0) - 0.05);
      case 'MUTE':
        return this.setMuted(!this._state.volume?.muted);
      case 'HOME':
      case 'EXIT':
        return this.stopApp();
      default:
        this.unsupported(`Key ${key}`);
    }
  }

  async setVolume(level: number): Promise<void> {
    const client = this.requireClient();
    await cb((done) => client.setVolume({ level: Math.min(1, Math.max(0, level)) }, done));
  }

  async setMuted(muted: boolean): Promise<void> {
    const client = this.requireClient();
    await cb((done) => client.setVolume({ muted }, done));
  }

  async media(action: 'play' | 'pause' | 'stop' | 'next' | 'previous'): Promise<void> {
    const player = this.requirePlayer();
    switch (action) {
      case 'play':
        return void (await cb((done) => player.play(done)));
      case 'pause':
        return void (await cb((done) => player.pause(done)));
      case 'stop':
        return void (await cb((done) => player.stop(done)));
      case 'next':
      case 'previous': {
        // Queue navigation isn't in castv2-client's DefaultMediaReceiver API; nudge by seeking.
        const m = this._state.media;
        const t = (m?.currentTime ?? 0) + (action === 'next' ? 30 : -10);
        return void (await cb((done) => player.seek(Math.max(0, t), done)));
      }
    }
  }

  async seek(seconds: number): Promise<void> {
    const player = this.requirePlayer();
    await cb((done) => player.seek(Math.max(0, seconds), done));
  }

  async castUrl(media: CastMedia): Promise<void> {
    const client = this.requireClient();
    const player = await cb<DefaultMediaReceiver>((done) => client.launch(DefaultMediaReceiver, done));
    this.attachPlayer(player);
    await cb<MediaStatus>((done) =>
      player.load(
        {
          contentId: media.url,
          contentType: media.contentType ?? guessContentType(media.url),
          streamType: 'BUFFERED',
          metadata: { type: 0, metadataType: 0, title: media.title ?? media.url },
        },
        { autoplay: true },
        done,
      ),
    );
  }

  protected async launchLink(_link: ParsedLink, t: LaunchTarget): Promise<void> {
    if (!t.cast) this.unsupported('Opening this link over Cast');
    await this.launchApp(t.cast.appId);
  }

  /** Launch a receiver app by its Cast app id (e.g. YouTube 233637DE). */
  async launchApp(appId: string): Promise<void> {
    const client = this.requireClient();
    await new Promise<void>((resolve, reject) =>
      client.receiver.launch(appId, (err: Error | null) => (err ? reject(err) : resolve())),
    );
  }

  private async stopApp(): Promise<void> {
    const client = this.requireClient();
    const player = this.player;
    this.player = undefined;
    if (player) await cb((done) => client.stop(player, done));
  }
}

function cb<T = unknown>(fn: (done: (err: Error | null, result?: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => fn((err, result) => (err ? reject(err) : resolve(result as T))));
}

function guessContentType(url: string): string {
  const u = url.toLowerCase().split('?')[0];
  if (u.endsWith('.webm')) return 'video/webm';
  if (u.endsWith('.m3u8')) return 'application/x-mpegURL';
  if (u.endsWith('.mp3')) return 'audio/mpeg';
  if (u.endsWith('.jpg') || u.endsWith('.jpeg')) return 'image/jpeg';
  if (u.endsWith('.png')) return 'image/png';
  return 'video/mp4';
}
