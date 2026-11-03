/**
 * Device discovery. Three layers, because home networks are messy:
 *
 *  1. mDNS / DNS-SD (bonjour-service), one listener per network interface
 *       _androidtvremote2._tcp  -> androidtv     _googlecast._tcp -> cast
 *  2. SSDP (M-SEARCH over UDP 1900, hand-rolled), sent out of every interface
 *       roku:ecp -> roku   webos-second-screen -> webos   dial + "Samsung" -> samsung
 *  3. Subnet port scan (TCP connect to each host on the local /24)
 *       8009 cast · 6466 androidtv · 8001 samsung · 8060 roku · 3000 webos
 *     Runs automatically when 1+2 find nothing within a few seconds, and on
 *     demand. It's what works when the router blocks multicast ("AP/client
 *     isolation", guest networks, some mesh systems) or macOS hasn't granted
 *     Local Network access to the app.
 *
 * Identity: a device's id is `${kind}:${host}` (what rooms, pairings and pins
 * are keyed by), but we also learn a stable identity (Cast uuid, Samsung device
 * id, SSDP USN, mDNS instance name). When the same identity shows up at a new
 * IP (DHCP), everything keyed by the old id is migrated so pairings and rooms
 * survive. A device that speaks several protocols shows up once per protocol;
 * the renderer groups entries by host.
 */
import { execFile } from 'child_process';
import dgram from 'dgram';
import { EventEmitter } from 'events';
import http from 'http';
import https from 'https';
import net from 'net';
import os from 'os';
import { Bonjour, Browser, Service } from 'bonjour-service';
import type { Capability, DeviceKind, DiscoveredDevice, DiscoveryStatus } from '../shared/types';
import { getStore, type KnownDevice } from './store';

const KIND_INFO: Record<DeviceKind, { port: number; pairing: DiscoveredDevice['pairing']; capabilities: Capability[] }> = {
  androidtv: { port: 6466, pairing: 'code', capabilities: ['keys', 'text', 'power', 'volume', 'apps', 'launch'] },
  cast: { port: 8009, pairing: 'none', capabilities: ['volumeLevel', 'media', 'cast', 'launch'] },
  roku: { port: 8060, pairing: 'none', capabilities: ['keys', 'text', 'power', 'volume', 'apps', 'launch', 'media'] },
  samsung: { port: 8002, pairing: 'prompt', capabilities: ['keys', 'text', 'power', 'volume', 'volumeLevel', 'apps', 'launch'] },
  webos: { port: 3001, pairing: 'prompt', capabilities: ['keys', 'text', 'power', 'volume', 'volumeLevel', 'apps', 'launch', 'media'] },
};

const SSDP_TARGETS = ['roku:ecp', 'urn:lge-com:service:webos-second-screen:1', 'urn:dial-multiscreen-org:service:dial:1', 'ssdp:all'];

/** Port probes for the subnet scan: a TCP connect on this port means "this kind lives here". */
const PROBES: Array<{ port: number; kind: DeviceKind }> = [
  { port: 8009, kind: 'cast' },
  { port: 6466, kind: 'androidtv' },
  { port: 8001, kind: 'samsung' },
  { port: 8060, kind: 'roku' },
  { port: 3000, kind: 'webos' },
];

const PRUNE_AFTER_MS = 30 * 24 * 3600 * 1000;

interface AddOptions {
  model?: string;
  meta?: Record<string, string>;
  port?: number;
  manual?: boolean;
  via?: string;
  identity?: string;
  mac?: string;
}

export class Discovery extends EventEmitter {
  private bonjours: Bonjour[] = [];
  private browsers: Browser[] = [];
  private ssdp?: dgram.Socket;
  private timer?: NodeJS.Timeout;
  private autoScanTimer?: NodeJS.Timeout;
  private devices = new Map<string, DiscoveredDevice>();
  private status: DiscoveryStatus = { mdns: 'idle', ssdp: 'idle', scan: 'idle', interfaces: [], found: { mdns: 0, ssdp: 0, scan: 0 }, log: [] };
  private scanning = false;
  private enriching = new Set<string>();

