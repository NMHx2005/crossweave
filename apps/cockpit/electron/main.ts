import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, execFileSync } from 'node:child_process'
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, webContents } from 'electron'
import { connectOrStart } from '../../../src/client/rpc-client.js'
import { COCKPIT_CHANNELS, isCockpitChannel, type CockpitEvent } from './channels'
import { DaemonBridge } from './daemon-bridge'
import { findCrossweaveRoot, resolveCockpitDaemonEntry } from './daemon-entry'
import { projectRootFromAdditionalData, projectRootFromArgv, resolveLaunchProjectRoot } from './project-root'
import { switchCockpitWorkspace } from './workspace-switch'
import { clearRecent, loadRecent, pushRecent } from './recent.js'
import { recentMenuItems } from './recent-menu'
import { addPlainProject, loadOpenProjects, loadPlainProjects, saveOpenProjects } from './open-projects'
import { COCKPIT_TOKENS } from '../src/ui/tokens'
import { appMenuTemplate } from './app-menu'
import { editorLaunch, resolveLinkTarget } from './editor-open'
import { badgeCount, folderLaunch, resolveFolder } from './path-target'
import { importSources, importTerminal, type ImportDeps } from './terminal-import'
import { listFonts } from './fonts'
import { CommandBridgeServer } from './command-bridge'
import { RendererBridge } from './renderer-bridge'
import { BrowserAgent } from './browser-agent'
import { collectDashboard } from './dashboard'
import { MAX_DRAFT_CHARS, refine as refineDraft, resolveCommand, type RefineDeps } from './prompt-refine'
import { BROWSER_COMMANDS } from '../../../src/core/browser-agent/permission.js'
import { PANE_KINDS } from '../src/lib/pane-bridge'
import { findRepos, folderKind } from '../../../src/core/folder-kind.js'
import { initGit, inspectFolder } from './folder-open'
import { loadSettings, saveSettings } from '../../../src/core/settings.js'
import { restoreGuarded, withGuardedFromFile } from './settings-guard'

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

/** The hop for bridge requests that only the window can carry out (layout lives in the renderer). */
const rendererBridge = new RendererBridge({
  send: (event, payload) => {
    const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    for (const win of windows) win.webContents.send(event, payload)
    return windows.length > 0
  },
})

/**
 * What a shell command may do to a Browser pane. The guest lookup is the trust anchor: only a `webview` guest
 * hosted by one of OUR windows can be attached to, so a page cannot register itself and nothing else in the app
 * is reachable through this.
 */
const browserAgent = new BrowserAgent({
  guest: (id) => {
    const contents = webContents.fromId(id)
    if (contents === undefined || contents.isDestroyed() || contents.getType() !== 'webview') return null
    const host = contents.hostWebContents
    if (host === undefined || !BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.webContents === host)) return null
    return contents
  },
  // Native, from main: the page cannot draw over it or answer it. It has a parent so that `signal` can close it on macOS.
  confirm: async (q, signal) => {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    const options = { type: 'question' as const, title: q.title, message: q.title, detail: q.body, buttons: [q.confirmLabel, 'Refuse'], defaultId: 1, cancelId: 1, noLink: true, signal }
    const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    return result.response === 0
  },
  emit: (activity) => sendToRenderers('browser.activity', activity),
})

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
  // What a shell command may ask this window to do. `pane.ping` only proves the channel:
  // the pane and browser kinds register here as their features land, each with its own checks.
  const commandBridge = new CommandBridgeServer()
  commandBridge.serve('pane.ping', (_params, ctx) => ({ pong: true, projectRoot: ctx.projectRoot }))
  // Every other pane kind is decided by the window: it owns the layout, and it asks the person where it must.
  for (const kind of PANE_KINDS) commandBridge.serve(kind, (params, ctx) => rendererBridge.ask(kind, params, { projectRoot: ctx.projectRoot }))
  // The Browser pane's kinds are decided here in main (permission, origin, confirmation), never in the daemon or the window.
  for (const command of BROWSER_COMMANDS) commandBridge.serve(`browser.${command}`, (params, ctx) => browserAgent.handle(`browser.${command}`, params, ctx))
  return new DaemonBridge({
    commandBridge,
    // A folder the user opened as a plain folder gets a daemon that serves it without git.
    connect: (projectRoot) => connectOrStart(projectRoot, loadPlainProjects().includes(projectRoot) ? { ...entry, env: { CW_PLAIN: '1' } } : entry),
    pickFolder,
    loadSavedRoot,
    saveRoot,
    forgetSavedRoot,
    exists: existsSync,
    send: sendToRenderers,
    loadOpenRoots: loadOpenProjects,
    saveOpenRoots: saveOpenProjects,
    isPlain: (root) => loadPlainProjects().includes(root),
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

/** The PATH a login shell would give (read once, only when a program is not found otherwise). */
let loginPathCache: Promise<string | undefined> | undefined
function loginShellPath(): Promise<string | undefined> {
  loginPathCache ??= new Promise((resolve) => {
    const shell = process.env.SHELL && process.env.SHELL.startsWith('/') ? process.env.SHELL : '/bin/zsh'
    // argv only; the shell reads the user's own start-up files, then prints its PATH.
    execFile(shell, ['-ilc', 'printf %s "$PATH"'], { timeout: 4000, encoding: 'utf8', maxBuffer: 64 * 1024 },
      (err, stdout) => resolve(err ? undefined : String(stdout).trim() || undefined))
  })
  return loginPathCache
}

/**
 * The composer's Refine. The command is the user's own program from their SAVED settings (read here, never taken
 * from the request), run as argv with a timeout and an output cap; nothing it prints is sent anywhere.
 */
function refineDeps(): RefineDeps {
  return {
    home: app.getPath('home'),
    loadPrompt: () => loadSettings().prompt,
    resolveCommand: (command) => resolveCommand(command, {
      home: app.getPath('home'),
      pathEnv: process.env.PATH ?? '',
      isExecutable: (path) => { try { accessSync(path, fsConstants.X_OK); return true } catch { return false } },
      loginPath: loginShellPath,
    }),
    run: (command, args, opts) => new Promise((resolve, reject) => {
      const child = execFile(command, args, { timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err === null) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) })
        const code = (err as NodeJS.ErrnoException).code
        // Could not start at all (not installed, not executable): the caller words that.
        if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return reject(err)
        if ((err as { killed?: boolean }).killed) {
          return resolve({ code: 124, stdout: String(stdout), stderr: `${String(stderr)}\ntimed out after ${Math.round(opts.timeoutMs / 1000)}s` })
        }
        resolve({ code: typeof code === 'number' ? code : 1, stdout: String(stdout), stderr: String(stderr) })
      })
      child.stdin?.end(opts.input)
    }),
  }
}

