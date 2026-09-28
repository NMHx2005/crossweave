import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, execFileSync } from 'node:child_process'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { connectOrStart } from '../../../src/client/rpc-client.js'
import { COCKPIT_CHANNELS, isCockpitChannel, type CockpitEvent } from './channels'
import { DaemonBridge } from './daemon-bridge'
import { findCrossweaveRoot, resolveCockpitDaemonEntry } from './daemon-entry'
import { projectRootFromAdditionalData, projectRootFromArgv, resolveLaunchProjectRoot } from './project-root'
import { switchCockpitWorkspace } from './workspace-switch'
import { clearRecent, loadRecent, pushRecent } from './recent.js'
import { recentMenuItems } from './recent-menu'
import { loadOpenProjects, saveOpenProjects } from './open-projects'
import { COCKPIT_TOKENS } from '../src/ui/tokens'
import { appMenuTemplate } from './app-menu'
import { editorLaunch, resolveLinkTarget } from './editor-open'
import { badgeCount, folderLaunch, resolveFolder } from './path-target'
import { importSources, importTerminal, type ImportDeps } from './terminal-import'
import { listFonts } from './fonts'
import { loadSettings } from '../../../src/core/settings.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function savedRootPath(): string {
  return join(app.getPath('userData'), 'project-root.json')
}

function loadSavedRoot(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(savedRootPath(), 'utf8')) as { projectRoot?: unknown }
    return typeof parsed.projectRoot === 'string' ? parsed.projectRoot : undefined
  } catch {
    return undefined
  }
}

