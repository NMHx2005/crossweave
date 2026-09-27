import { describe, expect, it } from 'bun:test';
import { qrMatrix, qrTerminal } from '../../src/remote/qr.js';

const URL_ = 'https://192.168.137.101:7788/#pair=ABCDEFGHJK';

describe('QR codes', () => {
  it('is a square of a QR size with the three finder patterns', () => {
    const m = qrMatrix(URL_);
    const n = m.length;
    expect((n - 21) % 4).toBe(0);
    for (const row of m) expect(row).toHaveLength(n);
    // A finder: a dark 7x7 ring, a light ring inside, a dark 3x3 centre.
    const finder = (r0: number, c0: number) => {
      for (let i = 0; i < 7; i++) {
        expect(m[r0]?.[c0 + i]).toBe(true);
        expect(m[r0 + 6]?.[c0 + i]).toBe(true);
        expect(m[r0 + i]?.[c0]).toBe(true);
        expect(m[r0 + i]?.[c0 + 6]).toBe(true);
      }
      expect(m[r0 + 1]?.[c0 + 1]).toBe(false);
      expect(m[r0 + 3]?.[c0 + 3]).toBe(true);
    };
    finder(0, 0);
    finder(0, n - 7);
    finder(n - 7, 0);
  });

  it('grows with the data and is deterministic', () => {
    expect(qrMatrix(URL_)).toEqual(qrMatrix(URL_));
    expect(qrMatrix(`${URL_}${'x'.repeat(100)}`).length).toBeGreaterThan(qrMatrix(URL_).length);
  });

  it('draws two module rows per terminal line, with a quiet zone', () => {
    const m = qrMatrix(URL_);
    const lines = qrTerminal(m).trimEnd().split('\n');
    expect(lines).toHaveLength(Math.ceil((m.length + 4) / 2));
    const visible = (lines[0] as string).replace(/\x1b\[[0-9;]*m/g, '');
    expect(visible).toHaveLength(m.length + 4);
    expect(visible.startsWith('  ')).toBe(true);
  });
});
