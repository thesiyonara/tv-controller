/**
 * Android TV Remote protocol v2 — remote session (port 6466).
 *
 * In-house implementation so we control reconnects, logging and the IME
 * (on-screen keyboard) messages the third-party libraries don't expose.
 * Schema: ./remotemessage.proto (from tronikos/androidtvremote2, Apache-2.0).
 *
 * Wire format: TLS with our client cert; each message is a varint-length-
 * delimited `remote.RemoteMessage` protobuf in both directions.
 */
import { EventEmitter } from 'events';
import path from 'path';
import tls from 'tls';
import protobuf from 'protobufjs';
import type { PairingCert } from '../store';

/** Feature bits negotiated in RemoteConfigure.code1 / RemoteSetActive.active */
export const Feature = {
  PING: 1 << 0,
  KEY: 1 << 1,
  IME: 1 << 2,
  VOICE: 1 << 3,
  POWER: 1 << 5,
  VOLUME: 1 << 6,
  APP_LINK: 1 << 9,
} as const;

const WANTED_FEATURES = Feature.PING | Feature.KEY | Feature.IME | Feature.POWER | Feature.VOLUME | Feature.APP_LINK;
/** Real messages are a few hundred bytes; a length prefix beyond this is a broken or hostile peer, not a frame to wait for. */
const MAX_FRAME_BYTES = 1024 * 1024;

export interface TextField {
  value: string;
  start: number;
  end: number;
  label?: string;
}

export interface SessionEvents {
  ready: () => void;
  powered: (on: boolean) => void;
  volume: (v: { level: number; maximum: number; muted: boolean }) => void;
  currentApp: (pkg: string) => void;
  /** TV opened its keyboard on a text field; `field` is what it contains now */
  imeShow: (field: TextField) => void;
  /** TV reported the field content changed (after our edits or the user's) */
  imeField: (field: TextField | undefined) => void;
  deviceInfo: (info: { model: string; vendor: string; version: string }) => void;
  /** the TV started a voice session (it wants microphone audio we don't send) */
  voiceBegin: () => void;
  error: (err: Error) => void;
  close: (hadError: boolean) => void;
}

let root: protobuf.Root | undefined;
function proto() {
  if (!root) root = protobuf.loadSync(path.join(__dirname, 'remotemessage.proto'));
  return root;
}

export class RemoteSession extends EventEmitter {
  private socket: tls.TLSSocket | undefined;
  private buf: Buffer = Buffer.alloc(0);
  private RemoteMessage: protobuf.Type;
  private KeyCode: protobuf.Enum;
  private Direction: protobuf.Enum;
  private activeFeatures = WANTED_FEATURES;
  private imeCounter = 0;
  private imeFieldCounter = 0;
  private lastField: TextField | undefined;
  public ready = false;

  constructor(
    private host: string,
    private cert: PairingCert,
    private port = 6466,
    private appVersion = '0.1.0',
    /** fingerprint256 recorded at pairing; a different certificate now means a reset TV or someone in the middle */
    private expectedFingerprint?: string,
  ) {
    super();
    const r = proto();
    this.RemoteMessage = r.lookupType('remote.RemoteMessage');
    this.KeyCode = r.lookupEnum('remote.RemoteKeyCode');
    this.Direction = r.lookupEnum('remote.RemoteDirection');
  }

