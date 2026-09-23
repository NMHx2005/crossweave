import { DaemonClient } from '../client/rpc-client.js';
import type { ClientTransport } from '../client/transport.js';
import { unixSocketTransport } from '../client/transport.js';
import { wsTransport } from '../gateway/ws-transport.js';
import { deriveAttention, type AttentionKind, type Landability } from '../domain/attention.js';

export interface DeckBridgeOptions {
  socketPath?: string;
  wsUrl?: string;
  transport?: ClientTransport;
}

export type WorktreeCardColour = 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'gray';
export interface WorktreeCard {
  id: string;
  heading: string;
  branch: string | null;
  worktreePath: string | null;
  status: string;
  colour: WorktreeCardColour;
  dot: 'working' | 'needs-you' | 'blocked' | 'ready' | 'unknown' | 'conflict';
  selected: boolean;
}

function colourFor(status: string): WorktreeCardColour {
  if (status === 'running') return 'blue';
  if (status === 'waiting') return 'amber';
  if (status === 'dead') return 'red';
  if (status === 'landed') return 'violet';
  return 'gray';
}

function dotFor(attention: AttentionKind): WorktreeCard['dot'] {
  if (attention === 'needs_you') return 'needs-you';
  return attention;
}

/**
 * Bridge that exposes crossweave sessions as Deck worktree cards.
 * Thin over DaemonClient — one truth, N UIs. Heading is the session name
 * (what a human calls the worktree), colour/dot derive from status+landability,
 * selected is caller-supplied (Deck tells us which card is focused).
 */
export class DeckBridge {
  constructor(private readonly client: DaemonClient) {}

  static async connect(opts: DeckBridgeOptions): Promise<DeckBridge> {
    let transport: ClientTransport;
    if (opts.transport) transport = opts.transport;
    else if (opts.wsUrl) transport = await wsTransport(opts.wsUrl);
    else if (opts.socketPath) transport = await unixSocketTransport(opts.socketPath);
    else throw new Error('DeckBridge.connect requires socketPath, wsUrl, or transport');
    return new DeckBridge(DaemonClient.attach(transport));
  }

  async listWorktrees(workspaceId: string, opts?: { selectedId?: string; landabilityByName?: Map<string, Landability>; recentBlocked?: Set<string> }): Promise<WorktreeCard[]> {
    const sessions = await this.client.call<{ id: string; name: string; branch: string | null; worktreePath: string | null; status: string }[]>('session.list', { workspaceId });
    return sessions.map((s) => {
      const attention = deriveAttention({ status: s.status, landability: opts?.landabilityByName?.get(s.name), recentBlocked: opts?.recentBlocked?.has(s.name) });
      return { id: s.id, heading: s.name, branch: s.branch, worktreePath: s.worktreePath, status: s.status, colour: colourFor(s.status), dot: dotFor(attention), selected: s.id === opts?.selectedId };
    });
  }

  attentionBySession(sessions: { id: string; name: string; status: string }[], landabilityByName?: Map<string, Landability>, recentBlocked?: Set<string>): Map<string, AttentionKind> {
    const out = new Map<string, AttentionKind>();
    for (const s of sessions) out.set(s.id, deriveAttention({ status: s.status, landability: landabilityByName?.get(s.name), recentBlocked: recentBlocked?.has(s.name) }));
    return out;
  }

  /** Latest words helper — intended to tail `session.data` when a data accessor exists; string passthrough for now. */
  latestWords(tail: string, maxWords = 6): string {
    const words = tail.trim().split(/\s+/).filter(Boolean);
    return words.slice(-maxWords).join(' ');
  }

  async land(workspaceId: string, sessionId: string): Promise<unknown> {
    return this.client.call('land.session', { workspaceId, idOrName: sessionId });
  }

  /** Resolve a file click to the session's own worktree, not the main checkout. */
  resolveFilePath(worktreePath: string | null, projectRoot: string, relPath: string): string {
    const base = worktreePath ?? projectRoot;
    // Strip leading slash so `join` does not discard base; keep as-is if already absolute
    const rel = relPath.startsWith('/') ? relPath.slice(1) : relPath;
    return `${base.replace(/\/$/, '')}/${rel}`;
  }

  onEvent(cb: (method: string, params: unknown) => void): void {
    this.client.onNotification(cb);
  }

  get clientRef(): DaemonClient { return this.client; }
}