  constructor() {
    super();
    const store = getStore();
    for (const d of store.knownDevices()) {
      if (!KIND_INFO[d.kind] || typeof d.host !== 'string' || !d.host) continue; // a hand-edited or damaged store
      if (d.lastSeen && Date.now() - d.lastSeen > PRUNE_AFTER_MS && !d.manual) {
        store.forgetDevice(d.id);
        continue;
      }
      this.add(d.kind, d.host, d.name, { model: d.model, port: d.port, manual: d.manual, via: 'stored', identity: d.identity, mac: d.mac });
      const dev = this.devices.get(d.id);
      if (dev) dev.lastSeen = d.lastSeen ?? 0; // "stored" means not seen yet this session
    }
  }

  start(): void {
    this.status.interfaces = localInterfaces().map((i) => `${i.name} ${i.address}/${i.cidr}`);
    this.log(`interfaces: ${this.status.interfaces.join(', ') || 'none'}`);
    this.startMdns();
    this.startSsdp();
    this.timer = setInterval(() => this.rescan(false), 20_000);
    // If passive discovery finds nothing new in 6s, fall back to the subnet scan.
    this.autoScanTimer = setTimeout(() => {
      if (this.status.found.mdns + this.status.found.ssdp === 0) void this.scanSubnet();
    }, 6000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.autoScanTimer) clearTimeout(this.autoScanTimer);
    this.browsers.forEach((b) => b.stop());
    this.browsers = [];
    this.bonjours.forEach((b) => b.destroy());
    this.bonjours = [];
    this.ssdp?.close();
    this.ssdp = undefined;
  }

  /** Re-query mDNS/SSDP; with `deep` also run the subnet scan. */
  rescan(deep = true): void {
    this.browsers.forEach((b) => b.update());
    this.sendSsdpSearch();
    if (deep) void this.scanSubnet();
  }

  getStatus(): DiscoveryStatus {
    return { ...this.status, log: this.status.log.slice(-40) };
  }

  list(): DiscoveredDevice[] {
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): DiscoveredDevice | undefined {
    return this.devices.get(id);
  }

  addManual(kind: DeviceKind, host: string, name?: string): DiscoveredDevice {
    const d = this.add(kind, host, name ?? host, { manual: true, via: 'manual' });
    void this.enrich(kind, host);
    return d;
  }

  forget(id: string): void {
    this.devices.delete(id);
    getStore().forgetDevice(id);
    this.emit('update', this.list());
  }

  /** Remember a MAC (learned from ARP after a connection) for Wake-on-LAN. */
  setMac(id: string, mac: string): void {
    const d = this.devices.get(id);
    if (!d || d.mac === mac) return;
    d.mac = mac;
    getStore().rememberDevice({ id, kind: d.kind, host: d.host, port: d.port, name: d.name, mac });
    this.log(`learned MAC for ${id}`);
    this.emit('update', this.list());
  }

  refreshPairedFlags(): void {
    const store = getStore();
    for (const d of this.devices.values()) d.paired = d.pairing === 'none' || store.hasCredential(d.id);
    this.emit('update', this.list());
  }

  private log(line: string): void {
    const stamp = new Date().toISOString().slice(11, 19);
    this.status.log.push(`${stamp} ${line}`);
    if (this.status.log.length > 200) this.status.log.splice(0, this.status.log.length - 200);
    this.emit('status', this.getStatus());
  }

