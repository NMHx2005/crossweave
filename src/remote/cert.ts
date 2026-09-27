import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate, createPrivateKey, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseIPv4 } from '../core/ip.js';
import { remoteDir } from './devices.js';

/**
 * The Wi-Fi reach's HTTPS certificate, made on this Mac: a small local CA and a leaf
 * for the one address the server listens on, like mkcert does. Node can sign but not
 * build a certificate, so this writes the DER itself (only the handful of structures
 * X.509 v3 needs) rather than shelling out to openssl or adding a dependency.
 *
 * The phone warns once — the CA is nobody's but this Mac's — unless the user installs
 * the CA from the page (`/ca.cer`). Apple's rules for a leaf a user-trusted CA signs
 * are honoured: a SAN, serverAuth, ECDSA P-256, and at most 397 days.
 */

// ── DER ────────────────────────────────────────────────────────────────────────

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, content: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), len(content.length), content]);
const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const explicit = (n: number, content: Buffer): Buffer => tlv(0xa0 + n, content);
const octets = (b: Buffer): Buffer => tlv(0x04, b);
const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'));
const bits = (b: Buffer, unused = 0): Buffer => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));

function integer(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const trimmed = b.subarray(i);
  return tlv(0x02, (trimmed[0] as number) & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number) as [number, number, ...number[]];
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk: number[] = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function time(d: Date): Buffer {
  const digits = d.toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  // RFC 5280: UTCTime through 2049, GeneralizedTime from 2050.
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${digits}Z`));
}

const OID = {
  ecdsaSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  subjectKeyId: '2.5.29.14',
  authorityKeyId: '2.5.29.35',
  nameConstraints: '2.5.29.30',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

/**
 * What the local CA may vouch for: no real DNS name (only `*.invalid`), so a user who
 * trusts it on the phone does not thereby let whoever reads `ca.key` intercept the
 * sites the phone visits. IP ranges are deliberately not constrained: BoringSSL (Bun's
 * TLS) refuses a chain whose CA carries iPAddress constraints ("unsupported name
 * constraint type"), and a phone that did the same could never pair.
 */
const CA_CONSTRAINTS = seq(tlv(0xa0, seq(tlv(0x82, Buffer.from('invalid', 'ascii')))));
/** DER of the nameConstraints OID, to recognise a CA made before it had them. */
const NAME_CONSTRAINTS_OID = oid('2.5.29.30');

const dn = (cn: string): Buffer => seq(
  set(seq(oid(OID.organization), utf8('crossweave'))),
  set(seq(oid(OID.commonName), utf8(cn))),
);
const extension = (id: string, critical: boolean, value: Buffer): Buffer =>
  seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

function serial(): Buffer {
  const b = randomBytes(16);
  b[0] = ((b[0] as number) & 0x7f) | 0x01; // positive and never zero
  return b;
}

type Issue = {
  subject: string;
  publicKey: KeyObject;
  /** The CA's name and key id, or 'self' for the CA itself. */
  issuer: { name: string; keyId: Buffer } | 'self';
  signingKey: KeyObject;
  notBefore: Date;
  notAfter: Date;
  ca: boolean;
  ip?: string;
};

function keyId(publicKey: KeyObject): Buffer {
  return createHash('sha1').update(publicKey.export({ type: 'spki', format: 'der' })).digest();
}

function certificate(o: Issue): string {
  const spki = o.publicKey.export({ type: 'spki', format: 'der' });
  const ownId = keyId(o.publicKey);
  const issuerName = o.issuer === 'self' ? o.subject : o.issuer.name;
  const authorityId = o.issuer === 'self' ? ownId : o.issuer.keyId;
  const exts: Buffer[] = [
    // pathLen 0: this CA signs leaves only, never another CA.
    extension(OID.basicConstraints, true, o.ca ? seq(bool(true), integer(Buffer.from([0]))) : seq()),
    // keyCertSign + cRLSign (0x06, one unused bit) for the CA; digitalSignature (0x80, seven) for the leaf.
    extension(OID.keyUsage, true, o.ca ? bits(Buffer.from([0x06]), 1) : bits(Buffer.from([0x80]), 7)),
    extension(OID.subjectKeyId, false, octets(ownId)),
    extension(OID.authorityKeyId, false, seq(tlv(0x80, authorityId))),
  ];
  if (o.ca) exts.push(extension(OID.nameConstraints, true, CA_CONSTRAINTS));
  if (!o.ca) {
    exts.push(extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))));
    const ip = parseIPv4(o.ip ?? '');
    if (ip === undefined) throw new Error('a leaf needs an IPv4 address');
    exts.push(extension(OID.subjectAltName, false, seq(tlv(0x87, Buffer.from(ip)))));
  }
  const algorithm = seq(oid(OID.ecdsaSha256));
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(serial()),
    algorithm,
    dn(issuerName),
    seq(time(o.notBefore), time(o.notAfter)),
    dn(o.subject),
    spki,
    explicit(3, seq(...exts)),
  );
  const signature = sign('sha256', tbs, { key: o.signingKey, dsaEncoding: 'der' });
  const der = seq(tbs, algorithm, bits(signature));
  const body = der.toString('base64').replace(/.{64}/g, '$&\n').replace(/\n?$/, '\n');
  return `-----BEGIN CERTIFICATE-----\n${body}-----END CERTIFICATE-----\n`;
}

// ── Files ──────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const CA_DAYS = 3650;
const LEAF_DAYS = 397;
/** Re-issued this long before it lapses, so a phone never meets an expired certificate. */
const RENEW_BEFORE = 30 * DAY;
/** Backdated, so a phone whose clock runs a little behind still accepts a new one. */
const SKEW = 3_600_000;
const CA_NAME = 'crossweave local CA';

export type TlsMaterial = { cert: string; key: string; ca: string; caDer: Buffer; caFingerprint: string };

export function tlsDir(home?: string): string {
  return join(remoteDir(home), 'tls');
}

function writePrivate(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function read(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

function parse(pem: string | undefined): X509Certificate | undefined {
  if (pem === undefined) return undefined;
  try {
    return new X509Certificate(pem);
  } catch {
    return undefined;
  }
}

function fresh(cert: X509Certificate, now: number): boolean {
  return Date.parse(cert.validFrom) <= now && Date.parse(cert.validTo) - RENEW_BEFORE > now;
}

/**
 * The certificate and key to serve `address` with, made or re-made as needed: a CA
 * that is missing, damaged or near its end is replaced (and with it the leaf); a leaf
 * is re-issued when it names another address, was signed by another CA, or nears
 * expiry.
 */
export function ensureTls(address: string, opts: { home?: string; now?: () => Date } = {}): TlsMaterial {
  const now = (opts.now?.() ?? new Date()).getTime();
  const dir = tlsDir(opts.home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const paths = { caKey: join(dir, 'ca.key'), ca: join(dir, 'ca.crt'), key: join(dir, 'server.key'), cert: join(dir, 'server.crt') };

  let caPem = read(paths.ca);
  let caKeyPem = read(paths.caKey);
  let caCert = caKeyPem === undefined ? undefined : parse(caPem);
  if (caCert === undefined || !caCert.ca || !fresh(caCert, now) || !caCert.raw.includes(NAME_CONSTRAINTS_OID)) {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    caPem = certificate({
      subject: CA_NAME, publicKey, issuer: 'self', signingKey: privateKey, ca: true,
      notBefore: new Date(now - SKEW), notAfter: new Date(now + CA_DAYS * DAY),
    });
    caKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    writePrivate(paths.caKey, caKeyPem);
    writePrivate(paths.ca, caPem);
    caCert = new X509Certificate(caPem);
  }
  const caKey = createPrivateKey(caKeyPem as string);

  let certPem = read(paths.cert);
  let keyPem = read(paths.key);
  const leaf = keyPem === undefined ? undefined : parse(certPem);
  // Boolean(): Bun's checkIssued returns the issuer, not true.
  const usable = leaf !== undefined && fresh(leaf, now) && Boolean(leaf.checkIssued(caCert)) && leaf.verify(caCert.publicKey)
    && leaf.checkIP(address) !== undefined;
  if (!usable) {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    certPem = certificate({
      subject: `crossweave ${address}`, publicKey, ip: address, ca: false, signingKey: caKey,
      issuer: { name: CA_NAME, keyId: keyId(caCert.publicKey) },
      notBefore: new Date(now - SKEW), notAfter: new Date(now + LEAF_DAYS * DAY),
    });
    keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    writePrivate(paths.key, keyPem);
    writePrivate(paths.cert, certPem);
  }
  return {
    cert: certPem as string,
    key: keyPem as string,
    ca: caPem as string,
    caDer: caCert.raw,
    caFingerprint: caCert.fingerprint256,
  };
}
