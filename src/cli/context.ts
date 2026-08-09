import { findProjectRoot } from '../core/paths.js';
import { connectOrStart, type DaemonClient } from '../client/rpc-client.js';
import { CrossweaveError } from '../core/errors.js';

export async function withClient<T>(
  fn: (client: DaemonClient, projectRoot: string) => Promise<T>,
): Promise<T> {
  const projectRoot = findProjectRoot(process.cwd());
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
  const message = String((err as Error).message).replace(/\s*\n\s*/g, ' ');
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(1);
}

export async function currentWorkspaceId(client: DaemonClient): Promise<string> {
  const ws = await client.call<{ id: string }>('workspace.init', {});
  return ws.id;
}
