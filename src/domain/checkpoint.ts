import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { CrossweaveError } from '../core/errors.js';
import { crossweaveDir } from '../core/paths.js';
import { redactSecrets } from '../core/redact-secrets.js';
import { diffBetween, type TreeDiff } from './session-diff.js';

const run = promisify(execFile);

/** Two per agent turn (its start and its end), so this is about 25 turns. */
export const CHECKPOINT_KEEP = 50;
export const CHECKPOINT_MAX_UNTRACKED_BYTES = 50 * 1024 * 1024;
const REF_ROOT = 'refs/crossweave/checkpoints';
// A fixed identity so a checkpoint never depends on (or fails for lack of) the person's git config.
const IDENTITY = {
  GIT_AUTHOR_NAME: 'crossweave',
  GIT_AUTHOR_EMAIL: 'crossweave@localhost',
  GIT_COMMITTER_NAME: 'crossweave',
  GIT_COMMITTER_EMAIL: 'crossweave@localhost',
};

export type CheckpointKind = 'start' | 'turn' | 'manual' | 'pre-restore';
export interface CheckpointFiles { added: number; modified: number; deleted: number }
export interface CheckpointInfo {
  seq: number;
  kind: CheckpointKind;
  label?: string;
  /** Epoch ms. */
  at: number;
  /** HEAD when it was taken. */
  head: string;
  tree: string;
  /** Against the previous checkpoint; for the oldest, against its own HEAD. Stored, never recomputed. */
  files: CheckpointFiles;
}
export interface CheckpointContext {
  projectRoot: string;
  sessionId: string;
  worktree: string;
  now?: () => number;
  /** Retention; defaults to `CHECKPOINT_KEEP`. */
  keep?: number;
  maxUntrackedBytes?: number;
}

interface Raw extends CheckpointInfo { ref: string }

async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  try {
    const { stdout } = await run('git', args, {
      cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (cause) {
    const e = cause as { stderr?: string; message?: string };
    throw new CrossweaveError('CHECKPOINT_GIT_FAILED', redactSecrets(`git ${args[0] ?? ''} failed: ${(e.stderr ?? e.message ?? '').trim()}`));
  }
}

/**
 * One chain per session: take, restore and prune never interleave. (The private index also keeps
 * a take from fighting the agent for the real `index.lock`.)
 */
const tails = new Map<string, Promise<unknown>>();
function locked<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const next = (tails.get(sessionId) ?? Promise.resolve()).then(fn);
  const tail = next.then(() => undefined, () => undefined);
  tails.set(sessionId, tail);
  void tail.then(() => { if (tails.get(sessionId) === tail) tails.delete(sessionId); });
  return next;
}

function refPrefix(sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new CrossweaveError('INVALID_ARGUMENTS', `Not a session id: ${sessionId}`);
  return `${REF_ROOT}/${sessionId}/`;
}

function indexDir(projectRoot: string): string {
  return join(crossweaveDir(projectRoot), 'checkpoint-index');
}

function indexPath(projectRoot: string, sessionId: string): string {
  return join(indexDir(projectRoot), sessionId);
}

/**
 * The session's own index file. Seeded once from HEAD and then kept: it carries git's stat cache, so after the
 * first run `git add -A` only re-hashes what changed.
 */
async function privateIndex(ctx: CheckpointContext): Promise<string> {
  const path = indexPath(ctx.projectRoot, ctx.sessionId);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    await git(ctx.worktree, ['read-tree', 'HEAD'], { GIT_INDEX_FILE: path });
  }
  return path;
}

/**
 * An agent that writes a multi-GB file the repo does not ignore must not fill the disk through us. Applied to the
 * automatic checkpoints only: a person's own checkpoint, and the one a restore saves first, must not be refused —
 * blocking a restore exactly when an agent misbehaved would defeat the feature.
 */
async function guardSize(ctx: CheckpointContext): Promise<void> {
  const limit = ctx.maxUntrackedBytes ?? CHECKPOINT_MAX_UNTRACKED_BYTES;
  const out = await git(ctx.worktree, ['ls-files', '-o', '--exclude-standard', '-z']);
  const sizes: Array<[string, number]> = [];
  let total = 0;
  for (const rel of out.split('\0')) {
    if (rel === '') continue;
    try {
      const size = lstatSync(join(ctx.worktree, rel)).size;
      sizes.push([rel, size]);
      total += size;
    } catch { /* vanished while we looked */ }
  }
  if (total > limit) {
    const biggest = sizes.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([rel, size]) => `${rel} (${Math.round(size / 1024)} KB)`).join(', ');
    throw new CrossweaveError('CHECKPOINT_TOO_LARGE', `Untracked files in the worktree exceed ${Math.round(limit / 1048576)} MB, so no checkpoint was taken. Largest: ${biggest}. Ignore or remove them.`);
  }
}

