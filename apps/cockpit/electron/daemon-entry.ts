import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type CockpitDaemonEntryOptions = {
  isPackaged?: boolean
  resourcesPath?: string
}

export function findCrossweaveRoot(startDir: string): string {
  let dir = startDir
  for (;;) {
    if (
      existsSync(join(dir, 'src', 'daemon', 'main.ts')) &&
      existsSync(join(dir, 'src', 'client', 'rpc-client.ts'))
    ) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(`Could not find crossweave repo root from ${startDir}`)
    }
    dir = parent
  }
}

export function resolveCockpitDaemonEntry(
  repoRoot: string,
  bunCommand: string,
  options: CockpitDaemonEntryOptions = {},
): { command: string; args: string[] } {
  if (options.isPackaged) {
    const base = options.resourcesPath ?? process.resourcesPath
    return {
      command: join(base, 'bin', 'cwd'),
      args: [],
    }
  }
  return {
    command: bunCommand,
    args: [join(repoRoot, 'src', 'daemon', 'main.ts')],
  }
}
