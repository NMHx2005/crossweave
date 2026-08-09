import { defineCommand } from 'citty';
import { withClient, fail, currentWorkspaceId } from '../context.js';

const DETACH_KEY = ''; // Ctrl-]

export const attachCommand = defineCommand({
  meta: { name: 'attach', description: 'Attach the terminal to a running session (Ctrl-] to detach)' },
  args: {
    target: { type: 'positional', description: 'Session name or id' },
    start: { type: 'boolean', default: true, description: 'Start the agent if it is not running' },
  },
  async run({ args }) {
    try {
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        const target = { workspaceId, idOrName: args.target };

        if (args.start) await client.call('session.resume', target);
        else await client.call('session.attach', target);

        const stdin = process.stdin;
        const isTty = stdin.isTTY === true;

        await new Promise<void>((resolve) => {
          let done = false;
          const finish = (): void => {
            if (done) return;
            done = true;
            if (isTty) stdin.setRawMode(false);
            stdin.pause();
            process.removeListener('SIGWINCH', onResize);
            resolve();
          };

          const onResize = (): void => {
            void client.call('session.resize', {
              ...target,
              cols: process.stdout.columns ?? 80,
              rows: process.stdout.rows ?? 24,
            }).catch(() => undefined);
          };

          client.onNotification((method, params) => {
            if (method === 'session.data') {
              process.stdout.write((params as { chunk: string }).chunk);
            } else if (method === 'session.exit') {
              process.stdout.write('\n[session exited]\n');
              finish();
            }
          });

          void client.call('session.attach', target).catch(() => undefined);
          onResize();
          process.on('SIGWINCH', onResize);

          if (isTty) stdin.setRawMode(true);
          stdin.resume();
          stdin.on('data', (buf: Buffer) => {
            const data = buf.toString('utf8');
            if (data.includes(DETACH_KEY)) {
              process.stdout.write('\n[detached]\n');
              finish();
              return;
            }
            void client.call('session.input', { ...target, data }).catch(() => undefined);
          });
        });
      });
    } catch (err) { fail(err); }
  },
});
