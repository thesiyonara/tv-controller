/**
 * Wake-on-LAN and MAC lookup.
 *
 * Samsung ("Power On with Mobile") and LG ("Mobile TV On" / QuickStart+) TVs
 * can be woken by a magic packet. We learn a device's MAC from the OS ARP
 * table right after we've talked to it, and remember it per device.
 */
import { execFile } from 'child_process';
import dgram from 'dgram';

const MAC_RE = /\b([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/i;

export function normalizeMac(mac: string): string | undefined {
  const m = MAC_RE.exec(mac)?.[0].replace(/-/g, ':').toLowerCase();
  if (!m || m === 'ff:ff:ff:ff:ff:ff' || m === '00:00:00:00:00:00') return undefined;
  return m;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

/** MAC for an IPv4 host from the ARP/neighbour table, or undefined if the OS doesn't know it. */
export async function lookupMac(host: string): Promise<string | undefined> {
  let out = '';
  if (process.platform === 'win32') out = await run('arp', ['-a', host]);
  else if (process.platform === 'linux') {
    out = await run('ip', ['neigh', 'show', host]);
    if (!MAC_RE.test(out)) out = await run('arp', ['-n', host]);
  } else out = await run('arp', ['-n', host]);
  const line = out.split('\n').find((l) => l.includes(host) && MAC_RE.test(l)) ?? out;
  return normalizeMac(line);
}

/**
 * Send a magic packet: to the limited broadcast address, and (if given) directly
 * to the host's last known IP, which some switches still map to the sleeping port.
 */
export async function sendMagicPacket(mac: string, host?: string): Promise<void> {
  const m = normalizeMac(mac);
  if (!m) throw new Error('No MAC address known for this device');
  const macBytes = Buffer.from(m.split(':').map((b) => parseInt(b, 16)));
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => macBytes)]);
  const targets = ['255.255.255.255', ...(host ? [host] : [])];
  const sock = dgram.createSocket('udp4');
  await new Promise<void>((resolve) => sock.bind(0, () => resolve()));
  try {
    sock.setBroadcast(true);
  } catch {
    /* ignore */
  }
  await Promise.all(
    targets.flatMap((t) => [9, 7].map((port) => new Promise<void>((resolve) => sock.send(packet, port, t, () => resolve())))),
  );
  // A couple of repeats; TVs in deep sleep sometimes miss the first one.
  for (let i = 0; i < 2; i++) {
    await new Promise((r) => setTimeout(r, 250));
    await Promise.all(targets.map((t) => new Promise<void>((resolve) => sock.send(packet, 9, t, () => resolve()))));
  }
  sock.close();
}
