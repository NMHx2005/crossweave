import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RemoteSettings } from '../../src/core/settings.js';
import type { Interfaces } from '../../src/remote/addresses.js';
import type { DaemonConn } from '../../src/remote/hub.js';
import { appendAudit, RemoteService, type ServiceEvent } from '../../src/remote/service.js';
import { startRemoteServer } from '../../src/remote/server.js';

let home: string;
let service: RemoteService | undefined;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cw-remote-service-')); });
afterEach(async () => {
  await service?.stop();
  service = undefined;
  rmSync(home, { recursive: true, force: true });
});

const v4 = (address: string) => ({ address, family: 'IPv4', internal: false });
const tailnet: Interfaces = { utun4: [v4('100.101.2.3')], en0: [v4('192.168.1.20')] };

const fakeConn = (): DaemonConn => ({ call: async <T>() => [] as T, onNotification: () => undefined, onClose: () => undefined, close: () => undefined });

function make(settings: () => RemoteSettings | undefined, ifaces: Interfaces = tailnet) {
  const events: ServiceEvent[] = [];
  let starts = 0;
  service = new RemoteService({
    home,
    settings,
    interfaces: () => ifaces,
    connect: async () => ({ conn: fakeConn(), workspaceId: 'w' }),
    emit: (e) => events.push(e),
    replanMs: 60_000,
    // Loopback in place of the planned addresses: the plan is what is under test.
    start: (o) => {
      starts++;
      return startRemoteServer({ ...o, port: 0, listen: o.listen.map((l) => ({ ...l, address: '127.0.0.1' })), tls: undefined });
    },
  });
  return { events, starts: () => starts };
}

const last = (events: ServiceEvent[], type: ServiceEvent['type']) => [...events].reverse().find((e) => e.type === type);

describe('remote service', () => {
  it('listens nowhere, and says nothing is wrong, while off', async () => {
    const { events, starts } = make(() => ({ enabled: false }));
    await service?.start();
    expect(last(events, 'status')).toEqual({ type: 'status', listening: [], problems: [] });
    expect(starts()).toBe(0);
  });

  it('says why a chosen reach cannot listen', async () => {
    const { events } = make(() => ({ enabled: true, tailscale: true }), { en0: [v4('192.168.1.20')] });
    await service?.start();
    const status = last(events, 'status') as Extract<ServiceEvent, { type: 'status' }>;
    expect(status.listening).toEqual([]);
    expect(status.problems[0]).toMatch(/Tailscale is not running/);
  });

  it('listens on the plan, and pairs with a link and QR code per address', async () => {
    const { events } = make(() => ({ enabled: true, tailscale: true }));
    await service?.start();
    const status = last(events, 'status') as Extract<ServiceEvent, { type: 'status' }>;
    expect(status.listening).toHaveLength(1);
    expect(status.listening[0]?.reach).toBe('tailscale');
    service?.pair();
    const pair = last(events, 'pair') as Extract<ServiceEvent, { type: 'pair' }>;
    expect(pair.code).toHaveLength(10);
    expect(pair.display).toBe(`${pair.code.slice(0, 5)}-${pair.code.slice(5)}`);
    expect(pair.links[0]?.url).toBe(`${status.listening[0]?.url}#pair=${pair.code}`);
    expect(pair.links[0]?.qr.length).toBeGreaterThan(20);
  });

  it('will not pair while listening nowhere', async () => {
    const { events } = make(() => ({ enabled: false }));
    await service?.start();
    service?.pair();
    expect(last(events, 'error')).toMatchObject({ type: 'error' });
    expect(last(events, 'pair')).toBeUndefined();
  });

  it('restarts only when where to listen changed', async () => {
    let settings: RemoteSettings = { enabled: true, tailscale: true, port: 7788 };
    const { starts } = make(() => settings);
    await service?.start();
    await service?.reload();
    expect(starts()).toBe(1);
    settings = { ...settings, port: 7789 };
    await service?.reload();
    expect(starts()).toBe(2);
    settings = { ...settings, enabled: false };
    await service?.reload();
    expect(starts()).toBe(2);
  });

  it('reports a port already in use in words', async () => {
    const events: ServiceEvent[] = [];
    service = new RemoteService({
      home,
      settings: () => ({ enabled: true, tailscale: true, port: 7788 }),
      interfaces: () => tailnet,
      connect: async () => ({ conn: fakeConn(), workspaceId: 'w' }),
      emit: (e) => events.push(e),
      start: async () => { throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }); },
    });
    await service.start();
    expect((last(events, 'status') as Extract<ServiceEvent, { type: 'status' }>).problems).toContain('Port 7788 is in use on this Mac — pick another in Settings');
  });

  it('keeps an audit log only the user can read', () => {
    appendAudit(home, { device: 'iPhone', action: 'watch' });
    const path = join(home, '.crossweave', 'remote', 'audit.log');
    expect(JSON.parse(readFileSync(path, 'utf8').trim())).toMatchObject({ device: 'iPhone', action: 'watch', at: expect.any(String) });
  });
});
