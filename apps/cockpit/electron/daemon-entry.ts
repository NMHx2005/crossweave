import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
): { command: string; args: string[] } {
  return {
    command: bunCommand,
    args: [join(repoRoot, 'src', 'daemon', 'main.ts')],
  }
}
