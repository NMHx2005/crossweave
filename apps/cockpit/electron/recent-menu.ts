/** One File → Open Recent entry; a structural subset of Electron's MenuItemConstructorOptions. */
export interface RecentMenuItem {
  label: string
  enabled?: boolean
  type?: 'separator'
  click?: () => void
}

export interface RecentMenuDeps {
  exists(path: string): boolean
  home: string
  open(root: string): void
  clear(): void
}

/**
 * The Open Recent submenu. Pure (no Electron), so the menu's shape is testable.
 *
 * Clear Recent is always present: replacing the submenu wholesale with the list
 * dropped it exactly when there was something to clear. A folder that has since been
 * deleted stays listed but disabled — clicking it only logged a failed switch.
 */
export function recentMenuItems(recents: string[], deps: RecentMenuDeps): RecentMenuItem[] {
  const tilde = (p: string): string =>
    deps.home !== '' && (p === deps.home || p.startsWith(`${deps.home}/`)) ? `~${p.slice(deps.home.length)}` : p
  const list: RecentMenuItem[] = recents.length === 0
    ? [{ label: 'No Recent Folders', enabled: false }]
    : recents.map((root) => ({ label: tilde(root), enabled: deps.exists(root), click: () => deps.open(root) }))
  return [
    ...list,
    ...(recents.length === 0 ? [] : [{ label: '', type: 'separator' as const }]),
    { label: 'Clear Recent', enabled: recents.length > 0, click: () => deps.clear() },
  ]
}