/** The worktree's content (tracked + untracked, minus ignored) as a tree object. Writes no ref. */
async function liveTree(ctx: CheckpointContext, guard: boolean): Promise<string> {
  const index = await privateIndex(ctx);
  if (guard) await guardSize(ctx);
  await git(ctx.worktree, ['add', '-A'], { GIT_INDEX_FILE: index });
  return (await git(ctx.worktree, ['write-tree'], { GIT_INDEX_FILE: index })).trim();
}

const SUBJECT = /^checkpoint (start|turn|manual|pre-restore) head=([0-9a-f]+) at=(\d+) files=(\d+),(\d+),(\d+)(?: label=(.*))?$/;

async function listRaw(cwd: string, sessionId: string): Promise<Raw[]> {
  const out = await git(cwd, ['for-each-ref', '--format=%(refname)%09%(tree)%09%(contents:subject)', refPrefix(sessionId)]);
  const rows: Raw[] = [];
  for (const line of out.split('\n')) {
    if (line === '') continue;
    const [ref, tree, ...rest] = line.split('\t');
    const m = SUBJECT.exec(rest.join('\t'));
    const seq = Number((ref ?? '').slice((ref ?? '').lastIndexOf('/') + 1));
    if (ref === undefined || tree === undefined || m === null || !Number.isInteger(seq)) continue;
    rows.push({
      seq, ref, tree, kind: m[1] as CheckpointKind, head: m[2] ?? '', at: Number(m[3]),
      files: { added: Number(m[4]), modified: Number(m[5]), deleted: Number(m[6]) },
      ...(m[7] ? { label: m[7] } : {}),
    });
  }
  return rows.sort((a, b) => b.seq - a.seq);
}

const toInfo = ({ ref: _ref, ...info }: Raw): CheckpointInfo => info;

export interface TreeChange { status: 'A' | 'M' | 'D'; path: string }

/** `-z` throughout: a path with a space, accent, quote or newline is one record, never a parsing accident. */
async function changesBetween(cwd: string, a: string, b: string): Promise<TreeChange[]> {
  const out = await git(cwd, ['diff-tree', '-r', '--no-renames', '--name-status', '-z', a, b]);
  const parts = out.split('\0');
  const rows: TreeChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i]?.[0];
    rows.push({ status: code === 'A' ? 'A' : code === 'D' ? 'D' : 'M', path: parts[i + 1] ?? '' });
  }
  return rows;
}

const countFiles = (changes: TreeChange[]): CheckpointFiles => ({
  added: changes.filter((c) => c.status === 'A').length,
  modified: changes.filter((c) => c.status === 'M').length,
  deleted: changes.filter((c) => c.status === 'D').length,
});

const pad = (seq: number): string => String(seq).padStart(6, '0');
const cleanLabel = (label: string): string => label.replace(/\p{C}+/gu, ' ').trim().slice(0, 100);

/** Unlocked: `restoreCheckpoint` already holds the session's lock when it needs a pre-restore one. */
async function snapshot(
  ctx: CheckpointContext, kind: CheckpointKind, label?: string,
): Promise<{ created: boolean; info: CheckpointInfo }> {
  const tree = await liveTree(ctx, kind === 'start' || kind === 'turn');
  const existing = await listRaw(ctx.worktree, ctx.sessionId);
  const newest = existing[0];
  if (newest !== undefined && newest.tree === tree) return { created: false, info: toInfo(newest) };

  const head = (await git(ctx.worktree, ['rev-parse', 'HEAD'])).trim();
  const files = countFiles(await changesBetween(ctx.worktree, newest?.tree ?? `${head}^{tree}`, tree));
  const at = (ctx.now ?? Date.now)();
  const clean = label === undefined ? '' : cleanLabel(label);
  const subject = `checkpoint ${kind} head=${head} at=${at} files=${files.added},${files.modified},${files.deleted}${clean === '' ? '' : ` label=${clean}`}`;
  // No parent, on purpose: a parent chain would keep every pruned checkpoint reachable through the newest one,
  // and pruning would free nothing. A turn's diff is tree against tree and needs no ancestry.
  const commit = (await git(ctx.worktree, ['commit-tree', tree, '-m', subject], IDENTITY)).trim();
  const seq = (newest?.seq ?? 0) + 1;
  const ref = `${refPrefix(ctx.sessionId)}${pad(seq)}`;
  // The empty old value makes git refuse if the ref already exists — two writers can never share a number.
  await git(ctx.worktree, ['update-ref', ref, commit, '']);
  const keep = ctx.keep ?? CHECKPOINT_KEEP;
  for (const old of existing.slice(keep - 1)) await git(ctx.worktree, ['update-ref', '-d', old.ref]);

  return { created: true, info: { seq, kind, ...(clean === '' ? {} : { label: clean }), at, head, tree, files } };
}