  private add(kind: DeviceKind, host: string, name: string, o: AddOptions = {}): DiscoveredDevice {
    let id = `${kind}:${host}`;
    const info = KIND_INFO[kind];

    // Same identity seen at a different address → the device moved (DHCP). Migrate.
    if (o.identity) {
      const previous = [...this.devices.values()].find((d) => d.kind === kind && d.identity === o.identity && d.host !== host);
      if (previous) {
        this.log(`${previous.name} moved from ${previous.host} to ${host}; keeping its pairing and rooms`);
        getStore().migrateDevice(previous.id, id);
        this.devices.delete(previous.id);
        this.emit('migrated', previous.id, id);
        o = { ...o, model: o.model ?? previous.model, mac: o.mac ?? previous.mac, manual: o.manual ?? previous.manual };
        if (!name || name === host) name = previous.name;
      }
    }

    const existing = this.devices.get(id);
    const device: DiscoveredDevice = {
      id,
      kind,
      name: name || existing?.name || host,
      host,
      port: o.port ?? existing?.port ?? info.port,
      model: o.model ?? existing?.model,
      meta: { ...(existing?.meta ?? {}), ...(o.meta ?? {}) },
      paired: info.pairing === 'none' || getStore().hasCredential(id),
      pairing: info.pairing,
      capabilities: info.capabilities,
      lastSeen: Date.now(),
      via: o.via ?? existing?.via,
      identity: o.identity ?? existing?.identity,
      mac: o.mac ?? existing?.mac,
      manual: o.manual ?? existing?.manual,
    };
    this.devices.set(id, device);
    const known: KnownDevice = { id, kind, host, port: device.port, name: device.name, model: device.model, identity: device.identity, mac: device.mac, lastSeen: o.via === 'stored' ? undefined : Date.now() };
    if (device.manual) known.manual = true;
    getStore().rememberDevice(known);
    if (!existing && o.via && o.via !== 'stored') this.log(`found ${kind} at ${host} via ${o.via}${name && name !== host ? ` (${name})` : ''}`);
    this.emit('update', this.list());
    return device;
  }

  // ---- mDNS ----

  private startMdns(): void {
    if (this.bonjours.length) return;
    const ifaces = localInterfaces();
    // A single default instance joins 224.0.0.251 on every interface and sends on the default
    // route. With several interfaces (VPN, Ethernet + Wi-Fi) we add one instance per interface
    // that sends its queries out of that interface; `bind: 0.0.0.0` keeps it able to receive
    // multicast (multicast-dns would otherwise bind the socket to the interface's unicast IP).
    const targets: Array<string | undefined> = ifaces.length > 1 ? ifaces.map((i) => i.address) : [undefined];
    let ok = 0;
    for (const iface of targets) {
      try {
        // `interface`/`bind` are multicast-dns options that bonjour-service passes through but doesn't type.
        const bonjour = new Bonjour((iface ? { interface: iface, bind: '0.0.0.0' } : {}) as any, (err: Error) => {
          this.status.mdns = 'error';
          this.log(`mDNS socket error${iface ? ` on ${iface}` : ''}: ${err.message}`);
        });
        this.bonjours.push(bonjour);
        const browse = (type: string, kind: DeviceKind) => {
          const browser = bonjour.find({ type }, (service) => this.onMdnsUp(kind, service));
          browser.on('error' as any, (e: Error) => this.log(`mDNS ${type}: ${e.message}`));
          this.browsers.push(browser);
        };
        browse('androidtvremote2', 'androidtv');
        browse('googlecast', 'cast');
        ok += 1;
      } catch (err) {
        this.log(`mDNS failed to start${iface ? ` on ${iface}` : ''}: ${(err as Error).message}`);
      }
    }
    this.status.mdns = ok ? 'listening' : 'error';
    if (ok) this.log(`mDNS: browsing _androidtvremote2._tcp and _googlecast._tcp on ${ok} interface${ok === 1 ? '' : 's'}`);
  }

  private onMdnsUp(kind: DeviceKind, service: Service): void {
    if (!service || typeof service !== 'object') return;
    const addrs = (Array.isArray(service.addresses) ? service.addresses : []).filter((a): a is string => typeof a === 'string');
    const host = addrs.find((a) => a.includes('.')) ?? addrs[0];
    if (!host) return;
    const txt = (service.txt && typeof service.txt === 'object' ? service.txt : {}) as Record<string, string>;
    const instance = typeof service.name === 'string' && service.name ? service.name : undefined;
    const name = txt.fn || instance || host;
    // Only a real instance name is an identity: two unnamed boxes must never look like one box that moved.
    const identity = kind === 'cast' ? txt.id && `cast:${txt.id}` : txt.bt ? `bt:${txt.bt}` : instance ? `name:${instance}` : undefined;
    if (!this.devices.has(`${kind}:${host}`)) this.status.found.mdns += 1;
    this.add(kind, host, name, { model: txt.md, meta: txt, port: typeof service.port === 'number' ? service.port : undefined, via: 'mDNS', identity: identity || undefined });
    // A Google TV found as Cast also has the remote service; the eureka endpoint names both.
    if (kind === 'androidtv' && !txt.md) void this.enrich(kind, host);
  }

