import { defineCommand } from 'citty';
import { withClient, fail, currentWorkspaceId } from '../context.js';

/**
 * Ctrl-]. Written as an escape, never as a literal control byte: an invisible 0x1D
 * in a code block does not survive transcription, and when it was lost this became
 * an empty string — `''.includes('')` is true, so the first keystroke detached and
 * no input ever reached the agent.
 *
 * Compared with `===` rather than `includes` so a 0x1D inside a paste does not
 * detach; a real keypress arrives as its own chunk.
 */
export const DETACH_KEY = '\x1d';

export const attachCommand = defineCommand({
  meta: { name: 'attach', description: 'Attach the terminal to a running session (Ctrl-] to detach)' },
  args: {
    target: { type: 'positional', description: 'Session name or id' },
    start: { type: 'boolean', default: true, description: 'Start the agent if it is not running' },
  },
  async run({ args }) {
    const stdin = process.stdin;
    const isTty = stdin.isTTY === true;

    // Last-resort guard, registered before anything can fail. A terminal left in raw
    // mode gives the user a shell that neither echoes nor answers Ctrl-C, recoverable
    // only from another window with `stty sane`.
    process.once('exit', () => {
      if (isTty) stdin.setRawMode(false);
    });

    try {
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        const target = { workspaceId, idOrName: args.target };

        if (args.start) await client.call('session.resume', target);
        // Subscribe exactly ONCE and await it. This used to run a second time inside
        // the promise with its failure swallowed, which both replayed the scrollback
        // twice and could leave the terminal raw and attached to nothing.
        await client.call('session.attach', target);

        await new Promise<void>((resolve) => {
          let done = false;

          const onResize = (): void => {
            void client.call('session.resize', {
              ...target,
              cols: process.stdout.columns ?? 80,
              rows: process.stdout.rows ?? 24,
            }).catch(() => undefined);
          };

          const onInput = (buf: Buffer): void => {
            const data = buf.toString('utf8');
            if (data === DETACH_KEY) {
              process.stdout.write('\n[detached]\n');
              finish();
              return;
            }
            void client.call('session.input', { ...target, data }).catch(() => undefined);
          };

          function finish(): void {
            if (done) return;
            done = true;
            if (isTty) stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener('data', onInput);
            process.removeListener('SIGWINCH', onResize);
            resolve();
          }

          client.onNotification((method, params) => {
            if (method === 'session.data') {
              process.stdout.write((params as { chunk: string }).chunk);
            } else if (method === 'session.exit') {
              process.stdout.write('\n[session exited]\n');
              finish();
            }
          });

          // Without this, finish() was reachable only from session.exit or Ctrl-] —
          // neither of which can fire once the socket is gone — so a daemon that died
          // left the CLI hung with the terminal in raw mode.
          client.onClose(() => {
            process.stdout.write('\n[daemon connection lost]\n');
            finish();
          });

          onResize();
          process.on('SIGWINCH', onResize);
          if (isTty) stdin.setRawMode(true);
          stdin.resume();
          stdin.on('data', onInput);
        });
      });
    } catch (err) { fail(err); }
  },
});
