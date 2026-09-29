import { describe, expect, it } from 'bun:test';
import { parseSignal } from '../../src/daemon/signal.js';

const codeOf = (fn: () => unknown): string => { try { fn(); return 'ok'; } catch (e) { return (e as { code?: string }).code ?? 'no-code'; } };

describe('parseSignal', () => {
  it('defaults to a done signal with an empty message', () => {
    expect(parseSignal({})).toEqual({ kind: 'done', message: '' });
  });

  it('takes the two kinds, and only those', () => {
    expect(parseSignal({ kind: 'ask', message: 'which branch?' })).toEqual({ kind: 'ask', message: 'which branch?' });
    expect(codeOf(() => parseSignal({ kind: 'run' }))).toBe('INVALID_PARAMS');
    expect(codeOf(() => parseSignal({ kind: 5 }))).toBe('INVALID_PARAMS');
  });

  it('turns control characters and newlines into spaces: the message is one displayable line', () => {
    expect(parseSignal({ message: 'a\nb\x1b[31mc\x07d\t e' }).message).toBe('a b [31mc d  e');
  });

  it('refuses a message that is not text or is over 200 characters, rather than cutting it', () => {
    expect(parseSignal({ message: 'x'.repeat(200) }).message).toHaveLength(200);
    expect(codeOf(() => parseSignal({ message: 'x'.repeat(201) }))).toBe('INVALID_PARAMS');
    expect(codeOf(() => parseSignal({ message: 42 }))).toBe('INVALID_PARAMS');
  });

  it('trims the ends', () => {
    expect(parseSignal({ message: '   done   ' }).message).toBe('done');
  });
});
