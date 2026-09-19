import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CockpitLaunchDeps {
  platform: string;
  arch: string;
  homeDir: string;
  cwd: string;
  exists: (path: string) => boolean;
  launch: (argv: readonly string[]) => Promise<number>;
}

export function cockpitAppPath(homeDir: string): string {
  return join(homeDir, 'Applications', 'crossweave Cockpit.app');
}

function cockpitExecutablePath(homeDir: string): string {
  return join(cockpitAppPath(homeDir), 'Contents', 'MacOS', 'crossweave Cockpit');
}

async function launch(argv: readonly string[]): Promise<number> {
  const proc = Bun.spawn([...argv], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return proc.exited;
}

export async function tryOpenCockpit(overrides: Partial<CockpitLaunchDeps> = {}): Promise<boolean> {
  const deps: CockpitLaunchDeps = {
    platform: process.platform,
    arch: process.arch,
    homeDir: homedir(),
    cwd: process.cwd(),
    exists: existsSync,
    launch,
    ...overrides,
  };

  if (deps.platform !== 'darwin' || deps.arch !== 'arm64') return false;

  const appPath = cockpitAppPath(deps.homeDir);
  if (!deps.exists(cockpitExecutablePath(deps.homeDir))) return false;

  try {
    const code = await deps.launch([
      'open',
      '-n',
      '-a',
      appPath,
      '--args',
      `--project-root=${deps.cwd}`,
    ]);
    return code === 0;
  } catch {
    return false;
  }
}
