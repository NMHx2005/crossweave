import { defineCommand } from 'citty';
import { findProjectRoot } from '../../core/paths.js';
import { issueGatewayToken, readGatewayToken, revokeGatewayToken, type TokenKind } from '../../gateway/auth.js';
import { fail } from '../context.js';

export const gatewayCommand = defineCommand({
  meta: { name: 'gateway', description: 'Manage the remote gateway token' },
  subCommands: {
    token: defineCommand({
      meta: { name: 'token', description: 'Create or show the gateway token for this workspace' },
      args: {
        rotate: { type: 'boolean', default: false, description: 'Rotate the token (revoke old, issue new)' },
        read: { type: 'boolean', default: false, description: 'Issue/read the read-only token' },
        control: { type: 'boolean', default: false, description: 'Issue/read the control token (default)' },
      },
      async run({ args }) {
        try {
          const root = findProjectRoot(process.cwd());
          const kind: TokenKind = args.read ? 'read' : 'control';
          if (args.rotate) {
            const tok = issueGatewayToken(root, kind);
            process.stdout.write(`${tok}\n`);
            return;
          }
          const existing = readGatewayToken(root, kind);
          if (existing) process.stdout.write(`${existing}\n`);
          else process.stdout.write(`${issueGatewayToken(root, kind)}\n`);
        } catch (err) { fail(err); }
      },
    }),
    revoke: defineCommand({
      meta: { name: 'revoke', description: 'Revoke the gateway token' },
      args: {
        read: { type: 'boolean', default: false, description: 'Revoke only the read token' },
        control: { type: 'boolean', default: false, description: 'Revoke only the control token' },
      },
      async run({ args }) {
        try {
          const root = findProjectRoot(process.cwd());
          const kind: TokenKind | undefined = args.read ? 'read' : args.control ? 'control' : undefined;
          const ok = revokeGatewayToken(root, kind);
          process.stdout.write(ok ? 'revoked\n' : 'no token\n');
        } catch (err) { fail(err); }
      },
    }),
  },
});
