import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJournal, readJournal, guardRestore } from '../../src/domain/journal.js';
import { ActivityFeed } from '../../src/domain/activity.js';

describe('journal', () => {
  it('writes and reads, guard prevents double-assign', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-journal-'));
    writeJournal(dir, { openTabs: ['s1','s2'], fileSurfaces: [], at: new Date().toISOString() });
    expect(readJournal(dir)?.openTabs).toEqual(['s1','s2']);
    const seen = new Set<string>();
    expect(guardRestore(['s1','s1','s2'], seen)).toEqual(['s1','s2']);
    expect(guardRestore(['s1'], seen)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
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
    expect(feed.unread(5)[0]?.sessionId).toBe('s2');
  });
});
