import { describe, expect, it } from 'bun:test';
import { isPrivateIPv4, isTailscaleIPv4, parseIPv4 } from '../../src/core/ip.js';

describe('IPv4 literals', () => {
  it('parses four decimal octets and nothing else', () => {
    expect(parseIPv4('192.168.1.20')).toEqual([192, 168, 1, 20]);
    for (const bad of ['192.168.1', '192.168.1.256', '192.168.01.2', '0x7f.0.0.1', ' 10.0.0.1', '10.0.0.1 ', 'a.b.c.d', '', '1.2.3.4.5']) {
      expect(parseIPv4(bad)).toBeUndefined();
    }
  });

  it('knows the private ranges, edges included', () => {
    for (const ok of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.0.1']) expect(isPrivateIPv4(ok)).toBe(true);
    for (const no of ['172.15.0.1', '172.32.0.1', '192.169.0.1', '8.8.8.8', '0.0.0.0', '127.0.0.1', '100.64.0.1']) expect(isPrivateIPv4(no)).toBe(false);
  });

  it('knows the Tailscale range (100.64.0.0/10), edges included', () => {
    for (const ok of ['100.64.0.1', '100.127.255.254', '100.101.2.3']) expect(isTailscaleIPv4(ok)).toBe(true);
    for (const no of ['100.63.255.255', '100.128.0.1', '10.0.0.1']) expect(isTailscaleIPv4(no)).toBe(false);
  });
});
