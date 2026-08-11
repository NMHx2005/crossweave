import { defineCommand } from 'citty';
import { withClient, fail, currentWorkspaceId } from '../context.js';

interface TrustResult { trusted: boolean; testCommand: string }
interface StatusResult { testCommand: string | null; trusted: boolean }

const trustCommand = defineCommand({
  meta: { name: 'trust', description: "Trust the current crossweave.config.json converge.testCommand" },
  async run() {
    try {
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        const result = await client.call<TrustResult>('config.trust', { workspaceId });
        process.stdout.write(`trusted converge.testCommand: ${result.testCommand}\n`);
      });
    } catch (err) { fail(err); }
  },
});

const untrustCommand = defineCommand({
  meta: { name: 'untrust', description: 'Revoke trust for converge.testCommand' },
  async run() {
    try {
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        await client.call('config.untrust', { workspaceId });
        process.stdout.write('converge.testCommand trust revoked\n');
      });
    } catch (err) { fail(err); }
  },
});

const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show whether converge.testCommand is trusted' },
  async run() {
    try {
      await withClient(async (client) => {
        const workspaceId = await currentWorkspaceId(client);
        const result = await client.call<StatusResult>('config.status', { workspaceId });
        if (result.testCommand === null) {
          process.stdout.write('converge.testCommand is not set\n');
          return;
        }
        process.stdout.write(`converge.testCommand: ${result.testCommand} (${result.trusted ? 'trusted' : 'NOT trusted'})\n`);
      });
    } catch (err) { fail(err); }
  },
});

export const configCommand = defineCommand({
  meta: { name: 'config', description: 'Manage crossweave.config.json trust' },
  subCommands: { trust: trustCommand, untrust: untrustCommand, status: statusCommand },
});
