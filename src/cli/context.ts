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
  process.stderr.write(`${code}: ${(err as Error).message}\n`);
  process.exit(1);
}

export async function currentWorkspaceId(client: DaemonClient): Promise<string> {
  const ws = await client.call<{ id: string }>('workspace.init', {});
  return ws.id;
}
