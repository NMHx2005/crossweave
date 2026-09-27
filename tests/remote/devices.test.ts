import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDevice, devicesPath, devicesStamp, listDevices, removeDevice, touchDevice, verifyDevice } from '../../src/remote/devices.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cw-devices-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const at = (iso: string) => () => new Date(iso);

describe('paired devices', () => {
  it('issues a token once and keeps only its hash, in a file only the user can read', () => {
    const { device, token } = addDevice('Hùng’s iPhone', { home, now: at('2026-09-27T10:00:00Z') });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(device).toEqual({ id: expect.any(String), name: 'Hùng’s iPhone', createdAt: '2026-09-27T10:00:00.000Z', lastSeenAt: null });
    const raw = readFileSync(devicesPath(home), 'utf8');
    expect(raw).not.toContain(token);
    expect(statSync(devicesPath(home)).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.crossweave', 'remote')).mode & 0o777).toBe(0o700);
    expect(listDevices(home)).toEqual([device]);
  });

  it('knows a device by its token, and nothing else', () => {
    const a = addDevice('A', { home });
    const b = addDevice('B', { home });
    expect(verifyDevice(a.token, home)?.id).toBe(a.device.id);
    expect(verifyDevice(b.token, home)?.id).toBe(b.device.id);
    for (const bad of [undefined, null, 12, '', 'x'.repeat(43), `${a.token}x`, a.token.slice(1), { token: a.token }]) {
      expect(verifyDevice(bad, home)).toBeUndefined();
    }
  });

  it('forgets a removed device at once', () => {
    const a = addDevice('A', { home });
    expect(removeDevice(a.device.id, home)).toBe(true);
    expect(verifyDevice(a.token, home)).toBeUndefined();
    expect(removeDevice(a.device.id, home)).toBe(false);
  });

  it('cleans a name it will show in Settings', () => {
    expect(addDevice('  My\u0000 \u001b[31mphone\n  ', { home }).device.name).toBe('My [31mphone');
    expect(addDevice('   ', { home }).device.name).toBe('Phone');
    expect(addDevice('x'.repeat(100), { home }).device.name).toHaveLength(40);
  });

  it('refuses a 21st device', () => {
    for (let i = 0; i < 20; i++) addDevice(`d${i}`, { home });
    expect(() => addDevice('one more', { home })).toThrow(/Remove a device/);
  });

  it('records when a device was last seen, at most once a minute', () => {
    const { device } = addDevice('A', { home });
    touchDevice(device.id, new Date('2026-09-27T10:00:00Z'), home);
    touchDevice(device.id, new Date('2026-09-27T10:00:30Z'), home);
    expect(listDevices(home)[0]?.lastSeenAt).toBe('2026-09-27T10:00:00.000Z');
    touchDevice(device.id, new Date('2026-09-27T10:01:01Z'), home);
    expect(listDevices(home)[0]?.lastSeenAt).toBe('2026-09-27T10:01:01.000Z');
  });

  it('records last-seen without rewriting the device list, so a removal is never undone', () => {
    const { device } = addDevice('A', { home });
    const stamp = devicesStamp(home);
    touchDevice(device.id, new Date('2026-09-27T10:00:00Z'), home);
    expect(devicesStamp(home)).toBe(stamp);
    expect(listDevices(home)[0]?.lastSeenAt).toBe('2026-09-27T10:00:00.000Z');
    removeDevice(device.id, home);
    touchDevice(device.id, new Date('2026-09-27T11:00:00Z'), home);
    expect(listDevices(home)).toEqual([]);
    expect(statSync(join(home, '.crossweave', 'remote', 'seen.json')).mode & 0o777).toBe(0o600);
  });

  it('changes its stamp when the file changes', () => {
    expect(devicesStamp(home)).toBe('none');
    const { device } = addDevice('A', { home });
    const first = devicesStamp(home);
    expect(first).not.toBe('none');
    removeDevice(device.id, home);
    expect(devicesStamp(home)).not.toBe(first);
  });

  it('treats a corrupt file as no devices (fails closed)', () => {
    addDevice('A', { home });
    writeFileSync(devicesPath(home), '{ nope');
    expect(listDevices(home)).toEqual([]);
    expect(verifyDevice('x'.repeat(43), home)).toBeUndefined();
  });
});
