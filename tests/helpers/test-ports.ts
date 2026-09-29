import { DEFAULT_CONFIG, type CrossweaveConfig } from '../../src/core/config.js';

/** Ports a test process may bind: a window of this many per process. */
const WINDOW = 30;
const FIRST = 20_000;
/** How many distinct windows fit under 65535 with the window size above. */
const SLOTS = 1_500;

/**
 * A port base of this process's own. The port tests bind real sockets to prove a block
 * held by another program is skipped, so they must not share a range with anything else on
 * the machine — including another `bun test` (two gates can run at once, and both used
 * 43000). Deriving the window from the pid keeps every concurrent suite apart.
 */
export function testPortBase(pid: number = process.pid): number {
  return FIRST + (pid % SLOTS) * WINDOW;
}

/** `DEFAULT_CONFIG` with this process's private port base. */
export const TEST_CONFIG: CrossweaveConfig = {
  ...DEFAULT_CONFIG,
  ports: { ...DEFAULT_CONFIG.ports, base: testPortBase() },
};
