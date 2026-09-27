import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '../client/rpc-client.js';
import { crossweaveDir } from '../core/paths.js';
import { loadSettings, type RemoteSettings } from '../core/settings.js';
import type { Interfaces } from './addresses.js';
import type { DaemonConn, Project } from './hub.js';
import { qrTerminal } from './qr.js';
import { RemoteService, type ServiceEvent } from './service.js';

/**
 * `cwd remote`: the remote server as its own process. The cockpit starts it with
 * `--control stdio` and drives it with JSON lines (below); it exits when that pipe
 * closes, so it can never outlive the app. `cw remote serve` runs it in the
 * foreground for a Mac without the cockpit.
 *
 * It reaches only daemons that are already running — it never starts one, and it
 * never starts a shell: sessions are created by the project's own daemon.
 */

/** From the cockpit. */
export type ControlIn =
  | { type: 'projects'; projects: Project[] }
  | { type: 'reload' }
  | { type: 'pair' }
  | { type: 'pair.cancel' };

export async function connectDaemon(root: string): Promise<{ conn: DaemonConn; workspaceId: string }> {
  const client = await DaemonClient.connect(join(crossweaveDir(root), 'daemon.sock'));
  try {
    client.setProjectRoot(root);
    const workspace = await client.call<{ id: string }>('workspace.init', {});
    client.setWorkspaceRoot(workspace.id, root);
    await client.call('daemon.subscribe', {});
    return { conn: client, workspaceId: workspace.id };
  } catch (err) {
    client.close();
    throw err;
  }
}

function isProjectList(v: unknown): v is Project[] {
  return Array.isArray(v) && v.every((p) => typeof p === 'object' && p !== null
    && typeof (p as Project).root === 'string' && (p as Project).root.startsWith('/')
    && typeof (p as Project).name === 'string');
}

/** The cockpit's side: one JSON object per stdin line in, one per stdout line out. */
export async function runControlled(): Promise<void> {
  const emit = (event: ServiceEvent): void => { process.stdout.write(`${JSON.stringify(event)}\n`); };
  const service = new RemoteService({
    settings: () => loadSettings().remote,
    interfaces: () => networkInterfaces() as Interfaces,
    connect: connectDaemon,
    emit,
  });
  let buffer = '';
  const handle = (line: string): void => {
    let msg: ControlIn;
    try {
      msg = JSON.parse(line) as ControlIn;
    } catch {
      return;
    }
    if (msg.type === 'projects' && isProjectList(msg.projects)) service.setProjects(msg.projects);
    else if (msg.type === 'reload') void service.reload();
    else if (msg.type === 'pair') service.pair();
    else if (msg.type === 'pair.cancel') service.cancelPair();
  };
  process.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line !== '') handle(line);
      nl = buffer.indexOf('\n');
    }
  });
  // The cockpit went away (quit or crashed): so does remote access.
  const quit = (): void => { void service.stop().then(() => process.exit(0)); };
  process.stdin.on('end', quit);
  process.stdin.on('close', quit);
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
  await service.start();
}

/** `cw remote serve`: the same server in the foreground, printing what it does. */
export async function runForeground(opts: {
  projects: Project[];
  overrides: RemoteSettings;
  pair: boolean;
  out: (text: string) => void;
}): Promise<void> {
  const settings = (): RemoteSettings => ({ ...loadSettings().remote, ...opts.overrides, enabled: true });
  let paired = false;
  const service = new RemoteService({
    settings,
    interfaces: () => networkInterfaces() as Interfaces,
    connect: connectDaemon,
    emit: (e) => {
      if (e.type === 'status') {
        for (const l of e.listening) opts.out(`listening (${l.reach}): ${l.url}\n`);
        if (e.caFingerprint !== undefined) opts.out(`Wi-Fi certificate (CA) SHA-256: ${e.caFingerprint}\n`);
        for (const p of e.problems) opts.out(`note: ${p}\n`);
        if (opts.pair && !paired && e.listening.length > 0) {
          paired = true;
          service.pair();
        }
      } else if (e.type === 'pair') {
        for (const link of e.links) {
          opts.out(`\nScan with your phone (${link.reach}):\n${qrTerminal(link.qr)}${link.url}\n`);
        }
        opts.out(`\nor type the code ${e.display} — valid for 2 minutes\n`);
      } else if (e.type === 'paired') {
        opts.out(`paired: ${e.device.name}\n`);
      } else if (e.type === 'peers') {
        opts.out(`connected phones: ${e.devices.length === 0 ? 'none' : e.devices.map((d) => d.name).join(', ')}\n`);
      } else {
        opts.out(`error: ${e.message}\n`);
      }
    },
  });
  service.setProjects(opts.projects);
  const quit = (): void => { void service.stop().then(() => process.exit(0)); };
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
  await service.start();
}
