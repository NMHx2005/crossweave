import { realpathSync } from 'node:fs';
import { findProjectRoot } from '../core/paths.js';

/**
 * The folder a daemon serves, and whether it has git. A repository's top level, as
 * always; a folder without git only when the daemon was started for it on purpose —
 * `CW_PLAIN=1`, set by the cockpit's "Open as a plain folder" — so `cw` run by mistake
 * in some folder still refuses rather than making it a project.
 */
export function resolveDaemonRoot(cwd: string, env: Record<string, string | undefined>): { projectRoot: string; git: boolean } {
  try {
    return { projectRoot: findProjectRoot(cwd), git: true };
  } catch (err) {
    if (env.CW_PLAIN === '1') return { projectRoot: realpathSync(cwd), git: false };
    throw err;
  }
}
