import { randomBytes } from 'node:crypto';

type IdPrefix = 'ws' | 's' | 'ev' | 'msg' | 'lease';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastMs = 0;
let counter = 0;

function encode(value: number, length: number): string {
  let n = value;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out = ALPHABET[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

export function newId(prefix: IdPrefix): string {
  const now = Date.now();
  if (now === lastMs) {
    counter += 1;
  } else {
    lastMs = now;
    counter = 0;
  }
  const rand = [...randomBytes(5)].map((b) => ALPHABET[b % 32]).join('');
  return `${prefix}_${encode(now, 10)}${encode(counter, 4)}${rand}`;
}
