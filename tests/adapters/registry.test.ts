import { describe, it, expect } from 'bun:test';
import { createAdapter } from '../../src/adapters/registry.js';

describe('createAdapter', () => {
  it('returns the claude adapter, unaffected by cursor support', () => {
    const a = createAdapter('claude');
    expect(a.kind).toBe('claude');
    expect(a.enforcementTier).toBe('T2');
  });

  it('returns a cursor adapter with T1 when deps are provided', () => {
    const a = createAdapter('cursor', {
      resolveWorkspaceId: () => 'ws_1',
      decideBlocked: () => ({ collisions: [], blocked: false }),
      recordUsage: () => {},
      notify: () => {},
    });
    expect(a.kind).toBe('cursor');
    expect(a.enforcementTier).toBe('T1');
  });

  it('throws ADAPTER_DEPS_MISSING for cursor with no deps', () => {
    expect(() => createAdapter('cursor')).toThrowError(
      expect.objectContaining({ code: 'ADAPTER_DEPS_MISSING' }) as unknown as Error,
    );
  });

  it('returns the cursor-print adapter with T3, no deps required', () => {
    const a = createAdapter('cursor-print');
    expect(a.kind).toBe('cursor-print');
    expect(a.enforcementTier).toBe('T3');
  });

  it('throws UNKNOWN_AGENT for an unsupported kind', () => {
    expect(() => createAdapter('bogus')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_AGENT' }) as unknown as Error,
    );
  });
});
