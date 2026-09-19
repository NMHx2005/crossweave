import { defineCommand } from 'citty';
import { findProjectRoot } from '../../core/paths.js';
import { issueGatewayToken, readGatewayToken, revokeGatewayToken } from '../../gateway/auth.js';
import { fail } from '../context.js';

export const gatewayCommand = defineCommand({
  meta: { name: 'gateway', description: 'Manage the remote gateway token' },
  subCommands: {
    token: defineCommand({
      meta: { name: 'token', description: 'Create or show the gateway token for this workspace' },
      args: { rotate: { type: 'boolean', default: false, description: 'Rotate the token (revoke old, issue new)' } },
      async run({ args }) {
        try {
          const root = findProjectRoot(process.cwd());
          if (args.rotate) {
            const tok = issueGatewayToken(root);
            process.stdout.write(`${tok}\n`);
            return;
          }
          const existing = readGatewayToken(root);
          if (existing) process.stdout.write(`${existing}\n`);
          else process.stdout.write(`${issueGatewayToken(root)}\n`);
        } catch (err) { fail(err); }
      },
    }),
    revoke: defineCommand({
      meta: { name: 'revoke', description: 'Revoke the gateway token' },
      async run() {
        try {
          const root = findProjectRoot(process.cwd());
          const ok = revokeGatewayToken(root);
          process.stdout.write(ok ? 'revoked\n' : 'no token\n');
        } catch (err) { fail(err); }
      },
    }),
  },
});
