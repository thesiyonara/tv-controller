// Minimal ambient typings for untyped JS dependencies. Only the surface we use.

declare module 'castv2-client' {
  import { EventEmitter } from 'events';
  type Cb<T = unknown> = (err: Error | null, result?: T) => void;

  export interface ReceiverApplication {
    appId: string;
    displayName: string;
    statusText?: string;
    sessionId: string;
    transportId: string;
    isIdleScreen?: boolean;
    namespaces?: Array<{ name: string }>;
  }
  export interface ReceiverStatus {
    volume?: { level: number; muted: boolean };
    applications?: ReceiverApplication[];
  }
  export interface MediaStatus {
    mediaSessionId?: number;
    playerState?: string;
    currentTime?: number;
    media?: {
      contentId?: string;
      duration?: number;
      metadata?: { metadataType?: number; title?: string; subtitle?: string; artist?: string; albumName?: string; seriesTitle?: string; season?: number; episode?: number; images?: Array<{ url: string }> };
    };
  }
  export interface ReceiverController extends EventEmitter {
    launch(appId: string, cb: Cb<ReceiverApplication[]>): void;
  }
  export class Client extends EventEmitter {
    connect(host: string | { host: string; port?: number }, cb: () => void): void;
    close(): void;
    getStatus(cb: Cb<ReceiverStatus>): void;
    getSessions(cb: Cb<ReceiverApplication[]>): void;
    launch<T>(app: new (...args: any[]) => T, cb: Cb<T>): void;
    join<T>(session: ReceiverApplication, app: new (...args: any[]) => T, cb: Cb<T>): void;
    stop(app: unknown, cb: Cb): void;
    setVolume(volume: { level?: number; muted?: boolean }, cb: Cb<{ level: number; muted: boolean }>): void;
    getVolume(cb: Cb<{ level: number; muted: boolean }>): void;
    receiver: ReceiverController;
  }
  export class DefaultMediaReceiver extends EventEmitter {
    static APP_ID: string;
    session: { displayName: string; appId: string; sessionId: string };
    getStatus(cb: Cb<MediaStatus>): void;
    load(media: unknown, options: { autoplay?: boolean; currentTime?: number }, cb: Cb<MediaStatus>): void;
    play(cb: Cb<MediaStatus>): void;
    pause(cb: Cb<MediaStatus>): void;
    stop(cb: Cb<MediaStatus>): void;
    seek(currentTime: number, cb: Cb<MediaStatus>): void;
    close(): void;
  }
}
