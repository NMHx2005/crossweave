import { describe, expect, it } from 'bun:test';
import { BROWSER_CONTROL_TIMEOUT_MS, buildBrowserRequest, formatBrowserResult } from '../../src/cli/commands/browser.js';

const build = (sub: string, positionals: string[] = [], flags: Record<string, string | boolean | undefined> = {}) => buildBrowserRequest(sub, positionals, flags);
const codeOf = (fn: () => unknown): string => { try { fn(); return 'ok'; } catch (e) { return (e as { code?: string }).code ?? 'no-code'; } };

describe('buildBrowserRequest', () => {
  it('list takes no pane and is a quick read', () => {
    expect(build('list', [], { pane: 'p1' })).toEqual({ kind: 'browser.list', params: {}, timeoutMs: 10_000 });
  });

  it('reads pass only what was given, with a short timeout', () => {
    expect(build('console')).toEqual({ kind: 'browser.console', params: {}, timeoutMs: 10_000 });
    expect(build('console', [], { level: 'error', since: '5', limit: '3', pane: 'p2' })).toMatchObject({ params: { level: 'error', since: 5, limit: 3, pane: 'p2' } });
    expect(build('network', [], { failed: true })).toMatchObject({ kind: 'browser.network', params: { failed: true } });
    expect(build('dom', [], { selector: '#a', max: '100' })).toMatchObject({ params: { selector: '#a', max: 100 } });
    expect(build('shot')).toMatchObject({ kind: 'browser.shot' });
  });

  it('controls wait longer than the cockpit\'s dialog does', () => {
    expect(BROWSER_CONTROL_TIMEOUT_MS).toBeGreaterThan(20_000);
    expect(build('navigate', ['http://localhost:3000'])).toEqual({ kind: 'browser.navigate', params: { url: 'http://localhost:3000' }, timeoutMs: BROWSER_CONTROL_TIMEOUT_MS });
    expect(build('click', ['#go'])).toMatchObject({ kind: 'browser.click', params: { selector: '#go' }, timeoutMs: BROWSER_CONTROL_TIMEOUT_MS });
    expect(build('type', ['#q', 'hello'])).toMatchObject({ params: { selector: '#q', text: 'hello' } });
    expect(build('eval', ['document.title'])).toMatchObject({ kind: 'browser.eval', params: { script: 'document.title' } });
  });

  it('refuses missing or malformed arguments before anything is sent', () => {
    expect(codeOf(() => build('navigate'))).toBe('INVALID_ARGUMENTS');
    expect(codeOf(() => build('click'))).toBe('INVALID_ARGUMENTS');
    expect(codeOf(() => build('type', ['#q']))).toBe('INVALID_ARGUMENTS');
    expect(codeOf(() => build('eval'))).toBe('INVALID_ARGUMENTS');
    expect(codeOf(() => build('console', [], { level: 'loud' }))).toBe('INVALID_ARGUMENTS');
    expect(codeOf(() => build('console', [], { limit: 'many' }))).toBe('INVALID_ARGUMENTS');
  });

  it('has no way to name a kind outside the fixed set', () => {
    expect(codeOf(() => build('cookies'))).toBe('INVALID_ARGUMENTS');
    expect(codeOf(() => build('pane.close'))).toBe('INVALID_ARGUMENTS');
  });
});

describe('formatBrowserResult', () => {
  it('prints one JSON object per line for a list of rows', () => {
    expect(formatBrowserResult('console', [{ a: 1 }, { a: 2 }])).toBe('{"a":1}\n{"a":2}');
    expect(formatBrowserResult('console', [])).toBe('');
  });

  it('prints just the path for a screenshot', () => {
    expect(formatBrowserResult('shot', { path: '/x/.crossweave/shots/1.png' })).toBe('/x/.crossweave/shots/1.png');
  });

  it('prints an object on one line', () => {
    expect(formatBrowserResult('eval', { value: 42 })).toBe('{"value":42}');
    expect(formatBrowserResult('click', { ok: true })).toBe('{"ok":true}');
  });
});
