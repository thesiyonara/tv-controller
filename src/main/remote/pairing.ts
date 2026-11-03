/**
 * Android TV Remote v2 — pairing (port 6467), in-house.
 *
 * Why not the library's PairingManager: it resolves "paired" whenever the socket
 * closes without a TLS error, so a cancelled dialog or a TV that simply hung up
 * looked like success and we stored a certificate the TV never approved. This
 * implementation only reports success on PairingSecretAck, maps the TV's status
 * codes to readable errors, and supports cancellation.
 *
 * Handshake (every message wrapped in PairingMessage{protocol_version:2, status:OK}):
 *   → PairingRequest{client_name, service_name}
 *   ← PairingRequestAck
 *   → PairingOption{input_encodings:[HEX/6], preferred_role:INPUT}
 *   ← PairingOption
 *   → PairingConfiguration{encoding:HEX/6, client_role:INPUT}
 *   ← PairingConfigurationAck            (TV now shows a 6-char code)
 *   → PairingSecret{sha256(client_mod‖client_exp‖server_mod‖server_exp‖code[2..6])}
 *   ← PairingSecretAck                   (success; TV trusts our certificate)
 *
 * The first two hex characters of the code are a checksum: they must equal the
 * first byte of that hash, which lets us reject a typo before bothering the TV.
 */
import crypto from 'crypto';
import { EventEmitter } from 'events';
import os from 'os';
import path from 'path';
import tls from 'tls';
import protobuf from 'protobufjs';
import type { PairingCert } from '../store';

// Certificate generation (node-forge) is the one piece we keep from androidtv-remote (MIT).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CertificateGenerator } = require('androidtv-remote/dist/certificate/CertificateGenerator.js');

export function generateCertificate(commonName: string): PairingCert {
  return CertificateGenerator.generateFull(commonName, 'US', 'CA', 'Local', 'Android TV Controller', 'Desktop');
}

export function defaultClientName(): string {
  const host = os.hostname().replace(/\.local$/i, '').replace(/[-_]/g, ' ');
  return `Android TV Controller (${host})`.slice(0, 60);
}

let root: protobuf.Root | undefined;
function proto(): protobuf.Root {
  if (!root) root = protobuf.loadSync(path.join(__dirname, 'pairingmessage.proto'));
  return root;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'The TV reported an error during pairing.',
  401: 'The TV rejected the pairing configuration.',
  402: 'Wrong code. Check the TV and try again.',
};

export interface PairingOptions {
  port?: number;
  clientName?: string;
  /** Give up if the TV goes quiet for this long (the user has to type the code). */
  idleTimeoutMs?: number;
}

export class Pairing extends EventEmitter {
  private socket?: tls.TLSSocket;
  private buf: Buffer = Buffer.alloc(0);
  private PM: protobuf.Type;
  private Status: Record<string, number>;
  private RoleType: Record<string, number>;
  private EncodingType: Record<string, number>;
  private settled = false;
  private cancelled = false;
  private resolveDone?: (ok: boolean) => void;
  private rejectDone?: (err: Error) => void;
  private idleTimer?: NodeJS.Timeout;
  /** true once the TV is showing the code */
  public awaitingCode = false;
  /** SHA-256 fingerprint of the TV's certificate, for pinning the remote session later */
  public peerFingerprint?: string;

  constructor(
    private host: string,
    private cert: PairingCert,
    private opts: PairingOptions = {},
  ) {
    super();
    const r = proto();
    this.PM = r.lookupType('pairing.PairingMessage');
    this.Status = r.lookupEnum('pairing.PairingMessage.Status').values;
    this.RoleType = r.lookupEnum('pairing.RoleType').values;
    this.EncodingType = r.lookupEnum('pairing.PairingEncoding.EncodingType').values;
  }

