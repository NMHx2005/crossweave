import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RemoteSettings } from '../core/settings.js';
import { listenPlan, type Interfaces, type Listen } from './addresses.js';
import { remoteDir, type Device } from './devices.js';
import { Hub, type HubDeps, type Project } from './hub.js';
import { formatCode, Pairing } from './pairing.js';
import { qrMatrix } from './qr.js';
import { startRemoteServer, type RunningRemote } from './server.js';

/**
 * The remote server's lifecycle, independent of how it is driven: the cockpit (over
 * stdio, src/remote/main.ts) or `cw remote serve`. Listens where the settings and the
 * Mac's interfaces say, re-plans when either changes, and reports what it is doing as
 * plain messages.
 */

export type Link = { reach: Listen['reach']; url: string; qr: boolean[][] };

export type ServiceEvent =
  | { type: 'status'; listening: Array<{ reach: Listen['reach']; url: string }>; problems: string[]; caFingerprint?: string }
  | { type: 'pair'; code: string; display: string; expiresAt: number; links: Link[] }
  | { type: 'paired'; device: Device }
  | { type: 'peers'; devices: Array<{ id: string; name: string }> }
  | { type: 'error'; message: string };

export type ServiceDeps = {
  home?: string;
  settings: () => RemoteSettings | undefined;
  interfaces: () => Interfaces;
  connect: HubDeps['connect'];
  emit: (event: ServiceEvent) => void;
  /** How often to look for a changed address (Tailscale coming up, another Wi-Fi). */
  replanMs?: number;
  now?: () => number;
  /** The server itself; a seam for tests, which bind to loopback. */
  start?: typeof startRemoteServer;
};

const AUDIT_MAX_BYTES = 1024 * 1024;

/** One JSON line per action, never its content; rotated once past 1 MB. */
export function appendAudit(home: string | undefined, entry: Record<string, unknown>): void {
  try {
    const dir = remoteDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, 'audit.log');
    try {
      if (statSync(path).size > AUDIT_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch { /* no log yet */ }
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    /* an audit write never takes the server down */
  }
}

export class RemoteService {
  readonly hub: Hub;
  private readonly pairing: Pairing;
  private running: RunningRemote | undefined;
  private planKey = '';
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ServiceDeps) {
    const audit = (entry: Record<string, unknown>): void => appendAudit(deps.home, entry);
    this.hub = new Hub({ connect: deps.connect, audit });
    this.pairing = new Pairing(deps.now ? { now: deps.now } : {});
  }

  setProjects(list: Project[]): void {
    this.hub.setProjects(list);
  }

  /** Listen as planned now, and keep re-planning. */
  start(): Promise<void> {
    this.timer ??= setInterval(() => void this.replan(), this.deps.replanMs ?? 15_000);
    return this.replan(true);
  }

  /** Settings changed: re-plan now (a restart only when where to listen changed). */
  reload(): Promise<void> {
    return this.replan(true);
  }

  private replan(force = false): Promise<void> {
    this.busy = this.busy.then(async () => {
      const settings = this.deps.settings();
      const plan = listenPlan(settings, this.deps.interfaces());
      const key = JSON.stringify([plan.listen, settings?.port ?? DEFAULT_PORT]);
      if (!force && key === this.planKey) return;
      if (key === this.planKey && this.running !== undefined) {
        this.status(plan.problems);
        return;
      }
      this.planKey = key;
      await this.running?.close();
      this.running = undefined;
      if (plan.listen.length > 0) {
        try {
          this.running = await (this.deps.start ?? startRemoteServer)({
            listen: plan.listen,
            port: settings?.port ?? DEFAULT_PORT,
            hub: this.hub,
            pairing: this.pairing,
            ...(this.deps.home === undefined ? {} : { home: this.deps.home }),
            onPaired: (device) => this.deps.emit({ type: 'paired', device }),
            onPeers: (devices) => this.deps.emit({ type: 'peers', devices }),
            audit: (entry) => appendAudit(this.deps.home, entry),
          });
        } catch (err) {
          // Most often the port is taken; say so, and try again on the next re-plan.
          this.planKey = '';
          const code = (err as NodeJS.ErrnoException).code;
          const message = code === 'EADDRINUSE'
            ? `Port ${settings?.port ?? DEFAULT_PORT} is in use on this Mac — pick another in Settings`
            : code === 'EADDRNOTAVAIL' ? 'That address is not on this Mac any more' : 'Could not start remote access';
          this.deps.emit({ type: 'status', listening: [], problems: [...plan.problems, message] });
          return;
        }
      }
      this.status(plan.problems);
    });
    return this.busy;
  }

  private status(problems: string[]): void {
    this.deps.emit({
      type: 'status',
      listening: this.running?.urls ?? [],
      problems,
      ...(this.running?.caFingerprint === undefined ? {} : { caFingerprint: this.running.caFingerprint }),
    });
  }

  /** A new pairing code, with a link (and its QR code) for each address listened on. */
  pair(): void {
    if (this.running === undefined || this.running.urls.length === 0) {
      this.deps.emit({ type: 'error', message: 'Remote access is not listening anywhere yet' });
      return;
    }
    const { code, expiresAt } = this.pairing.start();
    const links = this.running.urls.map(({ reach, url }) => {
      const link = `${url}#pair=${code}`;
      return { reach, url: link, qr: qrMatrix(link) };
    });
    this.deps.emit({ type: 'pair', code, display: formatCode(code), expiresAt, links });
  }

  cancelPair(): void {
    this.pairing.cancel();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.busy;
    await this.running?.close();
    this.running = undefined;
    this.planKey = '';
  }
}

export const DEFAULT_PORT = 7788;
