export interface WorkspaceSwitchWindow {
  show(): void
  focus(): void
}

export interface WorkspaceSwitchDeps {
  ensure(projectRoot: string): Promise<void>
  recreateWindow(): WorkspaceSwitchWindow
}

export async function switchCockpitWorkspace(
  projectRoot: string,
  deps: WorkspaceSwitchDeps,
): Promise<void> {
  await deps.ensure(projectRoot)
  const win = deps.recreateWindow()
  win.show()
  win.focus()
}
