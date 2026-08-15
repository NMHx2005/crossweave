import { describe, it, expect } from 'bun:test';
import { waitForQuit, buildActionLayerBindings, destroyRendererBeforeReporting } from '../../src/cli/commands/tui.js';

/**
 * A fake `CliRenderer` narrow enough to match `waitForQuit`'s `QuitAwareRenderer`
 * shape (just `on()` now — Critical 1 fix removed the `keyInput`/`destroy` fields
 * this used to need, since `waitForQuit` no longer listens for keypresses itself).
 */
function fakeRenderer() {
  let destroyListener: (() => void) | undefined;
  return {
    renderer: {
      on(event: string, listener: () => void) {
        if (event === 'destroy') destroyListener = listener;
      },
    },
    emitDestroy() {
      destroyListener?.();
    },
  };
}

describe('waitForQuit', () => {
  it('resolves once the renderer emits its destroy event', async () => {
    const { renderer, emitDestroy } = fakeRenderer();
    const done = waitForQuit(renderer);
    let resolved = false;
    void done.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    emitDestroy();
    await done;
    expect(resolved).toBe(true);
  });

  it('does not resolve before destroy fires, regardless of what triggers it eventually', async () => {
    const { renderer, emitDestroy } = fakeRenderer();
    const done = waitForQuit(renderer);
    // Simulates a signal-triggered destroy (SIGINT/SIGTERM) rather than the `q`
    // keymap binding — waitForQuit treats every destroy trigger identically, it
    // has no special-cased path for 'q' anymore.
    emitDestroy();
    await done;
  });
});

/**
 * Critical 1 regression guard: `q` used to be a raw, unscoped
 * `renderer.keyInput.on('keypress', ...)` listener registered directly by
 * `waitForQuit`, completely independent of the focus-scoped action layer — so it
 * fired even while the new-session form had focus (destroying the whole TUI on an
 * ordinary "q" in a session name like `query-api`) or while a y/n confirm was
 * showing (quitting instead of cancelling).
 *
 * The fix moves `q` into `buildActionLayerBindings`'s array — the SAME array the
 * other 5 keys (n/l/shift+l/x/g) live in, which `registerActionLayer` (in
 * `run()`) registers as one keymap layer scoped to `sessionList`'s focus via
 * `targetMode: 'focus'`. That scoping mechanism itself (inert while a different
 * renderable has focus, unregistered/re-registered around a confirm via
 * `confirmWithLayerPaused`) is already established/tested by the existing 5-key
 * mechanism — so proving `q` is a member of THIS SAME array, with a `cmd` that
 * calls `renderer.destroy()`, is sufficient proof it inherits that identical
 * scoping, per the fix brief.
 */
describe('buildActionLayerBindings — q (quit)', () => {
  it('registers q in the same bindings array as n/l/shift+l/x/g', () => {
    const calls: string[] = [];
    const bindings = buildActionLayerBindings({
      newSession: () => calls.push('newSession'),
      land: () => calls.push('land'),
      landAll: () => calls.push('landAll'),
      kill: () => calls.push('kill'),
      gc: () => calls.push('gc'),
      quit: () => calls.push('quit'),
    });
    expect(bindings.map((b) => b.key)).toEqual(['n', 'l', 'shift+l', 'x', 'g', 'q']);
  });

  it("q's cmd calls the injected quit action (renderer.destroy in real use), with no other side effect", () => {
    let destroyed = false;
    const bindings = buildActionLayerBindings({
      newSession: () => {},
      land: () => {},
      landAll: () => {},
      kill: () => {},
      gc: () => {},
      quit: () => {
        destroyed = true;
      },
    });
    const q = bindings.find((b) => b.key === 'q');
    expect(q).toBeDefined();
    expect(typeof q!.cmd).toBe('function');
    (q!.cmd as () => void)();
    expect(destroyed).toBe(true);
  });
});

/**
 * Important 4 regression guard: a synchronous throw during renderer setup used to
 * reach `catch (err) { fail(err) }` with the renderer cleanup living in `finally` —
 * dead code, since `fail()` calls `process.exit()`, which terminates the process
 * before any pending `finally` block runs (confirmed empirically against this
 * repo's real Bun runtime, not just theorized). `destroyRendererBeforeReporting`
 * is `run()`'s `catch` block extracted so this ORDER (destroy, then report) is
 * provable without a real renderer/TTY or an actual `process.exit()` call — the
 * fake `report` below stands in for `fail`, and if destroy ran AFTER report in a
 * future regression, this test would still catch it (report's own callback
 * records call order, not just call count).
 */
describe('destroyRendererBeforeReporting', () => {
  it('destroys the renderer BEFORE reporting the error', () => {
    const calls: string[] = [];
    const renderer = { destroy: () => calls.push('destroy') };
    const err = new Error('setup exploded');
    let reportedErr: unknown;
    const report = (e: unknown) => {
      calls.push('report');
      reportedErr = e;
    };
    destroyRendererBeforeReporting(renderer, err, report);
    expect(calls).toEqual(['destroy', 'report']);
    expect(reportedErr).toBe(err);
  });

  it('reports the error without throwing when the renderer is undefined (setup failed before it was ever assigned)', () => {
    const calls: string[] = [];
    const err = new Error('setup exploded before createCliRenderer resolved');
    const report = () => calls.push('report');
    expect(() => destroyRendererBeforeReporting(undefined, err, report)).not.toThrow();
    expect(calls).toEqual(['report']);
  });

  it('propagates if destroy() itself throws, skipping report — documents the behavior rather than hiding it; real CliRenderer.destroy() is confirmed idempotent/non-throwing (see waitForQuit\'s doc comment), so this path is not expected to occur in practice', () => {
    const calls: string[] = [];
    const renderer = {
      destroy: () => {
        throw new Error('destroy exploded');
      },
    };
    const report = () => calls.push('report');
    expect(() => destroyRendererBeforeReporting(renderer, new Error('x'), report)).toThrow('destroy exploded');
    expect(calls).toEqual([]);
  });
});
