/**
 * One timestamped lifecycle line from the daemon.
 *
 * Written to stderr so it reaches a terminal when `cwd` is run by hand, and
 * `.crossweave/daemon.log` when a client spawned the daemon (`connectOrStart`
 * redirects its stdio there). The daemon is a background process with no supervisor,
 * so this log is the only record of why it stopped — `reconcile()` will show its
 * sessions as `idle`/`dead` on the next start, with no other trace otherwise.
 */
export function daemonLog(message: string): void {
  process.stderr.write(`[${new Date().toISOString()}] crossweave daemon: ${message}\n`);
}
