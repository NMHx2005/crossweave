export interface WorkspaceSwitchWindow {
  show(): void
  focus(): void
}

export interface WorkspaceSwitchDeps {
  ensure(projectRoot: string): Promise<void>
  /**
   * The window showing `projectRoot`: the existing one told to put it on the stage
   * (its other projects keep their live panes), or a new one when none is open.
   */
  reveal(projectRoot: string): WorkspaceSwitchWindow
}

export async function switchCockpitWorkspace(
  projectRoot: string,
  deps: WorkspaceSwitchDeps,
): Promise<void> {
  await deps.ensure(projectRoot)
  const win = deps.reveal(projectRoot)
  win.show()
  win.focus()
}
