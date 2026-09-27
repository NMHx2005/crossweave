import { describe, expect, it } from 'bun:test';
import { listenPlan, tailscaleAddress, wifiCandidates, type Interfaces } from '../../src/remote/addresses.js';

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal });

// Shaped like this Mac's: Wi-Fi on en0, a VM bridge, Tailscale on a utun.
const mac: Interfaces = {
  lo0: [v4('127.0.0.1', true)],
  en0: [{ address: 'fe80::1', family: 'IPv6', internal: false }, v4('192.168.137.101')],
  bridge100: [v4('192.168.139.3')],
  utun4: [v4('100.101.2.3')],
  en5: [v4('10.0.0.8')],
};

describe('addresses', () => {
  it('finds the Tailscale address', () => {
    expect(tailscaleAddress(mac)).toBe('100.101.2.3');
    expect(tailscaleAddress({ en0: [v4('192.168.1.2')] })).toBeUndefined();
  });

  it('never takes a 100.64/10 address a Wi-Fi handed out for Tailscale', () => {
    expect(tailscaleAddress({ en0: [v4('100.70.1.2')] })).toBeUndefined();
    expect(tailscaleAddress({ en0: [v4('100.70.1.2')], utun4: [v4('100.101.2.3')] })).toBe('100.101.2.3');
    expect(tailscaleAddress({ tailscale0: [v4('100.101.2.3')] })).toBe('100.101.2.3');
  });

  it('offers private addresses with en0 first, never a VM bridge, loopback or tunnel', () => {
    expect(wifiCandidates(mac)).toEqual([
      { address: '192.168.137.101', interface: 'en0' },
      { address: '10.0.0.8', interface: 'en5' },
    ]);
  });

  it('accepts the numeric family older runtimes report', () => {
    expect(wifiCandidates({ en0: [{ address: '192.168.1.2', family: 4, internal: false }] })).toEqual([{ address: '192.168.1.2', interface: 'en0' }]);
  });

  it('plans one listener per reach that is on and present', () => {
    expect(listenPlan({ enabled: true, tailscale: true, wifi: true }, mac)).toEqual({
      listen: [{ reach: 'tailscale', address: '100.101.2.3' }, { reach: 'wifi', address: '192.168.137.101' }],
      problems: [],
    });
  });

  it('uses the chosen Wi-Fi address, and refuses to fall back when it is gone', () => {
    expect(listenPlan({ enabled: true, wifi: true, wifiAddress: '10.0.0.8' }, mac).listen).toEqual([{ reach: 'wifi', address: '10.0.0.8' }]);
    const gone = listenPlan({ enabled: true, wifi: true, wifiAddress: '10.9.9.9' }, mac);
    expect(gone.listen).toEqual([]);
    expect(gone.problems[0]).toMatch(/10\.9\.9\.9/);
  });

  it('says why a reach that is on cannot listen', () => {
    const none = listenPlan({ enabled: true, tailscale: true, wifi: true }, { lo0: [v4('127.0.0.1', true)] });
    expect(none.listen).toEqual([]);
    expect(none.problems).toHaveLength(2);
    expect(none.problems[0]).toMatch(/Tailscale/);
  });

  it('listens nowhere while off, or with no reach chosen', () => {
    expect(listenPlan({ enabled: false, tailscale: true, wifi: true }, mac)).toEqual({ listen: [], problems: [] });
    expect(listenPlan({ enabled: true }, mac)).toEqual({ listen: [], problems: ['Choose Tailscale, Wi-Fi, or both'] });
    expect(listenPlan(undefined, mac)).toEqual({ listen: [], problems: [] });
  });
});
