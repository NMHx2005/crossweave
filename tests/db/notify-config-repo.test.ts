import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/open.js';
import { WorkspaceRepo } from '../../src/db/repositories/workspace.js';
import { NotifyConfigRepo } from '../../src/db/repositories/notify-config.js';

function seed() {
  const db = openDatabase(':memory:');
  new WorkspaceRepo(db).insert({
    id: 'ws_1', name: 'w', rootPath: '/tmp/w', createdAt: 'now',
    defaultIsolation: 'worktree', safeModeTier: 'T2',
  });
  return new NotifyConfigRepo(db);
}

describe('NotifyConfigRepo', () => {
  test('get returns undefined for a workspace with no row yet', () => {
    expect(seed().get('ws_1')).toBeUndefined();
  });

  test('isEnabled defaults every event to true when no row exists', () => {
    const repo = seed();
    expect(repo.isEnabled('ws_1', 'land')).toBe(true);
    expect(repo.isEnabled('ws_1', 'convergence')).toBe(true);
  });

  test('setEnabled(false) turns every event off via isEnabled, regardless of per-event columns', () => {
    const repo = seed();
    repo.setEnabled('ws_1', false);
    expect(repo.isEnabled('ws_1', 'land')).toBe(false);
    expect(repo.isEnabled('ws_1', 'convergence')).toBe(false);
    const row = repo.get('ws_1')!;
    expect(row.enabled).toBe(false);
    // Per-event columns are untouched by the master switch — still their defaults.
    expect(row.land).toBe(true);
  });

  test('setEnabled(true) after false turns everything back on', () => {
    const repo = seed();
    repo.setEnabled('ws_1', false);
    repo.setEnabled('ws_1', true);
    expect(repo.isEnabled('ws_1', 'land')).toBe(true);
  });

  test('setEvent turns off exactly one event, leaving the others and the master switch alone', () => {
    const repo = seed();
    repo.setEvent('ws_1', 'land', false);
    expect(repo.isEnabled('ws_1', 'land')).toBe(false);
    expect(repo.isEnabled('ws_1', 'convergence')).toBe(true);
  });

  test('setEvent creates a row on first use (no prior setEnabled call needed)', () => {
    const repo = seed();
    repo.setEvent('ws_1', 'convergence', false);
    const row = repo.get('ws_1')!;
    expect(row.enabled).toBe(true); // master switch defaults on even on first-ever write
    expect(row.convergence).toBe(false);
  });

  // The Radar's events are gone; their columns stay in the table (forward-only
  // migrations) and cannot be toggled through the repo any more.
  test('refuses an event that no longer exists', () => {
    expect(() => seed().setEvent('ws_1', 'collision' as never, false)).toThrow(/invalid notify event/);
  });

  test('isEnabled is false when the master switch is off even if the per-event column is true', () => {
    const repo = seed();
    repo.setEnabled('ws_1', false);
    repo.setEvent('ws_1', 'land', true); // explicitly re-enabled at the event level
    expect(repo.isEnabled('ws_1', 'land')).toBe(false); // master switch still wins
  });

  test('preferences are workspace-scoped, not shared', () => {
    const db = openDatabase(':memory:');
    const workspaces = new WorkspaceRepo(db);
    workspaces.insert({ id: 'ws_1', name: 'a', rootPath: '/tmp/a', createdAt: 'now', defaultIsolation: 'worktree', safeModeTier: 'T2' });
    workspaces.insert({ id: 'ws_2', name: 'b', rootPath: '/tmp/b', createdAt: 'now', defaultIsolation: 'worktree', safeModeTier: 'T2' });
    const repo = new NotifyConfigRepo(db);
    repo.setEnabled('ws_1', false);
    expect(repo.isEnabled('ws_1', 'land')).toBe(false);
    expect(repo.isEnabled('ws_2', 'land')).toBe(true);
  });
});
