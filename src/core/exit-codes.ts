/**
 * Exit codes the daemon uses, shared with the client that spawns it.
 *
 * A startup failure that is NOT a failure of this process — another daemon already
 * owns the socket, so this one merely lost the bind race — exits with
 * `DAEMON_EXIT_ALREADY_RUNNING`. The waiting client reads that as "keep polling for
 * the winner" instead of reporting a start failure. Every other startup error exits
 * 1, which the client reports at once.
 */
export const DAEMON_EXIT_ALREADY_RUNNING = 75;