  // ---- SSDP ----

  private startSsdp(): void {
    if (this.ssdp) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.ssdp = sock;
    sock.on('message', (msg, rinfo) => this.onSsdpResponse(msg.toString(), rinfo.address));
    sock.on('error', (err) => {
      this.status.ssdp = 'error';
      this.log(`SSDP socket error: ${err.message}`);
    });
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
        sock.setMulticastTTL(4);
      } catch {
        /* ignore */
      }
      this.status.ssdp = 'listening';
      this.sendSsdpSearch();
    });
  }

  private sendSsdpSearch(): void {
    const sock = this.ssdp;
    if (!sock) return;
    const ifaces = localInterfaces();
    const sendAll = () => {
      for (const st of SSDP_TARGETS) {
        const msg = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
        sock.send(msg, 1900, '239.255.255.250', (err) => {
          if (err) this.log(`SSDP send failed: ${err.message}`);
        });
      }
    };
    if (!ifaces.length) return sendAll();
    for (const i of ifaces) {
      try {
        sock.setMulticastInterface(i.address);
      } catch {
        /* interface may not support multicast */
      }
      sendAll();
    }
  }

  private onSsdpResponse(text: string, address: string): void {
    const headers: Record<string, string> = {};
    for (const line of text.split('\r\n').slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toUpperCase()] = line.slice(i + 1).trim();
    }
    const st = headers.ST ?? '';
    const server = headers.SERVER ?? '';
    let kind: DeviceKind | undefined;
    if (st === 'roku:ecp' || /roku/i.test(server)) kind = 'roku';
    else if (st.includes('webos-second-screen') || /webos/i.test(server)) kind = 'webos';
    else if (/samsung/i.test(server) || /samsung/i.test(st)) kind = 'samsung';
    if (!kind) return;
    const usn = /uuid:([^:\s]+)/i.exec(headers.USN ?? '')?.[1];
    if (!this.devices.has(`${kind}:${address}`)) this.status.found.ssdp += 1;
    this.add(kind, address, this.devices.get(`${kind}:${address}`)?.name ?? placeholderName(kind, address), { meta: headers, via: 'SSDP', identity: usn ? `uuid:${usn}` : undefined });
    void this.enrich(kind, address);
  }

  // ---- subnet scan ----

  async scanSubnet(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.status.scan = 'running';
    const hosts = subnetHosts();
    this.log(`subnet scan: ${hosts.length} hosts × ${PROBES.length} ports`);
    this.emit('status', this.getStatus());
    let hits = 0;
    const outcomes = new Map<string, number>();
    const started = Date.now();
    const queue = hosts.flatMap((h) => PROBES.map((p) => ({ host: h, ...p })));
    let i = 0;
    const worker = async () => {
      while (i < queue.length) {
        const job = queue[i++];
        const r = await probePort(job.host, job.port, 500);
        outcomes.set(r, (outcomes.get(r) ?? 0) + 1);
        if (r === 'open') {
          hits += 1;
          const id = `${job.kind}:${job.host}`;
          if (!this.devices.has(id)) this.status.found.scan += 1;
          this.add(job.kind, job.host, this.devices.get(id)?.name ?? placeholderName(job.kind, job.host), { via: 'scan' });
          void this.enrich(job.kind, job.host);
        }
      }
    };
    await Promise.all(Array.from({ length: 96 }, worker));
    this.scanning = false;
    this.status.scan = 'done';
    this.status.scanned = hosts.length;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const summary = [...outcomes.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
    this.log(`subnet scan finished in ${secs}s: ${hits} open port${hits === 1 ? '' : 's'} on ${hosts.length} hosts (${summary})`);
    // Every probe failing with a routing/permission errno, in under a couple of seconds, means the OS
    // refused to send the packets at all: no amount of rescanning helps until that is fixed.
    const refused = (outcomes.get('EHOSTUNREACH') ?? 0) + (outcomes.get('EPERM') ?? 0) + (outcomes.get('ENETUNREACH') ?? 0) + (outcomes.get('EACCES') ?? 0);
    if (hits === 0 && refused >= queue.length * 0.9) {
      this.status.blocked = true;
      this.log(`the operating system refused ${refused} of ${queue.length} connections: local network access is blocked for this app (${process.platform === 'darwin' ? 'macOS Privacy & Security → Local Network; a signed build is required for the toggle to work, ' : ''}VPN or firewall)`);
    } else if (hits === 0 && this.status.found.mdns + this.status.found.ssdp === 0) await this.probeGateway();
    else this.status.blocked = false;
    this.emit('status', this.getStatus());
  }

  /**
   * Self-test after an empty scan: the router almost always answers on 80, 443 or 53.
   * If it doesn't, the OS (macOS Local Network permission), a VPN or a firewall is
   * blocking LAN access and no amount of rescanning will help.
   */
  private async probeGateway(): Promise<void> {
    const gw = await defaultGateway();
    this.status.gateway = gw;
    if (!gw) {
      this.log('no default gateway found: is this computer connected to a network?');
      this.status.blocked = true;
      return;
    }
    const open = await Promise.all([80, 443, 53, 8080].map((p) => portOpen(gw, p, 1200)));
    if (open.some(Boolean)) {
      this.status.blocked = false;
      this.log(`gateway ${gw} answers; the network is reachable, the TVs just didn't respond`);
    } else {
      this.status.blocked = true;
      this.log(`gateway ${gw} did not answer on 80/443/53: local network access looks blocked (${process.platform === 'darwin' ? 'macOS Privacy & Security → Local Network, ' : ''}VPN or firewall)`);
    }
  }

  // ---- enrichment (names, models, identities, MACs from each device's own HTTP endpoints) ----

  private async enrich(kind: DeviceKind, host: string): Promise<void> {
    const key = `${kind}:${host}`;
    if (this.enriching.has(key)) return;
    this.enriching.add(key);
    try {
      if (kind === 'roku') {
        const xml = await httpGet(`http://${host}:8060/query/device-info`);
        const name = tag(xml, 'user-device-name') || tag(xml, 'friendly-device-name');
        const mac = tag(xml, 'wifi-mac') || tag(xml, 'ethernet-mac');
        const deviceId = tag(xml, 'device-id');
        if (name) this.add('roku', host, name, { model: tag(xml, 'model-name'), identity: deviceId ? `roku:${deviceId}` : undefined, mac: mac || undefined });
      } else if (kind === 'samsung') {
        const info = JSON.parse(await httpGet(`http://${host}:8001/api/v2/`));
        const d = info.device ?? {};
        if (d.name) this.add('samsung', host, d.name, { model: d.modelName, identity: d.id ? `samsung:${d.id}` : undefined, mac: d.wifiMac || undefined });
      } else if (kind === 'cast' || kind === 'androidtv') {
        const info = await eurekaInfo(host);
        if (info?.name) {
          const identity = info.ssdp_udn ? `cast:${info.ssdp_udn}` : undefined;
          this.add(kind, host, info.name, { model: info.model_name, identity });
          const other: DeviceKind = kind === 'cast' ? 'androidtv' : 'cast';
          if (this.devices.has(`${other}:${host}`)) this.add(other, host, info.name, { model: info.model_name, identity });
        }
      } else if (kind === 'webos') {
        const d = this.devices.get(key);
        const loc = d?.meta.LOCATION;
        if (loc && /^http:\/\//.test(loc)) {
          const xml = await httpGet(loc);
          const name = tag(xml, 'friendlyName');
          if (name) this.add('webos', host, name, { model: tag(xml, 'modelName') });
        }
      }
    } catch {
      /* keep placeholder name */
    } finally {
      this.enriching.delete(key);
    }
  }
}

