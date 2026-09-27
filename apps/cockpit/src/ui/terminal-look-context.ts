import { createContext } from 'preact'
import { useContext } from 'preact/hooks'
import type { TerminalAppearance } from '../../../../src/core/settings.js'

/** Settings → Terminal, for every pane in the window; undefined is the cockpit's own look. */
export const TerminalLookContext = createContext<TerminalAppearance | undefined>(undefined)

export function useTerminalLook(): TerminalAppearance | undefined {
  return useContext(TerminalLookContext)
}
