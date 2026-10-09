import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import {
  deleteSessionCheckpoints,
  diffCheckpoints,
  listCheckpoints,
  pruneOrphans,
  restoreCheckpoint,
  takeCheckpoint,
  type CheckpointContext,
} from '../../src/domain/checkpoint.js';
import { commitFile, makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';

let fx: GitFixture;
let wt: string;
let ctx: CheckpointContext;
beforeEach(async () => {
  fx = await makeGitFixture();
  await commitFile(fx.root, 'a.txt', 'one\n', 'seed a');
  await commitFile(fx.root, 'b.txt', 'bee\n', 'seed b');
  // Inside the fixture, so its cleanup removes the worktree too.
  wt = join(fx.root, '.wt');
  await $`git worktree add -q -b cw/t ${wt}`.cwd(fx.root).quiet();
  let t = 1_000;
  ctx = { projectRoot: fx.root, sessionId: 's_test', worktree: wt, now: () => (t += 1_000) };
});
afterEach(async () => { await fx.cleanup(); });

const read = (rel: string): string => readFileSync(join(wt, rel), 'utf8');
const isDir = (rel: string): boolean => { try { return lstatSync(join(wt, rel)).isDirectory(); } catch { return false; } };

describe('takeCheckpoint', () => {
  it('captures modified and brand-new files; the first checkpoint is measured against HEAD', async () => {
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    writeFileSync(join(wt, 'new.txt'), 'n\n');
    const { created, info } = await takeCheckpoint(ctx, 'start');
    expect(created).toBe(true);
    expect(info.seq).toBe(1);
    expect(info.kind).toBe('start');
    expect(info.files).toEqual({ added: 1, modified: 1, deleted: 0 });
    expect((await listCheckpoints(ctx)).map((c) => c.seq)).toEqual([1]);
  });

  it('a pristine worktree still gets its first checkpoint, so the first turn has a "before"', async () => {
    const { created, info } = await takeCheckpoint(ctx, 'start');
    expect(created).toBe(true);
    expect(info.files).toEqual({ added: 0, modified: 0, deleted: 0 });
  });

  it('records nothing when the tree equals the newest checkpoint', async () => {
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    const first = await takeCheckpoint(ctx, 'turn');
    const again = await takeCheckpoint(ctx, 'turn');
    expect(again.created).toBe(false);
    expect(again.info.seq).toBe(first.info.seq);
    expect(await listCheckpoints(ctx)).toHaveLength(1);
  });

  it('numbers checkpoints and measures each against the one before it', async () => {
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    await takeCheckpoint(ctx, 'start');
    writeFileSync(join(wt, 'b.txt'), 'bee2\n');
    writeFileSync(join(wt, 'c.txt'), 'c\n');
    const second = await takeCheckpoint(ctx, 'turn');
    expect(second.info.seq).toBe(2);
    expect(second.info.files).toEqual({ added: 1, modified: 1, deleted: 0 });
    const listed = await listCheckpoints(ctx);
    expect(listed.map((c) => c.seq)).toEqual([2, 1]);
    expect(listed[0]?.files).toEqual({ added: 1, modified: 1, deleted: 0 }); // read back from the ref, not recomputed
  });

  it('keeps only the newest `keep` checkpoints', async () => {
    const small = { ...ctx, keep: 3 };
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(wt, 'a.txt'), `v${i}\n`);
      await takeCheckpoint(small, 'turn');
    }
    expect((await listCheckpoints(small)).map((c) => c.seq)).toEqual([5, 4, 3]);
  });

  it('does not capture files git ignores', async () => {
    await commitFile(wt, '.gitignore', 'ignored.log\n', 'ignore');
    writeFileSync(join(wt, 'ignored.log'), 'secret\n');
    writeFileSync(join(wt, 'kept.txt'), 'k\n');
    const { info } = await takeCheckpoint(ctx, 'start');
    const names = await $`git ls-tree -r --name-only ${info.tree}`.cwd(wt).quiet().text();
    expect(names).toContain('kept.txt');
    expect(names).not.toContain('ignored.log');
  });

  it('refuses a huge untracked payload in an automatic checkpoint, naming the culprit, and writes no ref', async () => {
    writeFileSync(join(wt, 'huge.bin'), Buffer.alloc(64));
    const err = await takeCheckpoint({ ...ctx, maxUntrackedBytes: 10 }, 'turn').then(() => null, (e: Error & { code?: string }) => e);
    expect(err?.code).toBe('CHECKPOINT_TOO_LARGE');
    expect(err?.message).toContain('huge.bin');
    expect(await listCheckpoints(ctx)).toHaveLength(0);
  });

  it('lets a person\'s own manual checkpoint through the size guard', async () => {
    writeFileSync(join(wt, 'huge.bin'), Buffer.alloc(64));
    const { created } = await takeCheckpoint({ ...ctx, maxUntrackedBytes: 10 }, 'manual');
    expect(created).toBe(true);
  });

  it('survives awkward file names', async () => {
    writeFileSync(join(wt, 'weird name é.txt'), 'w\n');
    writeFileSync(join(wt, '-dash.txt'), 'd\n');
    const { info } = await takeCheckpoint(ctx, 'start');
    expect(info.files.added).toBe(2);
  });

  it('serialises concurrent takes: one records, the other sees the same tree', async () => {
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    const [x, y] = await Promise.all([takeCheckpoint(ctx, 'turn'), takeCheckpoint(ctx, 'turn')]);
    expect([x.created, y.created].filter(Boolean)).toHaveLength(1);
    expect(await listCheckpoints(ctx)).toHaveLength(1);
  });

  it('stores a label with control characters flattened', async () => {
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    const { info } = await takeCheckpoint(ctx, 'manual', 'before\nrefactor');
    expect(info.label).toBe('before refactor');
  });

  it('fails with a CrossweaveError, not a crash, when the worktree has vanished', async () => {
    const gone = { ...ctx, worktree: join(fx.root, '.nowhere') };
    await expect(takeCheckpoint(gone, 'turn')).rejects.toMatchObject({ code: 'CHECKPOINT_GIT_FAILED' });
  });
});

