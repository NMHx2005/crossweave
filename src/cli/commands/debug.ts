import { defineCommand } from 'citty';
import { CrossweaveError } from '../../core/errors.js';
import { currentWorkspaceId, fail, sessionForCwd, withClient } from '../context.js';

export interface DebugErrorLine { at: number; line: string }
export interface DebugCheck {
  state: 'running' | 'pass' | 'fail';
  ms?: number;
  code?: number;
  tail?: string;
  stale?: boolean;
}
export interface DebugDiffFile { path: string; status: string; added: number; deleted: number }
export interface DebugBundle {
  session: { id: string; name: string; status: string; branch: string | null; worktreePath: string | null };
  agent: string | null;
  activity: string;
  lastActivityAt: number | null;
  check?: DebugCheck;
  errors: DebugErrorLine[];
  diff: { files: DebugDiffFile[]; total: number; uncommitted: number };
  latestWords?: string;
}

const REDACTED_NOTE = '(secrets scrubbed by a heuristic — check before pasting; --raw disables)';

/**
 * Renders the bundle the daemon already scrubbed — the DAEMON is the single scrub
 * point, so a caller that hands a raw bundle here bypasses it deliberately (`--raw`).
 * This text does not scrub again.
 */
export function renderDebug(b: DebugBundle, raw = false): string {
  const lines: string[] = [];
  const branch = b.session.branch ?? 'shared checkout';
  lines.push(`session: ${b.session.name} (${branch}, ${b.session.status})`);
  lines.push(`agent: ${b.agent ?? 'none'} — ${b.activity}`);
  if (b.check !== undefined) {
    const took = b.check.ms === undefined ? '' : ` (${(b.check.ms / 1000).toFixed(1)}s)`;
    const stale = b.check.stale === true ? ', stale' : '';
    if (b.check.state === 'fail') {
      lines.push(`check: FAIL (exit ${b.check.code ?? '?'}${took}${stale})`);
      if (b.check.tail !== undefined) lines.push(b.check.tail.trimEnd());
    } else {
      lines.push(`check: ${b.check.state}${took}${stale}`);
    }
  } else {
    lines.push('check: never run');
  }
  if (b.errors.length > 0) {
    lines.push(`errors seen in the terminal (heuristic):`);
    for (const e of b.errors) lines.push(`  ${e.line}`);
  }
  if (b.diff.total > 0 || b.diff.uncommitted > 0) {
    const added = b.diff.files.reduce((a, f) => a + f.added, 0);
    const deleted = b.diff.files.reduce((a, f) => a + f.deleted, 0);
    const shown = b.diff.files.length === b.diff.total ? 'all' : `${b.diff.files.length} of ${b.diff.total}`;
    lines.push(`diff: ${b.diff.total} file(s), +${added} −${deleted} in the ${shown} shown, ${b.diff.uncommitted} uncommitted`);
    for (const f of b.diff.files) lines.push(`  ${f.status.padEnd(8)} ${f.path}`);
    if (b.diff.files.length < b.diff.total) lines.push(`  … ${b.diff.total - b.diff.files.length} more`);
  }
  if (b.latestWords !== undefined) lines.push(`latest words: ${b.latestWords.trimEnd()}`);
  if (!raw) lines.push(REDACTED_NOTE);
  return lines.join('\n');
}

export type SessionPick =
  | { ok: true; idOrName: string }
  | { ok: false; code: string; message: string }

/**
 * Which session the bundle is for: an explicit name/id wins (not found is an error);
 * without one, the session standing at `cwd` (the hook-shell path); never both.
 */
export function debugSession(
  rows: ReadonlyArray<{ id: string; name: string; worktreePath: string | null }>,
  explicit: string | undefined,
  cwd: string,
): SessionPick {
  if (explicit !== undefined && explicit !== '') {
    const hit = rows.find((s) => s.id === explicit || s.name === explicit);
    if (hit === undefined) return { ok: false, code: 'SESSION_NOT_FOUND', message: `No such session: ${explicit}` };
    return { ok: true, idOrName: hit.name };
  }
  const byCwd = sessionForCwd(rows, cwd);
  if (byCwd === undefined) return { ok: false, code: 'INVALID_ARGUMENTS', message: 'Name the session: cw debug <session> (or run this from a session shell)' };
  return { ok: true, idOrName: byCwd };
}

export const debugCommand = defineCommand({
  meta: {
    name: 'debug',
    description: 'One compact debug bundle for a session: the check verdict with its failing tail, the errors its terminal showed, the diffstat and the agent\'s latest words — made to be pasted to an AI',
  },
  args: {
    session: { type: 'positional', required: false, description: 'Session name or id (default: this shell\'s own session)' },
    raw: { type: 'boolean', default: false, description: 'Skip the secret scrubber' },
  },
  async run({ args }) {
    try {
      const explicit = typeof args.session === 'string' && args.session !== '' ? args.session : process.env['CW_SESSION_ID'];
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        const rows = await client.call<Array<{ id: string; name: string; worktreePath: string | null }>>('session.list', { workspaceId });
        const pick = debugSession(rows, explicit ?? undefined, process.cwd());
        if (!pick.ok) throw new CrossweaveError(pick.code, pick.message);
        const bundle = await client.call<DebugBundle>('session.debug', { workspaceId, idOrName: pick.idOrName, raw: args.raw === true });
        process.stdout.write(`${renderDebug(bundle, args.raw === true)}\n`);
        if (bundle.check?.state === 'fail') process.exitCode = 1;
      });
    } catch (err) { fail(err); }
  },
});
