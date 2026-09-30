import type { SessionPreset } from '../../../../src/core/settings.js'

export type PresetPlan = { launcher: string; worktree: boolean; terminals: string[]; browserPath: string | undefined }

/** A preset with its defaults filled in: a plain terminal, an own worktree, nothing extra. */
export function planPreset(preset: SessionPreset): PresetPlan {
  return {
    launcher: preset.launcher ?? 'terminal',
    worktree: preset.worktree ?? true,
    terminals: preset.terminals ?? [],
    browserPath: preset.browser === undefined ? undefined : (preset.browser.path ?? '/'),
  }
}

/** Where the session's dev server listens by convention (its leased port); undefined when none was leased. */
export function presetUrl(portBase: number | undefined, path: string): string | undefined {
  if (portBase === undefined || !Number.isInteger(portBase) || portBase < 1 || portBase > 65535) return undefined
  return `http://localhost:${portBase}${path}`
}

/** One line for what a click on the preset will do. */
export function describePreset(preset: SessionPreset, launcherLabel: (id: string) => string): string {
  const plan = planPreset(preset)
  return [
    plan.launcher === 'terminal' ? 'terminal' : launcherLabel(plan.launcher),
    plan.worktree ? 'own worktree' : 'project folder',
    plan.terminals.length > 0 ? `runs ${plan.terminals.join(', ')}` : '',
    plan.browserPath !== undefined ? 'browser on its port' : '',
  ].filter(Boolean).join(' · ')
}
