import type { Database } from 'bun:sqlite';
import { newId } from '../core/ids.js';
import { MessageRepo, type MessageTrust, type MessageRow } from '../db/repositories/message.js';
import type { SessionManager } from './session.js';

/**
 * Delivers messages between sessions. `broadcast` fans out at send time to every
 * OTHER live session in the workspace — one row per recipient, each delivered
 * through the exact same mechanism as a direct message. There is no shared
 * "unaddressed" row for readers to miss: a session that starts after a broadcast
 * was sent simply wasn't a recipient of it, the same way it wouldn't have been in
 * the room for a message spoken before it arrived.
 */
export class MessageBus {
  private readonly repo: MessageRepo;

  constructor(
    db: Database,
    private readonly sessions: SessionManager,
  ) {
    this.repo = new MessageRepo(db);
  }

  private insertOne(opts: {
    workspaceId: string;
    fromSession: string;
    toSessionIdOrName: string;
    type: 'direct' | 'handoff';
    body: string;
    trust: MessageTrust;
    contextRef?: string;
  }): MessageRow {
    // Resolves by name OR id, exactly like `cw session kill <name>` does — so a tool
    // call using the friendly name its own description invites actually delivers.
    const recipient = this.sessions.resolve(opts.workspaceId, opts.toSessionIdOrName);
    const row: MessageRow = {
      id: newId('msg'),
      workspaceId: opts.workspaceId,
      fromSession: opts.fromSession,
      toSession: recipient.id,
      type: opts.type,
      body: opts.body,
      contextRef: opts.contextRef ?? null,
      createdAt: new Date().toISOString(),
      deliveredAt: null,
      trust: opts.trust,
    };
    this.repo.insert(row);
    return row;
  }

  send(opts: {
    workspaceId: string;
    fromSession: string;
    toSession: string;
    body: string;
    trust: MessageTrust;
    contextRef?: string;
  }): MessageRow {
    return this.insertOne({ ...opts, toSessionIdOrName: opts.toSession, type: 'direct' });
  }

  handoff(opts: {
    workspaceId: string;
    fromSession: string;
    toSession: string;
    body: string;
    trust: MessageTrust;
    contextRef?: string;
  }): MessageRow {
    return this.insertOne({ ...opts, toSessionIdOrName: opts.toSession, type: 'handoff' });
  }

  broadcast(opts: {
    workspaceId: string;
    fromSession: string;
    body: string;
    trust: MessageTrust;
  }): MessageRow[] {
    const recipients = this.sessions
      .list(opts.workspaceId)
      .filter((s) => s.id !== opts.fromSession && (s.status === 'idle' || s.status === 'running' || s.status === 'waiting'));

    return recipients.map((recipient) => {
      const row: MessageRow = {
        id: newId('msg'),
        workspaceId: opts.workspaceId,
        fromSession: opts.fromSession,
        toSession: recipient.id,
        type: 'broadcast',
        body: opts.body,
        contextRef: null,
        createdAt: new Date().toISOString(),
        deliveredAt: null,
        trust: opts.trust,
      };
      this.repo.insert(row);
      return row;
    });
  }

  /** Every undelivered message addressed to this session — direct, handoff or broadcast alike. */
  inbox(_workspaceId: string, sessionId: string): MessageRow[] {
    return this.repo.listPending(sessionId);
  }

  deliver(messageId: string): void {
    this.repo.markDelivered(messageId);
  }
}
