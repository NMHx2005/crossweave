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
  rows: SettingsRow[]
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: 'appearance',
    title: 'Appearance',
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
    rows: [
      { id: 'terminal-import', label: 'Import from Ghostty or iTerm2', description: 'Read the look of the terminal you already use', keywords: 'ghostty iterm colors theme' },
      { id: 'terminal-font', label: 'Terminal font', description: "The panes' font", keywords: 'font monospace' },
      { id: 'terminal-size', label: 'Terminal font size', description: 'Size of the pane text', keywords: 'font size zoom' },
      { id: 'terminal-cursor', label: 'Cursor', description: 'Block, bar or underline', keywords: 'caret style' },
      { id: 'terminal-blink', label: 'Blinking cursor', description: 'Whether the cursor blinks', keywords: 'cursor caret' },
      { id: 'terminal-option-meta', label: 'Option key sends Meta', description: 'Alt shortcuts in the shell and in agents', keywords: 'alt escape esc keyboard' },
    ],
  },
  {
    id: 'keyboard',
    title: 'Keyboard',
    rows: [
      { id: 'keyboard-shortcuts', label: 'Keyboard shortcuts', description: "Every command's shortcut", keywords: 'keys bindings hotkey accelerator phim tat' },
    ],
  },
  {
    id: 'launchers',
    title: 'Launchers',
    rows: [
      { id: 'launchers-list', label: 'Launchers', description: 'What a new session can start with', keywords: 'claude codex command agent environment env' },
    ],
  },
  {
    id: 'editor',
    title: 'Editor',
    rows: [
      { id: 'editor-open-in', label: 'Cmd+click opens files in', description: 'VS Code, Cursor, Zed, the cockpit or a command', keywords: 'editor open file vscode zed' },
    ],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    rows: [
      { id: 'notify-finish', label: 'Also when an agent finishes', description: 'It stopped working without asking', keywords: 'notify alert done' },
      { id: 'notify-sound', label: 'Play a sound', description: 'A sound with each notification', keywords: 'notify audio' },
      { id: 'notify-dock', label: 'Count them on the Dock icon', description: 'A badge with the number waiting', keywords: 'notify badge' },
    ],
  },
  {
    id: 'voice',
    title: 'Voice',
    rows: [
      { id: 'voice-command', label: 'Transcribe command', description: 'The program that turns a recording into text; {audio} and {language} are filled in', keywords: 'speech to text stt whisper microphone dictation' },
      { id: 'voice-language', label: 'Spoken language', description: 'Auto, Vietnamese or English', keywords: 'tieng viet vietnamese english whisper' },
      { id: 'voice-max', label: 'Longest recording', description: 'Seconds before a recording stops by itself', keywords: 'limit length duration' },
      { id: 'voice-snippets', label: 'Snippets', description: 'Text you add to a draft with one click', keywords: 'template phrase prompt tail' },
      { id: 'voice-refine', label: 'Refine the draft with a command', description: 'Off by default. A button that restructures the draft with a program you choose', keywords: 'llm ai rewrite improve prompt' },
      { id: 'voice-refine-command', label: 'Refine command', description: 'Reads the draft on stdin and prints the refined prompt', keywords: 'claude llm ai' },
      { id: 'voice-refine-instruction', label: 'Refine instruction', description: 'What the refine command is told to do', keywords: 'prompt system' },
      { id: 'voice-refine-auto', label: 'Refine after each transcription', description: 'Off by default', keywords: 'automatic' },
      { id: 'voice-refine-context', label: 'Include session context', description: 'Adds the branch and session name for the refine command', keywords: 'privacy branch' },
      { id: 'voice-test', label: 'Test the microphone and command', description: 'Records three seconds and shows what was heard', keywords: 'check try' },
    ],
  },
  {
    id: 'usage',
    title: 'Usage',
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
