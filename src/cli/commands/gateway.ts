import { defineCommand } from 'citty';
import { findProjectRoot } from '../../core/paths.js';
import { issueGatewayToken, readGatewayToken, revokeGatewayToken, type TokenKind } from '../../gateway/auth.js';
import { fail } from '../context.js';

export const gatewayCommand = defineCommand({
  meta: { name: 'gateway', description: 'Manage the remote gateway token' },
  subCommands: {
    serve: defineCommand({
      meta: { name: 'serve', description: 'Start the gateway WebSocket server' },
      args: {
        port: { type: 'string', default: '8787', description: 'Port to listen on' },
        host: { type: 'string', default: '127.0.0.1', description: 'Host to bind' },
        cert: { type: 'string', description: 'TLS cert file' },
        key: { type: 'string', description: 'TLS key file' },
        'allow-insecure': { type: 'boolean', default: false, description: 'Allow non-loopback without TLS (logs loudly)' },
      },
      async run({ args }) {
        try {
          const { join } = await import('node:path');
          const { crossweaveDir } = await import('../../core/paths.js');
          const { createGatewayHttpServer, attachGatewayWs } = await import('../../gateway/server.js');
          const root = findProjectRoot(process.cwd());
          const socketPath = join(crossweaveDir(root), 'daemon.sock');
          // The gateway refuses every client until a token exists, so serving without
          // one would be a gateway nobody can use — issue it here rather than fail.
          if (readGatewayToken(root, 'control') === undefined) {
            issueGatewayToken(root, 'control');
            process.stdout.write('issued a gateway control token — show it with `cw gateway token`\n');
          }
          const port = Number(args.port);
          const server = createGatewayHttpServer({ socketPath, port, host: args.host, cert: args.cert, key: args.key, allowInsecure: args['allow-insecure'] });
          await attachGatewayWs(server, { socketPath, port, host: args.host, projectRoot: root });
          server.listen(port, args.host, () => process.stdout.write(`gateway listening on ${args.host}:${port}\n`));
        } catch (err) { fail(err); }
      },
    }),
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