describe('diffCheckpoints', () => {
  it('diffs one turn against the previous checkpoint, and a checkpoint against the live worktree', async () => {
    const c1 = (await takeCheckpoint(ctx, 'start')).info;
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    const c2 = (await takeCheckpoint(ctx, 'turn')).info;
    writeFileSync(join(wt, 'b.txt'), 'bee2\n');

    const turn = await diffCheckpoints(ctx, c1.seq, c2.seq);
    expect(turn.files).toEqual([{ path: 'a.txt', status: 'modified', added: 1, deleted: 1 }]);
    expect(turn.patch).toContain('+two');

    const since = await diffCheckpoints(ctx, c2.seq);
    expect(since.files.map((f) => f.path)).toEqual(['b.txt']);
    expect(await listCheckpoints(ctx)).toHaveLength(2); // the live side wrote no ref
  });

  it('counts a binary file as 0/0 lines and does not break the parser', async () => {
    const c1 = (await takeCheckpoint(ctx, 'start')).info;
    writeFileSync(join(wt, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]));
    const diff = await diffCheckpoints(ctx, c1.seq);
    expect(diff.files).toEqual([{ path: 'blob.bin', status: 'added', added: 0, deleted: 0 }]);
  });

  it('reports an accented name as it is on disk', async () => {
    const c1 = (await takeCheckpoint(ctx, 'start')).info;
    writeFileSync(join(wt, 'é.txt'), 'x\n');
    expect((await diffCheckpoints(ctx, c1.seq)).files.map((f) => f.path)).toEqual(['é.txt']);
  });

  it('says CHECKPOINT_NOT_FOUND for a number that does not exist', async () => {
    await expect(diffCheckpoints(ctx, 99)).rejects.toMatchObject({ code: 'CHECKPOINT_NOT_FOUND' });
  });
});

