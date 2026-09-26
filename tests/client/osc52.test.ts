import { describe, expect, it } from 'bun:test';
import { clipboardWriteFromOsc52 } from '../../src/client/osc52.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('clipboardWriteFromOsc52', () => {
  // Claude Code copies a mouse selection by sending OSC 52; the cockpit's terminal
  // ignored it, so nothing ever reached the clipboard.
  it('decodes a write to the clipboard, UTF-8 included', () => {
    expect(clipboardWriteFromOsc52(`c;${b64('Claude Code v2.1.28')}`)).toBe('Claude Code v2.1.28');
    expect(clipboardWriteFromOsc52(`c;${b64('héllo ▐▛█ 日本')}`)).toBe('héllo ▐▛█ 日本');
    expect(clipboardWriteFromOsc52(`;${b64('default selection')}`)).toBe('default selection');
  });

  // A read request would hand the user's clipboard to whatever runs in the pane.
  it('never answers a clipboard read', () => {
    expect(clipboardWriteFromOsc52('c;?')).toBeUndefined();
    expect(clipboardWriteFromOsc52('?')).toBeUndefined();
  });

  it('rejects malformed and oversized payloads', () => {
    expect(clipboardWriteFromOsc52('no-separator')).toBeUndefined();
    expect(clipboardWriteFromOsc52('c;***not base64***')).toBeUndefined();
    expect(clipboardWriteFromOsc52(`c;${'A'.repeat(2 * 1024 * 1024)}`)).toBeUndefined();
  });
});