export function takeCheckpoint(
  ctx: CheckpointContext, kind: Exclude<CheckpointKind, 'pre-restore'>, label?: string,
): Promise<{ created: boolean; info: CheckpointInfo }> {
  return locked(ctx.sessionId, () => snapshot(ctx, kind, label));
}

/** Newest first, from one `for-each-ref`. Not locked: a read may see the state just before or after a take. */
export async function listCheckpoints(ctx: CheckpointContext): Promise<CheckpointInfo[]> {
  return (await listRaw(ctx.worktree, ctx.sessionId)).map(toInfo);
}

function findRaw(rows: Raw[], seq: number): Raw {
  const row = rows.find((r) => r.seq === seq);
  if (row === undefined) throw new CrossweaveError('CHECKPOINT_NOT_FOUND', `No checkpoint #${seq} for this session.`);
  return row;
}

/** `to` omitted compares with the live worktree; that side is an unreferenced tree, so it leaves no ref behind. */
export async function diffCheckpoints(
  ctx: CheckpointContext, from: number, to?: number, opts: { maxPatchBytes?: number } = {},
): Promise<TreeDiff> {
  const rows = await listRaw(ctx.worktree, ctx.sessionId);
  const a = findRaw(rows, from).tree;
  const b = to === undefined ? await locked(ctx.sessionId, () => liveTree(ctx, false)) : findRaw(rows, to).tree;
  return diffBetween(ctx.worktree, a, b, opts);
}

export interface RestorePlan { write: string[]; delete: string[] }

function planOf(changes: TreeChange[]): RestorePlan {
  // Going from "now" to the target: an added path is one the target has and the worktree lacks (write it), a
  // deleted path is one the worktree has and the target lacks (remove it), a modified one is written back.
  return {
    write: changes.filter((c) => c.status !== 'D').map((c) => c.path),
    delete: changes.filter((c) => c.status === 'D').map((c) => c.path),
  };
}

/** Whether everything under `rel` (a directory) is a file the plan is about to delete. */
function onlyDoomed(root: string, rel: string, doomed: ReadonlySet<string>): boolean {
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) { if (!onlyDoomed(root, child, doomed)) return false; } else if (!doomed.has(child)) return false;
  }
  return true;
}

/**
 * Every refusal happens here, before anything is touched. Git itself would write through nothing, but it would
 * destroy an ignored file standing where the checkpoint needs a directory (or a directory of ignored files
 * where it needs a file) and it replaces a symlinked directory — so the worktree must show nothing of that kind.
 * Git paths never hold `..`, but this is the only gate, so it is checked.
 */
function assertRestorable(root: string, plan: RestorePlan): void {
  const doomed = new Set(plan.delete);
  const blocked = (path: string, why: string): CrossweaveError =>
    new CrossweaveError('CHECKPOINT_RESTORE_BLOCKED', `${path} ${why}; move it aside, then restore again.`);
  for (const p of [...plan.delete, ...plan.write]) {
    const parts = p.split('/');
    if (parts.some((s) => s === '' || s === '.' || s === '..' || s === '.git')) {
      throw new CrossweaveError('PATH_ESCAPE', `Bad path in checkpoint: ${p}`);
    }
    for (let i = 1; i < parts.length; i += 1) {
      const prefix = parts.slice(0, i).join('/');
      if (doomed.has(prefix)) break;
      let st;
      try { st = lstatSync(join(root, prefix)); } catch { break; }
      if (!st.isDirectory()) throw blocked(prefix, `is in the way of ${p} and is not part of the checkpoint (an ignored file or a link)`);
    }
  }
  for (const p of plan.write) {
    let st;
    try { st = lstatSync(join(root, p)); } catch { continue; }
    if (st.isDirectory() && !onlyDoomed(root, p, doomed)) throw blocked(p, 'is a directory holding files the checkpoint does not track');
  }
}

