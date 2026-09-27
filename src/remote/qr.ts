import qrcode from 'qrcode-generator';

/** The QR code for `text` as rows of modules (true = dark), without the quiet zone. */
export function qrMatrix(text: string): boolean[][] {
  // M: survives a phone camera at an angle; the pairing URL stays a small code.
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

const QUIET = 2;

/**
 * The code for a terminal (`cw remote serve --pair`): two module rows per text line
 * with half blocks, black on an explicit white background so it scans on a dark or a
 * light terminal alike.
 */
export function qrTerminal(matrix: boolean[][]): string {
  const n = matrix.length + QUIET * 2;
  const dark = (r: number, c: number): boolean => matrix[r - QUIET]?.[c - QUIET] === true;
  const lines: string[] = [];
  for (let r = 0; r < n; r += 2) {
    let line = '\x1b[47m\x1b[30m';
    for (let c = 0; c < n; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(`${line}\x1b[0m`);
  }
  return `${lines.join('\n')}\n`;
}