  /** Resolves when the TLS handshake completes (not yet "ready"); rejects on failure. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: this.host,
        port: this.port,
        key: this.cert.key,
        cert: this.cert.cert,
        rejectUnauthorized: false,
      });
      this.socket = socket;
      let settled = false;

      socket.setTimeout(15_000); // TV pings every ~5s
      socket.once('secureConnect', () => {
        const fp = socket.getPeerCertificate()?.fingerprint256;
        if (this.expectedFingerprint && fp && fp !== this.expectedFingerprint) {
          settled = true;
          socket.destroy();
          reject(new Error('CERT_CHANGED: the TV presented a different certificate than when it was paired'));
          return;
        }
        settled = true;
        resolve();
      });
      socket.on('data', (chunk: Buffer) => this.onData(chunk));
      socket.on('timeout', () => {
        this.emit('error', new Error(settled ? 'Remote session timed out (no ping from TV)' : 'The TV accepted the connection but never completed the handshake'));
        socket.destroy();
      });
      socket.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        } else {
          this.emit('error', err);
        }
      });
      socket.on('close', (hadError: boolean) => {
        this.ready = false;
        // A socket that closes before the handshake (a sleeping box that accepts TCP and then goes quiet)
        // must still settle connect(), or the caller waits forever.
        if (!settled) {
          settled = true;
          reject(new Error('The TV closed the connection before the handshake completed'));
        }
        this.emit('close', hadError);
      });
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }

  // ---- outgoing -----------------------------------------------------------

  private send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.destroyed) throw new Error('Remote session not connected');
    const err = this.RemoteMessage.verify(payload);
    if (err) throw new Error(`Invalid RemoteMessage: ${err}`);
    const msg = this.RemoteMessage.create(payload);
    this.socket.write(this.RemoteMessage.encodeDelimited(msg).finish());
  }

  sendKey(key: string | number, direction: 'SHORT' | 'START_LONG' | 'END_LONG' = 'SHORT'): void {
    const keyCode = typeof key === 'number' ? key : this.KeyCode.values[key];
    if (keyCode === undefined) throw new Error(`Unknown key: ${key}`);
    this.send({ remoteKeyInject: { keyCode, direction: this.Direction.values[direction] } });
  }

  sendAppLink(appLink: string): void {
    this.send({ remoteAppLinkLaunchRequest: { appLink } });
  }

  /** What the TV says its focused text field contains (undefined when it closed). */
  get field(): TextField | undefined {
    return this.lastField;
  }

  /** Does the TV currently have a text field open that we can write into? */
  get imeAvailable(): boolean {
    return (this.activeFeatures & Feature.IME) !== 0 && this.imeCounter !== 0;
  }

  /**
   * Replace the content of the focused text field with `text` via the IME
   * protocol. Mirrors androidtvremote2's send_text. Requires that the TV has
   * reported a field (imeAvailable); callers fall back to key injection otherwise.
   */
  sendText(text: string): void {
    if (!this.imeAvailable) throw new Error('No text field open on the TV');
    const cursor = Math.max(0, text.length - 1);
    this.send({
      remoteImeBatchEdit: {
        imeCounter: this.imeCounter,
        fieldCounter: this.imeFieldCounter,
        editInfo: [{ insert: 1, textFieldStatus: { start: cursor, end: cursor, value: text } }],
      },
    });
  }

