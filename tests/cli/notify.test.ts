import { describe, expect, it } from 'bun:test';
import { buildNotifyRequest } from '../../src/cli/commands/notify.js';

const codeOf = (fn: () => unknown): string => { try { fn(); return 'ok'; } catch (e) { return (e as { code?: string }).code ?? 'no-code'; } };

describe('buildNotifyRequest', () => {
  it('uses this shell\'s own session and joins the words into the message', () => {
    expect(buildNotifyRequest(['tests', 'written'], {}, { CW_SESSION_ID: 's_1' })).toEqual({ idOrName: 's_1', kind: 'done', message: 'tests written' });
  });

  it('--session and --kind override', () => {
    expect(buildNotifyRequest(['q?'], { session: 'alpha', kind: 'ask' }, { CW_SESSION_ID: 's_1' })).toEqual({ idOrName: 'alpha', kind: 'ask', message: 'q?' });
  });

  it('no message is fine: done with nothing to add', () => {
    expect(buildNotifyRequest([], {}, { CW_SESSION_ID: 's_1' }).message).toBe('');
  });

  it('refuses a kind outside the two, and a call that names no session', () => {
    expect(codeOf(() => buildNotifyRequest([], { kind: 'run' }, { CW_SESSION_ID: 's_1' }))).toBe('INVALID_ARGUMENTS');
    expect(codeOf(() => buildNotifyRequest([], {}, {}))).toBe('INVALID_ARGUMENTS');
    expect(codeOf(() => buildNotifyRequest([], {}, { CW_SESSION_ID: '' }))).toBe('INVALID_ARGUMENTS');
  });
});