async function promptRefine(payload: unknown): Promise<unknown> {
  const p = payload as { text?: unknown; context?: unknown } | null
  if (typeof p?.text !== 'string' || p.text.length > MAX_DRAFT_CHARS) return { ok: false, reason: 'There is nothing to refine.' }
  const context = typeof p.context === 'string' && p.context.length <= MAX_DRAFT_CHARS ? p.context : undefined
  return refineDraft(refineDeps(), { text: p.text, ...(context === undefined ? {} : { context }) })
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
      if (channel === 'prompt.refine') return promptRefine(payload)
      if (channel === 'dashboard.get') {
        return collectDashboard({
          roots: async () => ((await bridge.handle('projects.list')) as { open?: string[] }).open ?? [],
          overview: (root) => bridge.handle('stats.overview', { projectRoot: root }),
          metrics: () => app.getAppMetrics().map((m) => ({ type: m.type, memoryKb: m.memory.workingSetSize, cpu: m.cpu.percentCPUUsage })),
        })
      }
      if (channel === 'bridge.reply') { rendererBridge.reply(payload); return { ok: true } }
      if (channel === 'browser.setAccess') return browserAgent.setAccess(payload)
      if (channel === 'browser.errors') return browserAgent.readErrors((payload as { projectRoot?: unknown } | null)?.projectRoot)
      if (channel === 'terminal.importSources') return importSources(importDeps())
      if (channel === 'fonts.list') return listFonts(importDeps().run)
      if (channel === 'folder.inspect') {
        return inspectFolder((payload as { path?: unknown } | null)?.path, { kind: folderKind, findRepos, plainChosen: (p) => loadPlainProjects().includes(p) })
      }
      if (channel === 'folder.openPlain') {
        const path = (payload as { path?: unknown } | null)?.path
        // Only a folder that really has no git: a repository opens as one.
        if (typeof path !== 'string' || inspectFolder(path, { kind: folderKind, findRepos: () => [] }).kind !== 'plain') return { ok: false }
        addPlainProject(path)
        return { ok: true }
      }
      if (channel === 'folder.initGit') {
        return initGit((payload as { path?: unknown } | null)?.path, {
          kind: folderKind,
          findRepos,
          run: (command, args, cwd) => new Promise((resolve) => {
            execFile(command, args, { cwd, timeout: 10_000, encoding: 'utf8' }, (err, stdout) => resolve({ ok: !err, out: String(stdout ?? '') }))
          }),
        })
      }
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
      // The project's daemon may predate `persistence`, `prompt` or `presets` and would drop them: see settings-guard.ts.
      if (channel === 'settings.get') { const file = loadSettings(); return withGuardedFromFile(await bridge.handle(channel, payload), { persistence: file.persistence, prompt: file.prompt, presets: file.presets }) }
      if (channel === 'settings.set') {
        const answer = await bridge.handle(channel, payload)
        const file = loadSettings()
        const lost = restoreGuarded(payload, { persistence: file.persistence, prompt: file.prompt, presets: file.presets })
        if (Object.keys(lost).length === 0) return answer
        try {
          saveSettings({ ...file, ...lost })
          return withGuardedFromFile(answer, lost)
        } catch {
          // Refused by validation: the daemon's answer stands.
          return answer
        }
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

  // Not a repository's top level (`cw` run in a plain folder, Open Recent on one): the
  // window's Open folder dialog explains it — starting a daemon there cannot work.
  if (folderKind(projectRoot).kind !== 'repo' && !loadPlainProjects().includes(projectRoot)) {
    const existing = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (existing) {
      existing.webContents.send('cockpit.command', { command: 'show-project', projectRoot })
      existing.show()
      existing.focus()
    }
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
    // The window has no use for the microphone or camera: refuse them. Every other request keeps
    // the behaviour it had before this handler existed (granted).
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(permission !== 'media')
    })
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
