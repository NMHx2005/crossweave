import { findProjectRoot } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { connectOrStart, type DaemonClient } from '../client/rpc-client.js';
import { CrossweaveError } from '../core/errors.js';
import { realpathSync } from 'node:fs';

export async function withClient<T>(
  fn: (client: DaemonClient, projectRoot: string) => Promise<T>,
): Promise<T> {
  const projectRoot = findProjectRoot(process.cwd());
  // Parsed HERE, in the foreground, before anything can spawn a daemon. `buildMethods`
  // loads the config too, but that runs inside the DETACHED daemon process whose stdio
  // is 'ignore': a CONFIG_INVALID thrown there kills the daemon before it binds its
  // socket, and all the user ever sees is `connectOrStart` giving up after 10 seconds
  // with DAEMON_START_FAILED. Throwing in this process is what lets fail() print the
  // real code and message. The daemon-side load stays as belt and braces.
  loadConfig(projectRoot);
  const client = await connectOrStart(projectRoot);
  try {
    return await fn(client, projectRoot);
  } finally {
    client.close();
  }
}

/** Every command funnels failures here so the exit code and stderr shape stay uniform. */
export function fail(err: unknown): never {
  const code = err instanceof CrossweaveError ? err.code : 'INTERNAL';
  // Collapse to exactly one line. Errors that wrap a subprocess's output carry its
  // multi-line stderr, and those extra lines would reach the terminal with no `CODE:`
  // prefix — the one thing a script or the TUI cannot parse.
  // [\r\n] not just \n: a lone carriage return can overwrite the line in a terminal.
  // Trimmed because a wrapped message that ended in a newline otherwise leaves a
  // stray trailing space.
  const message = String((err as Error).message).replace(/\s*[\r\n]+\s*/g, ' ').trim();
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(1);
}

export async function currentWorkspaceId(client: DaemonClient): Promise<string> {
  const ws = await client.call<{ id: string }>('workspace.init', {});
  return ws.id;
}

/**
 * The session standing at `cwd` (used by `cw notify` and `cw debug` when neither
 * `--session` nor `$CW_SESSION_ID` names one): exact path match after canonicalising
 * BOTH sides — the stored worktree path may be written `/var/...` where the shell
 * stands at `/private/var/...` (macOS symlink), and a trailing slash or a symlink in
 * between must not make a legitimate session unfindable.
 */
export function sessionForCwd(
  rows: ReadonlyArray<{ name: string; worktreePath: string | null }>,
  cwd: string,
): string | undefined {
  let here: string;
  try {
    here = realpathSync(cwd);
  } catch {
    here = cwd.replace(/\/+$/, '');
  }
  for (const row of rows) {
    const raw = row.worktreePath;
    if (raw === null || raw === '') continue;
    let wt: string;
    try {
      wt = realpathSync(raw);
    } catch {
      continue;
    }
    if (wt === here) return row.name;
  }
  return undefined;
}