  /** Resolves true on PairingSecretAck. Rejects with a readable error otherwise. */
  start(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
      const socket = tls.connect({
        host: this.host,
        port: this.opts.port ?? 6467,
        key: this.cert.key,
        cert: this.cert.cert,
        rejectUnauthorized: false,
      });
      this.socket = socket;
      this.touch();
      socket.once('secureConnect', () => {
        this.peerFingerprint = socket.getPeerCertificate()?.fingerprint256 || undefined;
        this.send({ pairingRequest: { clientName: this.opts.clientName ?? defaultClientName(), serviceName: 'atvremote' } });
      });
      socket.on('data', (chunk: Buffer) => this.onData(chunk));
      socket.on('error', (err: Error) => this.fail(friendly(err)));
      socket.on('close', () => this.fail(this.cancelled ? 'Pairing cancelled.' : 'The TV closed the pairing session. Make sure it is on and showing the home screen, then try again.'));
    });
  }

  /** Send the code the TV shows. Returns false (and sends nothing) if the checksum doesn't match. */
  sendCode(code: string): boolean {
    const c = code.replace(/[^0-9a-f]/gi, '').toUpperCase();
    if (c.length !== 6 || !this.socket) return false;
    const client = this.socket.getCertificate() as tls.PeerCertificate | object;
    const server = this.socket.getPeerCertificate();
    if (!('modulus' in client) || !server?.modulus || !server.exponent) return false;
    const h = crypto.createHash('sha256');
    h.update(Buffer.from(client.modulus as string, 'hex'));
    h.update(Buffer.from('0' + (client.exponent as string).slice(2), 'hex'));
    h.update(Buffer.from(server.modulus, 'hex'));
    h.update(Buffer.from('0' + server.exponent.slice(2), 'hex'));
    h.update(Buffer.from(c.slice(2), 'hex'));
    const secret = h.digest();
    if (secret[0] !== parseInt(c.slice(0, 2), 16)) return false;
    this.touch();
    this.send({ pairingSecret: { secret } });
    return true;
  }

  cancel(): void {
    this.cancelled = true;
    this.socket?.destroy();
  }

  // ---- internals ----

  private send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.destroyed) return;
    const msg = this.PM.create({ protocolVersion: 2, status: this.Status.STATUS_OK, ...payload });
    this.socket.write(this.PM.encodeDelimited(msg).finish());
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const frame = this.readFrame();
      if (!frame) break;
      let msg: Record<string, any>;
      try {
        msg = this.PM.decode(frame).toJSON();
      } catch (err) {
        this.fail(`Unreadable pairing message from the TV (${(err as Error).message}).`);
        return;
      }
      this.handle(msg);
    }
  }

  private readFrame(): Uint8Array | undefined {
    if (this.buf.length === 0) return undefined;
    const reader = protobuf.Reader.create(this.buf);
    let len: number;
    try {
      len = reader.uint32();
    } catch {
      return undefined;
    }
    const start = reader.pos;
    if (this.buf.length < start + len) return undefined;
    const frame = this.buf.subarray(start, start + len);
    this.buf = this.buf.subarray(start + len);
    return frame;
  }

  private handle(msg: Record<string, any>): void {
    this.touch();
    const status = typeof msg.status === 'string' ? this.Status[msg.status] : Number(msg.status ?? 200);
    if (status !== this.Status.STATUS_OK) {
      this.fail(STATUS_TEXT[status] ?? `The TV answered with status ${status}.`);
      return;
    }
    if (msg.pairingRequestAck) {
      this.send({
        pairingOption: {
          preferredRole: this.RoleType.ROLE_TYPE_INPUT,
          inputEncodings: [{ type: this.EncodingType.ENCODING_TYPE_HEXADECIMAL, symbolLength: 6 }],
        },
      });
    } else if (msg.pairingOption) {
      this.send({
        pairingConfiguration: {
          clientRole: this.RoleType.ROLE_TYPE_INPUT,
          encoding: { type: this.EncodingType.ENCODING_TYPE_HEXADECIMAL, symbolLength: 6 },
        },
      });
    } else if (msg.pairingConfigurationAck) {
      this.awaitingCode = true;
      this.emit('secret');
    } else if (msg.pairingSecretAck) {
      this.succeed();
    }
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.fail('Pairing timed out. Start again when you are in front of the TV.'), this.opts.idleTimeoutMs ?? 120_000);
  }

  private succeed(): void {
    if (this.settled) return;
    this.settled = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.resolveDone?.(true);
    this.socket?.end();
  }

  private fail(message: string): void {
    if (this.settled) return;
    this.settled = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.rejectDone?.(new Error(message));
    this.socket?.destroy();
  }
}

function friendly(err: Error): string {
  if (/ECONNREFUSED/.test(err.message)) return 'The TV refused the pairing connection. Is it on?';
  if (/EHOSTUNREACH|ETIMEDOUT|ENETUNREACH/.test(err.message)) return 'The TV is not reachable on the network.';
  return err.message;
}
