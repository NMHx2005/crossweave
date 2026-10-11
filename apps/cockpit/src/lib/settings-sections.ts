/**
 * The settings page's map: which sections exist and which rows each holds. The
 * navigation, the search and the deep links all read this one list, so a setting is
 * described in exactly one place. The controls themselves live in SettingsPage; a row's
 * `id` is what its element carries as `data-setting`, which is how a search hit or a
 * deep link scrolls to it.
 */
export interface SettingsRow {
  id: string
  label: string
  description: string
  /** Words a person might type that the label does not contain. */
  keywords?: string
}

export interface SettingsSection {
  id: string
  title: string
  /** One line under the title: what the section is for. */
  summary: string
  /** The longer explanation, folded under the section's cards. Safety facts are not put here: they stay in a row's own words. */
  details: string
  rows: SettingsRow[]
}

/** The nav's groups (a hairline apart, like Cursor's): each names its sections, in order. Every section is in exactly one. */
export const SETTINGS_GROUPS: ReadonlyArray<{ id: string; sections: readonly string[] }> = [
  { id: 'general', sections: ['dashboard', 'appearance', 'notifications'] },
  { id: 'sessions', sections: ['launchers', 'presets', 'prompt', 'checks', 'editor'] },
  { id: 'terminal', sections: ['terminal', 'keyboard'] },
  { id: 'usage', sections: ['usage'] },
]

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: 'dashboard',
    title: 'Dashboard',
    summary: "What your projects and sessions cost in disk and memory.",
    details: "Disk is measured in the background, so a figure marked ≥ is a lower bound. Suggestions only propose: nothing is stopped or deleted without asking.",
    rows: [
      { id: 'dashboard-summary', label: 'Overview', description: 'Projects, sessions, the disk their worktrees hold and the memory the app and its daemons use', keywords: 'stats statistics usage resources ram memory disk space size' },
      { id: 'dashboard-suggestions', label: 'Suggestions to free space', description: 'Sessions and worktrees that could be stopped, cleaned up or deleted to lighten the machine', keywords: 'clean cleanup delete remove gc reclaim free space slow heavy' },
      { id: 'dashboard-projects', label: 'Projects', description: 'Each open project: its sessions, disk and daemon memory', keywords: 'daemon table' },
      { id: 'dashboard-sessions', label: 'Sessions', description: 'Every session across projects, biggest disk first, with stop and delete', keywords: 'worktree kill stop remove' },
    ],
  },
  {
    id: 'appearance',
    title: 'Appearance',
    summary: "Fonts, theme and text size for the window.",
    details: "Fonts and text size apply as you choose them and are saved as you choose them. The terminal's own font and colours are under Terminal.",
    rows: [
      { id: 'appearance-ui-font', label: 'Interface font', description: "The window's font", keywords: 'font typeface chrome' },
      { id: 'appearance-code-font', label: 'Code font', description: 'Commands, paths, branches and the file editor', keywords: 'font monospace mono' },
      { id: 'appearance-theme', label: 'Theme', description: 'System, dark, light, or the imported terminal colors', keywords: 'dark light color scheme mode' },
      { id: 'appearance-text-size', label: 'Text size', description: 'Small, default or large text in the window', keywords: 'zoom scale font size' },
    ],
  },
  {
    id: 'terminal',
    title: 'Terminal',
    summary: "How the panes look and behave.",
    details: "Import reads the font, size, colours and cursor of Ghostty or iTerm2 once; nothing is kept in sync. Keeping terminals across a daemon restart saves recent output on disk, off by default.",
    rows: [
      { id: 'terminal-import', label: 'Import from Ghostty or iTerm2', description: 'Read the look of the terminal you already use', keywords: 'ghostty iterm colors theme' },
      { id: 'terminal-font', label: 'Terminal font', description: "The panes' font", keywords: 'font monospace' },
      { id: 'terminal-size', label: 'Terminal font size', description: 'Size of the pane text', keywords: 'font size zoom' },
      { id: 'terminal-cursor', label: 'Cursor', description: 'Block, bar or underline', keywords: 'caret style' },
      { id: 'terminal-blink', label: 'Blinking cursor', description: 'Whether the cursor blinks', keywords: 'cursor caret' },
      { id: 'terminal-persist', label: 'Keep terminals across a daemon restart', description: 'Off by default: saves recent terminal output on disk so a restarted daemon can show it again', keywords: 'restore persist snapshot scrollback tmux history' },
      { id: 'terminal-option-meta', label: 'Option key sends Meta', description: 'Alt shortcuts in the shell and in agents', keywords: 'alt escape esc keyboard' },
    ],
  },
  {
    id: 'keyboard',
    title: 'Keyboard',
    summary: "Every command's shortcut, and how to change it.",
    details: "Change records the next keys you press; the menu updates as it is saved. A prefix key (Ctrl-A by default) followed by one key runs a command in a focused terminal.",
    rows: [
      { id: 'keyboard-shortcuts', label: 'Keyboard shortcuts', description: "Every command's shortcut", keywords: 'keys bindings hotkey accelerator phim tat' },
    ],
  },
  {
    id: 'launchers',
    title: 'Launchers',
    summary: "What a new session can start with.",
    details: "The command is typed into the session's shell, in its worktree; when it exits you are back at the prompt. Your aliases and wrappers work (for example cx).",
    rows: [
      { id: 'launchers-list', label: 'Launchers', description: 'What a new session can start with', keywords: 'claude codex command agent environment env' },
    ],
  },
  {
    id: 'editor',
    title: 'Editor',
    summary: "Where Cmd+click opens a file.",
    details: "Cmd+click on a path in a terminal opens it in the editor you choose here, at the line and column when the program printed them.",
    rows: [
      { id: 'editor-open-in', label: 'Cmd+click opens files in', description: 'VS Code, Cursor, Zed, the cockpit or a command', keywords: 'editor open file vscode zed' },
    ],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    summary: "When the cockpit tells you something while you look elsewhere.",
    details: "Alerts appear when a session waits for you, finishes or its tests fail, while you look elsewhere (another app, project or tab). These apply right away. An alert never shows test output.",
    rows: [
      { id: 'notify-finish', label: 'Also when an agent finishes', description: 'It stopped working without asking', keywords: 'notify alert done' },
      { id: 'notify-check-fail', label: 'When tests fail', description: "A run of the project's tests ended red while you look elsewhere. It never shows the output", keywords: 'notify alert test tests check failed red fail' },
      { id: 'notify-sound', label: 'Play a sound', description: 'A sound with each notification', keywords: 'notify audio' },
      { id: 'notify-dock', label: 'Count them on the Dock icon', description: 'A badge with the number waiting', keywords: 'notify badge' },
      { id: 'notify-updates', label: 'Tell me about new versions', description: 'A corner notice when a newer release exists. It asks GitHub for the latest version number, nothing else', keywords: 'update upgrade release version check network' },
    ],
  },
  {
    id: 'presets',
    title: 'Presets',
    summary: "One-click recipes for starting a session.",
    details: "A preset starts a session in one click from the new-session picker (⌘T): the launcher, an own worktree or not, shells that each run a command, and a Browser pane on the session's leased port. The commands are typed and run for you, so they are yours alone: they live in this settings file, never in a repository.",
    rows: [
      { id: 'preset-list', label: 'Session presets', description: 'One-click recipes in the new-session picker: a launcher, a worktree, terminals that run a command, a Browser pane', keywords: 'template recipe workflow dev server terminal browser worktree launcher' },
    ],
  },
  {
    id: 'prompt',
    title: 'Prompt',
    summary: "The composer and its optional Refine step.",
    details: "The prompt composer (⌘⇧P) writes one prompt and sends it to one or several sessions. Refine is optional: the program is yours (this app does not choose an AI); it reads the draft and prints a better one, which you read before it goes anywhere. Empty means the composer has no Refine button.",
    rows: [
      { id: 'prompt-refine-command', label: 'Refine command', description: 'The program the Refine button runs: it reads the draft on stdin and prints a better prompt. Empty means no Refine button', keywords: 'llm ai rewrite improve prompt claude compose' },
      { id: 'prompt-refine-instruction', label: 'Refine instruction', description: 'What the refine command is told to do; empty uses the default', keywords: 'prompt system' },
      { id: 'prompt-refine-context', label: 'Include session context', description: 'Adds the session\'s name, branch and changed-file count for the refine command', keywords: 'privacy branch' },
    ],
  },
  {
    id: 'checks',
    title: 'Checks',
    summary: "Run the project's tests when an agent finishes a turn.",
    details: "Runs converge.testCommand in the session's worktree after a turn that changed files, once you have trusted it with cw config trust. A test suite can take minutes of CPU after every agent turn, which is why it is off by default. The verdict shows on the session's row; Send test failure to shell pastes the end of the output without pressing Enter.",
    rows: [
      { id: 'checks-auto-run', label: 'Run checks when an agent finishes a turn', description: 'Runs your trusted test command after a turn that changed files: code the agent just wrote, outside its sandbox, for every project. Off by default', keywords: 'test tests automatic auto run ci verify' },
      { id: 'checks-notify-link', label: 'Alert when a run fails', description: 'A desktop notification while you look elsewhere. Set under Notifications', keywords: 'notify alert desktop notification test fail' },
    ],
  },
  {
    id: 'usage',
    title: 'Usage',
    summary: "Tokens and cost per session.",
    details: "Tokens the agents in each session have used, read from their own logs (Claude Code, Codex). The logs carry no prices: add yours (USD per million tokens) to see cost; a model without a price shows as tokens.",
    rows: [
      { id: 'usage-show', label: 'Show usage on the rail', description: 'Tokens and cost per session', keywords: 'tokens cost' },
      { id: 'usage-prices', label: 'Model prices', description: 'USD per million tokens, to show cost', keywords: 'price cost tokens dollars model' },
    ],
  },
]

export function findSection(id: string): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find((s) => s.id === id)
}

/** Lower-case with diacritics removed, so "phim tat" finds "Phím tắt". */
export function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
}

export interface SearchGroup {
  section: SettingsSection
  rows: SettingsRow[]
}

/** Rows whose label, description or keywords contain every word typed, grouped by section. */
export function searchSettings(query: string): SearchGroup[] {
  const words = foldText(query).split(/\s+/).filter((w) => w !== '')
  if (words.length === 0) return []
  const groups: SearchGroup[] = []
  for (const section of SETTINGS_SECTIONS) {
    const rows = section.rows.filter((row) => {
      const haystack = foldText(`${section.title} ${row.label} ${row.description} ${row.keywords ?? ''}`)
      return words.every((w) => haystack.includes(w))
    })
    if (rows.length > 0) groups.push({ section, rows })
  }
  return groups
}