function saveRoot(root: string): void {
  const file = savedRootPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ projectRoot: root })}\n`)
  // Rebuilt here, after the push, so Open Recent lists the folder just opened. It
  // used to be rebuilt before the switch had persisted anything, one switch behind.
  try {
    pushRecent(root)
    buildMenu()
  } catch {}
}

function forgetSavedRoot(): void {
  try {
    writeFileSync(savedRootPath(), '{}\n')
  } catch {}
}

function sendToRenderers(event: CockpitEvent, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(event, payload)
  }
}

async function pickFolder(): Promise<string | undefined> {
  const parent = BrowserWindow.getAllWindows()[0]
  const options = {
    title: 'Open crossweave project',
    properties: ['openDirectory' as const],
  }
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled) return undefined
  return result.filePaths[0]
}

function resolveBunCommand(): string {
  if (process.env.BUN) return process.env.BUN
  try {
    return execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
  } catch {
    return 'bun'
  }
}

function buildMenu(): void {
  const template = appMenuTemplate({
    platform: process.platform,
    // Settings → Keyboard, read from the user's file (the daemon validated it on save).
    keybindings: loadSettings().keybindings,
    command: (name) => sendToRenderers('cockpit.command', { command: name }),
    recent: recentMenuItems(loadRecent(), {
      exists: existsSync,
      home: app.getPath('home'),
      open: (root) => { void switchWorkspace(root) },
      clear: () => {
        clearRecent()
        buildMenu()
      },
    }),
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createBridge(): DaemonBridge {
  const entry = app.isPackaged
    ? resolveCockpitDaemonEntry('', '', { isPackaged: true })
    : resolveCockpitDaemonEntry(findCrossweaveRoot(__dirname), resolveBunCommand())
  return new DaemonBridge({
    connect: (projectRoot) => connectOrStart(projectRoot, entry),
    pickFolder,
    loadSavedRoot,
    saveRoot,
    forgetSavedRoot,
    exists: existsSync,
    send: sendToRenderers,
    loadOpenRoots: loadOpenProjects,
    saveOpenRoots: saveOpenProjects,
  })
}

/**
 * Open a file a session's output linked to, in the user's editor. The worktree comes
 * from the daemon's own session list — not from the renderer — and the target must be
 * an existing file inside it (resolveLinkTarget).
 */
async function openInEditor(bridge: DaemonBridge, payload: unknown): Promise<{ ok: boolean; inApp?: boolean; path?: string; line?: number; col?: number }> {
  const p = (payload ?? {}) as { sessionId?: unknown; path?: unknown; line?: unknown; col?: unknown; projectRoot?: unknown }
  if (typeof p.sessionId !== 'string' || typeof p.path !== 'string') return { ok: false }
  // The session's own project (a view off the stage names it); the bridge refuses one
  // that is not open in this window.
  const sessions = await bridge.handle('session.list', typeof p.projectRoot === 'string' ? { projectRoot: p.projectRoot } : undefined) as Array<{ id: string; worktreePath?: string | null }>
  const worktree = sessions.find((s) => s.id === p.sessionId)?.worktreePath
  if (typeof worktree !== 'string') return { ok: false }
  const file = resolveLinkTarget(worktree, p.path)
  if (file === null) return { ok: false }
  const line = typeof p.line === 'number' && p.line > 0 ? p.line : 1
  const col = typeof p.col === 'number' && p.col > 0 ? p.col : 1
  const editor = loadSettings().editor
  // In-app: the renderer opens a file pane; hand back the path relative to the worktree.
  if (editor.kind === 'cockpit') return { ok: true, inApp: true, path: relative(worktree, file), line, col }
  const launch = editorLaunch(editor, file, line, col)
  if (launch.kind === 'url') {
    await shell.openExternal(launch.url)
  } else {
    const [command, ...args] = launch.argv
    if (command === undefined) return { ok: false }
    execFile(command, args, () => undefined)
  }
  return { ok: true }
}

async function folderFor(bridge: DaemonBridge, payload: unknown): Promise<string | null> {
  const { open } = await bridge.handle('projects.list') as { open: string[] }
  return resolveFolder(payload, open, async (projectRoot) => {
    const snapshot = await bridge.handle('projects.sessions', { projectRoot }) as { sessions: Array<{ id: string; worktreePath?: string | null }> }
    return snapshot.sessions
  })
}

/** Finder, or the editor from Settings (the in-app editor has no folder view: Finder). */
async function openFolder(bridge: DaemonBridge, payload: unknown, how: 'reveal' | 'editor'): Promise<{ ok: boolean }> {
  const folder = await folderFor(bridge, payload)
  if (folder === null || !existsSync(folder)) return { ok: false }
  const editor = loadSettings().editor
  if (how === 'reveal' || editor.kind === 'cockpit') {
    shell.showItemInFolder(folder)
    return { ok: true }
  }
  const launch = folderLaunch(editor, folder)
  if (launch.kind === 'url') {
    await shell.openExternal(launch.url)
  } else {
    const [command, ...args] = launch.argv
    if (command === undefined) return { ok: false }
    execFile(command, args, () => undefined)
  }
  return { ok: true }
}

/** Reads the user's terminal settings; argv-only subprocesses, bounded in time and size. */
function importDeps(): ImportDeps {
  return {
    home: app.getPath('home'),
    ...(process.env.XDG_CONFIG_HOME ? { xdgConfigHome: process.env.XDG_CONFIG_HOME } : {}),
    readFile: (path) => {
      try {
        const text = readFileSync(path, 'utf8')
        return text.length > 1_000_000 ? undefined : text
      } catch {
        return undefined
      }
    },
    run: (command, args) => new Promise((resolve) => {
      execFile(command, args, { timeout: 5000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout) => resolve(err ? undefined : String(stdout)))
    }),
  }
}

function setBadge(payload: unknown): { ok: boolean } {
  const count = badgeCount(payload)
  if (count === null) return { ok: false }
  app.setBadgeCount(count)
  return { ok: true }
}

function registerHandlers(bridge: DaemonBridge): void {
  for (const channel of COCKPIT_CHANNELS) {
    ipcMain.handle(channel, async (_event, payload: unknown) => {
      if (!isCockpitChannel(channel)) {
        throw new Error(`Disallowed invoke channel: ${channel}`)
      }
      if (channel === 'editor.open') return openInEditor(bridge, payload)
      if (channel === 'folder.reveal') return openFolder(bridge, payload, 'reveal')
      if (channel === 'folder.openInEditor') return openFolder(bridge, payload, 'editor')
      if (channel === 'app.badge') return setBadge(payload)
      if (channel === 'terminal.importSources') return importSources(importDeps())
      if (channel === 'fonts.list') return listFonts(importDeps().run)
      // Only folders that still exist: a deleted project must not be offered.
      if (channel === 'projects.recent') return loadRecent().filter((root) => existsSync(root))
      if (channel === 'menu.refresh') {
        buildMenu()
        return { ok: true }
      }
      if (channel === 'terminal.import') {
        const from = (payload as { from?: unknown } | null)?.from
        if (from !== 'ghostty' && from !== 'iterm2') return { ok: false, reason: 'Import from ghostty or iterm2' }
        return importTerminal(from, importDeps())
      }
      return bridge.handle(channel, payload)
    })
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 480,
    title: 'crossweave Cockpit',
    // Deck's chrome: no title bar; the traffic lights sit in the sidebar's top row,
    // and the sidebar and tab strip are the window's drag regions.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
    backgroundColor: COCKPIT_TOKENS['--cw-surface'],
    webPreferences: {
      preload: join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The browser pane. Every <webview> is locked down in hardenWebviews() below.
      webviewTag: true,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void win.loadFile(join(__dirname, '../dist/index.html'))
  }
  return win
}

/**
 * The browser pane loads arbitrary web pages next to the app, so each <webview> gets
 * none of the app's powers: no preload, no Node, its own sandboxed process and
 * session partition, http(s) only. A page opening a window goes to the user's
 * browser instead of a new Electron window with defaults nobody reviewed.
 */
function hardenWebviews(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event, prefs, params) => {
      delete (prefs as { preload?: string }).preload
      prefs.nodeIntegration = false
      prefs.nodeIntegrationInSubFrames = false
      prefs.contextIsolation = true
      prefs.sandbox = true
      prefs.webSecurity = true
      // http(s), or the blank page an empty browser pane starts on.
      const src = params.src ?? ''
      if (src !== 'about:blank' && !/^https?:\/\//i.test(src)) event.preventDefault()
    })
    if (contents.getType() === 'webview') {
      contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
        return { action: 'deny' }
      })
      contents.on('will-navigate', (event, url) => {
        if (!/^https?:\/\//i.test(url)) event.preventDefault()
      })
    }
  })
}

let bridge: DaemonBridge | undefined
let pendingProjectRoot: string | undefined

async function switchWorkspace(projectRoot: string): Promise<void> {
  if (!bridge) {
    pendingProjectRoot = projectRoot
    return
  }

  try {
    await switchCockpitWorkspace(projectRoot, {
      ensure: async (root) => {
        await bridge?.handle('workspace.ensure', { projectRoot: root })
      },
      // Never destroy the window: it holds every open project's live panes.
      reveal: (root) => {
        const existing = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
        if (existing === undefined) return createWindow()
        existing.webContents.send('cockpit.command', { command: 'show-project', projectRoot: root })
        return existing
      },
    })
  } catch (err) {
    console.error('workspace switch failed:', err)
  }
}

const initialProjectRoot = resolveLaunchProjectRoot(process.argv, process.env.COCKPIT_PROJECT_ROOT)
const hasSingleInstanceLock = app.requestSingleInstanceLock(
  initialProjectRoot ? { projectRoot: initialProjectRoot } : {},
)
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    const projectRoot = projectRootFromAdditionalData(additionalData) ?? projectRootFromArgv(argv)
    if (projectRoot !== undefined) void switchWorkspace(projectRoot)
  })

  app.whenReady().then(async () => {
    hardenWebviews()
    buildMenu()
    bridge = createBridge()
    registerHandlers(bridge)
    createWindow()

    const launchRoot = pendingProjectRoot ?? initialProjectRoot
    pendingProjectRoot = undefined
    try {
      await bridge.handle('workspace.ensure', launchRoot ? { projectRoot: launchRoot } : undefined)
    } catch (err) {
      // No project yet is the welcome screen's job, not an error.
      if (!String(err).includes('NO_PROJECT')) console.error('workspace.ensure failed:', err)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  bridge?.close()
})