  // ---- incoming -----------------------------------------------------------

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const frame = this.readFrame();
      if (frame === 'oversized') {
        // Don't keep buffering towards a length that can never arrive: drop the connection and say why.
        this.buf = Buffer.alloc(0);
        this.emit('error', new Error('The TV sent a frame larger than the protocol allows'));
        this.socket?.destroy();
        break;
      }
      if (!frame) break;
      let msg: Record<string, any>;
      try {
        msg = this.RemoteMessage.decode(frame).toJSON();
      } catch (err) {
        this.emit('error', new Error(`Bad frame from TV: ${(err as Error).message}`));
        continue;
      }
      this.handle(msg);
    }
  }

  /** Pull one varint-length-prefixed frame off the buffer; undefined if incomplete, 'oversized' if it never should complete. */
  private readFrame(): Uint8Array | 'oversized' | undefined {
    if (this.buf.length === 0) return undefined;
    const reader = protobuf.Reader.create(this.buf);
    let len: number;
    try {
      len = reader.uint32();
    } catch {
      // a varint is at most 5 bytes: more than that without a complete one is garbage, not a slow network
      return this.buf.length > 5 ? 'oversized' : undefined;
    }
    if (len > MAX_FRAME_BYTES) return 'oversized';
    const start = reader.pos;
    if (this.buf.length < start + len) return undefined;
    const frame = this.buf.subarray(start, start + len);
    this.buf = this.buf.subarray(start + len);
    return frame;
  }

  private handle(msg: Record<string, any>): void {
    if (msg.remotePingRequest) {
      this.send({ remotePingResponse: { val1: msg.remotePingRequest.val1 } });
      return;
    }
    if (msg.remoteConfigure) {
      const supported = Number(msg.remoteConfigure.code1 ?? 0);
      this.activeFeatures = WANTED_FEATURES & supported;
      const di = msg.remoteConfigure.deviceInfo ?? {};
      this.emit('deviceInfo', { model: di.model ?? '', vendor: di.vendor ?? '', version: di.appVersion ?? '' });
      this.send({
        remoteConfigure: {
          code1: this.activeFeatures,
          deviceInfo: {
            model: 'Desktop',
            vendor: 'Android TV Controller',
            unknown1: 1,
            unknown2: '1',
            packageName: 'android-tv-controller',
            appVersion: this.appVersion,
          },
        },
      });
      return;
    }
    if (msg.remoteSetActive) {
      this.send({ remoteSetActive: { active: this.activeFeatures } });
      if (!this.ready) {
        this.ready = true;
        this.emit('ready');
      }
      return;
    }
    if (msg.remoteStart) {
      this.emit('powered', Boolean(msg.remoteStart.started));
      return;
    }
    if (msg.remoteSetVolumeLevel) {
      const v = msg.remoteSetVolumeLevel;
      this.emit('volume', { level: Number(v.volumeLevel ?? 0), maximum: Number(v.volumeMax ?? 100), muted: Boolean(v.volumeMuted) });
      return;
    }
    if (msg.remoteImeKeyInject) {
      const pkg = msg.remoteImeKeyInject.appInfo?.appPackage;
      if (pkg) this.emit('currentApp', pkg);
      const f = msg.remoteImeKeyInject.textFieldStatus;
      if (f) this.updateField(toField(f));
      return;
    }
    if (msg.remoteImeShowRequest) {
      const f = toField(msg.remoteImeShowRequest.remoteTextFieldStatus ?? {});
      this.lastField = f;
      this.emit('imeShow', f);
      return;
    }
    if (msg.remoteImeBatchEdit) {
      const b = msg.remoteImeBatchEdit;
      this.imeCounter = Number(b.imeCounter ?? 0);
      this.imeFieldCounter = Number(b.fieldCounter ?? 0);
      const status = b.editInfo?.find((e: any) => e.textFieldStatus)?.textFieldStatus;
      if (status) this.updateField({ value: status.value ?? '', start: Number(status.start ?? 0), end: Number(status.end ?? 0) });
      return;
    }
    if (msg.remoteError) {
      this.emit('error', new Error(`TV reported error: ${JSON.stringify(msg.remoteError)}`));
      return;
    }
    if (msg.remoteVoiceBegin) {
      this.emit('voiceBegin');
      return;
    }
    // remoteVoicePayload/End, remoteAdjustVolumeLevel etc. — ignored
  }

  private updateField(f: TextField | undefined): void {
    this.lastField = f;
    this.emit('imeField', f);
  }
}

function toField(f: any): TextField {
  return { value: f.value ?? '', start: Number(f.start ?? 0), end: Number(f.end ?? 0), label: f.label || undefined };
}

/**
 * Map a character to an Android KEYCODE name for the key-injection fallback.
 * Only the subset a TV search box cares about; everything else is skipped.
 * Android key injection has no modifier state, so uppercase becomes lowercase.
 */
export function charToKey(ch: string): string | undefined {
  const c = ch.toLowerCase();
  if (c >= 'a' && c <= 'z') return `KEYCODE_${c.toUpperCase()}`;
  if (c >= '0' && c <= '9') return `KEYCODE_${c}`;
  const map: Record<string, string> = {
    ' ': 'KEYCODE_SPACE',
    '.': 'KEYCODE_PERIOD',
    ',': 'KEYCODE_COMMA',
    '-': 'KEYCODE_MINUS',
    '+': 'KEYCODE_PLUS',
    '=': 'KEYCODE_EQUALS',
    '@': 'KEYCODE_AT',
    '/': 'KEYCODE_SLASH',
    '\\': 'KEYCODE_BACKSLASH',
    "'": 'KEYCODE_APOSTROPHE',
    ';': 'KEYCODE_SEMICOLON',
    '#': 'KEYCODE_POUND',
    '*': 'KEYCODE_STAR',
    '[': 'KEYCODE_LEFT_BRACKET',
    ']': 'KEYCODE_RIGHT_BRACKET',
    '`': 'KEYCODE_GRAVE',
    '\n': 'KEYCODE_ENTER',
    '\t': 'KEYCODE_TAB',
  };
  return map[c];
}
