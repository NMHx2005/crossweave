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

describe('createAdapter from the agent catalog', () => {
  const settings = (over: Partial<import('../../src/core/settings.js').AgentDef>[] = []) => {
    const { BUILTIN_AGENTS } = require('../../src/core/settings.js') as typeof import('../../src/core/settings.js');
    const agents = BUILTIN_AGENTS.map((a) => ({ ...a, ...(over.find((o) => o.id === a.id) ?? {}) }));
    return { agents: [...agents, ...over.filter((o) => !agents.some((a) => a.id === o.id)) as never[]], editor: { kind: 'vscode' as const }, layouts: {} };
  };

  // No hook to intercept their writes, so they can only ever be advisory.
  it('runs codex, opencode, gemini and antigravity as T3 CLI agents with their configured argv', () => {
    const s = settings([{ id: 'codex', command: 'codex -c tui.animations=false' }]);
    const codex = createAdapter('codex', undefined, s) as unknown as { kind: string; enforcementTier: string; argv: string[] };
    expect(codex).toMatchObject({ kind: 'codex', enforcementTier: 'T3', argv: ['codex', '-c', 'tui.animations=false'] });
    expect(createAdapter('opencode', undefined, s).enforcementTier).toBe('T3');
    expect((createAdapter('antigravity', undefined, s) as unknown as { argv: string[] }).argv).toEqual(['agy']);
  });

  it('runs a user-declared agent by its command', () => {
    const s = settings([{ id: 'my-agent', label: 'Mine', command: 'my-agent --go', enabled: true, builtin: false }]);
    expect(createAdapter('my-agent', undefined, s)).toMatchObject({ kind: 'my-agent', enforcementTier: 'T3', argv: ['my-agent', '--go'] });
  });

  it('keeps claude on its hooked T2 adapter, honouring a changed command', () => {
    const a = createAdapter('claude', undefined, settings([{ id: 'claude', command: '/opt/claude --model x' }]));
    expect(a.enforcementTier).toBe('T2');
  });

  it('refuses a disabled agent', () => {
    expect(() => createAdapter('gemini', undefined, settings([{ id: 'gemini', enabled: false }]))).toThrowError(
      expect.objectContaining({ code: 'AGENT_DISABLED' }) as unknown as Error,
    );
  });
});

describe('resumeArgv', () => {
  it('builds each agent\'s own resume form', async () => {
    const { resumeArgv } = await import('../../src/adapters/catalog.js');
    expect(resumeArgv('claude', ['claude', '--x'], 'u1')).toEqual(['claude', '--x', '--resume', 'u1']);
    // codex resumes through a subcommand, which has to come before its other args.
    expect(resumeArgv('codex', ['codex', '-c', 'a=b'], 'u2')).toEqual(['codex', 'resume', 'u2', '-c', 'a=b']);
    expect(resumeArgv('opencode', ['opencode'], 'ses_1')).toEqual(['opencode', '--session', 'ses_1']);
  });
});
