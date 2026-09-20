import { describe, it, expect } from 'bun:test';
import { validateGatewayServerOptions } from '../../src/gateway/server.js';

describe('gateway TLS gating', () => {
  it('allows loopback without TLS', () => {
    expect(() => validateGatewayServerOptions({ socketPath: '/tmp/fake.sock', port: 8787, host: '127.0.0.1' })).not.toThrow();
    expect(() => validateGatewayServerOptions({ socketPath: '/tmp/fake.sock', port: 8787, host: 'localhost' })).not.toThrow();
  });
  it('rejects non-loopback without TLS unless allowInsecure', () => {
    expect(() => validateGatewayServerOptions({ socketPath: '/tmp/fake.sock', port: 8787, host: '0.0.0.0' })).toThrow(/allow-insecure/);
    expect(() => validateGatewayServerOptions({ socketPath: '/tmp/fake.sock', port: 8787, host: '0.0.0.0', allowInsecure: true })).not.toThrow();
  });
  it('requires both cert and key', () => {
    expect(() => validateGatewayServerOptions({ socketPath: '/tmp/fake.sock', port: 8787, host: '0.0.0.0', cert: '/tmp/cert' } as unknown as { socketPath: string; port: number; host: string; cert: string })).toThrow(/Both --cert and --key/);
  });
});
