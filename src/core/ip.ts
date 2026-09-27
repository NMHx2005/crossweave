/**
 * IPv4 literals the remote server may bind to. Kept strict on purpose: a value here
 * becomes a listen address, so anything that is not four decimal octets is refused
 * rather than handed to the resolver.
 */

export function parseIPv4(value: string): [number, number, number, number] | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((p) => (/^(0|[1-9][0-9]{0,2})$/.test(p) ? Number(p) : Number.NaN));
  if (octets.some((o) => !(o >= 0 && o <= 255))) return undefined;
  return octets as [number, number, number, number];
}

/** RFC 1918: the addresses a home or office Wi-Fi hands out. */
export function isPrivateIPv4(value: string): boolean {
  const o = parseIPv4(value);
  if (o === undefined) return false;
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
}

/** 100.64.0.0/10, the shared range Tailscale assigns its devices from. */
export function isTailscaleIPv4(value: string): boolean {
  const o = parseIPv4(value);
  return o !== undefined && o[0] === 100 && o[1] >= 64 && o[1] <= 127;
}
