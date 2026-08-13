#!/usr/bin/env bun
// A minimal ACP agent for tests — NOT a real coding agent. Speaks just enough of the
// protocol, using the same @agentclientprotocol/sdk production code depends on, for
// AcpAdapter's tests to exercise real, spec-correct ACP framing without depending on a
// real `cursor-agent` binary (needs a live account, unavailable in CI). Mirrors how
// ClaudePtyAdapter's existing tests use `sh -c '...'` fake commands instead of a real
// `claude` install.
//
// Protocol, driven entirely by the text of each session/prompt it receives — see the
// Task 2 brief in docs/superpowers/plans/2026-08-13-m5b-acp-client.md for the full
// contract this implements.
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

const sessions = new Set<string>();

async function initialize(): Promise<acp.InitializeResponse> {
  return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} };
}

async function newSession(): Promise<acp.NewSessionResponse> {
  const sessionId = crypto.randomUUID();
  sessions.add(sessionId);
  return { sessionId };
}

async function sendText(cx: acp.AgentContext, sessionId: string, text: string): Promise<void> {
  await cx.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  });
}

async function prompt(params: acp.PromptRequest, cx: acp.AgentContext): Promise<acp.PromptResponse> {
  const block = params.prompt[0];
  const text = block !== undefined && block.type === 'text' ? block.text : '';
  const sessionId = params.sessionId;

  if (text === '__PING__') {
    await sendText(cx, sessionId, 'PONG');
    return { stopReason: 'end_turn' };
  }

  if (text === '__TOOL_CALL__') {
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'test tool',
        kind: 'edit', status: 'pending', locations: [],
      },
    });
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' },
    });
    await sendText(cx, sessionId, 'DONE');
    return { stopReason: 'end_turn' };
  }

  const usageMarker = '__USAGE_UPDATE__:';
  if (text.startsWith(usageMarker)) {
    const parsed = JSON.parse(text.slice(usageMarker.length)) as {
      used: number;
      size: number;
      cost?: { amount: number; currency: string };
    };
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: 'usage_update', used: parsed.used, size: parsed.size, cost: parsed.cost },
    });
    await sendText(cx, sessionId, 'USAGE_REPORTED');
    return { stopReason: 'end_turn' };
  }

  const marker = '__REQUEST_PERMISSION__:';
  if (text.startsWith(marker)) {
    const parsed = JSON.parse(text.slice(marker.length)) as {
      locations?: { path: string }[];
      kind?: acp.ToolKind;
      options?: { kind: acp.PermissionOptionKind; name: string; optionId: string }[];
    };
    const response = await cx.request<acp.RequestPermissionResponse, acp.RequestPermissionRequest>(acp.methods.client.session.requestPermission, {
      sessionId,
      toolCall: {
        toolCallId: 'call_1', title: 'test tool call', kind: parsed.kind ?? 'edit',
        status: 'pending', locations: parsed.locations ?? [],
      },
      options: parsed.options ?? [
        { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
        { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
      ],
    });
    const result = response.outcome.outcome === 'cancelled' ? 'cancelled' : response.outcome.optionId;
    await sendText(cx, sessionId, `PERMISSION_RESULT:${result}`);
    return { stopReason: 'end_turn' };
  }

  await sendText(cx, sessionId, text);
  return { stopReason: 'end_turn' };
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;

acp
  .agent({ name: 'fake-acp-agent' })
  .onRequest('initialize', () => initialize())
  .onRequest('session/new', () => newSession())
  .onRequest('session/prompt', (ctx) => prompt(ctx.params, ctx.client))
  .connect(acp.ndJsonStream(input, output));