describe('restoreCheckpoint', () => {
  it('previews by default, then restores modified, deleted and added files — and is itself undoable', async () => {
    const cp = (await takeCheckpoint(ctx, 'start')).info; // a=one b=bee
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    unlinkSync(join(wt, 'b.txt'));
    mkdirSync(join(wt, 'dir'));
    writeFileSync(join(wt, 'dir', 'c.txt'), 'c\n');

    const preview = await restoreCheckpoint(ctx, cp.seq);
    expect(preview.applied).toBe(false);
    expect(preview.plan).toEqual({ write: ['a.txt', 'b.txt'], delete: ['dir/c.txt'] });
    expect(read('a.txt')).toBe('two\n'); // a preview changed nothing
    expect(await listCheckpoints(ctx)).toHaveLength(1); // and recorded nothing

    const done = await restoreCheckpoint(ctx, cp.seq, { apply: true });
    expect(done.applied).toBe(true);
    expect(read('a.txt')).toBe('one\n');
    expect(read('b.txt')).toBe('bee\n');
    expect(existsSync(join(wt, 'dir', 'c.txt'))).toBe(false);
    expect(existsSync(join(wt, 'dir'))).toBe(false); // the directory it emptied goes too
    expect(done.preRestoreSeq).toBe(2);
    expect((await listCheckpoints(ctx)).map((c) => c.kind)).toEqual(['pre-restore', 'start']);

    await restoreCheckpoint(ctx, done.preRestoreSeq!, { apply: true });
    expect(read('a.txt')).toBe('two\n');
    expect(existsSync(join(wt, 'b.txt'))).toBe(false);
    expect(existsSync(join(wt, 'dir', 'c.txt'))).toBe(true);
  });

  it('never moves HEAD or the real index, even when the agent committed mid-turn', async () => {
    const cp = (await takeCheckpoint(ctx, 'start')).info;
    await commitFile(wt, 'later.txt', 'x\n', 'agent commit');
    writeFileSync(join(wt, 'staged.txt'), 's\n');
    await $`git add staged.txt`.cwd(wt).quiet();
    const head = (await $`git rev-parse HEAD`.cwd(wt).quiet().text()).trim();
    const staged = await $`git diff --cached --name-only`.cwd(wt).quiet().text();

    await restoreCheckpoint(ctx, cp.seq, { apply: true });

    expect((await $`git rev-parse HEAD`.cwd(wt).quiet().text()).trim()).toBe(head);
    expect(await $`git diff --cached --name-only`.cwd(wt).quiet().text()).toBe(staged);
    expect(await $`git log --oneline`.cwd(wt).quiet().text()).toContain('agent commit');
    expect(existsSync(join(wt, 'later.txt'))).toBe(false); // the files go back; the commit stays
  });

  it('leaves ignored files alone', async () => {
    await commitFile(wt, '.gitignore', 'ignored.log\n', 'ignore');
    const cp = (await takeCheckpoint(ctx, 'start')).info;
    writeFileSync(join(wt, 'ignored.log'), 'keep me\n');
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    await restoreCheckpoint(ctx, cp.seq, { apply: true });
    expect(read('ignored.log')).toBe('keep me\n');
    expect(read('a.txt')).toBe('one\n');
  });

  // A: the plan deletes the LINK, never what it points at.
  it('removes a symlink the agent added, not the file it points to', async () => {
    const cp = (await takeCheckpoint(ctx, 'start')).info;
    symlinkSync('a.txt', join(wt, 'CLAUDE.md'));
    const done = await restoreCheckpoint(ctx, cp.seq, { apply: true });
    expect(done.plan.delete).toEqual(['CLAUDE.md']);
    expect(read('a.txt')).toBe('one\n');
    expect(() => lstatSync(join(wt, 'CLAUDE.md'))).toThrow();
  });

  // C: a link pointing outside the worktree is just a link to remove.
  it('removes a symlink pointing outside the worktree without touching its target', async () => {
    const outside = join(fx.root, 'outside.txt');
    writeFileSync(outside, 'mine\n');
    const cp = (await takeCheckpoint(ctx, 'start')).info;
    symlinkSync(outside, join(wt, 'link-out'));
    writeFileSync(join(wt, 'a.txt'), 'bad turn\n');
    const done = await restoreCheckpoint(ctx, cp.seq, { apply: true });
    expect(done.applied).toBe(true);
    expect(read('a.txt')).toBe('one\n');
    expect(readFileSync(outside, 'utf8')).toBe('mine\n');
  });

  it('turns a directory that became a symlink back into a real directory and writes nothing outside', async () => {
    const outside = join(fx.root, 'outside');
    mkdirSync(outside);
    mkdirSync(join(wt, 'dir'));
    writeFileSync(join(wt, 'dir', 'file.txt'), 'orig\n');
    const cp = (await takeCheckpoint(ctx, 'start')).info;
    rmSync(join(wt, 'dir'), { recursive: true });
    symlinkSync(outside, join(wt, 'dir'));

    await restoreCheckpoint(ctx, cp.seq, { apply: true });

    expect(isDir('dir')).toBe(true);
    expect(read('dir/file.txt')).toBe('orig\n');
    expect(existsSync(join(outside, 'file.txt'))).toBe(false);
  });

  // B: git would delete the ignored files inside the directory to make room for the file.
  it('refuses, before changing anything, when ignored files sit where the checkpoint needs a file', async () => {
    await commitFile(wt, '.gitignore', 'cache/*.log\n', 'ignore');
    writeFileSync(join(wt, 'cache'), 'a file\n');
    const cp = (await takeCheckpoint(ctx, 'start')).info;
    unlinkSync(join(wt, 'cache'));
    mkdirSync(join(wt, 'cache'));
    writeFileSync(join(wt, 'cache', 'precious.log'), 'ignored, never captured\n');
    writeFileSync(join(wt, 'a.txt'), 'two\n');

    await expect(restoreCheckpoint(ctx, cp.seq, { apply: true })).rejects.toMatchObject({ code: 'CHECKPOINT_RESTORE_BLOCKED' });

    expect(read('cache/precious.log')).toBe('ignored, never captured\n');
    expect(read('a.txt')).toBe('two\n'); // nothing was restored
    expect((await listCheckpoints(ctx)).map((c) => c.kind)).toEqual(['start']); // and no pre-restore ref was left behind
  });

  // F: the same hazard from the other side — an ignored file where the checkpoint needs a directory.
  it('refuses when an ignored file sits where the checkpoint needs a directory', async () => {
    await commitFile(wt, '.gitignore', 'logs\n', 'ignore');
    mkdirSync(join(wt, 'logs'));
    writeFileSync(join(wt, 'logs', 'a.txt'), 'kept\n');
    await $`git add -f logs/a.txt`.cwd(wt).quiet();
    await $`git commit -qm logs`.cwd(wt).quiet();
    const cp = (await takeCheckpoint(ctx, 'start')).info;
    rmSync(join(wt, 'logs'), { recursive: true });
    writeFileSync(join(wt, 'logs'), 'ignored precious file\n');

    await expect(restoreCheckpoint(ctx, cp.seq, { apply: true })).rejects.toMatchObject({ code: 'CHECKPOINT_RESTORE_BLOCKED' });
    expect(read('logs')).toBe('ignored precious file\n');
  });

  it('still works when the checkpoint cannot be taken because untracked files are huge (the restore is the way out)', async () => {
    const cp = (await takeCheckpoint(ctx, 'start')).info;
    writeFileSync(join(wt, 'a.txt'), 'bad turn\n');
    writeFileSync(join(wt, 'huge.bin'), Buffer.alloc(64));
    const done = await restoreCheckpoint({ ...ctx, maxUntrackedBytes: 10 }, cp.seq, { apply: true });
    expect(done.applied).toBe(true);
    expect(read('a.txt')).toBe('one\n');
  });

  it('still completes when its own pre-restore checkpoint prunes the target', async () => {
    const small = { ...ctx, keep: 2 };
    writeFileSync(join(wt, 'a.txt'), 'v1\n');
    const target = (await takeCheckpoint(small, 'turn')).info;
    writeFileSync(join(wt, 'a.txt'), 'v2\n');
    await takeCheckpoint(small, 'turn');
    writeFileSync(join(wt, 'a.txt'), 'v3\n');
    const done = await restoreCheckpoint(small, target.seq, { apply: true });
    expect(done.applied).toBe(true);
    expect(read('a.txt')).toBe('v1\n');
  });

  it('survives awkward file names', async () => {
    writeFileSync(join(wt, 'weird name é.txt'), 'w\n');
    const cp = (await takeCheckpoint(ctx, 'start')).info;
    unlinkSync(join(wt, 'weird name é.txt'));
    await restoreCheckpoint(ctx, cp.seq, { apply: true });
    expect(read('weird name é.txt')).toBe('w\n');
  });

  it('says CHECKPOINT_NOT_FOUND for a number that does not exist', async () => {
    await expect(restoreCheckpoint(ctx, 99, { apply: true })).rejects.toMatchObject({ code: 'CHECKPOINT_NOT_FOUND' });
  });
});

