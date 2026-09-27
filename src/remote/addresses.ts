import { isPrivateIPv4, isTailscaleIPv4 } from '../core/ip.js';
import type { RemoteSettings } from '../core/settings.js';

/** `os.networkInterfaces()`'s shape (family is a number on some older runtimes). */
export type Interfaces = Record<string, Array<{ address: string; family: string | number; internal: boolean }> | undefined>;

export type Reach = 'tailscale' | 'wifi';
export type Listen = { reach: Reach; address: string };

// Private addresses these interfaces carry are not the Wi-Fi a phone is on: VM and
// container bridges, VPN tunnels, AirDrop links. A phone could never reach them, and a
// bridge's address would put the server on a network the user did not pick.
const NOT_WIFI = /^(lo|bridge|vmenet|vnic|vboxnet|docker|br-|veth|virbr|utun|tun|tap|awdl|llw|anpi|ap\d|gif|stf|tailscale|zt)/;

function ipv4s(ifaces: Interfaces): Array<{ address: string; interface: string }> {
  const out: Array<{ address: string; interface: string }> = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list ?? []) {
      if (a.internal || (a.family !== 'IPv4' && a.family !== 4)) continue;
      out.push({ address: a.address, interface: name });
    }
  }
  return out;
}

/**
 * The Tailscale address: in 100.64/10 AND on a tunnel interface (`utun*` on macOS,
 * `tailscale*` on Linux). Some hotel, office and carrier networks hand out that same
 * range on the Wi-Fi itself, and serving plain HTTP there would be serving it to them.
 */
export function tailscaleAddress(ifaces: Interfaces): string | undefined {
  return ipv4s(ifaces).find((a) => isTailscaleIPv4(a.address) && /^(utun|tailscale)/.test(a.interface))?.address;
}

/** Private addresses a phone on the same network could reach, the built-in Wi-Fi first. */
export function wifiCandidates(ifaces: Interfaces): Array<{ address: string; interface: string }> {
  const rank = (name: string): number => (name === 'en0' ? 0 : /^(en|wl|eth)/.test(name) ? 1 : 2);
  return ipv4s(ifaces)
    .filter((a) => isPrivateIPv4(a.address) && !NOT_WIFI.test(a.interface))
    .sort((a, b) => rank(a.interface) - rank(b.interface) || a.interface.localeCompare(b.interface));
}

/**
 * Where the server listens, from the settings and the interfaces present now. Only
 * concrete addresses, never a wildcard. A chosen Wi-Fi address is pinned — a laptop
 * that moved to a café's network must not start serving there behind the user's
 * back — so the cockpit always saves one; without one (a hand-written settings file,
 * `cw remote serve`) the built-in Wi-Fi's current address is used.
 */
export function listenPlan(settings: RemoteSettings | undefined, ifaces: Interfaces): { listen: Listen[]; problems: string[] } {
  const listen: Listen[] = [];
  const problems: string[] = [];
  if (settings?.enabled !== true) return { listen, problems };
  if (settings.tailscale !== true && settings.wifi !== true) return { listen, problems: ['Choose Tailscale, Wi-Fi, or both'] };
  if (settings.tailscale === true) {
    const address = tailscaleAddress(ifaces);
    if (address !== undefined) listen.push({ reach: 'tailscale', address });
    else problems.push('Tailscale is not running on this Mac — install it and sign in, on the Mac and on your phone');
  }
  if (settings.wifi === true) {
    const candidates = wifiCandidates(ifaces);
    if (settings.wifiAddress !== undefined) {
      if (candidates.some((c) => c.address === settings.wifiAddress)) listen.push({ reach: 'wifi', address: settings.wifiAddress });
      else problems.push(`${settings.wifiAddress} is not an address of this Mac any more — pick the Wi-Fi address again in Settings`);
    } else if (candidates[0] !== undefined) {
      listen.push({ reach: 'wifi', address: candidates[0].address });
    } else {
      problems.push('This Mac is not on a Wi-Fi or local network');
    }
  }
  return { listen, problems };
}
