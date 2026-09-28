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

function plainProjectsPath(): string {
  return join(app.getPath('userData'), 'plain-projects.json')
}

/**
 * Folders without git the user chose to open as plain folders: only their daemons are
 * started with CW_PLAIN=1, so no other folder ever becomes a project by accident.
 */
export function loadPlainProjects(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(plainProjectsPath(), 'utf8')) as { plain?: unknown }
    if (Array.isArray(parsed.plain)) return parsed.plain.filter((x): x is string => typeof x === 'string' && isAbsolute(x))
  } catch {
    // none yet
  }
  return []
}

export function addPlainProject(root: string): void {
  const list = loadPlainProjects()
  if (list.includes(root)) return
  try {
    mkdirSync(dirname(plainProjectsPath()), { recursive: true })
    writeFileSync(plainProjectsPath(), `${JSON.stringify({ plain: [...list, root] }, null, 2)}\n`)
  } catch {
    // best effort: the dialog is shown again next time
  }
}

export function saveOpenProjects(roots: string[]): void {
  try {
    mkdirSync(dirname(openProjectsPath()), { recursive: true })
    writeFileSync(openProjectsPath(), `${JSON.stringify({ open: roots }, null, 2)}\n`)
  } catch {
    // best effort: the rail simply starts from the active project next time
  }
}
