import { AppearanceIcon, BellIcon, CheckIcon, CodeIcon, DashboardIcon, KeyboardIcon, LauncherIcon, PenIcon, PresetsIcon, TerminalIcon, UsageIcon } from './icons'

/** The page looks icons up by section id in a plain record: a section without an entry would render a blank nav button. */
export const SECTION_ICONS: Record<string, (p: { class?: string; title?: string }) => import('preact').JSX.Element> = {
  dashboard: DashboardIcon, appearance: AppearanceIcon, notifications: BellIcon, launchers: LauncherIcon, presets: PresetsIcon,
  prompt: PenIcon, checks: CheckIcon, editor: CodeIcon, terminal: TerminalIcon, keyboard: KeyboardIcon, usage: UsageIcon,
}
