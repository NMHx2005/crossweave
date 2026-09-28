import { defineCommand } from 'citty';
import { CrossweaveError } from '../../core/errors.js';
import { withClient, fail, currentWorkspaceId } from '../context.js';
import { loadGlobalConfig, saveGlobalConfig } from '../../update/global-config.js';

interface TrustResult { trusted: boolean; target: 'testCommand' | 'hooks'; testCommand?: string }
interface NotifyStatus { enabled: boolean; land: boolean; convergence: boolean }
interface HooksStatus { sessionSetup: string | null; sessionTeardown: string | null; trusted: boolean }
interface StatusResult { testCommand: string | null; trusted: boolean; hooks?: HooksStatus; notify: NotifyStatus }

const NOTIFY_EVENTS = ['land', 'convergence'] as const;
type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

function parseNotifyEvent(raw: string | undefined): NotifyEvent | undefined {
  if (raw === undefined) return undefined;
  if ((NOTIFY_EVENTS as readonly string[]).includes(raw)) return raw as NotifyEvent;
  throw new CrossweaveError('INVALID_ARGUMENTS', `--event must be one of ${NOTIFY_EVENTS.join(', ')}, got: ${raw}`);
}

const trustCommand = defineCommand({
  meta: { name: 'trust', description: 'Trust converge.testCommand, or `hooks` — two separate trusts, deliberately' },
  args: { target: { type: 'positional', required: false, description: 'hooks — omit to trust converge.testCommand' } },
  async run({ args }) {
    try {
      const target = args.target;
      if (target !== undefined && target !== 'hooks' && target !== 'testCommand') {
        throw new CrossweaveError('INVALID_ARGUMENTS', `Unknown trust target: ${target} (expected hooks)`);
      }
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        const result = await client.call<TrustResult>('config.trust', {
          workspaceId,
          ...(target === undefined ? {} : { target }),
        });
        process.stdout.write(
          result.target === 'hooks'
            ? 'trusted hooks (sessionSetup / sessionTeardown)\n'
            : `trusted converge.testCommand: ${result.testCommand}\n`,
        );
      });
    } catch (err) { fail(err); }
  },
});

const untrustCommand = defineCommand({
  meta: { name: 'untrust', description: 'Revoke trust: both converge.testCommand and the hooks' },
  async run() {
    try {
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        await client.call('config.untrust', { workspaceId });
        process.stdout.write('trust revoked (converge.testCommand and hooks)\n');
      });
    } catch (err) { fail(err); }
  },
});

const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show whether converge.testCommand and the hooks are trusted, and notify preferences' },
  async run() {
    try {
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        const result = await client.call<StatusResult>('config.status', { workspaceId });
        if (result.testCommand === null) {
          process.stdout.write('converge.testCommand is not set\n');
        } else {
          process.stdout.write(`converge.testCommand: ${result.testCommand} (${result.trusted ? 'trusted' : 'NOT trusted'})\n`);
        }
        // Printed only when the file actually sets a hook: a workspace with none has
        // nothing to say about them.
        const h = result.hooks;
        if (h !== undefined && (h.sessionSetup !== null || h.sessionTeardown !== null)) {
          process.stdout.write(`hooks: ${h.trusted ? 'trusted' : 'NOT trusted'}\n`);
          if (h.sessionSetup !== null) process.stdout.write(`  sessionSetup: ${h.sessionSetup}\n`);
          if (h.sessionTeardown !== null) process.stdout.write(`  sessionTeardown: ${h.sessionTeardown}\n`);
        }
        const n = result.notify;
        process.stdout.write(
          `notify: ${n.enabled ? 'on' : 'off'}\t` +
            `land=${n.land ? 'on' : 'off'}\tconvergence=${n.convergence ? 'on' : 'off'}\n`,
        );
      });
    } catch (err) { fail(err); }
  },
});

const notifyCommand = defineCommand({
  meta: { name: 'notify', description: 'Enable or disable push notifications, overall or per event' },
  subCommands: {
    on: defineCommand({
      meta: { name: 'on', description: 'Enable push notifications' },
      args: { event: { type: 'string', description: 'land|convergence — omit to set the master switch' } },
      async run({ args }) {
        try {
          const event = parseNotifyEvent(args.event);
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            await client.call('config.setNotify', { workspaceId, event, enabled: true });
            process.stdout.write(`notify ${event ?? ''} on\n`);
          });
        } catch (err) { fail(err); }
      },
    }),
    off: defineCommand({
      meta: { name: 'off', description: 'Disable push notifications' },
      args: { event: { type: 'string', description: 'land|convergence — omit to set the master switch' } },
      async run({ args }) {
        try {
          const event = parseNotifyEvent(args.event);
          await withClient(async (client) => {
            const workspaceId = await currentWorkspaceId(client);
            await client.call('config.setNotify', { workspaceId, event, enabled: false });
            process.stdout.write(`notify ${event ?? ''} off\n`);
          });
        } catch (err) { fail(err); }
      },
    }),
  },
});

const updateCheckCommand = defineCommand({
  meta: { name: 'update-check', description: 'Enable or disable the background version check' },
  subCommands: {
    on: defineCommand({
      meta: { name: 'on', description: 'Enable the background version check' },
      run() {
        try {
          saveGlobalConfig({ ...loadGlobalConfig(), updateCheck: true });
          process.stdout.write('update-check on\n');
        } catch (err) { fail(err); }
      },
    }),
    off: defineCommand({
      meta: { name: 'off', description: 'Disable the background version check' },
      run() {
        try {
          saveGlobalConfig({ ...loadGlobalConfig(), updateCheck: false });
          process.stdout.write('update-check off\n');
        } catch (err) { fail(err); }
      },
    }),
  },
});

export const configCommand = defineCommand({
  meta: { name: 'config', description: 'Manage crossweave.config.json trust and notify preferences' },
  subCommands: { trust: trustCommand, untrust: untrustCommand, status: statusCommand, notify: notifyCommand, 'update-check': updateCheckCommand },
});