export function restoreCheckpoint(
  ctx: CheckpointContext, seq: number, opts: { apply?: boolean } = {},
): Promise<{ plan: RestorePlan; applied: boolean; preRestoreSeq?: number }> {
  return locked(ctx.sessionId, async () => {
    const target = findRaw(await listRaw(ctx.worktree, ctx.sessionId), seq);
    const root = realpathSync(ctx.worktree);
    // The live tree first, unguarded: a restore must work even when the worktree is full of huge untracked files.
    const previewPlan = planOf(await changesBetween(ctx.worktree, await liveTree(ctx, false), target.tree));
    if (opts.apply !== true) return { plan: previewPlan, applied: false };
    // A refusal costs nothing: no ref has been written yet.
    assertRestorable(root, previewPlan);

    // The way back: if the tree is unchanged the newest checkpoint already is that point.
    const pre = await snapshot(ctx, 'pre-restore', `before restoring #${seq}`);
    const plan = planOf(await changesBetween(ctx.worktree, pre.info.tree, target.tree));
    assertRestorable(root, plan); // an agent may have written between the preview and the snapshot

    // Deletes first: a file that became a directory (or the reverse) needs the old entry gone before the new one lands.
    // Joined lexically, never resolved: a symlink is removed itself, never followed to its target.
    for (const p of plan.delete) {
      const abs = join(root, p);
      try { unlinkSync(abs); } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new CrossweaveError('CHECKPOINT_GIT_FAILED', `Could not remove ${p}: ${(cause as Error).message}`);
      }
      for (let dir = dirname(abs); dir.length > root.length; dir = dirname(dir)) {
        try { rmdirSync(dir); } catch { break; } // not empty (or already gone): stop climbing
      }
    }
    // A directory where the checkpoint has a file is empty by now (validated above): clear the way.
    for (const p of plan.write) {
      try { if (lstatSync(join(root, p)).isDirectory()) rmdirSync(join(root, p)); } catch { /* not there, or not a directory */ }
    }
    if (plan.write.length > 0) {
      // A throwaway index: reading the target into the session's private one would wipe its stat cache and make
      // the next take re-hash the whole worktree.
      const scratch = `${indexPath(ctx.projectRoot, ctx.sessionId)}.restore`;
      try {
        await git(ctx.worktree, ['read-tree', target.tree], { GIT_INDEX_FILE: scratch });
        // Only the paths in the plan: `-a` would rewrite every file, bump every mtime and wake every watcher.
        for (let i = 0; i < plan.write.length; i += 200) {
          await git(ctx.worktree, ['checkout-index', '-f', '--', ...plan.write.slice(i, i + 200)], { GIT_INDEX_FILE: scratch });
        }
      } finally {
        try { unlinkSync(scratch); } catch { /* never made */ }
      }
    }
    return { plan, applied: true, preRestoreSeq: pre.info.seq };
  });
}

/** Runs in the project root, not the worktree: the worktree may be about to vanish, the repository does not. */
export function deleteSessionCheckpoints(projectRoot: string, sessionId: string): Promise<void> {
  return locked(sessionId, async () => {
    const out = await git(projectRoot, ['for-each-ref', '--format=%(refname)', refPrefix(sessionId)]);
    for (const ref of out.split('\n')) if (ref !== '') await git(projectRoot, ['update-ref', '-d', ref]);
    try { unlinkSync(indexPath(projectRoot, sessionId)); } catch { /* none was ever made */ }
  });
}

/**
 * `gc`'s tidy-up for what a crash or a hand-deleted worktree left. Refs are shared by every worktree of a repository,
 * so only sessions this project made (it has their private index) are touched: another crossweave project on the same
 * repository must not lose its checkpoints to our gc.
 */
export async function pruneOrphans(projectRoot: string, live: ReadonlySet<string>): Promise<void> {
  let ours: string[];
  try { ours = readdirSync(indexDir(projectRoot)); } catch { return; }
  const gone = ours.filter((id) => !id.endsWith('.restore') && !live.has(id));
  if (gone.length === 0) return;
  const out = await git(projectRoot, ['for-each-ref', '--format=%(refname)', `${REF_ROOT}/`]);
  for (const ref of out.split('\n')) {
    if (ref === '') continue;
    const id = ref.split('/')[3];
    if (id !== undefined && gone.includes(id)) await git(projectRoot, ['update-ref', '-d', ref]);
  }
  for (const id of gone) { try { unlinkSync(indexPath(projectRoot, id)); } catch { /* raced with another cleanup */ } }
}
