import { join } from 'node:path';
import { openDatabase } from '../db/open.js';
import { crossweaveDir } from '../core/paths.js';
import { CrossweaveError } from '../core/errors.js';
import { DAEMON_EXIT_ALREADY_RUNNING } from '../core/exit-codes.js';
import { daemonLog } from '../core/log.js';
import { resolveDaemonRoot } from './root.js';
import { createDaemon } from './server.js';
import { buildMethods } from './methods.js';

/** One stat every few seconds is noise; an unreachable daemon lingering that long is not. */
const SOCKET_WATCHDOG_MS = 5_000;

async function main(): Promise<void> {
  const { projectRoot, git } = resolveDaemonRoot(process.cwd(), process.env);
  const dir = crossweaveDir(projectRoot);
  const db = openDatabase(join(dir, 'state.db'));
  const daemon = createDaemon({
    socketPath: join(dir, 'daemon.sock'),
    methods: buildMethods(db, projectRoot, undefined, undefined, { startBackgroundJobs: true, git }),
    watchdogMs: SOCKET_WATCHDOG_MS,
    onSocketLost: () => {
      // The sessions this daemon owns die with it: closing the pty master SIGHUPs
      // each shell. Say how many, because nothing else records that they existed —
      // the next daemon reconciles the rows to `idle`/`dead` and the cause is gone.
      shutdown(`socket removed or replaced — shutting down, hanging up ${runningSessions()} session(s)`);
    },
  });

  await daemon.listen();
  daemonLog(`listening at ${join(dir, 'daemon.sock')}`);

  function runningSessions(): number {
    try {
      const row = db
        .query("SELECT count(*) AS n FROM session WHERE status IN ('running', 'waiting')")
        .get() as { n: number } | null;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  function shutdown(reason: string): void {
    daemonLog(reason);
    void daemon.close().then(() => {
      db.close();
      process.exit(0);
    });
  }
  process.on('SIGINT', () => shutdown('SIGINT — shutting down'));
  process.on('SIGTERM', () => shutdown('SIGTERM — shutting down'));
}

// A rejected main() is a STARTUP failure: this daemon never served anything, so it
// must exit. It used to fall through to the 'unhandledRejection' handler below, which
// only logs — so a daemon that lost the bind race (DAEMON_ALREADY_RUNNING) or could
// not open its database lingered forever, and `connectOrStart` spawns one more on
// every failed connect. Hundreds accumulated on one machine.
main().catch((err: unknown) => {
  if (err instanceof CrossweaveError && err.code === 'DAEMON_ALREADY_RUNNING') {
    // Not a failure of this process: another daemon owns the socket, and the client
    // that spawned us should keep waiting for it rather than report a start failure.
    daemonLog(err.message);
    process.exit(DAEMON_EXIT_ALREADY_RUNNING);
  }
  daemonLog(`failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

// Last line of defence: an MCP server's own 'error' listener (src/mcp/server.ts) is
// the first line, but any other unexpected RUNTIME error in this process must not take
// down every session's agent process just because one thing went wrong. Log it and
// keep serving — a daemon that's still up for the other N sessions beats one that
// isn't up for any of them. (Startup failures are handled above, not here.)
process.on('uncaughtException', (err) => {
  daemonLog(`uncaught exception: ${String(err)}`);
});
process.on('unhandledRejection', (reason) => {
  daemonLog(`unhandled rejection: ${String(reason)}`);
});
