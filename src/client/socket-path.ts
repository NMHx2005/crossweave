import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CrossweaveError } from '../core/errors.js';

/**
 * macOS's `sun_path` is 104 bytes including the terminating NUL (Linux: 108); the
 * smaller limit is the one that matters.
 */
export const MAX_SOCKET_PATH_BYTES = 103;

/**
 * A path `connect()` can use for `socketPath`.
 *
 * Bun binds and connects past the `sun_path` limit, but Node's `net.connect` — the
 * one inside Electron — fails with `EINVAL`. A project nested deep enough therefore
 * worked from the CLI and hung the cockpit on "Connecting…" (and each retry spawned
 * another daemon, because "cannot connect" read as "nothing listening"). A symlink
 * is resolved by the kernel before the length check applies, so a short link to the
 * long path connects from either runtime.
 *
 * The link lives in a per-user directory that must be ours and closed to others:
 * a link directory another local user could write would let them aim this client
 * at a socket of their own. It defaults to `/tmp`, not `os.tmpdir()`: macOS's
 * per-user `/var/folders/…/T/` is itself ~50 bytes, which left the "short" link over
 * the limit too.
 */
export function connectablePath(socketPath: string, base = '/tmp'): string {
  if (Buffer.byteLength(socketPath) <= MAX_SOCKET_PATH_BYTES) return socketPath;

  const uid = process.getuid?.() ?? 0;
  const dir = join(base, `cw-sock-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) {
    throw new CrossweaveError(
      'SOCKET_DIR_UNSAFE',
      `Refusing unsafe socket link directory ${dir}: it must be a directory owned by you with mode 0700.`,
    );
  }

  const link = join(dir, `${createHash('sha256').update(socketPath).digest('hex').slice(0, 16)}.sock`);
  if (Buffer.byteLength(link) > MAX_SOCKET_PATH_BYTES) {
    throw new CrossweaveError(
      'SOCKET_PATH_TOO_LONG',
      `The daemon socket path is too long to connect to (${socketPath}), and so is the link directory ${dir}.`,
    );
  }
  let current: string | undefined;
  try {
    current = readlinkSync(link);
  } catch {
    current = undefined;
  }
  if (current !== socketPath) {
    // Create-then-rename, so a concurrent client never sees the link missing.
    const staging = `${link}.${process.pid}.tmp`;
    symlinkSync(socketPath, staging);
    renameSync(staging, link);
  }
  return link;
}
