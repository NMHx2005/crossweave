import { isAbsolute } from 'node:path'

const PROJECT_ROOT_PREFIX = '--project-root='

function absoluteProjectRoot(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && isAbsolute(value) ? value : undefined
}

export function projectRootFromArgv(argv: readonly string[]): string | undefined {
  const argument = argv.find((value) => value.startsWith(PROJECT_ROOT_PREFIX))
  if (argument === undefined) return undefined
  return absoluteProjectRoot(argument.slice(PROJECT_ROOT_PREFIX.length))
}

export function resolveLaunchProjectRoot(
  argv: readonly string[],
  envRoot?: string,
): string | undefined {
  return projectRootFromArgv(argv) ?? absoluteProjectRoot(envRoot)
}

export function projectRootFromAdditionalData(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return absoluteProjectRoot((value as { projectRoot?: unknown }).projectRoot)
}
