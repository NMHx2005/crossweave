import type { McpTool, McpToolResult } from './protocol.js';
import type { MessageBus } from '../domain/bus.js';
import type { ContextStore } from '../domain/context-store.js';

function text(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Expected a non-empty string for "${key}"`);
  }
  return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

/** Exactly the six real tools. `cw_check` and `cw_declare_contract` arrive in M3. */
export function buildTools(
  sessionId: string,
  workspaceId: string,
  bus: MessageBus,
  store: ContextStore,
): McpTool[] {
  return [
    {
      name: 'cw_send',
      description: 'Send a direct message to another session in this workspace, by name or id.',
      inputSchema: {
        type: 'object',
        properties: {
          toSession: { type: 'string', description: 'Target session id or name' },
          body: { type: 'string', description: 'Message body (max 8 KB)' },
        },
        required: ['toSession', 'body'],
      },
      handler: async (args) => {
        const toSession = requireString(args, 'toSession');
        const body = requireString(args, 'body');
        bus.send({ workspaceId, fromSession: sessionId, toSession, body, trust: 'agent' });
        return text('sent');
      },
    },
    {
      name: 'cw_broadcast',
      description: 'Broadcast a message to every other live session in this workspace.',
      inputSchema: {
        type: 'object',
        properties: { body: { type: 'string', description: 'Message body (max 8 KB)' } },
        required: ['body'],
      },
      handler: async (args) => {
        const body = requireString(args, 'body');
        const sent = bus.broadcast({ workspaceId, fromSession: sessionId, body, trust: 'agent' });
        return text(`broadcast sent to ${sent.length} session(s)`);
      },
    },
    {
      name: 'cw_handoff',
      description: 'Hand off work to another session, optionally attaching a published context entry.',
      inputSchema: {
        type: 'object',
        properties: {
          toSession: { type: 'string', description: 'Target session id or name' },
          body: { type: 'string', description: 'Handoff summary' },
          contextRef: { type: 'string', description: 'Id of a context entry published via cw_publish_context' },
        },
        required: ['toSession', 'body'],
      },
      handler: async (args) => {
        const toSession = requireString(args, 'toSession');
        const body = requireString(args, 'body');
        const contextRef = optionalString(args, 'contextRef');
        bus.handoff({ workspaceId, fromSession: sessionId, toSession, body, trust: 'agent', contextRef });
        return text('handoff sent');
      },
    },
    {
      name: 'cw_inbox',
      description: "List this session's undelivered messages (direct, broadcast and handoff alike).",
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const messages = bus.inbox(workspaceId, sessionId);
        // At-most-once: a message this call HANDS BACK is delivered, so the next poll
        // returns only what has arrived since. Without this nothing ever writes
        // `delivered_at` and every poll re-surfaces the session's whole history —
        // including a `cw_handoff` ("take over this work") an agent could act on again.
        bus.deliverAll(messages.map((m) => m.id));
        return text(
          messages.map((m) => ({
            id: m.id,
            from: m.fromSession,
            type: m.type,
            body: m.body,
            contextRef: m.contextRef,
            trust: m.trust,
            createdAt: m.createdAt,
          })),
        );
      },
    },
    {
      name: 'cw_publish_context',
      description: 'Publish a context entry visible to every session in this workspace. Returns its id for handoff.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Entry key' },
          body: { type: 'string', description: 'Entry body (max 64 KB)' },
        },
        required: ['key', 'body'],
      },
      handler: async (args) => {
        const key = requireString(args, 'key');
        const body = requireString(args, 'body');
        const entry = store.publish(workspaceId, sessionId, key, body);
        return text({ id: entry.id, key: entry.key });
      },
    },
    {
      name: 'cw_read_context',
      description: 'Read every shared context entry in this workspace.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const entries = store.readShared(workspaceId);
        return text(entries.map((e) => ({ id: e.id, sessionId: e.sessionId, key: e.key, body: e.body, createdAt: e.createdAt })));
      },
    },
  ];
}
