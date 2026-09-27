import { CrossweaveError } from '../core/errors.js';

/**
 * What a paired phone can do, as a small API of its own. The phone never speaks the
 * daemon's JSON-RPC: every call here is validated, and the hub makes the daemon call
 * itself — naming the workspace, choosing the parameters — so a phone cannot reach a
 * method, a parameter (`run`, `env`) or a project this file does not hand it.
 *
 * Each phone gets its own daemon connection per project it touches. A shared one
 * cannot work: the daemon replays a session's scrollback to the connection that
 * attaches, so a second phone watching through the first one's connection would get
 * no history, or the first would get it twice.
 */

export type Project = { root: string; name: string };

/** The daemon side the hub needs; `DaemonClient` in production, a fake in tests. */
export interface DaemonConn {
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  onNotification(cb: (method: string, params: unknown) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface Peer {
  id: string;
  deviceId: string;
  deviceName: string;
  send(method: string, params: Record<string, unknown>): void;
}

export type AuditEntry = { device: string; action: string; project?: string; session?: string; bytes?: number };

export type HubDeps = {
  /** A connection to `root`'s daemon, with the workspace it serves. */
  connect: (root: string) => Promise<{ conn: DaemonConn; workspaceId: string }>;
  audit?: (entry: AuditEntry) => void;
  /** Coalescing delay for `changed` pushes. */
  changeDelayMs?: number;
};

export class RemoteError extends CrossweaveError {}

const SESSION_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const LAUNCHER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_INPUT = 4096;
const MAX_NOTE = 120;
/** Typing is logged, never its content, and at most once a minute per session. */
const SEND_AUDIT_EVERY_MS = 60_000;

type ProjectConn = {
  conn: DaemonConn;
  workspaceId: string;
  /** Sessions this phone is watching: output from any other is dropped. */
  watching: Set<string>;
  changeTimer?: ReturnType<typeof setTimeout>;
};

type PeerState = {
  peer: Peer;
  projects: Map<string, Promise<ProjectConn>>;
  lastSendAudit: Map<string, number>;
};

function obj(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null && !Array.isArray(params) ? params as Record<string, unknown> : {};
}

function text(p: Record<string, unknown>, key: string, max: number): string {
  const v = p[key];
  if (typeof v !== 'string' || v.length === 0 || v.length > max) {
    throw new RemoteError('INVALID_PARAMS', `${key} must be text of at most ${max} characters`);
  }
  return v;
}

function sessionOf(p: Record<string, unknown>): string {
  const v = p.session;
  if (typeof v !== 'string' || !SESSION_ID.test(v)) throw new RemoteError('INVALID_PARAMS', 'session must be a session id');
  return v;
}

function launcherOf(p: Record<string, unknown>): string {
  const launcher = p.launcher === undefined ? 'terminal' : p.launcher;
  if (typeof launcher !== 'string' || !LAUNCHER_ID.test(launcher)) {
    throw new RemoteError('INVALID_PARAMS', 'launcher must be the id of a launcher set up on the Mac');
  }
  return launcher;
}

/** What the phone's list shows of a session — nothing it does not draw. */
function trimSession(s: Record<string, unknown>): Record<string, unknown> {
  const pick = ['id', 'name', 'status', 'activity', 'rang', 'agent', 'note', 'latestWords', 'branch', 'lastActivityAt', 'cols', 'rows', 'createdAt'];
  const out: Record<string, unknown> = {};
  for (const k of pick) if (s[k] !== undefined) out[k] = s[k];
  const usage = obj(s.usage);
  if (typeof usage.input === 'number' || typeof usage.output === 'number') {
    out.usage = { input: usage.input ?? 0, output: usage.output ?? 0, cacheWrite: usage.cacheWrite ?? 0, cacheRead: usage.cacheRead ?? 0, ...(usage.folder === true ? { folder: true } : {}) };
  }
  const git = obj(s.git);
  if (typeof git.ahead === 'number' || typeof git.changed === 'number') out.git = git;
  return out;
}

export class Hub {
  private projects = new Map<string, Project>();
  private readonly peers = new Map<string, PeerState>();

  constructor(private readonly deps: HubDeps) {}

  /** The projects open in the cockpit. A phone's connection to one that closed is dropped. */
  setProjects(list: Project[]): void {
    this.projects = new Map(list.map((p) => [p.root, p]));
    for (const state of this.peers.values()) {
      for (const [root, pending] of state.projects) {
        if (this.projects.has(root)) continue;
        state.projects.delete(root);
        void pending.then((pc) => pc.conn.close(), () => undefined);
      }
      state.peer.send('projects', { projects: this.listProjects() });
    }
  }

  listProjects(): Project[] {
    return [...this.projects.values()];
  }

  addPeer(peer: Peer): void {
    this.peers.set(peer.id, { peer, projects: new Map(), lastSendAudit: new Map() });
    this.deps.audit?.({ device: peer.deviceName, action: 'connect' });
  }

  removePeer(peerId: string): void {
    const state = this.peers.get(peerId);
    if (state === undefined) return;
    this.peers.delete(peerId);
    for (const pending of state.projects.values()) {
      void pending.then((pc) => {
        if (pc.changeTimer !== undefined) clearTimeout(pc.changeTimer);
        pc.conn.close();
      }, () => undefined);
    }
    this.deps.audit?.({ device: state.peer.deviceName, action: 'disconnect' });
  }

  peerCount(): number {
    return this.peers.size;
  }

  close(): void {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }

  private project(state: PeerState, p: Record<string, unknown>): Promise<ProjectConn> {
    const root = p.project;
    if (typeof root !== 'string' || !this.projects.has(root)) {
      return Promise.reject(new RemoteError('PROJECT_NOT_OPEN', 'That project is not open in crossweave on the Mac'));
    }
    const existing = state.projects.get(root);
    if (existing !== undefined) return existing;
    const pending = this.open(state, root);
    state.projects.set(root, pending);
    const forget = (): void => { if (state.projects.get(root) === pending) state.projects.delete(root); };
    // A failed connect, or a daemon that went away, is forgotten: the next call reconnects.
    pending.then((pc) => pc.conn.onClose(() => {
      forget();
      // A project the Mac closed was already announced by setProjects.
      if (this.peers.has(state.peer.id) && this.projects.has(root)) state.peer.send('changed', { project: root });
    }), forget);
    return pending;
  }

  private async open(state: PeerState, root: string): Promise<ProjectConn> {
    let connected: { conn: DaemonConn; workspaceId: string };
    try {
      connected = await this.deps.connect(root);
    } catch {
      throw new RemoteError('DAEMON_UNREACHABLE', 'crossweave is not running for that project on the Mac');
    }
    const pc: ProjectConn = { conn: connected.conn, workspaceId: connected.workspaceId, watching: new Set() };
    const { peer } = state;
    connected.conn.onNotification((method, params) => {
      if (!this.peers.has(peer.id)) return;
      const p = obj(params);
      if (method === 'session.data') {
        const session = p.sessionId;
        // A chunk no key here could open stays an object: nothing to draw.
        if (typeof session === 'string' && pc.watching.has(session) && typeof p.chunk === 'string') {
          peer.send('output', { project: root, session, data: p.chunk });
        }
      } else if (method === 'session.exit') {
        if (typeof p.sessionId === 'string' && pc.watching.has(p.sessionId)) {
          peer.send('exit', { project: root, session: p.sessionId, code: typeof p.code === 'number' ? p.code : null });
        }
        this.changed(pc, peer, root);
      } else if (method === 'tui.invalidate') {
        this.changed(pc, peer, root);
      }
    });
    return pc;
  }

  /** Session lists change in bursts (every status flip is one); the phone reloads once per burst. */
  private changed(pc: ProjectConn, peer: Peer, root: string): void {
    if (pc.changeTimer !== undefined) return;
    pc.changeTimer = setTimeout(() => {
      pc.changeTimer = undefined;
      if (this.peers.has(peer.id)) peer.send('changed', { project: root });
    }, this.deps.changeDelayMs ?? 300);
  }

  async handle(peerId: string, method: unknown, params: unknown): Promise<unknown> {
    const state = this.peers.get(peerId);
    if (state === undefined) throw new RemoteError('UNAUTHORIZED', 'Not signed in');
    const p = obj(params);
    const audit = (action: string, extra: Partial<AuditEntry> = {}): void =>
      this.deps.audit?.({ device: state.peer.deviceName, action, ...extra });

    switch (method) {
      case 'projects':
        return { projects: this.listProjects() };

      case 'sessions': {
        const pc = await this.project(state, p);
        const list = await pc.conn.call<Array<Record<string, unknown>>>('session.list', { workspaceId: pc.workspaceId });
        return { sessions: list.filter((s) => s.agentKind !== 'integration').map(trimSession) };
      }

      case 'launchers': {
        const pc = await this.project(state, p);
        const list = await pc.conn.call<Array<Record<string, unknown>>>('launchers.list', {});
        return {
          launchers: list
            .filter((l) => l.enabled !== false)
            .map((l) => ({ id: l.id, label: l.label, available: l.available === true })),
        };
      }

      case 'watch': {
        const pc = await this.project(state, p);
        const session = sessionOf(p);
        pc.watching.add(session);
        try {
          // Attaching again after an unwatch replays the scrollback, which the page
          // draws on a cleared terminal: it is how a re-opened session catches up.
          await pc.conn.call('session.attach', { workspaceId: pc.workspaceId, idOrName: session });
        } catch (err) {
          pc.watching.delete(session);
          throw err;
        }
        audit('watch', { project: p.project as string, session });
        return { ok: true };
      }

      case 'unwatch': {
        const pc = await this.project(state, p);
        pc.watching.delete(sessionOf(p));
        return { ok: true };
      }

      case 'send': {
        const pc = await this.project(state, p);
        const session = sessionOf(p);
        const data = text(p, 'data', MAX_INPUT);
        await pc.conn.call('session.input', { workspaceId: pc.workspaceId, idOrName: session, data });
        const key = `${p.project as string}\0${session}`;
        const now = Date.now();
        if (now - (state.lastSendAudit.get(key) ?? 0) >= SEND_AUDIT_EVERY_MS) {
          state.lastSendAudit.set(key, now);
          audit('type', { project: p.project as string, session, bytes: data.length });
        }
        return { ok: true };
      }

      case 'create': {
        const pc = await this.project(state, p);
        const name = text(p, 'name', 64);
        const launcher = launcherOf(p);
        // Only a launcher id reaches the daemon, which looks its command up in the
        // Mac's own Settings: the phone picks among lines the user wrote, never one of its own.
        const row = await pc.conn.call<{ id: string }>('session.new', { workspaceId: pc.workspaceId, name, worktree: true });
        await pc.conn.call('session.resume', { workspaceId: pc.workspaceId, idOrName: row.id, launcher });
        audit('create', { project: p.project as string, session: row.id });
        return { id: row.id };
      }

      case 'start': {
        const pc = await this.project(state, p);
        const session = sessionOf(p);
        const launcher = launcherOf(p);
        // A stopped session's shell, reopened — with a launcher only by id, as for create.
        await pc.conn.call('session.resume', { workspaceId: pc.workspaceId, idOrName: session, ...(launcher === 'terminal' ? {} : { launcher }) });
        audit('start', { project: p.project as string, session });
        return { ok: true };
      }

      case 'note': {
        const pc = await this.project(state, p);
        const session = sessionOf(p);
        const note = typeof p.text === 'string' && p.text.length <= MAX_NOTE ? p.text : undefined;
        if (note === undefined) throw new RemoteError('INVALID_PARAMS', `text must be at most ${MAX_NOTE} characters`);
        await pc.conn.call('session.note', { workspaceId: pc.workspaceId, idOrName: session, note });
        audit('note', { project: p.project as string, session });
        return { ok: true };
      }

      default:
        throw new RemoteError('METHOD_NOT_FOUND', `Unknown method: ${String(method).slice(0, 40)}`);
    }
  }
}
