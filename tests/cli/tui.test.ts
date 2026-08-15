import { describe, it, expect } from 'bun:test';
import { waitForQuit } from '../../src/cli/commands/tui.js';

/**
 * A fake `CliRenderer` narrow enough to match `waitForQuit`'s `QuitAwareRenderer`
 * shape, distinguishing `destroy()` from a no-op `stop()` the real bug called
 * instead — this test would have failed against that version, since nothing would
 * ever call `emitDestroy()` and the awaited promise would hang.
 */
function fakeRenderer() {
  const calls: string[] = [];
  let destroyListener: (() => void) | undefined;
  let keypressListener: ((key: { name: string }) => void) | undefined;
  return {
    calls,
    renderer: {
      on(event: string, listener: () => void) {
        if (event === 'destroy') destroyListener = listener;
      },
      keyInput: {
        on(_event: 'keypress', listener: (key: { name: string }) => void) {
          keypressListener = listener;
        },
      },
      destroy() {
        calls.push('destroy');
        destroyListener?.();
      },
    },
    pressKey(name: string) {
      keypressListener?.({ name });
    },
  };
}

describe('waitForQuit', () => {
  it('a q keypress calls destroy() and the returned promise resolves', async () => {
    const { calls, renderer, pressKey } = fakeRenderer();
    const done = waitForQuit(renderer);
    pressKey('q');
    await done;
    expect(calls).toEqual(['destroy']);
  });

  it('a non-quit keypress does not call destroy()', () => {
    const { calls, renderer, pressKey } = fakeRenderer();
    void waitForQuit(renderer);
    pressKey('x');
    expect(calls).toEqual([]);
  });
});