/** Default IPv4 gateway from the OS routing table. */
export function defaultGateway(): Promise<string | undefined> {
  const run = (cmd: string, args: string[]) =>
    new Promise<string>((resolve) => execFile(cmd, args, { timeout: 3000, windowsHide: true }, (err, out) => resolve(err ? '' : String(out))));
  return (async () => {
    let out = '';
    if (process.platform === 'darwin') out = await run('route', ['-n', 'get', 'default']);
    else if (process.platform === 'win32') out = await run('route', ['print', '0.0.0.0']);
    else out = await run('ip', ['route', 'show', 'default']);
    const m = process.platform === 'win32'
      ? /0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/.exec(out)
      : /(?:gateway:|default via)\s+(\d+\.\d+\.\d+\.\d+)/.exec(out);
    if (m) return m[1];
    // Fall back to .1 on the first interface's subnet.
    const i = localInterfaces()[0];
    return i ? i.address.replace(/\.\d+$/, '.1') : undefined;
  })();
}

function placeholderName(kind: DeviceKind, host: string): string {
  const label: Record<DeviceKind, string> = { androidtv: 'Android TV', cast: 'Chromecast', roku: 'Roku', samsung: 'Samsung TV', webos: 'LG TV' };
  return `${label[kind]} (${host})`;
}

