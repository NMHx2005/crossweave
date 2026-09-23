import { describe, it, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyJournal,
  guardRestore,
  journalPath,
  normalizeTabs,
  readJournal,
  writeJournal,
} from '../../src/domain/journal.js';
import { ActivityFeed, activityFromEvent } from '../../src/domain/activity.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cw-journal-'));
}

describe('journal', () => {
  it('writes and reads, guard prevents double-assign', () => {
    const dir = tempDir();
    writeJournal(dir, {
      workspaceId: 'ws_1',
      openTabs: ['s1', 's2'],
      fileSurfaces: [],
      at: new Date().toISOString(),
    });
    expect(readJournal(dir)?.openTabs).toEqual(['s1', 's2']);
    const seen = new Set<string>();
    expect(guardRestore(['s1', 's1', 's2'], seen)).toEqual(['s1', 's2']);
    expect(guardRestore(['s1'], seen)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves no partial file behind, and a torn one reads as absent', () => {
    const dir = tempDir();
    writeJournal(dir, {
      workspaceId: 'ws_1',
      openTabs: ['s1'],
      fileSurfaces: [],
      at: 'now',
    });
    // Atomic write: the tmp file rename() left is gone, not sitting next to the journal.
    expect(JSON.parse(readFileSync(journalPath(dir), 'utf8')).openTabs).toEqual(['s1']);
    writeFileSync(journalPath(dir), '{"openTabs": ["s1"');
    expect(readJournal(dir)).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('no file at all reads as absent, not as an empty journal', () => {
    const dir = tempDir();
    expect(readJournal(dir)).toBeUndefined();
    expect(emptyJournal('ws_1')).toEqual({
      workspaceId: 'ws_1',
      openTabs: [],
      fileSurfaces: [],
      at: null,
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('normalizeTabs drops non-strings and unknown ids, collapses repeats, caps the list', () => {
    const known = new Set(['s1', 's2', 's3']);
    const isKnown = (id: string): boolean => known.has(id);
    expect(normalizeTabs(['s1', 42, null, 'ghost', 's2', 's1'], isKnown)).toEqual(['s1', 's2']);
    expect(normalizeTabs('s1', isKnown)).toEqual([]);
    // The cap is 16 (MAX_TABS): a runaway client must not grow a state file without bound.
    const many = Array.from({ length: 20 }, (_, i) => `s${i}`);
    expect(normalizeTabs(many, () => true).length).toBe(16);
    expect(normalizeTabs(many, () => true)[0]).toBe('s0');
  });
});

describe('activity', () => {
  it('tracks unread and ack', () => {
    const feed = new ActivityFeed();
    feed.push('blocked', 's1');
    feed.push('landed', 's2');
    expect(feed.unread(5).length).toBe(2);
    feed.ack('s1');
    expect(feed.unread(5).length).toBe(1);
    expect(feed.unread(5)[0]?.session).toBe('s2');
  });

  it('keeps the newest first and does not grow without bound', () => {
    const feed = new ActivityFeed();
    for (let i = 0; i < 60; i++) feed.push('blocked', `s${i}`);
    expect(feed.all().length).toBe(50);
    expect(feed.all()[0]?.session).toBe('s59');
    expect(feed.unread(5).length).toBe(5);
  });
});

describe('activityFromEvent', () => {
  it('maps the tui.event payloads that have a producer', () => {
    expect(
      activityFromEvent({ kind: 'blocked', session: 'auth', path: 'a.ts', symbol: null, workspaceId: 'ws_1' }),
    ).toEqual({ kind: 'blocked', session: 'auth' });
    expect(
      activityFromEvent({ kind: 'land', session: 'auth', ok: true, baseBranch: 'main', workspaceId: 'ws_1' }),
    ).toEqual({ kind: 'landed', session: 'auth' });
    expect(
      activityFromEvent({ kind: 'land', session: 'auth', ok: false, reason: 'LAND_MERGE_FAILED', workspaceId: 'ws_1' }),
    ).toEqual({ kind: 'land_failed', session: 'auth' });
  });

  it('ignores pair events and anything that is not an event', () => {
    // collision/convergence name two sessions and describe a pair — the rail badge
    // already carries that state, and a row nobody can act on is not an item.
    expect(activityFromEvent({ kind: 'collision', sessionA: 'a', sessionB: 'b', workspaceId: 'ws_1' })).toBeNull();
    expect(
      activityFromEvent({ kind: 'convergence', sessionA: 'a', sessionB: 'b', from: 'unknown', to: 'ready', workspaceId: 'ws_1' }),
    ).toBeNull();
    expect(activityFromEvent({ kind: 'blocked' })).toBeNull();
    expect(activityFromEvent({ kind: 'blocked', session: '' })).toBeNull();
    expect(activityFromEvent(null)).toBeNull();
    expect(activityFromEvent('blocked')).toBeNull();
    expect(activityFromEvent(undefined)).toBeNull();
  });
});
