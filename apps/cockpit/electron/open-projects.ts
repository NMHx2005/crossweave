import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { app } from 'electron'

/**
 * The projects the rail lists, in the order they were opened. Kept apart from the
 * Open Recent menu's history: closing a project from the rail must not erase it from
 * the history, and the history is capped where this list is not.
 */
function openProjectsPath(): string {
  return join(app.getPath('userData'), 'open-projects.json')
}

export function loadOpenProjects(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(openProjectsPath(), 'utf8')) as { open?: unknown }
    if (Array.isArray(parsed.open)) {
      return parsed.open.filter((x): x is string => typeof x === 'string' && isAbsolute(x))
    }
  } catch {
    // missing or unreadable: no projects yet
  }
  return []
}

export function saveOpenProjects(roots: string[]): void {
  try {
    mkdirSync(dirname(openProjectsPath()), { recursive: true })
    writeFileSync(openProjectsPath(), `${JSON.stringify({ open: roots }, null, 2)}\n`)
  } catch {
    // best effort: the rail simply starts from the active project next time
  }
}
