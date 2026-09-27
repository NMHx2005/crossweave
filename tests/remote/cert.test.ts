import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { createServer, request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { ensureTls, tlsDir } from '../../src/remote/cert.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cw-cert-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const DAY = 86_400_000;
const at = (ms: number) => () => new Date(ms);
const T0 = Date.parse('2026-09-27T10:00:00Z');

describe('local TLS certificates', () => {
  it('issues a CA and a leaf for the address, as Apple requires of a leaf', () => {
    const tls = ensureTls('192.168.1.20', { home, now: at(T0) });
    const ca = new X509Certificate(tls.ca);
    const leaf = new X509Certificate(tls.cert);
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(Boolean(leaf.checkIssued(ca))).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(ca.verify(ca.publicKey)).toBe(true);
    expect(leaf.checkIP('192.168.1.20')).toBe('192.168.1.20');
    expect(leaf.checkIP('192.168.1.21')).toBeUndefined();
    expect(leaf.subjectAltName).toContain('IP Address:192.168.1.20');
    expect(leaf.keyUsage).toContain('1.3.6.1.5.5.7.3.1');
    const days = (Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)) / DAY;
    expect(days).toBeLessThanOrEqual(398);
    expect(Date.parse(leaf.validFrom)).toBeLessThanOrEqual(T0);
    expect(tls.caFingerprint).toBe(ca.fingerprint256);
    expect(tls.caDer.equals(ca.raw)).toBe(true);
  });

  it('keeps its files readable by the user only', () => {
    ensureTls('192.168.1.20', { home, now: at(T0) });
    const dir = tlsDir(home);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const f of ['ca.key', 'server.key', 'ca.crt', 'server.crt']) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
  });

  it('reuses what it made, re-issuing the leaf only for a new address or near expiry', () => {
    const first = ensureTls('192.168.1.20', { home, now: at(T0) });
    const again = ensureTls('192.168.1.20', { home, now: at(T0 + DAY) });
    expect(again.cert).toBe(first.cert);
    expect(again.ca).toBe(first.ca);
    const moved = ensureTls('10.0.0.5', { home, now: at(T0 + DAY) });
    expect(moved.cert).not.toBe(first.cert);
    expect(moved.ca).toBe(first.ca);
    const late = ensureTls('10.0.0.5', { home, now: at(T0 + 380 * DAY) });
    expect(late.cert).not.toBe(moved.cert);
    expect(late.ca).toBe(first.ca);
  });

  it('replaces a damaged CA, and the leaf with it', () => {
    const first = ensureTls('192.168.1.20', { home, now: at(T0) });
    writeFileSync(join(tlsDir(home), 'ca.crt'), 'garbage');
    const next = ensureTls('192.168.1.20', { home, now: at(T0) });
    expect(next.ca).not.toBe(first.ca);
    const leaf = new X509Certificate(next.cert);
    expect(Boolean(leaf.checkIssued(new X509Certificate(next.ca)))).toBe(true);
    expect(Boolean(leaf.checkIssued(new X509Certificate(first.ca)))).toBe(false);
    expect(readFileSync(join(tlsDir(home), 'ca.crt'), 'utf8')).toBe(next.ca);
  });

  it('completes a real TLS handshake that trusts only the local CA', async () => {
    const tls = ensureTls('127.0.0.1', { home });
    const server = createServer({ cert: tls.cert, key: tls.key }, (_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        request({ host: '127.0.0.1', port, path: '/', ca: tls.ca }, (res) => {
          let b = '';
          res.on('data', (c) => { b += c; });
          res.on('end', () => resolve(b));
        }).on('error', reject).end();
      });
      expect(body).toBe('ok');
      const untrusted = await new Promise<string>((resolve) => {
        request({ host: '127.0.0.1', port, path: '/' }, () => resolve('trusted'))
          .on('error', (e) => resolve(String((e as NodeJS.ErrnoException).code ?? e.message))).end();
      });
      expect(untrusted).not.toBe('trusted');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
