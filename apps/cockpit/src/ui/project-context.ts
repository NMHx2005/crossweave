import { createContext } from 'preact'
import { useContext } from 'preact/hooks'
import { cockpitApi, type CockpitApi } from '../host/cockpit-api'

/**
 * The API of the project a component belongs to. Each project's view provides its own
 * (`projectApi(root)`), so a pane in a view off the stage still talks to its project's
 * daemon and hears only its project's output.
 */
export const ProjectApiContext = createContext<CockpitApi>(cockpitApi)

export function useProjectApi(): CockpitApi {
  return useContext(ProjectApiContext)
}
