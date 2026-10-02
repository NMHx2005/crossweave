import { describe, it, expect } from 'bun:test';
import { redactSecrets } from '../../src/core/redact-secrets.js';

/**
 * The debug bundle (`cw debug`, the Debug tab, "Send to session") is text the person
 * may paste to an AI anywhere — secrets in logs must not ride along by accident.
 * Heuristic on purpose: labelled as such everywhere it is shown; `--raw` is the
 * user's explicit opt-out. These tests pin what the patterns catch and, as important,
 * what they leave alone.
 */

describe('redactSecrets', () => {
  it('blanks the well-known token shapes', () => {
    expect(redactSecrets('key=AKIAIOSFODNN7EXAMPLE')).toContain('[redacted-aws-key]');
    expect(redactSecrets('push with ghp_0123456789abcdefghijklmnopqrstuvwxyz')).toContain('[redacted-github-token]');
    expect(redactSecrets('OPENAI_API_KEY=sk-proj-0123456789abcdefghij')).toContain('[redacted-api-key]');
  });

  it('blanks bearer headers and URL credentials', () => {
    expect(redactSecrets('Authorization: Bearer eyJhbGciOi.eyJzdWIiOiJIUzI1NiJ9.sig')).toContain('Bearer [redacted]');
    expect(redactSecrets('https://user:s3cret@registry.example.com/pkg')).toBe('https://[redacted]@registry.example.com/pkg');
  });

  it('blanks a PEM private key block whole', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ\nmore\n-----END RSA PRIVATE KEY-----\n';
    expect(redactSecrets(pem)).toContain('[redacted-private-key]');
    expect(redactSecrets(pem)).not.toContain('MIIEow');
  });

  it('blanks key=value pairs whose key names a secret', () => {
    expect(redactSecrets('auth_token: "abc123secretvalue"')).toContain('[redacted]');
    expect(redactSecrets('DB_PASSWORD=hunter2z')).toContain('[redacted]');
  });

  it('leaves ordinary lines alone — no false redaction of code or paths', () => {
    const plain = 'src/auth/login.ts:42: expect(user).toEqual(saved)\nerror: build failed in src/index.ts\n';
    expect(redactSecrets(plain)).toBe(plain);
    expect(redactSecrets('tokens = 42')).toBe('tokens = 42');
  });

  it('an empty string stays empty', () => {
    expect(redactSecrets('')).toBe('');
  });
});