function tag(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];
}

/** Chromecast / Google TV setup info: plain HTTP on 8008 on older firmware, HTTPS 8443 on newer. */
async function eurekaInfo(host: string): Promise<{ name?: string; model_name?: string; ssdp_udn?: string } | undefined> {
  const params = 'params=name,model_name,ssdp_udn';
  for (const url of [`http://${host}:8008/setup/eureka_info?${params}`, `https://${host}:8443/setup/eureka_info?${params}`]) {
    try {
      const body = await httpGet(url);
      const json = JSON.parse(body);
      if (json && typeof json === 'object') return json;
    } catch {
      /* try the next */
    }
  }
  return undefined;
}

export function localInterfaces(): Array<{ name: string; address: string; netmask: string; cidr: number }> {
  const out: Array<{ name: string; address: string; netmask: string; cidr: number }> = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(169\.254\.|127\.)/.test(a.address)) continue;
      if (/^(utun|awdl|llw|bridge|vmnet|docker|veth|br-|tailscale|zt|tun|tap|wg)/i.test(name)) continue;
      const cidr = a.netmask.split('.').reduce((n, o) => n + ((Number(o) >>> 0).toString(2).match(/1/g)?.length ?? 0), 0);
      out.push({ name, address: a.address, netmask: a.netmask, cidr });
    }
  }
  return out;
}

/** All hosts on each local interface's subnet, capped at /22 (1022 hosts) per interface. */
export function subnetHosts(): string[] {
  const hosts = new Set<string>();
  for (const i of localInterfaces()) {
    const cidr = Math.max(i.cidr, 22);
    const ip = i.address.split('.').map(Number);
    const ipNum = ((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) >>> 0;
    const mask = cidr === 0 ? 0 : (0xffffffff << (32 - cidr)) >>> 0;
    const base = (ipNum & mask) >>> 0;
    const count = 2 ** (32 - cidr);
    for (let n = 1; n < count - 1; n++) {
      const h = (base + n) >>> 0;
      if (h === ipNum) continue;
      hosts.add(`${h >>> 24}.${(h >>> 16) & 255}.${(h >>> 8) & 255}.${h & 255}`);
    }
  }
  return [...hosts];
}

export function portOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return probePort(host, port, timeoutMs).then((r) => r === 'open');
}

/** 'open' | 'closed' (RST) | 'timeout' | an errno such as EHOSTUNREACH/EPERM (the OS refused to even try). */
export function probePort(host: string, port: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (r: string) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(r);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish('open'));
    s.once('timeout', () => finish('timeout'));
    s.once('error', (err: NodeJS.ErrnoException) => finish(err.code === 'ECONNREFUSED' ? 'closed' : err.code || 'error'));
    s.connect(port, host);
  });
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout: 3000, rejectUnauthorized: false } as http.RequestOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => ((res.statusCode ?? 500) >= 400 ? reject(new Error(`HTTP ${res.statusCode}`)) : resolve(Buffer.concat(chunks).toString())));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
