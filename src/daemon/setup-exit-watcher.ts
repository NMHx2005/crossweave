import { scanForSetupSentinel } from '../domain/session-setup.js';
import type { RuntimeObserver } from './runtime.js';

/**
 * How much unmatched output to keep buffered per session while waiting for a sentinel
 * to complete. The sentinel itself is a few dozen bytes; this only needs to survive a
 * chunk boundary landing mid-sentinel, not accumulate a session's whole scrollback.
 */
const BUFFER_CAP = 512;

/**
 * Watches every running session's pty output for the OSC sentinel `wrapWithSentinel`
 * wraps `hooks.sessionSetup` in, and reports the hook's real exit code once it
 * completes — the only way to learn it, since the hook is typed into the shell, not
 * spawned by the daemon (see src/domain/session-setup.ts).
 */
export class SetupExitWatcher implements RuntimeObserver {
  private buffers = new Map<string, string>();

  constructor(private readonly onExitCode: (sessionId: string, code: number) => void) {}

  started(sessionId: string): void {
    this.buffers.delete(sessionId);
  }

  output(sessionId: string, chunk: string): void {
    const buffer = ((this.buffers.get(sessionId) ?? '') + chunk).slice(-BUFFER_CAP);
    const found = scanForSetupSentinel(buffer);
    if (found === undefined) {
      this.buffers.set(sessionId, buffer);
      return;
    }
    this.buffers.delete(sessionId);
    this.onExitCode(sessionId, found.code);
  }

  input(): void {
    // Not needed — the sentinel only ever arrives in output.
  }

  exited(sessionId: string, _code: number, _requested: boolean): void {
    this.buffers.delete(sessionId);
  }
}
