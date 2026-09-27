import { describe, expect, it } from 'bun:test';
import {
  closeMessage, createRpc, fitFontSize, formatTokens, guessDeviceName, KEYS, pairCodeFromHash, sessionState, sessionTitle, store, usageLabel,
} from '../../src/remote/web/app.js';

describe('phone page helpers', () => {
  it('reads the pairing code from the fragment only, and only if it looks like one', () => {
    expect(pairCodeFromHash('#pair=ABCDE-FGHJK')).toBe('ABCDE-FGHJK');
    expect(pairCodeFromHash('')).toBe('');
    expect(pairCodeFromHash('#pair=<script>')).toBe('');
    expect(pairCodeFromHash('#other=1')).toBe('');
  });

  it('guesses a device name from the user agent', () => {
    expect(guessDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone');
    expect(guessDeviceName('Mozilla/5.0 (Linux; Android 15)')).toBe('Android phone');
    expect(guessDeviceName('curl/8')).toBe('Phone');
  });

  it('explains every close code the server uses, and unpairs only when told to', () => {
    expect(closeMessage(4003)).toMatchObject({ unpair: true, retry: false });
    expect(closeMessage(4000)).toMatchObject({ unpair: false, retry: true });
    expect(closeMessage(4029).text).toMatch(/Too many/);
    expect(closeMessage(1008)).toMatchObject({ retry: false });
    expect(closeMessage(1006)).toMatchObject({ retry: true, unpair: false });
  });

  it('titles a row by note, then the agent’s last words, then the name', () => {
    expect(sessionTitle({ id: 's', name: 'auth', note: 'fix login', latestWords: 'Done.' })).toBe('fix login');
    expect(sessionTitle({ id: 's', name: 'auth', latestWords: 'Done.' })).toBe('Done.');
    expect(sessionTitle({ id: 's', name: 'auth' })).toBe('auth');
  });

  it('says "Needs you" only when the agent rang, like the cockpit', () => {
    expect(sessionState({ id: 's', name: 'a', status: 'running', activity: 'asked', rang: true })).toEqual({ tone: 'asked', label: 'Needs you' });
    expect(sessionState({ id: 's', name: 'a', status: 'running', activity: 'asked', rang: false })).toEqual({ tone: 'ready', label: 'Done' });
    expect(sessionState({ id: 's', name: 'a', status: 'running', activity: 'working' }).tone).toBe('working');
    expect(sessionState({ id: 's', name: 'a', status: 'idle' })).toEqual({ tone: 'stopped', label: 'Stopped' });
  });

  it('formats token counts', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(514_000)).toBe('514k');
    expect(formatTokens(2_300_000)).toBe('2.3M');
    expect(usageLabel({ id: 's', name: 'a', usage: { input: 1000, output: 500, cacheWrite: 0, cacheRead: 0 } })).toBe('1.5k tokens');
    expect(usageLabel({ id: 's', name: 'a' })).toBeUndefined();
  });

  it('fits the session’s columns to the screen, within legible bounds', () => {
    expect(fitFontSize(390, 80)).toBe(8);
    expect(fitFontSize(390, 200)).toBe(5);
    expect(fitFontSize(2000, 80)).toBe(14);
    expect(fitFontSize(0, 80)).toBe(12);
  });

  it('types what a terminal would for each quick key', () => {
    expect(KEYS.enter?.data).toBe('\r');
    expect(KEYS.esc?.data).toBe('\x1b');
    expect(KEYS.ctrlc?.data).toBe('\x03');
    expect(KEYS.up?.data).toBe('\x1b[A');
  });

  it('matches replies by id and hands pushes over', async () => {
    const sent: string[] = [];
    const pushes: string[] = [];
    const rpc = createRpc((t) => sent.push(t), (m) => pushes.push(m));
    const a = rpc.call<number>('projects');
    const b = rpc.call('sessions', { project: '/r' });
    const [fa, fb] = sent.map((s) => JSON.parse(s));
    rpc.receive(JSON.stringify({ id: fb.id, error: { code: 'PROJECT_NOT_OPEN', message: 'closed' } }));
    rpc.receive(JSON.stringify({ id: fa.id, result: 1 }));
    rpc.receive(JSON.stringify({ method: 'changed', params: { project: '/r' } }));
    rpc.receive('not json');
    expect(await a).toBe(1);
    await expect(b).rejects.toMatchObject({ code: 'PROJECT_NOT_OPEN', message: 'closed' });
    expect(pushes).toEqual(['changed']);
    const c = rpc.call('x');
    rpc.failAll('gone');
    await expect(c).rejects.toThrow('gone');
  });

  it('survives storage that throws or is missing', () => {
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect(store(throwing).get('k')).toBeUndefined();
    expect(() => store(throwing).set('k', 'v')).not.toThrow();
    expect(store(undefined).get('k')).toBeUndefined();
  });
});