describe('cleanup', () => {
  it('deleteSessionCheckpoints removes every ref and the private index, and only that session\'s', async () => {
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    await takeCheckpoint(ctx, 'turn');
    const other = { ...ctx, sessionId: 's_other' };
    await takeCheckpoint(other, 'turn');

    await deleteSessionCheckpoints(fx.root, ctx.sessionId);

    expect(await listCheckpoints(ctx)).toHaveLength(0);
    expect(await listCheckpoints(other)).toHaveLength(1);
    expect(existsSync(join(fx.root, '.crossweave', 'checkpoint-index', ctx.sessionId))).toBe(false);
  });

  it('pruneOrphans drops this project\'s sessions that no longer exist and keeps live ones', async () => {
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    await takeCheckpoint(ctx, 'turn');
    const ghost = { ...ctx, sessionId: 's_ghost' };
    await takeCheckpoint(ghost, 'turn');

    await pruneOrphans(fx.root, new Set([ctx.sessionId]));

    expect(await listCheckpoints(ctx)).toHaveLength(1);
    expect(await listCheckpoints(ghost)).toHaveLength(0);
    expect(existsSync(join(fx.root, '.crossweave', 'checkpoint-index', 's_ghost'))).toBe(false);
  });

  // Refs are shared by every worktree of a repository: a session this project never indexed is someone else's.
  it('pruneOrphans leaves refs alone when this project has no private index for them', async () => {
    writeFileSync(join(wt, 'a.txt'), 'two\n');
    const foreign = { ...ctx, sessionId: 's_foreign' };
    await takeCheckpoint(foreign, 'turn');
    unlinkSync(join(fx.root, '.crossweave', 'checkpoint-index', 's_foreign')); // as if another project made it

    await pruneOrphans(fx.root, new Set());

    expect(await listCheckpoints(foreign)).toHaveLength(1);
  });

  it('deleting a session that never had checkpoints is a no-op', async () => {
    await expect(deleteSessionCheckpoints(fx.root, 's_never')).resolves.toBeUndefined();
  });
});
