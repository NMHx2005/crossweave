import { basename } from 'node:path';
import { defineCommand } from 'citty';
import { CrossweaveError } from '../../core/errors.js';
import { findProjectRoot } from '../../core/paths.js';
import { cleanRemote } from '../../core/settings.js';
import { listDevices, removeDevice } from '../../remote/devices.js';
import { fail } from '../context.js';

/** One line per field that came from a phone: no escape sequence reaches the terminal. */
const printable = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

export const remoteCommand = defineCommand({
  meta: { name: 'remote', description: 'Reach this Mac\'s sessions from a phone (Tailscale or Wi-Fi)' },
  subCommands: {
    serve: defineCommand({
      meta: { name: 'serve', description: 'Run remote access in the foreground (the cockpit runs it itself when turned on)' },
      args: {
        project: { type: 'string', description: 'Project folders to offer, comma-separated (default: this one)' },
        tailscale: { type: 'boolean', description: 'Listen on the Tailscale address' },
        wifi: { type: 'boolean', description: 'Listen on the Wi-Fi address (HTTPS)' },
        port: { type: 'string', description: 'Port (default 7788)' },
        pair: { type: 'boolean', default: false, description: 'Show a pairing code and QR code once listening' },
      },
      async run({ args }) {
        try {
          const roots = typeof args.project === 'string' && args.project !== ''
            ? args.project.split(',').map((p) => findProjectRoot(p.trim()))
            : [findProjectRoot(process.cwd())];
          const raw: Record<string, unknown> = {};
          if (args.tailscale !== undefined) raw.tailscale = args.tailscale;
          if (args.wifi !== undefined) raw.wifi = args.wifi;
          if (args.port !== undefined) raw.port = Number(args.port);
          const { remote, problems } = cleanRemote(raw);
          if (problems.length > 0) throw new CrossweaveError('INVALID_ARGUMENTS', problems[0] as string);
          const { runForeground } = await import('../../remote/main.js');
          await runForeground({
            projects: roots.map((root) => ({ root, name: basename(root) })),
            overrides: remote ?? {},
            pair: args.pair,
            out: (t) => process.stdout.write(t),
          });
        } catch (err) { fail(err); }
      },
    }),
    devices: defineCommand({
      meta: { name: 'devices', description: 'List the phones paired with this Mac' },
      run() {
        try {
          const devices = listDevices();
          if (devices.length === 0) {
            process.stdout.write('no paired phones\n');
            return;
          }
          for (const d of devices) {
            process.stdout.write(`${d.id.slice(0, 8)}  ${printable(d.name).padEnd(24)}  paired ${d.createdAt.slice(0, 10)}  last seen ${d.lastSeenAt?.slice(0, 16).replace('T', ' ') ?? 'never'}\n`);
          }
        } catch (err) { fail(err); }
      },
    }),
    revoke: defineCommand({
      meta: { name: 'revoke', description: 'Remove a paired phone (its connection closes at once)' },
      args: { device: { type: 'positional', required: true, description: 'The id (or its first characters) or the name' } },
      run({ args }) {
        try {
          const want = String(args.device);
          const matches = listDevices().filter((d) => d.id === want || (want.length >= 4 && d.id.startsWith(want)) || d.name === want);
          if (matches.length === 0) throw new CrossweaveError('DEVICE_NOT_FOUND', `No paired phone matches ${printable(want)}`);
          if (matches.length > 1) throw new CrossweaveError('DEVICE_AMBIGUOUS', `${matches.length} phones match ${printable(want)} — use more of the id`);
          const d = matches[0] as (typeof matches)[number];
          removeDevice(d.id);
          process.stdout.write(`removed ${printable(d.name)}\n`);
        } catch (err) { fail(err); }
      },
    }),
  },
});
